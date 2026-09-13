import unittest
from unittest.mock import patch

from liming_analyzer.api_client import AnalysisResult, AnalyzerApiError, ClaimedJob
from liming_analyzer.worker import process_once, run_forever


class Client:
    def __init__(self):
        self.job = ClaimedJob("job-1", "org-1", "project-1", "video-1", "url", "queued", 1, 2, {})
        self.claims = 0
        self.completions = []
        self.failures = []

    def claim(self):
        self.claims += 1
        return self.job if self.claims == 1 else None

    def complete(self, job, result_key, result):
        self.completions.append((job, result_key, result))

    def fail(self, *args):
        self.failures.append(args)


class LanWorkerTests(unittest.TestCase):
    def test_cancellation_during_completion_does_not_stop_other_peoples_queue(self):
        class CancelledClient(Client):
            def complete(self, *args):
                raise AnalyzerApiError(409, "INVALID_STATUS_TRANSITION", "cancelled by another member")

        client = CancelledClient()
        run_forever(client, lambda *_: AnalysisResult("analysis.v1", {}), idle_seconds=0, stop=lambda: client.claims == 2)
        self.assertEqual(client.claims, 2)
        self.assertEqual(client.failures, [])

    def test_completion_response_loss_retries_same_result_without_running_model_again(self):
        class DisconnectedClient(Client):
            def complete(self, *args):
                super().complete(*args)
                if len(self.completions) == 1:
                    raise ConnectionResetError("server committed but response was lost")

        client = DisconnectedClient()
        with patch("liming_analyzer.worker.time.sleep"), patch("liming_analyzer.worker.logger.warning"):
            self.assertTrue(process_once(client, lambda *_: AnalysisResult("analysis.v1", {"summary": "ok"})))
        self.assertEqual(len(client.completions), 2)
        self.assertEqual(client.completions[0], client.completions[1])
        self.assertEqual(client.claims, 1)
        self.assertEqual(client.failures, [])

    def test_transient_completion_errors_have_a_bounded_retry_budget(self):
        class UnavailableClient(Client):
            def complete(self, *args):
                super().complete(*args)
                raise AnalyzerApiError(503, "DATABASE_UNAVAILABLE", "restarting")

        client = UnavailableClient()
        with patch("liming_analyzer.worker.time.sleep"), patch("liming_analyzer.worker.logger.warning"):
            with self.assertRaises(AnalyzerApiError):
                process_once(client, lambda *_: AnalysisResult("analysis.v1", {}))
        self.assertEqual(len(client.completions), 3)
        self.assertEqual(len({item[1] for item in client.completions}), 1)
        self.assertEqual(client.failures, [])

    def test_an_unavailable_source_does_not_restart_the_shared_worker(self):
        class MissingSourceClient(Client):
            def claim(self):
                self.claims += 1
                if self.claims == 1:
                    raise AnalyzerApiError(409, "JOB_SOURCE_UNAVAILABLE", "source is missing")
                return None

        client = MissingSourceClient()
        run_forever(client, lambda *_: AnalysisResult("analysis.v1", {}), idle_seconds=0, stop=lambda: client.claims == 2)
        self.assertEqual(client.claims, 2)

    def test_authentication_failure_still_stops_worker(self):
        class UnauthorizedClient(Client):
            def complete(self, *args):
                super().complete(*args)
                raise AnalyzerApiError(401, "SERVICE_AUTH_REQUIRED", "bad token")

        client = UnauthorizedClient()
        with self.assertRaises(AnalyzerApiError):
            process_once(client, lambda *_: AnalysisResult("analysis.v1", {}))
        self.assertEqual(len(client.completions), 1)


if __name__ == "__main__":
    unittest.main()
