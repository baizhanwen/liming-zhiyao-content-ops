"""Source preservation and storage bounds must match the JavaScript consumer."""

from types import SimpleNamespace

import pytest

from liming_analyzer.content_analysis import _text, build_evidence_registry
from liming_analyzer.content_report_contract import (
    EVIDENCE_REGISTRY_MAX_ENTRIES,
    REPORT_MAX_UTF16_UNITS,
    utf16_units,
    validate_evidence_storage,
)


def test_dense_sources_retain_whitespace_unicode_and_full_text():
    text = "  会议记录😀\n" + "完整画面原文" * 700 + "\n  "
    media = SimpleNamespace(info=SimpleNamespace(duration_ms=1000))
    transcript = SimpleNamespace(segments=[SimpleNamespace(start_ms=0, end_ms=1000, text=text)])
    visuals = SimpleNamespace(
        keyframes=[SimpleNamespace(timestamp_ms=0, ocr_text=text, asset_id=None, roles=())],
        observations=[SimpleNamespace(kind="vision", start_ms=0, end_ms=0, text=text)],
        stats={},
    )
    registry = build_evidence_registry(media, transcript, visuals)
    assert [row["text"] for row in registry if row["source"] != "frame"] == [text, text, text]


def test_generated_text_uses_the_same_utf16_units_as_the_reader():
    assert utf16_units("甲😀乙") == 4
    assert _text("😀" * 1000, 2000)
    assert not _text("😀" * 1001, 2000)
    assert _text("😀" * 600, 1200)
    assert not _text("😀" * 601, 1200)


def test_evidence_rejects_an_unstorable_entry_and_total_before_model_requests():
    with pytest.raises(ValueError, match="text_exceeds_report_budget"):
        validate_evidence_storage([{"text": "😀" * (REPORT_MAX_UTF16_UNITS // 2 + 1)}])
    row = {"id": "ocr:0001", "text": "字" * 600_000}
    with pytest.raises(ValueError, match="registry_exceeds_report_budget"):
        validate_evidence_storage([row, row])
    with pytest.raises(ValueError, match="registry_exceeds_entry_limit"):
        validate_evidence_storage([{"text": ""}] * (EVIDENCE_REGISTRY_MAX_ENTRIES + 1))
