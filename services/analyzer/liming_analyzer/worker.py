from __future__ import annotations

import time
import urllib.error
import uuid
from collections.abc import Callable

from .api_client import AnalysisResult, AnalyzerApiClient, AnalyzerApiError, ClaimedJob, Processor


def classify_worker_error(error: Exception) -> tuple[str, str]:
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
    if any(value in lowered for value in ("429", "rate limit", "too many requests")):
        return "MODEL_RATE_LIMITED", message
    if any(value in lowered for value in ("deepseek", "openai", "api call", "model report")):
        return "MODEL_REQUEST_FAILED", message
    return "WORKER_PROCESSING_FAILED", message


def process_once(client: AnalyzerApiClient, processor: Processor) -> bool:
    job = client.claim()
    if job is None:
        return False
    current = job

    def heartbeat(status: str, progress: int, stage: str) -> ClaimedJob:
        nonlocal current
        current = client.heartbeat(current, status, progress, stage)
        return current

    result_key = f"result:{job.id}:{uuid.uuid4().hex}"
    try:
        result: AnalysisResult = processor(job, heartbeat)
    except Exception as error:  # noqa: BLE001 - worker boundary converts failures into job state
        error_code, error_message = classify_worker_error(error)
        try:
            client.fail(current, result_key, error_code, error_message[:1000], "分析失败", current.progress)
        except AnalyzerApiError as failure_error:
            if failure_error.status != 409:
                raise
        return True
    # Transport or lease errors during completion must remain retryable; they are not
    # evidence that media analysis itself failed.
    client.complete(current, result_key, result)
    return True


def run_forever(client: AnalyzerApiClient, processor: Processor, idle_seconds: float = 5.0, stop: Callable[[], bool] | None = None) -> None:
    should_stop = stop or (lambda: False)
    while not should_stop():
        try:
            processed = process_once(client, processor)
        except urllib.error.URLError:
            processed = False
        if not processed:
            time.sleep(idle_seconds)
