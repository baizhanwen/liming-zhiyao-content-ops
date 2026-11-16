from __future__ import annotations

import json
import logging
import math
import os
import shutil
import time
from collections.abc import Callable, Mapping
from dataclasses import replace
from datetime import UTC, datetime
from pathlib import Path
from tempfile import TemporaryDirectory
from typing import Any, Protocol
from urllib.parse import urlparse

from .adapters import AcquiredSource, SourceMetadata
from .api_client import AnalyzerApiClient, ClaimedJob
from .collection_mode import job_collection_mode
from .source_errors import SourceDownloadError, classify_source_message, safe_source_diagnostic
from .douyin_collector.python.limits import BROWSER_TIMEOUT_SECONDS, MAX_DURATION_SECONDS, MAX_MEDIA_BYTES

logger = logging.getLogger(__name__)

SUPPORTED_COOKIE_BROWSERS = frozenset({
    "brave", "chrome", "chromium", "edge", "firefox", "opera", "safari", "vivaldi", "whale",
})


def parse_browser_cookie_spec(value: str) -> tuple[str, str | None, None, None] | None:
    clean = value.strip()
    if not clean or clean.lower() in {"none", "disabled"}:
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
    def __init__(self, client: AnalyzerApiClient, public_video: PublicVideoResolver, cookie_file: str = "", *,
                 cookie_video_factory: Callable[[], PublicVideoResolver] | None = None) -> None:
        self.client = client
        self.public_video = public_video
        # A legacy host path may still be supplied by older integrations. It is
        # intentionally never read: organization jobs only use their own snapshot.
        self._cookie_video_factory = cookie_video_factory or (lambda: YtDlpPublicVideoResolver(organization_cookie_only=True))
        self._progress = None

    def set_progress(self, callback) -> None:
        self._progress = callback

    def _download(self, resolver, source_url, destination, *, cookie_file=None):
        setter = getattr(resolver, "set_progress", None)
        if callable(setter):
            setter(self._progress)
        try:
            resolved = (resolver.download(source_url, destination) if cookie_file is None else
                        resolver.download(source_url, destination, cookie_file=cookie_file))
            return resolved if isinstance(resolved, AcquiredSource) else AcquiredSource(resolved)
        finally:
            if callable(setter):
                setter(None)

    def acquire(self, job: ClaimedJob, destination: Path) -> AcquiredSource:
        if job.source_type == "upload":
            return AcquiredSource(self.client.download_upload_source(job, destination))
        source_url = job.source.get("source_url")
        if not isinstance(source_url, str) or not is_allowed_douyin_url(source_url):
            raise ValueError("claimed public source is not an allowed Douyin URL")
        mode = job_collection_mode(job)
        if mode == "anonymous":
            # The default never reads an organization snapshot, personal browser
            # state or a manually imported host Cookie file.
            if getattr(self.public_video, "uses_cookie_snapshots", False) is True:
                raise SourceDownloadError("SOURCE_RUNTIME_UNAVAILABLE", "匿名采集器尚未就绪，请检查独立浏览器采集环境。")
            return self._download(self.public_video, source_url, destination)
        # Every explicit Cookie attempt gets a new resolver and private copy, so
        # mutable yt-dlp Cookie jars cannot leak across organizations or jobs.
        with TemporaryDirectory(prefix="liming-job-cookies-") as temporary:
            snapshot = Path(temporary) / "cookies.txt"
            try:
                uploaded = self.client.download_cookie_snapshot(job, snapshot)
                if not uploaded or not snapshot.is_file() or snapshot.stat().st_size == 0:
                    raise SourceDownloadError("SOURCE_COOKIE_REQUIRED", "当前公司尚未提供抖音 Cookie，请先上传 Cookie，再重试 Cookie 采集。")
                snapshot.chmod(0o600)
                resolver = self._cookie_video_factory()
                return self._download(resolver, source_url, destination, cookie_file=snapshot)
            except SourceDownloadError as error:
                logger.warning("Video source failed: job=%s code=%s", job.id, error.code)
                raise
            except Exception:
                logger.warning("Cookie source unavailable: job=%s", job.id)
                raise SourceDownloadError("SOURCE_COOKIE_UNAVAILABLE", "当前公司的 Cookie 采集未完成，请检查采集环境及 Cookie 状态后重试。") from None


class SkillCollectPublicVideoResolver:
    """Bridge the vendored lmzy collector to the existing analysis contract."""

    uses_cookie_snapshots = False

    def __init__(
        self,
        collector=None,
        *,
        ffmpeg: str = "ffmpeg",
        ffprobe: str = "ffprobe",
        browser_timeout: int = BROWSER_TIMEOUT_SECONDS,
        progress=None,
        cancelled=None,
    ) -> None:
        from .douyin_collector import collect

        self._collector = collector if collector is not None else collect
        self._ffmpeg = ffmpeg
        self._ffprobe = ffprobe
        self._browser_timeout = browser_timeout
        self._progress = progress
        self._cancelled = cancelled

    def set_progress(self, callback) -> None:
        self._progress = callback

    def download(self, url: str, destination: Path, *, cookie_file: Path | None = None) -> AcquiredSource:
        from .douyin_collector import CollectorError

        if not is_allowed_douyin_url(url):
            raise ValueError("public resolver only accepts allowed Douyin URLs")
        destination = Path(destination)
        evidence_path = destination.with_name(destination.name + ".acquisition.json")
        published = False
        completed = False
        stage = "prepare_destination"
        try:
            destination.parent.mkdir(parents=True, exist_ok=True)
            with TemporaryDirectory(prefix=".source-capture-", dir=destination.parent.resolve()) as temporary:
                folder = Path(temporary)
                stage = "collector"
                result = self._collector(
                    url, folder,
                    progress=self._progress,
                    cancelled=self._cancelled,
                    browser_timeout=self._browser_timeout,
                    ffmpeg=self._ffmpeg,
                    ffprobe=self._ffprobe,
                )
                stage = "source_validation"
                source = Path(result["media_path"])
                if source.is_symlink() or not source.resolve().is_relative_to(folder.resolve()) or not source.is_file():
                    raise SourceDownloadError("SOURCE_DOWNLOAD_FAILED", "采集产物未处于当前任务目录，请重试。")
                stage = "source_metadata"
                metadata = SourceMetadata(
                    platform_work_id=str(result["video_id"])[:200],
                    title=str(result.get("title") or "抖音视频")[:500],
                    duration_sec=_integer(result.get("duration")),
                )
                # Preserve bounded provenance and silent-video limitations for
                # this task without signed URLs, cookies or browser responses.
                evidence = {key: result[key] for key in (
                    "video_id", "source_url", "sha256", "size_bytes", "duration",
                    "has_video", "has_audio", "limitations", "acquisition_method",
                    "identity_verified", "coverage", "reported_duration", "evidence",
                ) if key in result}
                stage = "write_provenance"
                pending_evidence = folder / "acquisition.json"
                pending_evidence.write_text(json.dumps(evidence, ensure_ascii=False, indent=2), encoding="utf-8")
                stage = "publish_source"
                source.replace(destination)
                published = True
                stage = "publish_provenance"
                os.replace(pending_evidence, evidence_path)
                completed = True
                return AcquiredSource(destination, metadata)
        except CollectorError as error:
            failure = _collector_failure(error.code)
            if failure.code == "SOURCE_PUBLISH_FAILED":
                logger.error("Skill Collect internal failure: %s", json.dumps(
                    safe_source_diagnostic(error, getattr(error, "stage", stage)), ensure_ascii=True,
                ))
            else:
                logger.warning("Skill Collect acquisition failed: code=%s", failure.code)
            raise failure from None
        except SourceDownloadError:
            raise
        except Exception as error:  # noqa: BLE001 - log only allowlisted internal diagnostics
            logger.error("Skill Collect internal failure: %s", json.dumps(
                safe_source_diagnostic(error, stage), ensure_ascii=True,
            ))
            if isinstance(error, OSError) and stage in {
                "prepare_destination", "write_provenance", "publish_source", "publish_provenance",
            }:
                raise _collector_failure("media_publish_failed") from None
            raise SourceDownloadError(
                "SOURCE_INTERNAL_ERROR", "视频采集服务出现内部异常，请联系管理员查看本机分析日志，或上传原文件继续。",
            ) from None
        finally:
            if published and not completed:
                cleanup_failed = False
                for path in (destination, evidence_path):
                    try:
                        path.unlink(missing_ok=True)
                    except OSError as error:
                        cleanup_failed = True
                        logger.error("Skill Collect internal failure: %s", json.dumps(
                            safe_source_diagnostic(error, "cleanup_source"), ensure_ascii=True,
                        ))
                if cleanup_failed:
                    raise _collector_failure("media_publish_failed") from None


def _collector_failure(code: str) -> SourceDownloadError:
    # Only public, fixed messages cross the worker API. Collector diagnostics
    # can contain transient request state and must never be serialized here.
    if code == "media_publish_failed":
        return SourceDownloadError("SOURCE_PUBLISH_FAILED", "视频采集文件未能保存到本机，请检查分析主机磁盘、目录权限和日志后再试，或上传原文件继续。")
    if code in {"cancelled"}:
        return SourceDownloadError("SOURCE_CANCELLED", "视频采集已取消。")
    if code in {"ffmpeg_missing", "browser_unavailable", "browser_missing", "node_missing", "browser_runtime", "browser_dependency", "douyin_browser_runtime"}:
        return SourceDownloadError("SOURCE_RUNTIME_UNAVAILABLE", "视频采集环境未就绪，请运行 tools\\setup-analyzer.bat 安装 Chromium、Node 和 FFmpeg。")
    if code == "douyin_rate_limited":
        return SourceDownloadError("SOURCE_RATE_LIMITED", "抖音暂时限制了采集请求，请稍后重试或上传本地视频。")
    if code in {"dns", "network", "http", "timeout", "browser_timeout", "browser_failed", "source_timeout", "douyin_browser_timeout", "douyin_resolve_failed", "douyin_fetch"}:
        return SourceDownloadError("SOURCE_NETWORK_FAILED", "获取视频时网络或抖音服务暂时异常，请稍后重试。")
    if code in {"restricted", "douyin_blocked", "douyin_restricted", "douyin_browser_required", "douyin_unavailable", "douyin_access_restricted", "douyin_login_required", "douyin_verification_required"}:
        return SourceDownloadError("DOUYIN_ACCESS_REJECTED", "抖音公开页面暂未提供可验证原片，可能存在访问限制或验证码，请稍后重试或上传本地视频。")
    if code == "douyin_not_found":
        return SourceDownloadError("SOURCE_UNAVAILABLE", "原视频不存在、已删除或不可访问，请确认链接或上传本地视频。")
    if code in {"duration", "too_large"}:
        return SourceDownloadError("SOURCE_UNAVAILABLE", "原视频须不超过 1 GiB，且时长在 60 分钟以内；可上传符合上传限制的本地视频继续。")
    return SourceDownloadError("SOURCE_DOWNLOAD_FAILED", "未能获取完整且身份一致的原片，请确认链接后重试或上传本地视频。")


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

    uses_cookie_snapshots = True

    def __init__(
        self,
        factory: Callable[[Mapping[str, Any]], Any] | None = None,
        *,
        cookies_from_browser: str = "",
        cookie_file: str = "",
        ffmpeg_location: str = "",
        ffprobe_location: str = "ffprobe",
        organization_cookie_only: bool = False,
        media_inspector=None,
        cancelled=None,
    ) -> None:
        if factory is None:
            try:
                from .douyin_share import create_public_video_downloader
            except ImportError as error:
                raise RuntimeError("yt-dlp is required for public video links") from error
            factory = create_public_video_downloader
        self._factory = factory
        self._cookies_from_browser = parse_browser_cookie_spec(cookies_from_browser)
        self._cookie_file = Path(cookie_file).expanduser().resolve() if cookie_file else None
        self._ffmpeg_location = ffmpeg_location.strip()
        self._ffprobe_location = ffprobe_location
        self._organization_cookie_only = organization_cookie_only
        self._media_inspector = media_inspector
        self._cancelled = cancelled
        self._progress = None

    def set_progress(self, callback) -> None:
        self._progress = callback

    def _check_cancelled(self):
        if self._cancelled is not None and self._cancelled():
            raise SourceDownloadError("SOURCE_CANCELLED", "视频采集已取消。")

    @staticmethod
    def _limit_failure():
        return SourceDownloadError("SOURCE_UNAVAILABLE", "原视频须不超过 1 GiB，且时长在 60 分钟以内；请使用符合限制的素材。")

    def download(self, url: str, destination: Path, *, cookie_file: Path | None = None) -> AcquiredSource:
        self._check_cancelled()
        if self._organization_cookie_only:
            # A strict organization resolver never falls back to configured host
            # files, a browser profile or an unauthenticated request.
            if cookie_file is None or not cookie_file.is_file() or not cookie_file.stat().st_size:
                raise SourceDownloadError("SOURCE_COOKIE_REQUIRED", "当前公司尚未提供抖音 Cookie，请先上传 Cookie，再重试 Cookie 采集。")
            destination = Path(destination)
            destination.parent.mkdir(parents=True, exist_ok=True)
            with TemporaryDirectory(prefix=".cookie-source-", dir=destination.parent.resolve()) as temporary:
                folder = Path(temporary)
                result = self._download(url, folder / "source", cookie_file, folder / "cookies.txt")
                path = Path(result.path)
                if path.is_symlink() or not path.is_file() or not path.resolve().is_relative_to(folder.resolve()):
                    raise SourceDownloadError("SOURCE_DOWNLOAD_FAILED", "Cookie 采集未取得当前任务的有效原片。")
                if not 0 < path.stat().st_size <= MAX_MEDIA_BYTES:
                    raise self._limit_failure()
                try:
                    if self._media_inspector is not None:
                        probe = self._media_inspector(path)
                    else:
                        from .douyin_collector.python.media import inspect_video
                        from .douyin_collector.python.runtime import media_tools
                        with media_tools(self._ffmpeg_location or "ffmpeg", self._ffprobe_location):
                            probe = inspect_video(path)
                except SourceDownloadError:
                    raise
                except Exception as error:
                    code = getattr(error, "code", None)
                    if code in {"duration", "too_large"}:
                        raise self._limit_failure() from None
                    if code == "cancelled":
                        raise SourceDownloadError("SOURCE_CANCELLED", "视频采集已取消。") from None
                    raise SourceDownloadError("SOURCE_DOWNLOAD_FAILED", "Cookie 原片校验未完成，请检查媒体工具与视频文件后重试。") from None
                duration = probe.get("duration") if isinstance(probe, Mapping) else None
                if (not isinstance(duration, (int, float)) or isinstance(duration, bool)
                        or not math.isfinite(duration) or not 0 < duration <= MAX_DURATION_SECONDS):
                    raise self._limit_failure()
                if not probe.get("video"):
                    raise SourceDownloadError("SOURCE_DOWNLOAD_FAILED", "Cookie 采集未取得有效视频轨，不能作为原片分析。")
                self._check_cancelled()
                path.replace(destination)
                return AcquiredSource(destination, replace(result.metadata, duration_sec=_integer(duration)))
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
            "max_filesize": MAX_MEDIA_BYTES,
            "socket_timeout": 30,
            "retries": 2,
        }
        limit_failure = None
        if self._organization_cookie_only:
            def check_metadata(info, *, incomplete=False):
                nonlocal limit_failure
                self._check_cancelled()
                duration = info.get("duration")
                size = info.get("filesize") or info.get("filesize_approx")
                if ((isinstance(duration, (int, float)) and not isinstance(duration, bool)
                     and (not math.isfinite(duration) or duration <= 0 or duration > MAX_DURATION_SECONDS))
                        or (isinstance(size, (int, float)) and not isinstance(size, bool) and size > MAX_MEDIA_BYTES)):
                    limit_failure = self._limit_failure()
                    raise limit_failure
                return None
            def progress(event):
                nonlocal limit_failure
                self._check_cancelled()
                received = event.get("downloaded_bytes")
                if isinstance(received, (int, float)) and received > MAX_MEDIA_BYTES:
                    limit_failure = self._limit_failure()
                    raise limit_failure
                if callable(self._progress):
                    self._progress({"phase": "browser", "downloaded_bytes": received}
                                   if type(received) is int and received >= 0 else {"phase": "browser"})
            options.update(match_filter=check_metadata, progress_hooks=[progress])
        if self._ffmpeg_location:
            options["ffmpeg_location"] = self._ffmpeg_location
        cookie_file_available = cookie_file is not None and cookie_file.is_file()
        attempts: list[tuple[str, dict[str, Any]]] = []
        if cookie_file_available:
            attempts.append(("cookie_file", {"cookiefile": str(scratch_cookie)}))
        if not self._organization_cookie_only and self._cookies_from_browser is not None:
            attempts.append(("browser", {"cookiesfrombrowser": self._cookies_from_browser}))
        if not attempts and self._organization_cookie_only:
            raise SourceDownloadError("SOURCE_COOKIE_REQUIRED", "当前公司尚未提供抖音 Cookie，请先上传 Cookie，再重试 Cookie 采集。")
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
                        scratch_cookie.chmod(0o600)
                    self._check_cancelled()
                    with self._factory({**options, **authentication_options, "logger": diagnostics}) as downloader:
                        info = downloader.extract_info(url, download=True)
                    if limit_failure is not None:
                        raise limit_failure
                    break
                except Exception as error:
                    info = None
                    failure = (error if isinstance(error, SourceDownloadError) else
                               limit_failure or diagnostics.failure or classify_source_message(str(error)))
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
                    if self._organization_cookie_only:
                        raise failure from None
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
