from __future__ import annotations

import logging
import time
import urllib.error
import uuid
from collections.abc import Callable

from .api_client import AnalysisResult, AnalyzerApiClient, AnalyzerApiError, ClaimedJob, Processor
from .source_errors import SourceDownloadError

logger = logging.getLogger(__name__)

class ProcessingFailure(RuntimeError):
    """Safe classified failure transported from an isolated processing child."""
    def __init__(self, code: str, message: str):
        super().__init__(message)
        self.code = code


def _is_transient_api_error(error: AnalyzerApiError) -> bool:
    if error.code in {"STORAGE_QUOTA_EXCEEDED", "ANALYSIS_QUOTA_EXCEEDED", "CAPACITY_UNAVAILABLE", "INVALID_MEDIA_SIZE"}:
        return False
    return error.status in {408, 425, 429} or error.status >= 500 or error.code == "INVALID_RESPONSE"


def classify_worker_error(error: Exception) -> tuple[str, str]:
    if isinstance(error, AnalyzerApiError) and error.code in {
        "STORAGE_QUOTA_EXCEEDED", "ANALYSIS_QUOTA_EXCEEDED", "CAPACITY_UNAVAILABLE", "INVALID_MEDIA_SIZE",
        "MEDIA_UPLOAD_STATUS_UNKNOWN", "MEDIA_UPLOAD_CLEANUP_PENDING",
    }:
        return error.code, str(error)
    if isinstance(error, ProcessingFailure):
        return error.code, str(error)
    if isinstance(error, SourceDownloadError):
        return error.code, str(error)
    message = str(error).strip() or "分析失败"
    lowered = message.lower()
    if "cookie" in lowered:
        return "DOUYIN_COOKIE_EXPIRED", message
    if any(value in lowered for value in ("yt-dlp", "download", "http error", "source media")):
        return "SOURCE_DOWNLOAD_FAILED", message
    if any(value in lowered for value in ("ffmpeg", "ffprobe", "codec", "media processing")):
        return "MEDIA_PROCESSING_FAILED", message
    if any(value in lowered for value in ("funasr", "transcript", "speech recognition")):
        return "TRANSCRIPTION_FAILED", message
    if any(value in lowered for value in ("paddle", "ocr", "keyframe", "scene")):
        return "VISUAL_EXTRACTION_FAILED", message
    if any(value in lowered for value in ("context length", "maximum context", "token limit")):
        return "MODEL_CONTEXT_LIMIT", message
    if "max_tokens" in lowered or "output is incomplete" in lowered or "length limit" in lowered:
        return "MODEL_OUTPUT_LIMIT", "模型报告超过当前模式的输出长度，已启用压缩输出；请从证据检查点继续。"
    if "invalid json" in lowered or "json_invalid" in lowered or ("validation error" in lowered and any(name in lowered for name in ("report", "scriptrewritebatch", "restructure"))):
        return "MODEL_OUTPUT_INVALID", "模型报告格式不完整，已启用 JSON 恢复；请从证据检查点继续。"
    if any(value in lowered for value in ("429", "rate limit", "too many requests")):
        return "MODEL_RATE_LIMITED", message
    if "model report did not preserve exact source evidence" in lowered:
        return "MODEL_EVIDENCE_MISMATCH", "模型引用格式未通过追溯校验，请从证据检查点继续。"
    if "analysis source did not contain usable" in lowered:
        return "MODEL_EVIDENCE_UNAVAILABLE", "转写与画面中没有可用于追溯的有效证据。"
    if any(value in lowered for value in ("deepseek", "openai", "api call", "model report")):
        return "MODEL_REQUEST_FAILED", message
    return "WORKER_PROCESSING_FAILED", message


def process_once(client: AnalyzerApiClient, processor: Processor) -> bool:
    job = client.claim()
    if job is None:
        return False
    try:
        return _process_claimed(client, processor, job)
    finally:
        if job.attempt_count and getattr(processor, "resources_released", True):
            try:
                client.release_cancelled(job)
            except (AnalyzerApiError, OSError):
                # A lost cancellation acknowledgement keeps the execution slot
                # reserved only until lease expiry, never forever.
                logger.warning("Could not acknowledge released resources: job=%s", job.id)


def _process_claimed(client: AnalyzerApiClient, processor: Processor, job: ClaimedJob) -> bool:
    current = job
    logger.info("Analysis task claimed: job=%s source=%s", job.id, job.source_type)

    def heartbeat(status: str, progress: int, stage: str) -> ClaimedJob:
        nonlocal current
        current = client.heartbeat(current, status, progress, stage)
        return current

    result_key = f"result:{job.id}:{uuid.uuid4().hex}"
    try:
        result: AnalysisResult = processor(job, heartbeat)
    except Exception as error:  # noqa: BLE001 - worker boundary converts failures into job state
        error_code, error_message = classify_worker_error(error)
        logger.warning("Analysis task failed: job=%s code=%s progress=%s", job.id, error_code, current.progress)
        try:
            client.fail(current, result_key, error_code, error_message[:1000], "分析失败", current.progress)
        except AnalyzerApiError as failure_error:
            if failure_error.status != 409:
                raise
        return True
    # Reuse the result key after a lost response: the server may already have
    # committed the report. Do not pay for another model run to recover the ACK.
    for attempt in range(3):
        try:
            client.complete(current, result_key, result)
            logger.info("Analysis result accepted: job=%s", job.id)
            break
        except AnalyzerApiError as error:
            if error.status == 409 or (error.status == 404 and error.code == "JOB_NOT_FOUND"):
                logger.info("Job %s changed before completion; continuing the queue (%s).", job.id, error.code)
                return True
            if not _is_transient_api_error(error) or attempt == 2:
                raise
        except (urllib.error.URLError, OSError):
            if attempt == 2:
                raise
        logger.warning("Retrying completion for job %s with the same result key.", job.id)
        time.sleep(attempt + 1)
    return True


def run_forever(client: AnalyzerApiClient, processor: Processor, idle_seconds: float = 5.0, stop: Callable[[], bool] | None = None) -> None:
    should_stop = stop or (lambda: False)
    while not should_stop():
        try:
            processed = process_once(client, processor)
        except AnalyzerApiError as error:
            if error.status == 409 and error.code in {"JOB_SOURCE_UNAVAILABLE", "JOB_TRANSCRIPT_UNAVAILABLE", "JOB_TRANSCRIPT_INVALID"}:
                # The server has marked this one job failed. Other users' work
                # must not require a worker/model restart.
                logger.warning("Skipping unavailable job (%s).", error.code)
                continue
            if not _is_transient_api_error(error):
                raise
            logger.warning("Analyzer API is temporarily unavailable (%s). Retrying.", error)
            processed = False
        except (urllib.error.URLError, OSError) as error:
            # On Windows a web-server restart commonly surfaces as
            # ConnectionResetError/ConnectionRefusedError, both OSError
            # subclasses rather than urllib.error.URLError. They must not kill
            # the long-running worker.
            logger.warning("Analyzer API connection was interrupted (%s). Retrying.", error)
            processed = False
        if not processed:
            time.sleep(idle_seconds)
