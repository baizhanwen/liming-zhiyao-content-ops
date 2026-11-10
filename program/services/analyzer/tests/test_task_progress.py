from liming_analyzer.task_progress import ProgressObservations, safe_observation


def test_observations_never_include_untrusted_text_urls_headers_or_invalid_counts():
    event = {"phase": "browser", "requests": 2, "downloaded_bytes": 8192, "url": "https://private.invalid", "headers": {"Authorization": "synthetic-secret"}, "total": True, "completed": -1, "files_total": 2**53}
    assert safe_observation(event) == {"phase": "browser", "metrics": {"requests": 2, "downloaded_bytes": 8192}}
    assert safe_observation({"phase": []}) is None
    assert safe_observation({"phase": "supplier-private-message"}) is None


def test_observations_are_snapshot_copies_and_invalid_events_leave_latest_fact_unchanged():
    observations = ProgressObservations()
    assert observations.snapshot() is None
    observations.update({"phase": "model_vision", "sampled_frames": 3, "total_frames": 8})
    snapshot = observations.snapshot()
    snapshot["metrics"]["sampled_frames"] = 999
    observations.update({"phase": "invalid", "detail": "private"})
    assert observations.snapshot()["metrics"]["sampled_frames"] == 3


def test_optional_observer_failure_does_not_interrupt_business_operation():
    from liming_analyzer.task_progress import observe

    def heartbeat(*_):
        pass

    def broken_observer(_):
        raise RuntimeError("synthetic telemetry failure")

    heartbeat.observe = broken_observer
    observe(heartbeat, "model_analysis", completed=1, total=2)
