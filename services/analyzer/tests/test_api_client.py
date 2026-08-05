import json
import unittest

from liming_analyzer.api_client import AnalysisResult, AnalyzerApiClient, AnalyzerApiError, ClaimedJob


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

    def test_heartbeat_carries_version_and_returns_next_version(self):
        transport = FakeTransport([(200, {"job": {"status": "processing", "progress": 20, "version": 4}})])
        client = AnalyzerApiClient("https://example.test", "secret", "worker-01", transport)
        job = ClaimedJob("job-1", "org-1", "project-1", "video-1", "url", "queued", 1, 3, {})
        updated = client.heartbeat(job, "processing", 20, "规范化媒体")
        self.assertEqual(updated.version, 4)
        self.assertEqual(transport.requests[0][3]["version"], 3)

    def test_completion_uses_result_key_for_idempotency(self):
        transport = FakeTransport([(200, {"job": {"status": "completed"}, "idempotent": False})])
        client = AnalyzerApiClient("https://example.test", "secret", "worker-01", transport)
        job = ClaimedJob("job-1", "org-1", "project-1", "video-1", "upload", "analyzing", 90, 8, {})
        client.complete(job, "result:job-1:12345678", AnalysisResult("analysis.v1", {"summary": "ok"}, 90))
        self.assertEqual(transport.requests[0][3]["resultKey"], "result:job-1:12345678")
        self.assertEqual(transport.requests[0][3]["analysis"]["schemaVersion"], "analysis.v1")

    def test_structured_api_errors_are_exposed(self):
        transport = FakeTransport([(409, {"error": {"code": "LEASE_EXPIRED", "message": "expired"}})])
        client = AnalyzerApiClient("https://example.test", "secret", "worker-01", transport)
        with self.assertRaisesRegex(AnalyzerApiError, "LEASE_EXPIRED"):
            client.claim()


if __name__ == "__main__":
    unittest.main()
