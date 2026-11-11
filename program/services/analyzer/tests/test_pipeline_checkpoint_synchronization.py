"""Deterministic heartbeat/checkpoint interleavings, with no HTTP/model calls."""
import threading
import time
from copy import deepcopy
from dataclasses import replace
from pathlib import Path
from types import SimpleNamespace

import pytest

from liming_analyzer.adapters import MediaInfo, NormalizedMedia, TranscriptOutput, VisualOutput
from liming_analyzer.api_client import AnalyzerApiError, ClaimedJob
from liming_analyzer.pipeline import AnalysisPipeline


def job_with(checkpoint=None):
    return ClaimedJob("synchronization-fixture", "org", "project", "video", "upload", "analyzing", 84, 1, {}, checkpoint=checkpoint)


def run_structure(structure, checkpoints, heartbeat, *, job=None):
    pipeline = AnalysisPipeline(None, None, None, None, structure, checkpoints=checkpoints, heartbeat_seconds=.01)
    media = NormalizedMedia(Path("unused"), None, MediaInfo(1000, None, None, None, None))
    return pipeline._run_structure(job or job_with(), media, TranscriptOutput("zh-CN", ()), VisualOutput(), None, heartbeat, 88, "test stage")


def test_checkpoint_waits_for_committed_heartbeat_ack_and_uses_its_new_version():
    entered = threading.Event()
    server_version = [1]
    observed_versions = []
    expected = object()

    class Structure:
        def set_unified_checkpoint(self, callback):
            self.callback = callback

        def analyze(self, *_args):
            assert entered.wait(2)
            self.callback({"canonical": {"status": "completed"}, "modules": {}})
            return expected

    def heartbeat(_status, _progress, _stage):
        server_version[0] += 1  # Server committed; caller still has version 1.
        entered.set()
        time.sleep(.15)  # Longer than the former 50ms guess-and-retry window.
        return replace(job_with(), version=server_version[0])

    def save(job, _stage, _checkpoint):
        observed_versions.append(job.version)
        if job.version != server_version[0]:
            raise AnalyzerApiError(409, "JOB_VERSION_CONFLICT", "synthetic stale version")

    current, value = run_structure(Structure(), SimpleNamespace(save=save), heartbeat)
    assert value is expected
    assert observed_versions == [2]
    assert current.version == 2


def test_genuine_lost_lease_is_not_retried_or_hidden_by_version_synchronization():
    attempts = []
    reached_after_save = []

    class Structure:
        def set_unified_checkpoint(self, callback):
            self.callback = callback

        def analyze(self, *_args):
            self.callback({"modules": {}})
            reached_after_save.append(True)

    def save(job, *_args):
        attempts.append(job.version)
        raise AnalyzerApiError(409, "LEASE_NOT_OWNED", "synthetic lost lease")

    with pytest.raises(AnalyzerApiError, match="LEASE_NOT_OWNED"):
        run_structure(Structure(), SimpleNamespace(save=save), lambda *_args: job_with())
    assert attempts == [1]
    assert reached_after_save == []


@pytest.mark.parametrize("keys,expected", [(["visual"], ["visual"]),
                                           (["canonical", "visual", "visual"], ["canonical", "visual"]),
                                           (["untrusted-module"], None), ([True], None), ("visual", None)])
def test_each_success_checkpoint_keeps_only_validated_retry_selection(keys, expected):
    snapshots = []

    class Structure:
        def set_unified_checkpoint(self, callback):
            self.callback = callback

        def analyze(self, *_args):
            self.callback({"modules": {}})
            self.callback({"modules": {"visual": {"status": "completed"}}})
            return "complete"

    def save(_job, _stage, checkpoint):
        snapshots.append(checkpoint)

    run_structure(Structure(), SimpleNamespace(save=save), lambda *_args: job_with(),
                  job=job_with({"retry_module_keys": keys, "unrelated_untrusted_payload": {"must_not": "persist"}}))
    assert len(snapshots) == 2
    assert all(row.get("retry_module_keys") == expected for row in snapshots)
    assert all("unrelated_untrusted_payload" not in row for row in snapshots)


def test_worker_resume_cannot_spend_on_a_module_outside_the_saved_retry_selection():
    from test_content_provider_integration import inputs
    from test_unified_analysis import OfflineSdk, run_unified

    from liming_analyzer.content_analysis import MODULES
    from liming_analyzer.pipeline import _evidence_checkpoint

    _report, _sdk, _ledger, initial, _job, analyzer = run_unified(sdk=OfflineSdk(failures={
        "content_classification:" + MODULES[0]: ["overloaded"],
        "content_classification:visual": ["timeout"],
    }))
    media, transcript, visuals = inputs()
    selected = {**_evidence_checkpoint(media, transcript, visuals, None),
                "unified_progress": initial[-1], "retry_module_keys": ["visual"]}
    snapshots = []
    store = SimpleNamespace(save=lambda _job, _stage, value: snapshots.append(deepcopy(value)))
    pipeline = AnalysisPipeline(None, None, None, None, analyzer, checkpoints=store)

    def continue_worker(checkpoint):
        current = replace(job_with(checkpoint), analysis_profile="max", checkpoint_stage="evidence_ready")
        return pipeline._run_structure(current, media, transcript, visuals, None, lambda *_args: current, 88, "resume")[1]

    first_sdk = OfflineSdk()
    analyzer.client = first_sdk
    first = continue_worker(selected)
    assert [row["task"] for row in first_sdk.calls] == ["content_classification:visual"]
    assert first.report["unified_report"]["status"] == "partial"
    assert snapshots[-1]["retry_module_keys"] == ["visual"]

    # A restarted worker resumes directly from the durable checkpoint; no new
    # UI request is available to reconstruct the previous user's selection.
    resumed_sdk = OfflineSdk()
    analyzer.client = resumed_sdk
    resumed = continue_worker(snapshots[-1])
    assert resumed_sdk.calls == []
    assert resumed.report["unified_report"]["status"] == "partial"
    deferred = next(row for row in resumed.report["unified_report"]["sections"] if row["key"] == MODULES[0])
    assert deferred["reason"] == "not_requested"
