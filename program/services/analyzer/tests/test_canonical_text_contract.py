"""Legal SDK Unicode text remains within the shared stored-report budget."""
import pytest

from liming_analyzer.canonical_review import create_review_response_model
from liming_analyzer.canonical_transcript import create_canonical_response_model
from liming_analyzer.content_report_contract import REPORT_MAX_UTF16_UNITS, utf16_units


@pytest.mark.parametrize("text", ["文" * 12_000, "😀" * 12_000])
def test_legal_generated_canonical_text_survives_utf16_report_measurement(text):
    legacy = create_canonical_response_model().model_validate({"segments": [{"s": 1, "t": text}]})
    reviewed = create_review_response_model().model_validate({
        "patches": [], "uncertain": [], "punctuation": [{"s": 1, "text": text}],
    })
    assert legacy.segments[0].t == reviewed.punctuation[0].text == text
    assert utf16_units(text) <= REPORT_MAX_UTF16_UNITS
    assert utf16_units(legacy.model_dump_json()) <= REPORT_MAX_UTF16_UNITS
    assert utf16_units(reviewed.model_dump_json()) <= REPORT_MAX_UTF16_UNITS
