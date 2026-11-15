import unittest
import urllib.error
from dataclasses import replace
from unittest.mock import patch

from liming_analyzer.api_client import AnalysisResult, AnalyzerApiError, ClaimedJob
from liming_analyzer.worker import ProcessingFailure, process_once, run_forever


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
        with patch("liming_analyzer.worker.time.sleep"), patch("liming_analyzer.worker.logger.warning"), self.assertRaises(AnalyzerApiError):
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

        client = MissingSourceClient()
        run_forever(client, lambda *_: AnalysisResult("analysis.v1", {}), idle_seconds=0, stop=lambda: client.claims == 2)
        self.assertEqual(client.claims, 2)

    def test_failure_delivery_recovers_before_write_or_after_commit_and_processes_the_next_job(self):
        for committed_before_disconnect in (False, True):
            with self.subTest(committed_before_disconnect=committed_before_disconnect):
                class InterruptedFailureClient(Client):
                    held = True

                    def claim(self):
                        self.claims += 1
                        if self.claims == 1:
                            return self.job
                        if not self.held:
                            return replace(self.job, id="job-2", video_id="video-2")
                        return None

                    def fail(self, *args, committed=committed_before_disconnect):
                        super().fail(*args)
                        if committed or len(self.failures) > 1:
                            self.held = False
                        if len(self.failures) == 1:
                            raise ConnectionResetError("synthetic failure receipt disconnected")

                client = InterruptedFailureClient()
                processed = []

                def processor(job, _heartbeat, processed=processed):
                    processed.append(job.id)
                    if job.id == "job-1":
                        raise ProcessingFailure("SOURCE_INTERNAL_ERROR", "original collector cleanup error")
                    return AnalysisResult("analysis.v1", {"summary": "next job"})

                with patch("liming_analyzer.worker.time.sleep"), patch("liming_analyzer.worker.logger.warning"):
                    run_forever(client, processor, idle_seconds=0, stop=lambda client=client: client.claims == 2)
                self.assertEqual(processed, ["job-1", "job-2"])
                self.assertEqual(len(client.failures), 2)
                self.assertEqual(client.failures[0], client.failures[1])
                self.assertEqual(client.failures[0][2:4], ("SOURCE_INTERNAL_ERROR", "original collector cleanup error"))
                self.assertEqual(len(client.completions), 1)
                self.assertEqual(client.completions[0][0].id, "job-2")

    def test_transient_failure_delivery_has_three_identical_attempts_and_preserves_original_error(self):
        for interruption in (
            AnalyzerApiError(503, "DATABASE_UNAVAILABLE", "synthetic restarting"),
            AnalyzerApiError(429, "RATE_LIMITED", "synthetic throttling"),
            urllib.error.URLError("synthetic timeout"),
            TimeoutError("synthetic timeout"),
        ):
            with self.subTest(interruption=type(interruption).__name__):
                class InterruptedFailureClient(Client):
                    def fail(self, *args, interruption=interruption):
                        super().fail(*args)
                        raise interruption

                client = InterruptedFailureClient()
                processed = []

                def processor(job, _heartbeat, processed=processed):
                    processed.append(job.id)
                    raise ProcessingFailure("SOURCE_INTERNAL_ERROR", "original collector error")

                with patch("liming_analyzer.worker.time.sleep") as sleep, patch("liming_analyzer.worker.logger.warning"), self.assertRaises(type(interruption)):
                    process_once(client, processor)
                self.assertEqual(processed, ["job-1"])
                self.assertEqual(len(client.failures), 3)
                self.assertTrue(all(attempt == client.failures[0] for attempt in client.failures))
                self.assertEqual(client.failures[0][2:4], ("SOURCE_INTERNAL_ERROR", "original collector error"))
                self.assertEqual([call.args for call in sleep.call_args_list], [(1,), (2,)])
                self.assertEqual(client.completions, [])

    def test_failure_delivery_recovers_from_a_transient_server_error_without_rerunning_processing(self):
        class RestartingClient(Client):
            def fail(self, *args):
                super().fail(*args)
                if len(self.failures) == 1:
                    raise AnalyzerApiError(503, "DATABASE_UNAVAILABLE", "synthetic restarting")

        client = RestartingClient()
        processed = []

        def processor(job, _heartbeat):
            processed.append(job.id)
            raise ProcessingFailure("SOURCE_INTERNAL_ERROR", "original collector error")

        with patch("liming_analyzer.worker.time.sleep"), patch("liming_analyzer.worker.logger.warning"):
            self.assertTrue(process_once(client, processor))
        self.assertEqual(processed, ["job-1"])
        self.assertEqual(client.failures[0], client.failures[1])
        self.assertEqual(len(client.failures), 2)

    def test_failure_delivery_does_not_retry_conflicts_or_nontransient_errors(self):
        for status, code in ((409, "LEASE_NOT_OWNED"), (409, "JOB_VERSION_CONFLICT"),
                             (401, "SERVICE_AUTH_REQUIRED"), (403, "SERVICE_FORBIDDEN"),
                             (400, "INVALID_FAILURE_RESULT"), (429, "ANALYSIS_QUOTA_EXCEEDED")):
            with self.subTest(code=code):
                class RejectedFailureClient(Client):
                    def fail(self, *args, status=status, code=code):
                        super().fail(*args)
                        raise AnalyzerApiError(status, code, "synthetic rejected receipt")

                client = RejectedFailureClient()

                def processor(*_args):
                    raise ProcessingFailure("SOURCE_INTERNAL_ERROR", "original collector error")

                with patch("liming_analyzer.worker.time.sleep") as sleep, patch("liming_analyzer.worker.logger.warning"):
                    if status == 409:
                        self.assertTrue(process_once(client, processor))
                    else:
                        with self.assertRaises(AnalyzerApiError):
                            process_once(client, processor)
                self.assertEqual(len(client.failures), 1)
                self.assertEqual(client.completions, [])
                sleep.assert_not_called()

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
