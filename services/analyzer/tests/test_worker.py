import unittest
import urllib.error
from dataclasses import replace
from unittest.mock import patch

from liming_analyzer.__main__ import build_lazy_processor
from liming_analyzer.api_client import AnalysisResult, AnalyzerApiError, ClaimedJob
from liming_analyzer.worker import classify_worker_error, process_once, run_forever


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
        self.job = ClaimedJob(
            "job-1", "org-1", "project-1", "video-1", "url", "queued", 1, 2, {}
        )

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

    def test_failures_are_classified_into_actionable_codes(self):
        self.assertEqual(
            classify_worker_error(RuntimeError("Fresh cookies are needed"))[0],
            "DOUYIN_COOKIE_EXPIRED",
        )
        self.assertEqual(
            classify_worker_error(RuntimeError("ffmpeg failed"))[0],
            "MEDIA_PROCESSING_FAILED",
        )
        self.assertEqual(
            classify_worker_error(RuntimeError("429 rate limit"))[0],
            "MODEL_RATE_LIMITED",
        )
        self.assertEqual(
            classify_worker_error(
                RuntimeError("The output is incomplete due to a max_tokens length limit.")
            )[0],
            "MODEL_OUTPUT_LIMIT",
        )
        self.assertEqual(
            classify_worker_error(
                RuntimeError("1 validation error for Report Invalid JSON: expected comma")
            )[0],
            "MODEL_OUTPUT_INVALID",
        )

    def test_success_submits_completion_once(self):
        client = FakeClient(self.job)
        self.assertTrue(
            process_once(client, lambda *_: AnalysisResult("analysis.v1", {"summary": "ok"}))
        )
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

        run_forever(
            ReconnectingClient(None),
            lambda *_: AnalysisResult("analysis.v1", {}),
            idle_seconds=0,
            stop=lambda: calls >= 2,
        )
        self.assertEqual(calls, 2)

    def test_worker_survives_windows_connection_reset(self):
        calls = 0

        class ReconnectingClient(FakeClient):
            def claim(self):
                nonlocal calls
                calls += 1
                if calls == 1:
                    raise ConnectionResetError(10054, "connection reset")

        run_forever(
            ReconnectingClient(None),
            lambda *_: AnalysisResult("analysis.v1", {}),
            idle_seconds=0,
            stop=lambda: calls >= 2,
        )
        self.assertEqual(calls, 2)

    def test_worker_retries_transient_api_failures(self):
        calls = 0

        class ReconnectingClient(FakeClient):
            def claim(self):
                nonlocal calls
                calls += 1
                if calls == 1:
                    raise AnalyzerApiError(503, "API_ERROR", "server restarting")

        run_forever(
            ReconnectingClient(None),
            lambda *_: AnalysisResult("analysis.v1", {}),
            idle_seconds=0,
            stop=lambda: calls >= 2,
        )
        self.assertEqual(calls, 2)

    def test_worker_does_not_hide_authentication_failure(self):
        class UnauthorizedClient(FakeClient):
            def claim(self):
                raise AnalyzerApiError(401, "UNAUTHORIZED", "bad token")

        with self.assertRaises(AnalyzerApiError):
            run_forever(
                UnauthorizedClient(None),
                lambda *_: AnalysisResult("analysis.v1", {}),
                idle_seconds=0,
            )

    def test_lazy_processor_heartbeats_before_loading_models(self):
        heartbeat_calls = []
        processed_versions = []

        class Pipeline:
            def process(self, job, _heartbeat):
                processed_versions.append(job.version)
                return AnalysisResult("analysis.v1", {})

        def heartbeat(status, progress, stage):
            heartbeat_calls.append((status, progress, stage))
            return ClaimedJob(
                self.job.id,
                self.job.organization_id,
                self.job.project_id,
                self.job.video_id,
                self.job.source_type,
                status,
                progress,
                self.job.version + 1,
                self.job.source,
            )

        with patch("liming_analyzer.__main__.build_pipeline", return_value=Pipeline()) as builder:
            processor = build_lazy_processor(object(), FakeClient(None))
            processor(self.job, heartbeat)

        builder.assert_called_once()
        self.assertEqual(
            heartbeat_calls[0],
            ("downloading", 2, "正在初始化本地分析模型（首次使用可能需要下载）"),
        )
        self.assertEqual(processed_versions, [self.job.version + 1])

    def test_lazy_processor_treats_segment_checkpoint_as_analysis_resume(self):
        heartbeat_calls = []
        processed = []
        resumed = replace(
            self.job,
            progress=82,
            checkpoint_stage="segment_progress",
            checkpoint={"checkpoint_version": 1, "segment_progress": {}},
        )

        class Pipeline:
            def process(self, job, _heartbeat):
                processed.append(job)
                return AnalysisResult("analysis.v1", {})

        def heartbeat(status, progress, stage):
            heartbeat_calls.append((status, progress, stage))
            return replace(resumed, status=status, progress=progress, version=resumed.version + 1)

        with patch("liming_analyzer.__main__.build_pipeline", return_value=Pipeline()):
            processor = build_lazy_processor(object(), FakeClient(None))
            processor(resumed, heartbeat)

        self.assertEqual(
            heartbeat_calls[0],
            ("analyzing", 82, "正在初始化本地分析模型（首次使用可能需要下载）"),
        )
        self.assertEqual(processed[0].checkpoint_stage, "segment_progress")

if __name__ == "__main__":
    unittest.main()
