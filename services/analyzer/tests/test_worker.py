import unittest
import urllib.error

from liming_analyzer.api_client import AnalysisResult, ClaimedJob
from liming_analyzer.worker import process_once, run_forever


class FakeClient:
    def __init__(self, job):
        self.job = job
        self.completed = 0
        self.failed = 0

    def claim(self):
        return self.job

    def heartbeat(self, job, status, progress, stage):
        return job

    def complete(self, job, result_key, result):
        self.completed += 1

    def fail(self, job, result_key, error_code, error_message, stage, progress):
        self.failed += 1


class WorkerTests(unittest.TestCase):
    def setUp(self):
        self.job = ClaimedJob("job-1", "org-1", "project-1", "video-1", "url", "queued", 1, 2, {})

    def test_empty_queue_does_no_work(self):
        client = FakeClient(None)
        self.assertFalse(process_once(client, lambda *_: AnalysisResult("analysis.v1", {})))
        self.assertEqual(client.completed, 0)

    def test_processor_failure_reports_failed_job(self):
        client = FakeClient(self.job)

        def processor(*_):
            raise RuntimeError("bad media")

        self.assertTrue(process_once(client, processor))
        self.assertEqual(client.failed, 1)
        self.assertEqual(client.completed, 0)

    def test_success_submits_completion_once(self):
        client = FakeClient(self.job)
        self.assertTrue(process_once(client, lambda *_: AnalysisResult("analysis.v1", {"summary": "ok"})))
        self.assertEqual(client.completed, 1)
        self.assertEqual(client.failed, 0)

    def test_worker_survives_a_temporary_web_server_restart(self):
        calls = 0

        class ReconnectingClient(FakeClient):
            def claim(self):
                nonlocal calls
                calls += 1
                if calls == 1:
                    raise urllib.error.URLError("server restarting")
                return None

        run_forever(ReconnectingClient(None), lambda *_: AnalysisResult("analysis.v1", {}), idle_seconds=0, stop=lambda: calls >= 2)
        self.assertEqual(calls, 2)


if __name__ == "__main__":
    unittest.main()
