from __future__ import annotations

import time
import urllib.error
import uuid
from collections.abc import Callable

from .api_client import AnalysisResult, AnalyzerApiClient, ClaimedJob, Processor


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
        client.fail(current, result_key, "WORKER_PROCESSING_FAILED", str(error)[:1000] or "analysis failed", "分析失败", current.progress)
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
