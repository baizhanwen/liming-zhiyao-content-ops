import os
import tempfile
import time
import unittest
from dataclasses import replace
from pathlib import Path
from unittest.mock import patch

from liming_analyzer.api_client import AnalysisResult, AnalyzerApiError, ClaimedJob
from liming_analyzer.process_runtime import IsolatedProcessor, ProcessingFailure, ProcessingLimits


def fake_factory(_settings, _client, monitor):
    completed = 0
    def processor(job, heartbeat):
        nonlocal completed
        heartbeat("transcribing", 40, "synthetic evidence")
        if job.id == "crash":
            os._exit(17)
        if job.id in {"hang", "cancel"}:
            while True:
                time.sleep(1)
        if job.id == "long":
            monitor("duration", 610)
            time.sleep(0.3)
        completed += 1
        return AnalysisResult("analysis.v7", {"pid": os.getpid(), "completed": completed})
    return processor


class ControlClient:
    def __init__(self):
        self.cancel_at = None

    def check_control(self, job):
        if job.id == "cancel" and self.cancel_at and time.monotonic() >= self.cancel_at:
            raise AnalyzerApiError(409, "JOB_EXECUTION_REVOKED", "cancelled")
        return {"version": job.version}


@unittest.skipUnless(os.name == "nt", "Windows process isolation")
class ProcessRuntimeTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.client = ControlClient()
        self.limits = ProcessingLimits(initialization=5, evidence=0.2, poll=0.02)
        self.processor = IsolatedProcessor(None, self.client, root=Path(self.temporary.name), limits=self.limits, factory=fake_factory)
        self.addCleanup(self.processor.close)
        self.job = ClaimedJob("ok", "org", "project", "video", "url", "queued", 1, 1, {})

    def run_job(self, name):
        job = replace(self.job, id=name)
        return self.processor(job, lambda status, progress, _stage: replace(job, status=status, progress=progress))

    def test_healthy_process_and_loaded_models_are_reused(self):
        first = self.run_job("ok")
        second = self.run_job("ok-2")
        self.assertEqual(first.report["pid"], second.report["pid"])
        self.assertEqual(second.report["completed"], 2)

    def test_uninterruptible_stage_times_out_then_next_job_runs(self):
        self.run_job("ok")
        started = time.monotonic()
        with self.assertRaises(ProcessingFailure) as caught:
            self.run_job("hang")
        self.assertEqual(caught.exception.code, "ANALYZER_STAGE_TIMEOUT")
        self.assertLess(time.monotonic() - started, 5)
        self.assertEqual(self.run_job("next").report["completed"], 1)

    def test_cancel_releases_processing_resources_then_next_job_runs(self):
        self.run_job("ok")
        self.processor.limits = replace(self.limits, evidence=10)
        self.client.cancel_at = time.monotonic() + 0.15
        started = time.monotonic()
        with self.assertRaises(AnalyzerApiError) as caught:
            self.run_job("cancel")
        self.assertEqual(caught.exception.code, "JOB_EXECUTION_REVOKED")
        self.assertLess(time.monotonic() - started, 5)
        self.assertEqual(self.run_job("next").report["completed"], 1)

    def test_native_process_crash_does_not_poison_next_job(self):
        with self.assertRaises(ProcessingFailure) as caught:
            self.run_job("crash")
        self.assertEqual(caught.exception.code, "ANALYZER_PROCESS_CRASHED")
        self.assertEqual(self.run_job("next").report["completed"], 1)

    def test_broken_pipe_on_task_send_releases_resources_and_recovers(self):
        self.run_job("ok")
        with patch.object(self.processor.connection, "send", side_effect=OSError(109, "pipe ended")):
            with self.assertRaises(ProcessingFailure) as caught:
                self.run_job("next")
        self.assertEqual(caught.exception.code, "ANALYZER_PROCESS_CRASHED")
        self.assertTrue(self.processor.resources_released)
        self.assertEqual(self.run_job("recovered").report["completed"], 1)

    def test_broken_pipe_on_heartbeat_ack_is_classified_as_process_crash(self):
        self.run_job("ok")
        send = self.processor.connection.send
        def injected_send(value):
            if isinstance(value, tuple) and value[0] == "ok":
                raise OSError(109, "pipe ended")
            return send(value)
        with patch.object(self.processor.connection, "send", side_effect=injected_send):
            with self.assertRaises(ProcessingFailure) as caught:
                self.run_job("next")
        self.assertEqual(caught.exception.code, "ANALYZER_PROCESS_CRASHED")
        self.assertTrue(self.processor.resources_released)
        self.assertEqual(self.run_job("recovered").report["completed"], 1)

    def test_long_media_gets_finite_additional_budget(self):
        self.assertEqual(self.run_job("long").report["completed"], 1)
        self.assertLess(self.limits.stage_seconds("evidence", 86400, "max"), 20000)

    def test_task_deadline_remains_bounded_across_stages(self):
        self.run_job("ok")
        self.processor.limits = replace(self.limits, task=0.1, evidence=10)
        with self.assertRaises(ProcessingFailure) as caught:
            self.run_job("hang")
        self.assertEqual(caught.exception.code, "ANALYZER_TASK_TIMEOUT")

    def test_restart_cleans_only_marked_orphan_workspaces(self):
        work = Path(self.temporary.name) / ".local" / "analyzer-work"
        orphan = work / "processor-old"
        unmarked = work / "processor-user-files"
        orphan.mkdir(parents=True)
        unmarked.mkdir()
        (orphan / ".analyzer-owned").write_text("v1", encoding="ascii")
        (orphan / "media.bin").write_bytes(b"temporary media")
        (unmarked / "keep.txt").write_text("keep", encoding="ascii")
        self.run_job("ok")
        deadline = time.monotonic() + 3
        while orphan.exists() and time.monotonic() < deadline:
            time.sleep(0.02)
        self.assertFalse(orphan.exists())
        self.assertTrue((unmarked / "keep.txt").is_file())
        self.assertTrue(self.processor.workspace.is_dir())


if __name__ == "__main__":
    unittest.main()
