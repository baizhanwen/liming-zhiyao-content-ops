"""Drive the real Python worker against an isolated runtime, using fake media only."""
from __future__ import annotations

import json
import sys
import time
import urllib.error
from datetime import datetime, timezone
from urllib.parse import urlsplit

from liming_analyzer.api_client import AnalysisResult, AnalyzerApiClient, _urllib_transport
from liming_analyzer.source_errors import SourceDownloadError
from liming_analyzer.worker import run_forever


def main() -> None:
    config = json.load(sys.stdin)
    records = []
    processed = []
    completed_keys = []
    dropped_claim = False
    dropped_completion = False
    deadline = time.monotonic() + 45

    def transport(method, url, headers, body):
        nonlocal dropped_claim, dropped_completion
        route = urlsplit(url).path
        if route.endswith("/claim") and not dropped_claim:
            dropped_claim = True
            raise ConnectionResetError("injected pre-claim connection reset")
        started = time.monotonic()
        status, reply = _urllib_transport(method, url, headers, body)
        records.append({"scenario": "真实 Python Worker 故障恢复", "method": method, "route": route, "status": status, "ms": round((time.monotonic() - started) * 1000)})
        if route.endswith("/complete"):
            completed_keys.append(json.loads(body)["resultKey"])
            if status == 200 and not dropped_completion:
                dropped_completion = True
                # The server accepted the result; only the ACK is lost.
                raise urllib.error.URLError("injected lost completion response")
        return status, reply

    def processor(job, heartbeat):
        processed.append(job.id)
        heartbeat("downloading", 5, "隔离测试下载")
        if job.id == config["failedJobId"]:
            raise SourceDownloadError("SOURCE_NETWORK_FAILED", "隔离测试注入抖音下载超时")
        for status, progress in [("processing", 15), ("transcribing", 30), ("extracting", 60), ("analyzing", 90)]:
            heartbeat(status, progress, "隔离测试进度")
        return AnalysisResult(schema_version="analysis.v7", confidence=90, report={"fixture": True, "analysis_meta": {"quality_audit": {"status": "passed", "acceptance_passed": True, "completion_status": "complete"}}})

    def stopped():
        if time.monotonic() > deadline:
            raise TimeoutError("Python worker did not finish fixture queue")
        return len(processed) == 3

    client = AnalyzerApiClient(config["origin"], config["token"], "runtime-python", transport=transport, browser_auth_probe=lambda: {"status": "logged_in", "browser": "synthetic-fixture", "checkedAt": datetime.now(timezone.utc).isoformat()})
    run_forever(client, processor, idle_seconds=0.01, stop=stopped)
    assert len(set(processed)) == 3, "A failed item or lost ACK caused duplicate processing"
    assert len(completed_keys) == 3 and len(set(completed_keys)) == 2, "Lost ACK must reuse the same result key"
    assert dropped_claim and dropped_completion
    print(json.dumps({"processed": processed, "requests": records, "lostAckRecovered": True, "claimDisconnectRecovered": True}))


if __name__ == "__main__":
    main()
