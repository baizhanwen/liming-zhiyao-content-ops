"""Omitted classification citations can reuse explicit matching annotations."""

import copy
import logging
from dataclasses import replace

import pytest

from test_content_module_protocol import compact_synthetic_response, module_payload
from test_content_analysis import synthetic_inputs

from liming_analyzer.content_analysis import _checked_bundle_module, _initial_content_state
from liming_analyzer.content_module_protocol import (
    CompactProtocolError,
    _complete_classification_evidence,
    decode_compact_response,
    prepare_compact_request,
)


def missing_topic_references():
    payload = module_payload("text_topic_structure_audience")
    wire, context = prepare_compact_request("text_topic_structure_audience", payload)
    raw = compact_synthetic_response("text_topic_structure_audience", wire, 1000)
    index = next(item["i"] for item in wire["d"] if item["n"] == "选题赛道")
    classification = raw["c"][index]
    subject = next(item for item in raw["g"] if item["k"] == "topic_subject")
    subject["t"] = list(classification["t"])
    classification["e"] = []
    return payload, context, raw, index, subject


def base_classifications():
    return _initial_content_state(*synthetic_inputs())[-1]


def test_missing_topic_citation_reuses_same_tagged_subject_and_passes_full_validation(caplog):
    payload, context, raw, index, subject = missing_topic_references()
    original = copy.deepcopy(raw)
    with caplog.at_level(logging.INFO):
        response, findings = decode_compact_response(raw, context)
    checked, _findings = _checked_bundle_module(context.module_key, response, findings, payload, base_classifications(), 6000)
    row = next(item for item in checked["classifications"] if item["dimension_id"] == "topic.category")
    assert row["state"] == "known"
    assert row["evidence_ids"] == [context.evidence[item]["id"] for item in subject["e"]]
    assert "source=matching_annotation dimensions=topic.category" in caplog.text
    assert raw == original


@pytest.mark.parametrize("change", ["untagged", "different_tag", "different_kind", "no_subject"])
def test_missing_topic_citation_is_not_guessed_from_unrelated_annotations(change):
    payload, context, raw, _index, subject = missing_topic_references()
    if change == "untagged":
        subject["t"] = []
    elif change == "different_tag":
        count = len(next(item for item in context.dimensions if item["id"] == "topic.category")["tags"])
        subject["t"] = [(subject["t"][0] + 1) % count]
    elif change == "different_kind":
        raw["g"].remove(subject)
    else:
        raw["g"] = []
    response, findings = decode_compact_response(raw, context)
    row = next(item for item in response["classifications"] if item["dimension_id"] == "topic.category")
    assert row["evidence_ids"] == []
    with pytest.raises(CompactProtocolError) as failure:
        _checked_bundle_module(context.module_key, response, findings, payload, base_classifications(), 6000)
    assert "known_requires_evidence:topic.category" in failure.value.safe_validation_issues


def test_existing_classification_citations_are_preserved():
    _payload, context, raw, index, subject = missing_topic_references()
    raw["c"][index]["e"] = [subject["e"][0]]
    response, _findings = decode_compact_response(raw, context)
    row = next(item for item in response["classifications"] if item["dimension_id"] == "topic.category")
    assert row["evidence_ids"] == [context.evidence[subject["e"][0]]["id"]]


def test_invalid_annotation_reference_cannot_be_repaired():
    _payload, context, raw, _index, subject = missing_topic_references()
    subject["e"] = [len(context.evidence)]
    with pytest.raises(CompactProtocolError, match="compact_evidence_index"):
        decode_compact_response(raw, context)


@pytest.mark.parametrize("source,text", [("vision", "画面中有计算机"), ("transcript", "")])
def test_missing_text_citation_requires_nonempty_textual_source(source, text):
    _payload, context, raw, _index, subject = missing_topic_references()
    evidence = list(context.evidence)
    for index in subject["e"]:
        evidence[index] = {**evidence[index], "source": source, "text": text}
    response, _findings = decode_compact_response(raw, replace(context, evidence=tuple(evidence)))
    row = next(item for item in response["classifications"] if item["dimension_id"] == "topic.category")
    assert row["evidence_ids"] == []


def test_matching_unit_types_complete_each_selected_classification_tag():
    payload = module_payload("text_expression_value")
    wire, context = prepare_compact_request("text_expression_value", payload)
    raw = compact_synthetic_response("text_expression_value", wire, 1000)
    index = next(item["i"] for item in wire["d"] if item["n"] == "信息点类型")
    raw["c"][index]["e"] = []
    response, findings = decode_compact_response(raw, context)
    checked, _findings = _checked_bundle_module(context.module_key, response, findings, payload, base_classifications(), 6000)
    row = next(item for item in checked["classifications"] if item["dimension_id"] == "value.information_type")
    assert row["state"] == "known"
    assert row["evidence_ids"] == response["information_units"][0]["evidence_ids"]
    raw["c"][index]["t"].append((raw["c"][index]["t"][0] + 1) % len(context.information_type_ids))
    response, findings = decode_compact_response(raw, context)
    row = next(item for item in response["classifications"] if item["dimension_id"] == "value.information_type")
    assert row["evidence_ids"] == []
    with pytest.raises(CompactProtocolError) as failure:
        _checked_bundle_module(context.module_key, response, findings, payload, base_classifications(), 6000)
    assert "known_requires_evidence:value.information_type" in failure.value.safe_validation_issues


def test_matching_annotations_are_combined_only_within_reference_limit():
    _payload, context, raw, _index, _subject = missing_topic_references()
    response, _findings = decode_compact_response(raw, context)
    row = next(item for item in response["classifications"] if item["dimension_id"] == "topic.problem")
    row = {**row, "evidence_ids": []}
    definition = next(item for item in context.dimensions if item["id"] == row["dimension_id"])
    tag_ids = list(definition["tags"])
    other = next(tag for tag in tag_ids if tag not in row["tags"] and tag != definition["none_tag_id"])
    row["tags"] = [*row["tags"], other]
    evidence = tuple({"id": f"t{i}", "source": "transcript", "text": f"真实来源{i}",
                      "start_ms": i * 100, "end_ms": (i + 1) * 100} for i in range(9))
    context = replace(context, evidence=evidence)
    annotations = [
        {"id": "g0", "kind": "topic_problem", "dimension_id": "topic.problem",
         "tags": row["tags"][:1], "evidence_ids": [f"t{i}" for i in range(8)]},
        {"id": "g1", "kind": "topic_problem", "dimension_id": "topic.problem",
         "tags": row["tags"][1:], "evidence_ids": ["t8"]},
    ]
    assert _complete_classification_evidence([row], annotations, [], context)[0]["evidence_ids"] == []
    reviewed = replace(context, review_context={"verified": True})
    assert _complete_classification_evidence([row], annotations, [], reviewed)[0]["evidence_ids"] == [f"t{i}" for i in range(9)]
    annotations[1]["tags"].append(next(tag for tag in tag_ids if tag not in row["tags"]))
    assert _complete_classification_evidence([row], annotations, [], reviewed)[0]["evidence_ids"] == []
