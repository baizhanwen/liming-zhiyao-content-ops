"""Real HTTP worker and Windows processing tree; synthetic media/models only."""
from __future__ import annotations

import json
import os
import sys
import time
import urllib.error
from datetime import datetime, timezone
from functools import partial
from pathlib import Path
from urllib.parse import urlsplit

from liming_analyzer.api_client import AnalysisResult, AnalyzerApiClient, _urllib_transport
from liming_analyzer.process_runtime import IsolatedProcessor, ProcessingLimits
from liming_analyzer.source_errors import SourceDownloadError
from liming_analyzer.worker import run_forever


def fixture_factory(_settings, _client, _monitor, *, jobs):
    def processor(job, heartbeat):
        heartbeat("downloading", 5, "隔离测试下载")
        if job.id == jobs[1]:
            raise SourceDownloadError("SOURCE_NETWORK_FAILED", "隔离测试注入下载超时")
        heartbeat("processing", 15, "隔离测试媒体")
        heartbeat("transcribing", 30, "隔离测试原生推理")
        if job.id == jobs[3]:
            os._exit(17)
        if job.id in {jobs[2], jobs[4], jobs[5]}:
            while True:
                time.sleep(1)
        heartbeat("extracting", 60, "隔离测试证据")
        heartbeat("analyzing", 90, "隔离测试模型")
        if job.id == jobs[6]:
            while True:
                time.sleep(1)
        return AnalysisResult(schema_version="analysis.v7", confidence=90, report={"fixture": True, "analysis_meta": {"quality_audit": {"status": "passed", "acceptance_passed": True, "completion_status": "complete"}}})
    return processor


def main() -> None:
    config = json.load(sys.stdin)
    jobs = config["jobIds"]
    expected_jobs = set(jobs)
    assert len(expected_jobs) == 50
    records, processed, completed_keys, recovery_times = [], [], [], []
    dropped_claim = dropped_completion = dropped_heartbeat = dropped_control = cancelled = False
    deadline = time.monotonic() + 110
    failures = {jobs[1]: "SOURCE_NETWORK_FAILED", jobs[2]: "ANALYZER_STAGE_TIMEOUT", jobs[3]: "ANALYZER_PROCESS_CRASHED", jobs[5]: "WORKER_PROCESSING_FAILED", jobs[6]: "ANALYZER_STAGE_TIMEOUT"}

    def transport(method, url, headers, body):
        nonlocal dropped_claim, dropped_completion, dropped_heartbeat, dropped_control, cancelled
        route = urlsplit(url).path
        if route.endswith("/claim") and not dropped_claim:
            dropped_claim = True
            raise ConnectionResetError("injected pre-claim connection reset")
        if route.endswith(f"/{jobs[5]}/control") and not dropped_control:
            dropped_control = True
            raise ConnectionResetError("injected in-flight connection reset")
        started = time.monotonic()
        status, reply = _urllib_transport(method, url, headers, body)
        records.append({"scenario": "真实 Python 隔离处理故障恢复", "method": method, "route": route, "status": status, "ms": round((time.monotonic() - started) * 1000)})
        if route.endswith(f"/{jobs[4]}/heartbeat") and json.loads(body)["status"] == "transcribing" and not cancelled:
            cancel_route = f"/api/analysis-jobs/{jobs[4]}/cancel"
            code, _ = _urllib_transport("POST", config["origin"].rstrip("/") + cancel_route, {"Cookie": config["cancelCookie"], "Content-Type": "application/json"}, b"{}")
            assert code == 200
            cancelled = True
            records.append({"scenario": "处理中取消", "method": "POST", "route": cancel_route, "status": code, "ms": 0})
        if route.endswith(f"/{jobs[7]}/heartbeat") and status == 200 and not dropped_heartbeat:
            dropped_heartbeat = True
            raise ConnectionResetError("injected lost heartbeat acknowledgement")
        if route.endswith("/complete"):
            completed_keys.append(json.loads(body)["resultKey"])
            if status == 200 and not dropped_completion:
                dropped_completion = True
                raise urllib.error.URLError("injected lost completion response")
        return status, reply

    def stopped():
        if time.monotonic() > deadline:
            raise TimeoutError("Python worker did not finish fixture queue")
        return len(processed) >= len(expected_jobs)

    client = AnalyzerApiClient(config["origin"], config["token"], "runtime-python", transport=transport, browser_auth_probe=lambda: {"status": "logged_in", "browser": "synthetic-fixture", "checkedAt": datetime.now(timezone.utc).isoformat()})
    limits = ProcessingLimits(initialization=15, evidence=0.6, model=0.6, poll=0.05)
    with IsolatedProcessor(None, client, root=Path(config["workspace"]), limits=limits, factory=partial(fixture_factory, jobs=jobs)) as isolated:
        def processor(job, heartbeat):
            processed.append(job.id)
            started = time.monotonic()
            try:
                return isolated(job, heartbeat)
            finally:
                if job.id in failures or job.id == jobs[4]:
                    elapsed = time.monotonic() - started
                    recovery_times.append({"jobId": job.id, "seconds": round(elapsed, 3)})
                    assert isolated.resources_released
                    assert elapsed < 10, "fault did not release local resources within ten seconds"
        run_forever(client, processor, idle_seconds=0.01, stop=stopped)
    assert set(processed) == expected_jobs and len(processed) == 50, "Missing or duplicate processing"
    assert len(completed_keys) == 45 and len(set(completed_keys)) == 44, "Lost ACK must reuse the same result key"
    assert dropped_claim and dropped_completion and dropped_heartbeat and dropped_control and cancelled
    print(json.dumps({"processed": processed, "requests": records, "failures": failures, "recoveryTimes": recovery_times, "lostAckRecovered": True, "lostHeartbeatRecovered": True, "claimDisconnectRecovered": True, "cancelledJobId": jobs[4]}))


if __name__ == "__main__":
    main()