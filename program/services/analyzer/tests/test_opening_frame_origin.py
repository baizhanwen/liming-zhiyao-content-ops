"""Opening proof keeps real video PTS when audio begins before the first picture."""
import copy
import json
from dataclasses import replace

import pytest

from liming_analyzer.content_analysis import (
    _checked_bundle_module,
    _initial_content_state,
    _module_payload,
    build_content_analysis_bundle,
    build_evidence_registry,
)
from liming_analyzer.content_module_protocol import (
    CompactProtocolError,
    decode_compact_response,
    prepare_compact_request,
    validate_temporal_evidence,
)
from test_content_analysis import synthetic_inputs
from test_content_module_protocol import compact_synthetic_response, wire_label_index


def delayed_video_inputs():
    media, transcript, visuals = synthetic_inputs()
    times = [250, 750, 1_250, 1_750, 2_250, 2_750]
    first_frame, first_observation = visuals.keyframes[0], visuals.observations[0]
    visuals.keyframes = [copy.copy(first_frame) for _ in times]
    visuals.observations = [copy.copy(first_observation) for _ in times]
    for index, timestamp in enumerate(times):
        frame = visuals.keyframes[index]
        frame.timestamp_ms = timestamp
        frame.roles = ("first_frame", "opening") if index == 0 else ("opening",)
        frame.asset_id = f"real_delayed_frame_{timestamp}"
        visuals.observations[index].start_ms = visuals.observations[index].end_ms = timestamp
    visuals.stats["first_frame_timestamp_ms"] = times[0]
    visuals.stats["temporal_groups"][0].update(
        start_ms=times[0], end_ms=times[-1], timestamps_ms=times,
        first_frame_timestamp_ms=times[0],
    )
    return media, transcript, visuals


def opening_response(module, wire, budget):
    response = compact_synthetic_response(module, wire, budget)
    if module == "visual":
        opening = next(row for row in wire["d"] if row["n"] == "前3秒画面")
        ref = next(row["i"] for row in wire["e"] if row["s"] == "v" and row["a"] == 750)
        response["c"][opening["i"]] = {
            "d": opening["i"], "s": 0,
            "t": [wire_label_index(opening["t"], "动作进行中")], "e": [ref],
        }
    return response


def opening_context():
    supplied = delayed_video_inputs()
    _taxonomy, dimensions, registry, base = _initial_content_state(*supplied)
    requested = [row for row in dimensions.values() if row["module"] == "visual"]
    payload, _selected, _complete = _module_payload(
        "visual", requested, registry, list(base.values()), "max",
        {"media": {"duration_ms": 6_000}}, "asr", compact=True,
    )
    wire, context = prepare_compact_request("visual", payload)
    return payload, base, wire, context


def test_delayed_first_picture_preserves_audio_clock_and_completed_opening_proof():
    supplied = delayed_video_inputs()
    result = build_content_analysis_bundle(*supplied, opening_response)["content_analysis"]
    assert result["status"] == "complete", result["validation"]
    first = next(row for row in result["evidence_registry"] if row["source"] == "frame")
    assert first["start_ms"] == first["end_ms"] == 250
    assert first["frame_group_id"] == "first_frame"
    spoken = next(row for row in result["evidence_registry"] if row["source"] == "transcript")
    assert spoken["start_ms"] == 0 and spoken["end_ms"] == 2_200
    opening = next(row for row in result["classifications"] if row["dimension_id"] == "visual.opening")
    assert opening["state"] == "known" and opening["tags"] == ["visual.opening.ongoing_action"]
    group = next(row for row in result["evidence_registry"] if row["id"] == "temporal:opening")
    manifest = json.loads(group["text"])
    assert manifest["first_frame_timestamp_ms"] == manifest["timestamps_ms"][0] == 250
    assert manifest["timestamps_ms"][-1] == 2_750


@pytest.mark.parametrize("variation", ["no_stats", "mismatched_stats", "no_first_role", "wrong_first_role",
                                      "no_group_origin", "wrong_group_origin", "earlier_vision", "after_3s"])
def test_delayed_opening_registry_rejects_unproven_origin(variation):
    media, transcript, visuals = delayed_video_inputs()
    if variation == "no_stats":
        visuals.stats.pop("first_frame_timestamp_ms")
    elif variation == "mismatched_stats":
        visuals.stats["first_frame_timestamp_ms"] = 750
    elif variation == "no_first_role":
        visuals.keyframes[0].roles = ("opening",)
    elif variation == "wrong_first_role":
        visuals.keyframes[0].roles = ("opening",)
        visuals.keyframes[1].roles = ("first_frame",)
        visuals.stats["first_frame_timestamp_ms"] = 750
    elif variation == "no_group_origin":
        visuals.stats["temporal_groups"][0].pop("first_frame_timestamp_ms")
    elif variation == "wrong_group_origin":
        visuals.stats["temporal_groups"][0]["first_frame_timestamp_ms"] = 500
    elif variation == "earlier_vision":
        earlier = copy.copy(visuals.observations[0])
        earlier.start_ms = earlier.end_ms = 0
        visuals.observations.append(earlier)
    else:
        visuals.keyframes[-1].timestamp_ms = 3_000
        visuals.observations[-1].start_ms = visuals.observations[-1].end_ms = 3_000
        visuals.stats["temporal_groups"][0]["timestamps_ms"][-1] = 3_000
    registry = build_evidence_registry(media, transcript, visuals)
    assert not any(row["id"] == "temporal:opening" for row in registry)


@pytest.mark.parametrize("variation", ["no_origin", "wrong_origin", "no_first_frame", "wrong_first_frame",
                                      "duplicate_first_frame", "earlier_frame", "earlier_vision", "missing_vision"])
def test_delayed_opening_protocol_requires_real_matching_first_picture(variation):
    payload, base, wire, context = opening_context()
    evidence = copy.deepcopy(list(context.evidence))
    frame_evidence = copy.deepcopy(list(context.frame_evidence))
    group = next(row for row in evidence if row["id"] == "temporal:opening")
    first = next(row for row in frame_evidence if row["frame_group_id"] == "first_frame")
    if variation in {"no_origin", "wrong_origin"}:
        manifest = json.loads(group["text"])
        if variation == "no_origin":
            manifest.pop("first_frame_timestamp_ms")
        else:
            manifest["first_frame_timestamp_ms"] = 500
        group["text"] = json.dumps(manifest)
    elif variation == "no_first_frame":
        first["frame_group_id"] = None
    elif variation == "wrong_first_frame":
        first["start_ms"] = first["end_ms"] = 750
    elif variation == "duplicate_first_frame":
        frame_evidence.append({**first, "id": "frame:duplicate"})
    elif variation == "earlier_frame":
        frame_evidence.append({**first, "id": "frame:earlier", "start_ms": 0, "end_ms": 0, "frame_group_id": None})
    elif variation == "earlier_vision":
        vision = next(row for row in evidence if row["source"] == "vision")
        evidence.append({**vision, "id": "vision:earlier", "start_ms": 0, "end_ms": 0})
    else:
        next(row for row in evidence if row["source"] == "vision" and row["start_ms"] == 250)["source"] = "ocr"
    mutated = replace(context, evidence=tuple(evidence), frame_evidence=tuple(frame_evidence),
                      review_context={"uncertain_segment_ids": []})
    response = opening_response("visual", wire, 6_000)
    # Isolate opening from unrelated dimensions in deliberately corrupt input.
    opening_index = next(row["i"] for row in wire["d"] if row["n"] == "前3秒画面")
    for row in response["c"]:
        if row["d"] != opening_index:
            row.update(s=1, t=[], e=[])
            row.pop("p", None)
    for finding in response["f"]:
        finding["e"] = [next(index for index, row in enumerate(evidence)
                            if row["source"] == "vision" and row["start_ms"] == 750)]
    decoded, _findings = decode_compact_response(response, mutated)
    opening = next(row for row in decoded["classifications"] if row["dimension_id"] == "visual.opening")
    assert opening["state"] == "unknown" and opening["tags"] is None
    refs = [row["id"] for row in evidence if row["source"] in {"vision", "temporal"}]
    with pytest.raises(CompactProtocolError):
        validate_temporal_evidence(refs, {row["id"]: row for row in [*evidence, *frame_evidence]},
                                   dimension_id="visual.opening")


def test_delayed_opening_complete_proof_survives_final_cache_validation_without_repair():
    payload, base, wire, context = opening_context()
    decoded, findings = decode_compact_response(opening_response("visual", wire, 6_000), context)
    checked, _findings = _checked_bundle_module("visual", decoded, findings, payload, base, 6_000)
    opening = next(row for row in checked["classifications"] if row["dimension_id"] == "visual.opening")
    registry = {row["id"]: row for row in [*context.evidence, *context.frame_evidence]}
    validate_temporal_evidence(opening["evidence_ids"], registry, dimension_id="visual.opening")
    with pytest.raises(CompactProtocolError):
        validate_temporal_evidence(opening["evidence_ids"][:-1], registry, dimension_id="visual.opening")


def test_legacy_zero_opening_registry_keeps_exact_serialized_manifest():
    supplied = synthetic_inputs()
    group = next(row for row in build_evidence_registry(*supplied) if row["id"] == "temporal:opening")
    assert json.loads(group["text"]) == {
        "kind": "opening", "timestamps_ms": [0, 500, 1_000],
        "limitations": ["稀疏采样，仅支持这一采样窗口内的判断。"],
    }
