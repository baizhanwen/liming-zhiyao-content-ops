"""Local format recovery must preserve decisions and retain ambiguous failures."""

import copy

import pytest
from pydantic import ValidationError
from test_content_module_protocol import compact_synthetic_response, module_payload

from liming_analyzer.content_module_protocol import (
    CompactProtocolError,
    create_compact_response_model,
    decode_compact_response,
    normalize_compact_response_shape,
    prepare_compact_request,
)

MODULE = "text_expression_value"


def fixture():
    wire, context = prepare_compact_request(MODULE, module_payload(MODULE))
    raw = compact_synthetic_response(MODULE, wire, 6000)
    model = create_compact_response_model(MODULE, dimension_count=len(wire["d"]))
    return context, raw, model


def test_single_information_type_array_is_repaired_before_sdk_and_cached_decode():
    context, raw, model = fixture()
    expected = decode_compact_response(raw, context)
    raw["u"][0]["t"] = [raw["u"][0]["t"]]
    original = copy.deepcopy(raw)
    parsed = model.model_validate(raw).model_dump(mode="json")
    assert type(parsed["u"][0]["t"]) is int
    assert decode_compact_response(parsed, context) == expected
    assert decode_compact_response(raw, context) == expected
    assert raw == original


@pytest.mark.parametrize("value", [[], [True], [1.0], ["3"], [3, 4], [-1], [10], True])
def test_ambiguous_information_types_remain_invalid(value):
    context, raw, model = fixture()
    raw["u"][0]["t"] = value
    with pytest.raises(ValidationError):
        model.model_validate(raw)
    with pytest.raises(CompactProtocolError):
        decode_compact_response(raw, context)


def test_identical_classification_duplicates_preserve_all_requested_results():
    context, raw, model = fixture()
    expected = decode_compact_response(raw, context)
    raw["c"].insert(2, copy.deepcopy(raw["c"][1]))
    original = copy.deepcopy(raw)
    parsed = model.model_validate(raw).model_dump(mode="json")
    assert len(parsed["c"]) == len(context.dimensions)
    assert decode_compact_response(parsed, context) == expected
    assert decode_compact_response(raw, context) == expected
    assert raw == original


def test_conflicting_duplicate_cannot_be_truncated_or_merged():
    context, raw, model = fixture()
    conflict = {**raw["c"][0], "r": "different explanation"}
    raw["c"].append(conflict)
    with pytest.raises(ValidationError):
        model.model_validate(raw)
    with pytest.raises(CompactProtocolError, match="compact_c_count"):
        decode_compact_response(raw, context)


def test_duplicate_with_a_missing_requested_dimension_cannot_hide_the_omission():
    context, raw, _model = fixture()
    raw["c"][-1] = copy.deepcopy(raw["c"][0])
    with pytest.raises(CompactProtocolError, match="compact_duplicate_dimension"):
        decode_compact_response(raw, context)


@pytest.mark.parametrize("state", [1, 2])
def test_unrequested_empty_placeholder_is_removed_only_after_reference_validation(state):
    context, raw, model = fixture()
    expected = decode_compact_response(raw, context)
    raw["c"].append({"d": len(context.dimensions), "s": state, "e": [0]})
    original = copy.deepcopy(raw)
    normalized = normalize_compact_response_shape(
        raw, dimension_count=len(context.dimensions),
        information_type_count=len(context.information_type_ids),
    )
    assert len(normalized["c"]) == len(context.dimensions) + 1
    with pytest.raises(ValidationError):
        model.model_validate(raw)
    assert decode_compact_response(raw, context) == expected
    assert raw == original


@pytest.mark.parametrize("extra", [
    {"s": 0, "t": [0]}, {"s": 3}, {"t": [0]}, {"p": 0}, {"r": "unrequested claim"},
    {"e": [-1]}, {"e": [True]}, {"e": [9999]}, {"e": [0, 0]}, {"extra": 1},
])
def test_foreign_claims_or_bad_references_cannot_disappear_as_placeholders(extra):
    context, raw, _model = fixture()
    raw["c"].append({"d": len(context.dimensions), "s": 1, "e": [0], **extra})
    with pytest.raises(CompactProtocolError, match="compact_c_count"):
        decode_compact_response(raw, context)


def test_unrequested_placeholder_cannot_cover_a_missing_requested_dimension():
    context, raw, _model = fixture()
    raw["c"].pop()
    raw["c"].extend([
        {"d": len(context.dimensions), "s": 1, "e": [0]},
        {"d": len(context.dimensions) + 1, "s": 1, "e": [0]},
    ])
    with pytest.raises(CompactProtocolError, match="compact_c_count"):
        decode_compact_response(raw, context)


def test_json_type_differences_are_not_treated_as_identical_duplicate_evidence():
    context, raw, _model = fixture()
    row = next(row for row in raw["c"] if row.get("s") == 0)
    row["e"] = [0]
    raw["c"].append({**copy.deepcopy(row), "e": [False]})
    with pytest.raises(CompactProtocolError, match="compact_c_count"):
        decode_compact_response(raw, context)
