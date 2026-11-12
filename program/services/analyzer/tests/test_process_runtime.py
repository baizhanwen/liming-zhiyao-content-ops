import os
import tempfile
import time
import unittest
from dataclasses import replace
from pathlib import Path
from unittest.mock import patch

from liming_analyzer.api_client import AnalysisResult, AnalyzerApiError, ClaimedJob
from liming_analyzer.process_runtime import IsolatedProcessor, ProcessingFailure, ProcessingLimits, _processing_source_stamp


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

    def test_changed_source_restarts_only_at_next_task_boundary_and_cleans_old_workspace(self):
        with patch("liming_analyzer.process_runtime._processing_source_stamp", return_value="old") as stamp:
            first = self.run_job("ok")
            old_workspace = self.processor.workspace
            second_job = replace(self.job, id="updated-during-task")

            def heartbeat(status, progress, _stage):
                stamp.return_value = "new"
                self.assertTrue(old_workspace.is_dir())
                return replace(second_job, status=status, progress=progress)

            second = self.processor(second_job, heartbeat)
            self.assertEqual(second.report["pid"], first.report["pid"])
            self.assertEqual(second.report["completed"], 2)
            third = self.run_job("after-update")
            self.assertNotEqual(third.report["pid"], first.report["pid"])
            self.assertEqual(third.report["completed"], 1)
            self.assertFalse(old_workspace.exists())
            new_workspace = self.processor.workspace
            fourth = self.run_job("same-version")
            self.assertEqual(fourth.report["pid"], third.report["pid"])
            self.assertEqual(self.processor.workspace, new_workspace)
            self.assertEqual(stamp.call_count, 4)

    def test_shared_contract_change_restarts_idle_child_then_reuses_new_version(self):
        root = Path(self.temporary.name)
        source = root / "process_runtime.py"
        source.write_text("source", encoding="utf-8")
        resources = root / "resources"
        resources.mkdir()
        contract = resources / "content-report-contract.v1.json"
        contract.write_text('{"limit":1}', encoding="utf-8")
        with patch("liming_analyzer.process_runtime.__file__", str(source)):
            first = self.run_job("old-contract")
            old_workspace = self.processor.workspace
            contract.write_text('{"limit":2}', encoding="utf-8")
            second = self.run_job("new-contract")
            self.assertNotEqual(first.report["pid"], second.report["pid"])
            self.assertFalse(old_workspace.exists())
            third = self.run_job("same-contract")
            self.assertEqual(second.report["pid"], third.report["pid"])
            self.assertEqual(third.report["completed"], 2)

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


class ProcessingSourceStampTests(unittest.TestCase):
    def test_actual_source_contents_and_membership_change_the_stamp(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            module = root / "process_runtime.py"
            module.write_text("old", encoding="utf-8")
            with patch("liming_analyzer.process_runtime.__file__", str(module)):
                first = _processing_source_stamp()
                before = module.stat()
                module.write_text("new", encoding="utf-8")
                os.utime(module, ns=(before.st_atime_ns, before.st_mtime_ns))
                changed = _processing_source_stamp()
                self.assertNotEqual(changed, first)
                (root / "helper.py").write_text("helper", encoding="utf-8")
                added = _processing_source_stamp()
                self.assertNotEqual(added, changed)
                (root / "helper.py").unlink()
                self.assertEqual(_processing_source_stamp(), changed)
                (root / "model.bin").write_bytes(b"unrelated cached model")
                self.assertEqual(_processing_source_stamp(), changed)
                resources = root / "resources"
                resources.mkdir()
                contract = resources / "content-report-contract.v1.json"
                contract.write_text('{"limit":1}', encoding="utf-8")
                with_resource = _processing_source_stamp()
                self.assertNotEqual(with_resource, changed)
                previous = contract.stat()
                contract.write_text('{"limit":2}', encoding="utf-8")
                os.utime(contract, ns=(previous.st_atime_ns, previous.st_mtime_ns))
                self.assertNotEqual(_processing_source_stamp(), with_resource)
                contract.unlink()
                self.assertEqual(_processing_source_stamp(), changed)


if __name__ == "__main__":
    unittest.main()
