"""Bounded control connectivity recovery without weakening execution fencing."""
import os
import time
from dataclasses import replace
from datetime import datetime, timedelta, timezone
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

import pytest

from liming_analyzer.api_client import AnalysisResult, AnalyzerApiError, ClaimedJob
from liming_analyzer.process_runtime import IsolatedProcessor, ProcessingLimits
from liming_analyzer.worker import ProcessingFailure


def control_fixture(_settings, _client, monitor):
    def process(job, heartbeat):
        monitor("phase", "artifacts")
        heartbeat("processing", 22, "synthetic original persistence")
        (Path(job.source["root"]) / job.id).touch()
        time.sleep(job.source.get("work_seconds", .045))
        return AnalysisResult("analysis.v1", {"pid": os.getpid(), "synthetic": True})
    return process


class Control:
    def __init__(self, root):
        self.root = root
        self.calls = 0
        self.behavior = "healthy"
        self.fields = True
        self.lease_seconds = 30
        self.failure = TimeoutError("timed out")
        self.unhealthy_calls = 0
        self.fail_initial = False

    def check_control(self, job):
        self.calls += 1
        active = (self.root / job.id).exists()
        if self.fail_initial:
            raise self.failure
        if active and self.behavior != "healthy":
            self.unhealthy_calls += 1
            if self.behavior == "recover" and self.unhealthy_calls > 5:
                self.behavior = "healthy"
            elif self.behavior == "revoke_after_result" and self.unhealthy_calls > 5:
                raise AnalyzerApiError(409, "JOB_EXECUTION_REVOKED", "cancelled")
            else:
                raise self.failure
        value = {"version": job.version, "status": job.status, "progress": job.progress}
        if self.fields:
            value.update(attempt=job.attempt_count,
                         leaseExpiresAt=(datetime.now(timezone.utc)+timedelta(seconds=self.lease_seconds)).isoformat())
        return value


@pytest.fixture
def guarded(tmp_path):
    client = Control(tmp_path)
    limits = ProcessingLimits(initialization=5, artifacts=2, task=3, poll=.01)
    processor = IsolatedProcessor(None, client, root=tmp_path, limits=limits, factory=control_fixture)
    with patch("liming_analyzer.process_runtime._CONTROL_RECOVERY_SECONDS", .18), patch(
            "liming_analyzer.process_runtime._CONTROL_LEASE_MARGIN_SECONDS", .02):
        try:
            yield client, processor
        finally:
            processor.close()


def run(processor, root, name, *, work_seconds=.045):
    job = ClaimedJob(name, "org", "project", "video", "url", "queued", 1, 1,
                     {"root": str(root), "work_seconds": work_seconds}, attempt_count=1)
    return processor(job, lambda status, progress, _stage: replace(job, status=status, progress=progress))


@pytest.mark.skipif(os.name not in {"nt", "posix"}, reason="native process guard")
def test_one_control_outage_recovers_and_reuses_same_child(guarded, tmp_path):
    client, processor = guarded
    first = run(processor, tmp_path, "healthy")
    client.behavior = "recover"
    result = run(processor, tmp_path, "recover", work_seconds=.025)
    assert client.unhealthy_calls > 5
    assert result.report["pid"] == first.report["pid"]
    assert processor.resources_released is True
    assert run(processor, tmp_path, "next").report["pid"] == first.report["pid"]


@pytest.mark.skipif(os.name not in {"nt", "posix"}, reason="native process guard")
@pytest.mark.parametrize("failure", [TimeoutError("timed out"), AnalyzerApiError(503, "CONTROL_CHECK_TIMEOUT", "synthetic")])
def test_continuous_outage_rejects_pending_result_and_recovers_next_task(guarded, tmp_path, failure):
    client, processor = guarded
    first = run(processor, tmp_path, "healthy")
    client.behavior = "outage"
    client.failure = failure
    began = time.monotonic()
    with pytest.raises(ProcessingFailure) as caught:
        run(processor, tmp_path, "pending-result", work_seconds=.025)
    assert caught.value.code == "ANALYZER_CONTROL_UNAVAILABLE"
    assert .12 <= time.monotonic()-began < .55
    assert processor.process is None and processor.resources_released
    client.behavior = "healthy"
    assert run(processor, tmp_path, "recovered").report["pid"] != first.report["pid"]


@pytest.mark.skipif(os.name not in {"nt", "posix"}, reason="native process guard")
def test_revocation_while_result_pending_is_never_accepted(guarded, tmp_path):
    client, processor = guarded
    run(processor, tmp_path, "healthy")
    client.behavior = "revoke_after_result"
    with pytest.raises(AnalyzerApiError) as caught:
        run(processor, tmp_path, "revoked-pending", work_seconds=.025)
    assert caught.value.code == "JOB_EXECUTION_REVOKED"
    assert processor.process is None and processor.resources_released


@pytest.mark.skipif(os.name not in {"nt", "posix"}, reason="native process guard")
@pytest.mark.parametrize("status", [401, 403, 404, 409])
def test_explicit_access_denial_never_gets_grace(guarded, tmp_path, status):
    client, processor = guarded
    run(processor, tmp_path, "healthy")
    client.failure = AnalyzerApiError(status, "JOB_EXECUTION_REVOKED", "synthetic")
    client.behavior = "outage"
    with pytest.raises(AnalyzerApiError) as caught:
        run(processor, tmp_path, f"denied-{status}", work_seconds=.2)
    assert caught.value.status == status
    assert client.unhealthy_calls == 1
    assert processor.process is None


@pytest.mark.skipif(os.name not in {"nt", "posix"}, reason="native process guard")
def test_old_protocol_and_initial_unconfirmed_failure_stop_immediately(guarded, tmp_path):
    client, processor = guarded
    run(processor, tmp_path, "healthy")
    client.fail_initial = True
    with pytest.raises(ProcessingFailure) as caught:
        run(processor, tmp_path, "initial-unconfirmed")
    assert caught.value.code == "ANALYZER_CONTROL_UNAVAILABLE"
    client.fail_initial = False
    client.fields = False
    run(processor, tmp_path, "legacy-healthy")
    client.behavior = "outage"
    with pytest.raises(ProcessingFailure) as caught:
        run(processor, tmp_path, "legacy-outage", work_seconds=.2)
    assert caught.value.code == "ANALYZER_CONTROL_UNAVAILABLE"
    assert client.unhealthy_calls == 1


@pytest.mark.skipif(os.name not in {"nt", "posix"}, reason="native process guard")
def test_confirmed_lease_caps_recovery_window(guarded, tmp_path):
    client, processor = guarded
    run(processor, tmp_path, "healthy")
    client.lease_seconds = .09
    client.behavior = "outage"
    began = time.monotonic()
    with pytest.raises(ProcessingFailure) as caught:
        run(processor, tmp_path, "short-lease", work_seconds=.3)
    assert caught.value.code == "ANALYZER_CONTROL_UNAVAILABLE"
    assert time.monotonic()-began < .15
    assert processor.process is None


@pytest.mark.skipif(os.name not in {"nt", "posix"}, reason="native process guard")
@pytest.mark.parametrize("limit,code", [("artifacts", "ANALYZER_STAGE_TIMEOUT"), ("task", "ANALYZER_TASK_TIMEOUT")])
def test_watchdog_budgets_continue_during_control_outage(guarded, tmp_path, limit, code):
    client, processor = guarded
    run(processor, tmp_path, "healthy")
    client.behavior = "outage"
    processor.limits = replace(processor.limits, **{limit: .065})
    with pytest.raises(ProcessingFailure) as caught:
        run(processor, tmp_path, f"deadline-{limit}", work_seconds=.5)
    assert caught.value.code == code
    assert processor.process is None


@pytest.mark.parametrize("limit,code", [("artifacts", "ANALYZER_STAGE_TIMEOUT"), ("task", "ANALYZER_TASK_TIMEOUT")])
def test_slow_successful_reconfirmation_cannot_deliver_result_after_deadline(tmp_path, limit, code):
    # This deterministic owner/pipe fixture makes the result arrive during a
    # control outage, then has a successful GET cross an existing deadline.
    # The returned 200 must not exempt a pending result from the watchdog.
    clock = [100.0]
    job = ClaimedJob("delayed-confirmation", "org", "project", "video", "url", "queued", 1, 1, {}, attempt_count=1)
    messages = iter([("phase", "artifacts"), ("result", AnalysisResult("analysis.v1", {}))])
    class Client:
        calls = 0
        def check_control(self, _job):
            self.calls += 1
            if self.calls == 2:
                raise TimeoutError("synthetic interrupted request")
            if self.calls == 3:
                clock[0] += .2
            return {"version": 1, "attempt": 1,
                    "leaseExpiresAt": (datetime.now(timezone.utc)+timedelta(seconds=30)).isoformat()}
    def poll(_timeout):
        clock[0] += .01
        return True
    limits = ProcessingLimits(initialization=5, artifacts=1, task=1, poll=.01)
    limits = replace(limits, **{limit: .1})
    owner = IsolatedProcessor(None, Client(), root=tmp_path, limits=limits)
    owner.process = SimpleNamespace(is_alive=lambda: True)
    owner.connection = SimpleNamespace(send=lambda _value: None, poll=poll, recv=lambda: next(messages))
    owner._source_stamp = "fixture"
    def close():
        owner.process = None
        owner.resources_released = True
    owner.close = close
    with patch("liming_analyzer.process_runtime._processing_source_stamp", return_value="fixture"), patch(
            "liming_analyzer.process_runtime.time.monotonic", side_effect=lambda: clock[0]):
        with pytest.raises(ProcessingFailure) as caught:
            owner(job, lambda *_args: job)
    assert caught.value.code == code
    assert owner.process is None and owner.resources_released
