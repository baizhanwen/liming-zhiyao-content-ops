"""Retirement codes carry process health without carrying source secrets."""
from liming_analyzer.processing_health import (
    processor_retirement_reasons,
    request_processor_retirement,
    reset_processor_health,
)


def test_retirement_is_bounded_deduplicated_and_reset_at_task_boundary():
    reset_processor_health()
    request_processor_retirement("capture_stdin_close")
    request_processor_retirement("capture_stdin_close")
    assert processor_retirement_reasons() == ("capture_stdin_close",)
    for index in range(100):
        request_processor_retirement(f"cleanup_{index}")
    assert len(processor_retirement_reasons()) == 16
    reset_processor_health()
    assert processor_retirement_reasons() == ()


def test_retirement_rejects_non_diagnostic_values():
    reset_processor_health()
    request_processor_retirement("https://private.invalid/path?token=secret")
    assert processor_retirement_reasons() == ("resource_cleanup_unconfirmed",)
    reset_processor_health()
