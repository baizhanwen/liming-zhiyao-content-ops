import json
import tempfile
import unittest
import urllib.error
from pathlib import Path
from unittest.mock import patch

from liming_analyzer.adapters import SourceMetadata
from liming_analyzer.api_client import (
    AnalysisResult,
    AnalyzerApiClient,
    AnalyzerApiError,
    ClaimedJob,
)


class FakeTransport:
    def __init__(self, responses):
        self.responses = list(responses)
        self.requests = []

    def __call__(self, method, url, headers, body):
        self.requests.append((method, url, headers, json.loads(body)))
        status, payload = self.responses.pop(0)
        return status, b"" if payload is None else json.dumps(payload).encode()


class ApiClientTests(unittest.TestCase):
    def test_empty_queue_returns_none_and_sends_service_token(self):
        transport = FakeTransport([(204, None)])
        client = AnalyzerApiClient("https://example.test", "secret", "worker-01", transport)
        self.assertIsNone(client.claim())
        self.assertEqual(transport.requests[0][2]["Authorization"], "Bearer secret")

    def test_claim_preserves_analysis_profile(self):
        transport = FakeTransport([(200, {"job": {
            "id": "job-1", "organization_id": "org-1", "project_id": "project-1", "video_id": "video-1",
            "source_type": "url", "status": "queued", "progress": 1, "version": 2, "source": {},
            "analysis_profile": "deep",
        }})])
        client = AnalyzerApiClient("https://example.test", "secret", "worker-01", transport)
        job = client.claim()
        self.assertIsNotNone(job)
        self.assertEqual(job.analysis_profile, "deep")

    def test_heartbeat_carries_version_and_returns_next_version(self):
        transport = FakeTransport([(200, {"job": {"status": "processing", "progress": 20, "version": 4}})])
        client = AnalyzerApiClient("https://example.test", "secret", "worker-01", transport)
        job = ClaimedJob("job-1", "org-1", "project-1", "video-1", "url", "queued", 1, 3, {})
        updated = client.heartbeat(job, "processing", 20, "规范化媒体")
        self.assertEqual(updated.version, 4)
        self.assertEqual(transport.requests[0][3]["version"], 3)

    def test_checkpoint_uses_current_lease_version_and_claim_restores_it(self):
        checkpoint = {"checkpoint_version": 1, "transcript": {"segments": []}}
        transport = FakeTransport([
            (201, {"checkpoint": {"stage": "evidence_ready"}}),
            (200, {"job": {
                "id": "job-1", "organization_id": "org-1", "project_id": "project-1", "video_id": "video-1",
                "source_type": "url", "status": "queued", "progress": 82, "version": 4, "source": {},
                "checkpoint_stage": "evidence_ready", "checkpoint": checkpoint, "resume_count": 1,
            }}),
        ])
        client = AnalyzerApiClient("https://example.test", "secret", "worker-01", transport)
        current = ClaimedJob("job-1", "org-1", "project-1", "video-1", "url", "extracting", 70, 3, {})
        client.save_checkpoint(current, "evidence_ready", checkpoint)
        restored = client.claim()
        self.assertEqual(transport.requests[0][1], "https://example.test/api/internal/analysis-jobs/job-1/checkpoint")
        self.assertEqual(transport.requests[0][3]["version"], 3)
        self.assertEqual(restored.checkpoint_stage, "evidence_ready")
        self.assertEqual(restored.resume_count, 1)
        self.assertEqual(restored.checkpoint["checkpoint_version"], 1)

    def test_completion_uses_result_key_for_idempotency(self):
        transport = FakeTransport([(200, {"job": {"status": "completed"}, "idempotent": False})])
        client = AnalyzerApiClient("https://example.test", "secret", "worker-01", transport)
        job = ClaimedJob("job-1", "org-1", "project-1", "video-1", "upload", "analyzing", 90, 8, {})
        result = AnalysisResult(
            "analysis.v1",
            {"summary": "ok"},
            90,
            source_metadata=SourceMetadata(platform_work_id="work-1", plays=1000),
        )
        client.complete(job, "result:job-1:12345678", result)
        self.assertEqual(transport.requests[0][3]["resultKey"], "result:job-1:12345678")
        self.assertEqual(transport.requests[0][3]["analysis"]["schemaVersion"], "analysis.v1")
        self.assertEqual(transport.requests[0][3]["sourceMetadata"]["metrics"]["plays"], 1000)

    def test_artifact_upload_uses_binary_body_and_job_lease_headers(self):
        requests = []

        def transport(method, url, headers, body):
            requests.append((method, url, headers, body))
            return 201, json.dumps({"asset": {"id": "asset-1"}}).encode()

        client = AnalyzerApiClient("https://example.test", "secret", "worker-01", transport)
        job = ClaimedJob("job-1", "org-1", "project-1", "video-1", "upload", "extracting", 70, 8, {})
        with tempfile.TemporaryDirectory() as temporary:
            artifact = Path(temporary) / "frame.jpg"
            artifact.write_bytes(b"jpeg")
            result = client.upload_artifact(
                job,
                kind="keyframe",
                path=artifact,
                content_type="image/jpeg",
                timestamp_ms=500,
                confidence=90,
            )
        self.assertEqual(result["id"], "asset-1")
        self.assertEqual(requests[0][2]["X-Job-Version"], "8")
        self.assertEqual(requests[0][2]["X-Artifact-Timestamp-Ms"], "500")
        self.assertEqual(requests[0][3], b"jpeg")

    def test_structured_api_errors_are_exposed(self):
        transport = FakeTransport([(409, {"error": {"code": "LEASE_EXPIRED", "message": "expired"}})])
        client = AnalyzerApiClient("https://example.test", "secret", "worker-01", transport)
        with self.assertRaisesRegex(AnalyzerApiError, "LEASE_EXPIRED"):
            client.claim()

    def test_uploaded_source_uses_worker_lease_endpoint_and_streams_to_file(self):
        class Stream:
            def __init__(self):
                self.headers = {"Content-Length": "5"}

            def __enter__(self):
                return self

            def __exit__(self, *_):
                return False

            def read(self, _size):
                chunk, self.chunk = getattr(self, "chunk", b"media"), b""
                return chunk

        client = AnalyzerApiClient("https://example.test", "secret", "worker-01")
        job = ClaimedJob("job-1", "org-1", "project-1", "video-1", "upload", "queued", 1, 3, {})
        with tempfile.TemporaryDirectory() as temporary, patch("liming_analyzer.api_client.urllib.request.urlopen", return_value=Stream()) as opener:
            destination = Path(temporary) / "source.bin"
            self.assertEqual(client.download_upload_source(job, destination).read_bytes(), b"media")
        request = opener.call_args.args[0]
        self.assertEqual(request.get_header("Authorization"), "Bearer secret")
        self.assertEqual(request.get_header("X-worker-id"), "worker-01")

    def test_cookie_snapshot_uses_worker_lease_endpoint_and_replaces_local_file(self):
        class Stream:
            def __init__(self):
                self.headers = {"Content-Length": "28"}

            def __enter__(self):
                return self

            def __exit__(self, *_):
                return False

            def read(self, _size):
                chunk, self.chunk = getattr(self, "chunk", b"# Netscape HTTP Cookie File\n"), b""
                return chunk

        client = AnalyzerApiClient("https://example.test", "secret", "worker-01")
        job = ClaimedJob("job-1", "org-1", "project-1", "video-1", "url", "queued", 1, 3, {})
        with tempfile.TemporaryDirectory() as temporary, patch("liming_analyzer.api_client.urllib.request.urlopen", return_value=Stream()) as opener:
            destination = Path(temporary) / "cookies.txt"
            self.assertTrue(client.download_cookie_snapshot(job, destination))
            self.assertIn(b"Netscape", destination.read_bytes())
        request = opener.call_args.args[0]
        self.assertTrue(request.full_url.endswith("/api/internal/analysis-jobs/job-1/cookies"))
        self.assertEqual(request.get_header("X-worker-id"), "worker-01")

    def test_missing_cookie_snapshot_removes_stale_local_file(self):
        client = AnalyzerApiClient("https://example.test", "secret", "worker-01")
        job = ClaimedJob("job-1", "org-1", "project-1", "video-1", "url", "queued", 1, 3, {})
        missing = urllib.error.HTTPError("https://example.test/cookies", 404, "Not Found", {}, None)
        with tempfile.TemporaryDirectory() as temporary, patch("liming_analyzer.api_client.urllib.request.urlopen", side_effect=missing):
            destination = Path(temporary) / "cookies.txt"
            destination.write_text("stale cookie", encoding="utf-8")
            self.assertFalse(client.download_cookie_snapshot(job, destination))
            self.assertFalse(destination.exists())


if __name__ == "__main__":
    unittest.main()
