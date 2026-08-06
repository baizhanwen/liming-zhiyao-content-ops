from __future__ import annotations

from collections.abc import Callable, Mapping
from datetime import UTC, datetime
from pathlib import Path
from typing import Any, Protocol
from urllib.parse import urlparse

from .adapters import AcquiredSource, SourceMetadata
from .api_client import AnalyzerApiClient, ClaimedJob

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
    def download(self, url: str, destination: Path) -> AcquiredSource | Path: ...


def is_allowed_douyin_url(value: str) -> bool:
    parsed = urlparse(value); host = (parsed.hostname or "").lower()
    allowed = host in {"douyin.com", "iesdouyin.com"} or host.endswith(
        (".douyin.com", ".iesdouyin.com")
    )
    return parsed.scheme == "https" and allowed


class PlatformSourceProvider:
    def __init__(self, client: AnalyzerApiClient, public_video: PublicVideoResolver) -> None:
        self.client = client
        self.public_video = public_video

    def acquire(self, job: ClaimedJob, destination: Path) -> AcquiredSource:
        if job.source_type == "upload":
            return AcquiredSource(self.client.download_upload_source(job, destination))
        source_url = job.source.get("source_url")
        if not isinstance(source_url, str) or not is_allowed_douyin_url(source_url):
            raise ValueError("claimed public source is not an allowed Douyin URL")
        resolved = self.public_video.download(source_url, destination)
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


class YtDlpPublicVideoResolver:
    """Best-effort public resolver kept behind an adapter because platform support changes."""

    def __init__(
        self,
        factory: Callable[[Mapping[str, Any]], Any] | None = None,
        *,
        cookies_from_browser: str = "",
        cookie_file: str = "",
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

    def download(self, url: str, destination: Path) -> AcquiredSource:
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
        using_cookie_file = self._cookie_file is not None and self._cookie_file.is_file()
        if using_cookie_file:
            options["cookiefile"] = str(self._cookie_file)
        elif self._cookies_from_browser is not None:
            options["cookiesfrombrowser"] = self._cookies_from_browser
        try:
            with self._factory(options) as downloader:
                info = downloader.extract_info(url, download=True)
        except Exception as error:
            message = str(error)
            if "cookie" in message.lower():
                if using_cookie_file:
                    raise RuntimeError(
                        "抖音 Cookie 快照已失效。请重新运行 refresh-douyin-cookies.bat；"
                        "快照完成后，解析期间可以正常打开 Edge。"
                    ) from error
                if self._cookies_from_browser is None:
                    raise RuntimeError(
                        "抖音要求新鲜 Cookie。请运行 refresh-douyin-cookies.bat，或改用本地上传。"
                    ) from error
                raise RuntimeError(
                    "浏览器 Cookie 数据库正在使用中。请完全关闭 Edge，运行 "
                    "refresh-douyin-cookies.bat 生成快照；之后解析时可以保持 Edge 打开。"
                ) from error
            raise
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
