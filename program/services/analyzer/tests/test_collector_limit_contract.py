"""New intake budgets must reach acquisition and durable source persistence."""
import json
import hashlib
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from unittest.mock import patch

import pytest

from liming_analyzer.api_client import AnalyzerApiClient, ClaimedJob, _SourceUploadBody
from liming_analyzer.douyin_collector.python.limits import BROWSER_TIMEOUT_SECONDS, DOWNLOAD_TIMEOUT_SECONDS
from liming_analyzer.process_runtime import ProcessingLimits
from liming_analyzer.sources import SkillCollectPublicVideoResolver, _collector_failure


def test_parent_budget_allows_both_static_and_browser_phase_budgets():
    assert ProcessingLimits().download >= DOWNLOAD_TIMEOUT_SECONDS + BROWSER_TIMEOUT_SECONDS + 180
    assert SkillCollectPublicVideoResolver(collector=lambda *_a, **_k: None)._browser_timeout == 900
    for code in ("duration", "too_large"):
        failure = _collector_failure(code)
        assert "60 分钟" in str(failure) and "1 GiB" in str(failure)


def test_explicit_shorter_parent_download_timeout_is_respected(monkeypatch):
    monkeypatch.setenv("ANALYZER_TIMEOUT_DOWNLOAD_SECONDS", "60")
    assert ProcessingLimits.from_environment().download == 60


def test_source_upload_has_explicit_length_and_bounded_reads(tmp_path):
    source = tmp_path / "source.mp4"
    payload = b"synthetic-chunk" * 150_000
    source.write_bytes(payload)
    seen = {}

    class Response:
        status = 201

        def __enter__(self):
            return self

        def __exit__(self, *_args):
            return False

        def read(self):
            return json.dumps({"asset": {"id": "streamed-source"}}).encode()

    def upload(request, **_kwargs):
        seen["length"] = request.get_header("Content-length")
        seen["attempt"] = request.get_header("X-worker-attempt")
        seen["data"] = bytearray()
        reads = []
        while chunk := request.data.read(20 * 1024 * 1024):
            reads.append(len(chunk))
            seen["data"].extend(chunk)
        assert len(reads) > 1 and max(reads) <= 1024 * 1024
        return Response()

    client = AnalyzerApiClient("http://localhost", "synthetic-token", "worker")
    job = ClaimedJob("job", "org", "project", "video", "url", "processing", 18, 4, {}, attempt_count=2)
    with patch.object(Path, "read_bytes", side_effect=AssertionError("whole-file allocation forbidden")), patch(
        "liming_analyzer.api_client.urllib.request.urlopen", side_effect=upload
    ):
        result = client.upload_artifact(job, kind="source_video", path=source, content_type="video/mp4")
    assert result["id"] == "streamed-source"
    assert seen["data"] == payload
    assert seen["length"] == str(len(payload)) and seen["attempt"] == "2"


def test_truncated_source_upload_does_not_silently_finish(tmp_path):
    source = tmp_path / "truncated.mp4"
    source.write_bytes(b"short")
    with source.open("rb") as stream:
        body = _SourceUploadBody(stream, 10)
        assert body.read(0) == b""
        assert body.read() == b"short"
        with pytest.raises(OSError, match="declared length"):
            body.read()


def test_source_upload_streams_through_real_http_without_chunked_encoding(tmp_path):
    source = tmp_path / "original.mp4"
    source.write_bytes(b"synthetic-original" * 100_000)
    expected = hashlib.sha256(b"synthetic-original" * 100_000).hexdigest()
    received = {}

    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *_args):
            pass

        def do_POST(self):
            length = int(self.headers["Content-Length"])
            received.update(length=length, transfer_encoding=self.headers.get("Transfer-Encoding"),
                            attempt=self.headers.get("X-Worker-Attempt"))
            digest, remaining = hashlib.sha256(), length
            while remaining:
                chunk = self.rfile.read(min(remaining, 64 * 1024))
                if not chunk:
                    break
                digest.update(chunk)
                remaining -= len(chunk)
            received.update(sha256=digest.hexdigest(), remaining=remaining)
            data = json.dumps({"asset": {"id": "streamed-original", "sha256": digest.hexdigest()}}).encode()
            self.send_response(201)
            self.send_header("Content-Length", str(len(data)))
            self.end_headers()
            self.wfile.write(data)

    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        client = AnalyzerApiClient(f"http://127.0.0.1:{server.server_port}", "synthetic", "worker")
        job = ClaimedJob("job", "org", "project", "video", "url", "processing", 18, 4, {}, attempt_count=2)
        with patch.object(Path, "read_bytes", side_effect=AssertionError("whole-file allocation forbidden")):
            result = client.upload_artifact(job, kind="source_video", path=source, content_type="video/mp4")
        assert result["sha256"] == expected
        assert received == {"length": source.stat().st_size, "transfer_encoding": None,
                            "attempt": "2", "sha256": expected, "remaining": 0}
    finally:
        server.shutdown()
        server.server_close()
        thread.join(timeout=2)
