from __future__ import annotations

import re
from pathlib import Path

_DIAGNOSTIC_STAGES = frozenset({
    "prepare_destination", "collector", "collect_media", "validate_media", "source_validation",
    "source_metadata", "write_provenance", "publish_source", "publish_provenance",
    "sync_media", "publish_media", "set_permissions",
    "cleanup_media", "cleanup_source",
})
_PACKAGE_ROOT = Path(__file__).resolve().parent


def safe_source_diagnostic(error: Exception, stage: str) -> dict:
    """Keep code locations and OS error numbers without exception text or locals."""
    diagnostic = {"stage": stage if isinstance(stage, str) and stage in _DIAGNOSTIC_STAGES else "collector", "errors": []}
    seen: set[int] = set()
    current: BaseException | None = error
    while current is not None and id(current) not in seen and len(diagnostic["errors"]) < 8:
        seen.add(id(current))
        row = {"type": type(current).__name__, "stack": []}
        for attribute in ("errno", "winerror"):
            value = getattr(current, attribute, None)
            if type(value) is int:
                row[attribute] = value
        trace = current.__traceback__
        while trace is not None and len(row["stack"]) < 24:
            code = trace.tb_frame.f_code
            try:
                filename = Path(code.co_filename).resolve().relative_to(_PACKAGE_ROOT).as_posix()
            except (OSError, ValueError):
                filename = "<external>"
            # Never format a traceback: source lines and exception messages can
            # embed URLs, credentials, private paths or the customer's content.
            row["stack"].append({"file": filename, "line": trace.tb_lineno,
                                 "function": code.co_name if filename != "<external>" else "<external>"})
            trace = trace.tb_next
        diagnostic["errors"].append(row)
        current = current.__cause__ or (None if current.__suppress_context__ else current.__context__)
    return diagnostic


class SourceDownloadError(RuntimeError):
    """A safe, actionable source error; never includes cookies or raw URLs."""

    def __init__(self, code: str, message: str) -> None:
        super().__init__(message)
        self.code = code


def classify_source_message(message: str) -> SourceDownloadError:
    lowered = message.lower()
    if re.search(r"(?:http(?: error)?|status(?: code)?)[: =]+429\b", lowered) or "too many requests" in lowered:
        return SourceDownloadError("SOURCE_RATE_LIMITED", "抖音暂时限制了下载请求，请稍后重试；这不代表 Cookie 已过期。")
    if any(value in lowered for value in ("timed out", "timeout", "connection reset", "connection refused", "temporary failure", "name resolution", "getaddrinfo failed", "remote end closed")) or re.search(r"(?:http(?: error)?|status(?: code)?)[: =]+5\d\d\b", lowered):
        return SourceDownloadError("SOURCE_NETWORK_FAILED", "获取视频时网络或抖音服务暂时异常，请稍后重试。")
    if re.search(r"(?:http(?: error)?|status(?: code)?)[: =]+404\b", lowered) or "video is unavailable" in lowered:
        return SourceDownloadError("SOURCE_UNAVAILABLE", "原视频不存在、已删除或不可访问，请先确认链接能在浏览器打开。")
    if any(value in lowered for value in ("cookie database", "dpapi", "app-bound", "failed to decrypt", "could not decrypt")):
        return SourceDownloadError("DOUYIN_BROWSER_UNAVAILABLE", "无法读取分析主机浏览器登录态，可能被浏览器占用或受系统保护；请在视频分析页面上传 cookies.txt。")
    if "netscape" in lowered and "cookie" in lowered:
        return SourceDownloadError("DOUYIN_COOKIE_INVALID", "Cookie 文件格式无法读取，请重新导出 Netscape 格式的 cookies.txt。")
    if "fresh cookies" in lowered or any(value in lowered for value in ("login required", "log in", "sign in", "cookies are needed", "cookie file expired", "cookies expired")) or re.search(r"(?:http(?: error)?|status(?: code)?)[: =]+(?:401|403)\b", lowered):
        # yt-dlp also emits "Fresh cookies" when its non-fatal detail request
        # returns no metadata. It is not proof that a login cookie has expired.
        return SourceDownloadError("DOUYIN_ACCESS_REJECTED", "抖音未返回可下载的视频信息，可能是临时访问限制或登录校验，不能据此判定 Cookie 过期。请稍后重试；持续失败时，在浏览器确认视频可访问，再更新 Cookie。")
    return SourceDownloadError("SOURCE_DOWNLOAD_FAILED", "未能获取视频，请确认链接可访问；持续失败时联系管理员查看下载诊断。")
