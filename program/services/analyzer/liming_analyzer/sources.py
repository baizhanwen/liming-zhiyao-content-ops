from __future__ import annotations

import logging
import shutil
import time
from collections.abc import Callable, Mapping
from datetime import UTC, datetime
from pathlib import Path
from tempfile import TemporaryDirectory
from typing import Any, Protocol
from urllib.parse import urlparse

from .adapters import AcquiredSource, SourceMetadata
from .api_client import AnalyzerApiClient, ClaimedJob
from .source_errors import SourceDownloadError, classify_source_message

logger = logging.getLogger(__name__)

SUPPORTED_COOKIE_BROWSERS = frozenset({
    "brave", "chrome", "chromium", "edge", "firefox", "opera", "safari", "vivaldi", "whale",
})


def parse_browser_cookie_spec(value: str) -> tuple[str, str | None, None, None] | None:
    clean = value.strip()
    if not clean:
        return None
    if len(clean) > 500 or "\r" in clean or "\n" in clean:
        raise ValueError("browser cookie configuration is invalid")
    browser, separator, profile = clean.partition(":")
    browser = browser.strip().lower()
    if browser not in SUPPORTED_COOKIE_BROWSERS:
        choices = ", ".join(sorted(SUPPORTED_COOKIE_BROWSERS))
        raise ValueError(f"unsupported cookie browser: {browser}; choose one of {choices}")
    return browser, profile.strip() if separator and profile.strip() else None, None, None


class PublicVideoResolver(Protocol):
    def download(self, url: str, destination: Path, *, cookie_file: Path | None = None) -> AcquiredSource | Path: ...


def is_allowed_douyin_url(value: str) -> bool:
    parsed = urlparse(value); host = (parsed.hostname or "").lower()
    allowed = host in {"douyin.com", "iesdouyin.com"} or host.endswith(
        (".douyin.com", ".iesdouyin.com")
    )
    return parsed.scheme == "https" and allowed


class PlatformSourceProvider:
    def __init__(self, client: AnalyzerApiClient, public_video: PublicVideoResolver, cookie_file: str = "") -> None:
        self.client = client
        self.public_video = public_video
        self.cookie_file = Path(cookie_file).expanduser().resolve() if cookie_file else None

    def acquire(self, job: ClaimedJob, destination: Path) -> AcquiredSource:
        if job.source_type == "upload":
            return AcquiredSource(self.client.download_upload_source(job, destination))
        source_url = job.source.get("source_url")
        if not isinstance(source_url, str) or not is_allowed_douyin_url(source_url):
            raise ValueError("claimed public source is not an allowed Douyin URL")
        # Remote organization snapshots are job-local. A 404 may delete this
        # temporary file, but must never erase the host's manually imported file.
        with TemporaryDirectory(prefix="liming-job-cookies-") as temporary:
            snapshot = Path(temporary) / "cookies.txt"
            uploaded = self.client.download_cookie_snapshot(job, snapshot)
            try:
                resolved = self.public_video.download(source_url, destination, cookie_file=snapshot if uploaded else self.cookie_file)
            except SourceDownloadError as error:
                logger.warning("Video source failed: job=%s code=%s", job.id, error.code)
                raise
        return resolved if isinstance(resolved, AcquiredSource) else AcquiredSource(resolved)


def _integer(value: Any) -> int | None:
    if isinstance(value, bool):
        return None
    if isinstance(value, (int, float)) and value >= 0:
        return round(value)
    return None


def _published_at(value: Any) -> str | None:
    if not isinstance(value, (int, float)) or value <= 0:
        return None
    return datetime.fromtimestamp(value, UTC).isoformat().replace("+00:00", "Z")


class _DownloadDiagnostics:
    def __init__(self) -> None:
        self.failure: SourceDownloadError | None = None

    def debug(self, _message: str) -> None:
        pass

    def warning(self, message: str) -> None:
        failure = classify_source_message(message)
        # Preserve the specific warning swallowed by a non-fatal extractor
        # request, rather than replacing it with the generic Fresh cookies hint.
        if failure.code not in {"SOURCE_DOWNLOAD_FAILED", "DOUYIN_ACCESS_REJECTED"}:
            self.failure = failure

    def error(self, message: str) -> None:
        self.warning(message)


class YtDlpPublicVideoResolver:
    """Best-effort public resolver kept behind an adapter because platform support changes."""

    def __init__(
        self,
        factory: Callable[[Mapping[str, Any]], Any] | None = None,
        *,
        cookies_from_browser: str = "",
        cookie_file: str = "",
        ffmpeg_location: str = "",
    ) -> None:
        if factory is None:
            try:
                from yt_dlp import YoutubeDL
            except ImportError as error:
                raise RuntimeError("yt-dlp is required for public video links") from error
            factory = YoutubeDL
        self._factory = factory
        self._cookies_from_browser = parse_browser_cookie_spec(cookies_from_browser)
        self._cookie_file = Path(cookie_file).expanduser().resolve() if cookie_file else None
        self._ffmpeg_location = ffmpeg_location.strip()

    def download(self, url: str, destination: Path, *, cookie_file: Path | None = None) -> AcquiredSource:
        # yt-dlp saves its cookie jar on close. Give it a writable private copy
        # so it cannot overwrite an uploaded/master snapshot or another job.
        with TemporaryDirectory(prefix="liming-download-cookies-") as temporary:
            return self._download(url, destination, cookie_file or self._cookie_file, Path(temporary) / "cookies.txt")

    def _download(self, url: str, destination: Path, cookie_file: Path | None, scratch_cookie: Path) -> AcquiredSource:
        if not is_allowed_douyin_url(url):
            raise ValueError("public resolver only accepts allowed Douyin URLs")
        destination.parent.mkdir(parents=True, exist_ok=True)
        options = {
            "outtmpl": str(destination.with_name(f"{destination.name}.%(ext)s")),
            "noplaylist": True,
            "quiet": True,
            "no_warnings": True,
            "restrictfilenames": True,
            "merge_output_format": "mp4",
            "max_filesize": 2_000_000_000,
            "socket_timeout": 30,
            "retries": 2,
        }
        if self._ffmpeg_location:
            options["ffmpeg_location"] = self._ffmpeg_location
        cookie_file_available = cookie_file is not None and cookie_file.is_file()
        attempts: list[tuple[str, dict[str, Any]]] = []
        if cookie_file_available:
            attempts.append(("cookie_file", {"cookiefile": str(scratch_cookie)}))
        if self._cookies_from_browser is not None:
            attempts.append(("browser", {"cookiesfrombrowser": self._cookies_from_browser}))
        if not attempts:
            attempts.append(("none", {}))
        info: Any = None
        primary_error: SourceDownloadError | None = None
        for attempt_index, (authentication_mode, authentication_options) in enumerate(attempts):
            for request_attempt in range(2):
                diagnostics = _DownloadDiagnostics()
                try:
                    if authentication_mode == "cookie_file":
                        assert cookie_file is not None
                        shutil.copyfile(cookie_file, scratch_cookie)
                    with self._factory({**options, **authentication_options, "logger": diagnostics}) as downloader:
                        info = downloader.extract_info(url, download=True)
                    break
                except Exception as error:
                    info = None
                    failure = diagnostics.failure or classify_source_message(str(error))
                    logger.warning("Douyin download attempt failed: mode=%s attempt=%s code=%s", authentication_mode, request_attempt + 1, failure.code)
                    if failure.code == "SOURCE_NETWORK_FAILED" and request_attempt == 0:
                        time.sleep(3)
                        continue
                    authentication_failure = failure.code in {"DOUYIN_ACCESS_REJECTED", "DOUYIN_BROWSER_UNAVAILABLE", "DOUYIN_COOKIE_INVALID"}
                    if authentication_failure and attempt_index < len(attempts) - 1:
                        primary_error = failure
                        break
                    if failure.code == "DOUYIN_BROWSER_UNAVAILABLE" and primary_error is not None:
                        failure = primary_error
                    if failure.code == "DOUYIN_ACCESS_REJECTED" and authentication_mode == "browser" and primary_error is None:
                        failure = SourceDownloadError(failure.code, "抖音暂未接受分析主机浏览器登录态或请求。请稍后重试；持续失败时确认视频可访问并上传 Cookie。")
                    raise failure from error
            if info is not None:
                break
        if not isinstance(info, dict):
            raise TypeError("public resolver returned invalid metadata")
        candidates: list[Path] = []
        requested = info.get("requested_downloads")
        if isinstance(requested, list):
            candidates.extend(Path(item["filepath"]) for item in requested if isinstance(item, dict) and isinstance(item.get("filepath"), str))
        for key in ("filepath", "_filename"):
            if isinstance(info.get(key), str):
                candidates.append(Path(info[key]))
        candidates.extend(destination.parent.glob(f"{destination.name}.*"))
        source_path = next((path for path in candidates if path.is_file()), None)
        if source_path is None:
            raise RuntimeError("public resolver did not produce a media file")
        metadata = SourceMetadata(
            platform_work_id=str(info["id"])[:200] if info.get("id") is not None else None,
            title=str(info["title"])[:500] if info.get("title") is not None else None,
            author_name=str(info.get("uploader") or info.get("channel"))[:300] if info.get("uploader") or info.get("channel") else None,
            published_at=_published_at(info.get("timestamp")),
            duration_sec=_integer(info.get("duration")),
            plays=_integer(info.get("view_count")),
            likes=_integer(info.get("like_count")),
            comments=_integer(info.get("comment_count")),
            favorites=_integer(info.get("collect_count") or info.get("favorite_count")),
            shares=_integer(info.get("share_count")),
        )
        return AcquiredSource(source_path, metadata)
