"""Safe progress facts cross the isolated child boundary, separate from liveness."""
import json
import os
import tempfile
from contextlib import nullcontext
from dataclasses import replace
from unittest.mock import patch

from liming_analyzer.api_client import AnalysisResult, ClaimedJob
from liming_analyzer.process_runtime import IsolatedProcessor, ProcessingLimits, _child_main


def job(name="test-job"):
    return ClaimedJob(name, "test-org", "test-project", "test-video", "url", "queued", 1, 2, {})


class ChildConnection:
    def __init__(self, replies):
        self.replies = iter(replies)
        self.sent = []
        self.closed = False

    def recv(self):
        return next(self.replies)

    def send(self, message):
        self.sent.append(message)

    def close(self):
        self.closed = True


def test_child_sends_only_safe_facts_and_resets_observations_for_each_task():
    first, second = job(), job("second-job")
    connection = ChildConnection(["attached", ("run", first), ("ok", first), ("run", second), ("ok", second), ("stop", None)])

    def factory(_settings, _client, _monitor):
        def process(current, heartbeat):
            if current.id == first.id:
                heartbeat.observe({"phase": "browser", "requests": 2, "url": "https://private.invalid", "headers": {"Authorization": "synthetic-private"}})
            else:
                heartbeat.observe({"phase": [], "detail": "synthetic-private"})
            heartbeat("downloading", 8, "Synthetic stage")
            return AnalysisResult("analysis.v1", {})
        return process

    with tempfile.TemporaryDirectory() as folder, patch("liming_analyzer.process_runtime.InstanceLock", return_value=nullcontext()), patch("liming_analyzer.process_runtime.prepare_processing_child", create=True), patch.object(tempfile, "tempdir", tempfile.tempdir):
        _child_main(connection, None, folder, folder, factory, os.getpid())
    messages = [value for kind, value in connection.sent if kind == "heartbeat"]
    assert messages[0] == ("downloading", 8, "Synthetic stage", {"phase": "browser", "metrics": {"requests": 2}})
    assert messages[1] == ("downloading", 8, "Synthetic stage", None)
    assert "private" not in json.dumps(messages)
    assert connection.closed


def test_owner_forwards_whitelisted_observations_before_heartbeat_and_accepts_legacy_messages():
    current = job()

    class Client:
        def check_control(self, _job):
            return {"version": current.version}

    for payload in [
        ("downloading", 8, "Synthetic stage", {"phase": "browser", "requests": 3, "headers": {"Authorization": "synthetic-private"}}),
        ("downloading", 8, "Synthetic stage"),
    ]:
        class OwnerConnection(ChildConnection):
            def poll(self, _seconds):
                return True

        connection = OwnerConnection([("heartbeat", payload), ("result", AnalysisResult("analysis.v1", {}))])
        observed = []
        heartbeats = []

        def heartbeat(status, progress, stage):
            heartbeats.append((status, progress, stage, list(observed)))
            return replace(current, status=status, progress=progress)

        heartbeat.observe = observed.append
        with tempfile.TemporaryDirectory() as folder:
            processor = IsolatedProcessor(None, Client(), root=folder, limits=ProcessingLimits(poll=0.01))
            processor.process = object()  # Existing child, so no process or model is started.
            processor.connection = connection
            assert processor(current, heartbeat).schema_version == "analysis.v1"
        if len(payload) == 4:
            assert observed == [{"phase": "browser", "requests": 3}]
            assert heartbeats[0][3] == observed
        else:
            assert observed == []
        assert processor.resources_released


def observed_factory(_settings, _client, _monitor):
    def process(current, heartbeat):
        if current.id == "first-job":
            heartbeat.observe({"phase": "browser", "requests": 4, "url": "https://private.invalid"})
        heartbeat("downloading", 8, "Synthetic stage")
        return AnalysisResult("analysis.v1", {})
    return process


def test_real_isolated_child_forwards_facts_and_reuses_no_previous_task_observation():
    class Client:
        def check_control(self, current):
            return {"version": current.version}

    with tempfile.TemporaryDirectory() as folder, IsolatedProcessor(None, Client(), root=folder, factory=observed_factory) as processor:
        facts = []
        for name in ("first-job", "second-job"):
            current = job(name)

            def heartbeat(status, progress, _stage):
                return replace(current, status=status, progress=progress)

            heartbeat.observe = facts.append
            assert processor(current, heartbeat).schema_version == "analysis.v1"
            assert processor.resources_released
        assert facts == [{"phase": "browser", "requests": 4}]
