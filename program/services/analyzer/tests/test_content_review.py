"""Synthetic v12 coverage, gap safety and independent-module regressions."""

from types import SimpleNamespace

import pytest
from test_content_analysis import synthetic_inputs
from test_content_module_protocol import compact_synthetic_response

from liming_analyzer.content_analysis import (
    MODULES,
    _initial_content_state,
    _module_payload,
    _validate_segments,
    build_content_analysis_bundle,
)
from liming_analyzer.content_module_protocol import (
    CompactProtocolError,
    compact_signature,
    create_compact_response_model,
    decode_compact_response,
    prepare_compact_request,
)


def reviewed_inputs(pending=(2,), *, raw_pending=False):
    media, transcript, visuals = synthetic_inputs()
    first, last = transcript.segments
    transcript.segments = [first, SimpleNamespace(start_ms=2_300, end_ms=2_800,
                                                  text="疑似乱码待核对" if raw_pending else ""), last]
    if 1 in pending:
        transcript.segments[0] = SimpleNamespace(start_ms=0, end_ms=2_200, text="")
    if 3 in pending:
        transcript.segments[2] = SimpleNamespace(start_ms=3_000, end_ms=5_900, text="")
    ids = [f"transcript:{index:04d}" for index in pending]
    review = {"total_segments": 3, "accepted_segments": 3 - len(ids),
              "uncertain_segment_ids": ids,
              "uncertain_ranges": [{"source_segment_id": f"transcript:{index:04d}",
                                    "start_ms": transcript.segments[index - 1].start_ms,
                                    "end_ms": transcript.segments[index - 1].end_ms}
                                   for index in pending],
              "first_source_segment_id": "transcript:0001"}
    return (media, transcript, visuals), review


def test_pending_slot_is_never_renumbered_or_sent_and_metadata_is_public():
    inputs, review = reviewed_inputs(raw_pending=True)
    wires = {}

    def request(module, wire, cap):
        wires[module] = wire
        assert "疑似乱码" not in str(wire)
        assert wire["review"] == ({"transcript_text_used": False} if module == "visual" else review)
        assert wire["coverage"]["review_limited"] is True
        assert wire["coverage"]["complete"] is False
        return compact_synthetic_response(module, wire, cap)

    result = build_content_analysis_bundle(*inputs, request, review_context=review)
    content = result["content_analysis"]
    assert {row["id"] for row in content["evidence_registry"] if row["source"] == "transcript"} == {
        "transcript:0001", "transcript:0003",
    }
    assert content["methodology"]["transcript_review"] == review
    assert set(wires) == set(MODULES)
    assert content["status"] == "complete"
    assert content["module_status"]["visual"]["source_coverage"]["uncertain_segment_count"] == 1


def test_original_first_pending_does_not_promote_next_sentence_or_text_hook():
    inputs, review = reviewed_inputs((1, 2))

    def request(module, wire, cap):
        response = compact_synthetic_response(module, wire, cap)
        if module == MODULES[1]:
            hook = next(row for row in wire["d"] if row["n"] == "开头Hook")
            text = next(row["i"] for row in wire["e"] if row["s"] == "t")
            response["c"][hook["i"]] = {"d": hook["i"], "s": 0, "t": [0], "e": [text]}
        return response

    content = build_content_analysis_bundle(*inputs, request, review_context=review)["content_analysis"]
    assert not any(row["kind"].startswith("hook_first") for row in content["segments"])
    hook = next(row for row in content["classifications"] if row["dimension_id"] == "hook.type")
    assert hook["state"] == "unknown"
    assert hook["reason"] == "original_opening_text_requires_review"


def test_any_review_gap_prevents_whole_source_absence():
    inputs, review = reviewed_inputs()

    def request(module, wire, cap):
        response = compact_synthetic_response(module, wire, cap)
        if module == MODULES[1]:
            cta = next(row for row in wire["d"] if row["n"] == "行动引导")
            response["c"][cta["i"]] = {"d": cta["i"], "s": 0, "t": [cta["z"]],
                                         "e": [next(row["i"] for row in wire["e"] if row["s"] == "t")]}
        return response

    content = build_content_analysis_bundle(*inputs, request, review_context=review)["content_analysis"]
    cta = next(row for row in content["classifications"] if row["dimension_id"] == "cta.action")
    assert cta["state"] == "unknown"
    assert "absence_not_verifiable" in cta["reason"]


def test_cta_literal_cannot_stitch_over_pending_but_summary_may_cite_both_sides():
    inputs, review = reviewed_inputs()
    _, definitions, registry, _ = _initial_content_state(*inputs, review_context=review)
    evidence = {row["id"]: row for row in registry}
    row = {"id": "cta", "kind": "cta", "dimension_id": "cta.action",
           "tags": ["cta.action.practice"], "start_ms": 0, "end_ms": 5_900,
           "text": inputs[1].segments[0].text + inputs[1].segments[2].text,
           "evidence_ids": ["transcript:0001", "transcript:0003"]}
    issues = []
    assert _validate_segments([row], MODULES[1], definitions, evidence, 6_000, issues, review) == []
    assert issues == []  # local unsafe annotation is discarded, not a module failure
    row.update(kind="structure", dimension_id="structure.role", tags=["structure.role.question"],
               text="可见片段先提出问题，后给出动作；中间一段待核对。")
    assert len(_validate_segments([row], MODULES[0], definitions, evidence, 6_000, issues, review)) == 1


def test_all_text_pending_keeps_visual_and_visual_only_synthesis_available():
    inputs, review = reviewed_inputs((1, 2, 3))
    for frame in inputs[2].keyframes:
        frame.ocr_text = None
    wires = {}

    def request(module, wire, cap):
        wires[module] = wire
        return compact_synthetic_response(module, wire, cap)

    content = build_content_analysis_bundle(*inputs, request, review_context=review)["content_analysis"]
    assert set(wires) == {"visual", "synthesis"}
    assert content["status"] == "partial"
    assert all(content["module_status"][module]["status"] == "not_acquired" for module in MODULES[:2])
    assert content["module_status"]["visual"]["status"] == "completed"
    assert content["module_status"]["synthesis"]["status"] == "completed"
    assert wires["synthesis"]["upstream"] == {
        "available": ["visual"], "missing": list(MODULES[:2]), "limited": ["visual"],
    }
    assert not any(row["s"] == "t" for row in wires["synthesis"]["e"])


def test_failed_text_module_does_not_cancel_other_safe_synthesis():
    inputs, review = reviewed_inputs()
    wires = {}

    def request(module, wire, cap):
        wires[module] = wire
        if module == MODULES[0]:
            raise RuntimeError("synthetic provider failure")
        return compact_synthetic_response(module, wire, cap)

    content = build_content_analysis_bundle(*inputs, request, review_context=review)["content_analysis"]
    assert content["module_status"][MODULES[0]]["status"] == "failed"
    assert content["module_status"]["synthesis"]["status"] == "completed"
    assert wires["synthesis"]["upstream"]["missing"] == [MODULES[0]]
    assert content["status"] == "partial"


def test_dense_repeated_ocr_does_not_evict_real_opening_vision_and_raw_is_retained():
    inputs, review = reviewed_inputs(())
    _media, _transcript, visuals = inputs
    full_page = "界面导航栏和文章正文。" * 2_000
    for frame in visuals.keyframes:
        frame.ocr_text = full_page
    _, definitions, registry, base = _initial_content_state(*inputs, review_context=review)
    requested = [row for row in definitions.values() if row["module"] == "visual"]
    payload, evidence, complete = _module_payload(
        "visual", requested, registry, list(base.values()), "standard", {}, "asr",
        compact=True, review_context=review,
    )
    wire, _context = prepare_compact_request("visual", payload)
    assert payload["source_coverage"]["required_opening_complete"] is True
    assert {"vision:0001", "vision:0002", "vision:0003", "temporal:opening"}.issubset(evidence)
    assert len([row for row in wire["e"] if row["s"] == "o"]) == 1
    assert all(len(row["x"]) <= 360 and row["excerpted"] for row in wire["e"] if row["s"] == "o")
    assert all(row["text"] == full_page for row in registry if row["source"] == "ocr")
    assert not complete
    assert wire["coverage"]["evidence_excerpted"] is True
    assert payload["source_coverage"]["estimated_payload_tokens"] + 700 <= payload["source_coverage"]["input_token_limit"]


def test_mismatched_review_contract_is_rejected_before_model_call():
    inputs, review = reviewed_inputs()
    review["total_segments"] = 2
    with pytest.raises(ValueError, match="invalid_transcript_review_context"):
        build_content_analysis_bundle(*inputs, lambda *_args: pytest.fail("must not call model"), review_context=review)


def test_canonical_review_changes_reuse_visual_cache_with_current_safe_revalidation():
    inputs, verified = reviewed_inputs(())

    def visual_absence(module, wire, cap):
        response = compact_synthetic_response(module, wire, cap)
        if module == "visual":
            dimension = next(row for row in wire["d"] if row["n"] == "人物数量")
            if dimension["z"] is not None:
                ref = next(row["i"] for row in wire["e"] if row["s"] == "v")
                response["c"][dimension["i"]] = {"d": dimension["i"], "s": 0,
                                                     "t": [dimension["z"]], "e": [ref]}
        return response

    first = build_content_analysis_bundle(*inputs, visual_absence, review_context=verified)
    initial = next(row for row in first["content_analysis"]["classifications"]
                   if row["dimension_id"] == "visual.person_count")
    assert initial["state"] == "known"
    changed_inputs, pending = reviewed_inputs((2,))
    calls = []

    def request(module, wire, cap):
        calls.append(module)
        return compact_synthetic_response(module, wire, cap)

    resumed = build_content_analysis_bundle(*changed_inputs, request, review_context=pending,
                                            resume_modules=first["module_results"])
    assert "visual" not in calls
    assert set(calls) == {MODULES[0], MODULES[1], "synthesis"}
    coverage = resumed["content_analysis"]["module_status"]["visual"]["source_coverage"]
    assert coverage["review_limited"] is True
    assert coverage["uncertain_segment_count"] == 1
    revised = next(row for row in resumed["content_analysis"]["classifications"]
                   if row["dimension_id"] == "visual.person_count")
    assert revised["state"] == "unknown"


def test_all_unknown_text_response_is_unavailable_and_never_a_success_cache():
    inputs, review = reviewed_inputs()
    checkpoints = {}

    def request(module, wire, cap):
        if module in MODULES[:2]:
            ref = next(row["i"] for row in wire["e"] if row["s"] == "t")
            return {"c": [{"d": row["i"], "s": 1} for row in wire["d"]], "g": [], "u": [],
                    "f": [{"k": 0, "e": [ref], "x": "仅有局部可见句子，尚不足形成模块判断。"}]}
        return compact_synthetic_response(module, wire, cap)

    result = build_content_analysis_bundle(*inputs, request, review_context=review,
                                           on_module_checkpoint=lambda key, value: checkpoints.update({key: value}))
    assert not set(MODULES[:2]) & set(checkpoints)
    assert not set(MODULES[:2]) & set(result["module_results"])
    for module in MODULES[:2]:
        assert result["content_analysis"]["module_status"][module]["status"] == "not_acquired"
    assert result["content_analysis"]["status"] == "partial"


@pytest.mark.parametrize("bad_source", ["o", "late_vision"])
def test_v12_unproven_first_frame_dimension_is_unknown_without_erasing_valid_visuals(bad_source):
    inputs, review = reviewed_inputs()

    def request(module, wire, cap):
        response = compact_synthetic_response(module, wire, cap)
        if module == "visual":
            dimension = next(row for row in wire["d"] if row["n"] == "首帧信息")
            ref = next(row["i"] for row in wire["e"] if (
                row["s"] == "o" if bad_source == "o" else row["s"] == "v" and row["a"] > 0
            ))
            response["c"][dimension["i"]] = {"d": dimension["i"], "s": 0, "t": [0], "e": [ref]}
        return response

    result = build_content_analysis_bundle(*inputs, request, review_context=review)
    content = result["content_analysis"]
    visual = content["module_status"]["visual"]
    row = next(row for row in content["classifications"] if row["dimension_id"] == "visual.first_frame_information")
    assert row["state"] == "unknown"
    assert row["tags"] is None and row["primary_tag"] is None
    assert row["reason"] == "first_frame_not_proven_by_cited_evidence"
    assert visual["status"] == "completed" and visual["validation"]["passed"]
    assert len(result["findings_by_module"]["visual"]) == 4
    assert next(row for row in content["classifications"] if row["dimension_id"] == "visual.camera_motion")["state"] == "known"


def failed_visual_candidate(inputs, review):
    captured = {}

    def request(module, wire, cap):
        response = compact_synthetic_response(module, wire, cap)
        if module == "visual":
            dimension = next(row for row in wire["d"] if row["n"] == "首帧信息")
            ref = next(row["i"] for row in wire["e"] if row["s"] == "o")
            response["c"][dimension["i"]] = {"d": dimension["i"], "s": 0, "t": [0], "e": [ref]}
            captured.update(signature=compact_signature(wire), status="failed", candidate=response,
                            validation={"passed": False, "issues": ["insufficient_evidence_modality:visual.first_frame_information"]})
        return response

    current = build_content_analysis_bundle(*inputs, request, review_context=review)
    current["module_results"].pop("visual")
    return current, captured


@pytest.mark.parametrize("retry_keys", [None, ("visual",)])
def test_matching_bounded_failure_candidate_recovers_without_paid_call_and_saves_success(retry_keys):
    inputs, review = reviewed_inputs()
    current, failed = failed_visual_candidate(inputs, review)
    checkpoints = {}

    def no_call(*_args):
        pytest.fail("exact candidate recovery must not call model")

    result = build_content_analysis_bundle(*inputs, no_call, review_context=review,
        resume_modules=current["module_results"], resume_failures={"visual": failed},
        retry_module_keys=retry_keys,
        on_module_checkpoint=lambda key, value: checkpoints.update({key: value}))
    assert set(checkpoints) == {"visual"}
    assert checkpoints["visual"]["status"] == "completed"
    assert result["content_analysis"]["status"] == "complete"
    assert result["findings_by_module"]["visual"] == current["findings_by_module"]["visual"]


@pytest.mark.parametrize("corruption", ["bad_ref", "too_large"])
def test_matching_but_invalid_failure_candidate_stays_failed_without_blind_paid_retry(corruption):
    inputs, review = reviewed_inputs()
    current, failed = failed_visual_candidate(inputs, review)
    if corruption == "bad_ref":
        failed["candidate"]["c"][0]["e"] = [999_999]
    else:
        failed["candidate"]["f"][0]["x"] = "x" * 65_536
    calls = []

    def request(module, wire, cap):
        calls.append(module)
        assert module != "visual"
        return compact_synthetic_response(module, wire, cap)

    result = build_content_analysis_bundle(*inputs, request, review_context=review,
        resume_modules=current["module_results"], resume_failures={"visual": failed})
    assert "visual" not in calls
    assert result["content_analysis"]["module_status"]["visual"]["status"] == "failed"
    assert result["content_analysis"]["status"] == "partial"


@pytest.mark.parametrize("corruption", ["bad_ref", "too_large"])
def test_explicit_module_retry_requests_once_after_bad_candidate_then_reuses_success(corruption):
    inputs, review = reviewed_inputs()
    current, failed = failed_visual_candidate(inputs, review)
    if corruption == "bad_ref":
        failed["candidate"]["c"][0]["e"] = [999_999]
    else:
        failed["candidate"]["f"][0]["x"] = "x" * 65_536
    calls = []
    checkpoints = {}

    def request(module, wire, cap):
        calls.append(module)
        return compact_synthetic_response(module, wire, cap)

    result = build_content_analysis_bundle(*inputs, request, review_context=review,
        resume_modules=current["module_results"], resume_failures={"visual": failed},
        retry_module_keys=("visual",),
        on_module_checkpoint=lambda key, value: checkpoints.update({key: value}))
    assert calls == ["visual"]
    assert set(checkpoints) == {"visual"}
    assert result["content_analysis"]["module_status"]["visual"]["status"] == "completed"

    calls.clear()
    cached = build_content_analysis_bundle(*inputs, request, review_context=review,
        resume_modules=result["module_results"], resume_failures={"visual": failed},
        retry_module_keys=("visual",))
    assert calls == []
    assert cached["content_analysis"]["status"] == "complete"


def test_automatic_restore_of_still_invalid_candidate_does_not_request_any_module():
    inputs, review = reviewed_inputs()
    failures = {}

    def first_request(module, wire, cap):
        response = compact_synthetic_response(module, wire, cap)
        if module == "visual":
            response["c"][0]["e"] = [999_999]
        return response

    first = build_content_analysis_bundle(*inputs, first_request, review_context=review,
        on_module_failure=lambda key, value: failures.update({key: value}))
    assert set(failures) == {"visual"}

    def no_call(*_args):
        pytest.fail("automatic restore must retain the matching failed result without a new request")

    restored = build_content_analysis_bundle(*inputs, no_call, review_context=review,
        resume_modules=first["module_results"], resume_failures=failures)
    assert restored["content_analysis"]["module_status"]["visual"]["status"] == "failed"
    assert restored["content_analysis"]["module_status"]["synthesis"]["status"] == "completed"
    assert restored["content_analysis"]["status"] == "partial"


def test_mismatched_failure_candidate_uses_normal_request_path():
    inputs, review = reviewed_inputs()
    current, failed = failed_visual_candidate(inputs, review)
    failed["signature"] = "different_input"
    calls = []

    def request(module, wire, cap):
        calls.append(module)
        return compact_synthetic_response(module, wire, cap)

    result = build_content_analysis_bundle(*inputs, request, review_context=review,
        resume_modules=current["module_results"], resume_failures={"visual": failed})
    assert "visual" in calls
    assert result["content_analysis"]["module_status"]["visual"]["status"] == "completed"


def test_v12_unproven_temporal_dimension_becomes_unknown_without_losing_other_valid_visuals():
    inputs, review = reviewed_inputs()

    def request(module, wire, cap):
        response = compact_synthetic_response(module, wire, cap)
        if module == "visual":
            dimension = next(row for row in wire["d"] if row["n"] == "镜头运动")
            row = response["c"][dimension["i"]]
            row["e"] = [next(source["i"] for source in wire["e"] if source["s"] == "v")]
        return response

    result = build_content_analysis_bundle(*inputs, request, review_context=review)
    assert result["content_analysis"]["module_status"]["visual"]["status"] == "completed"
    motion = next(row for row in result["content_analysis"]["classifications"]
                  if row["dimension_id"] == "visual.camera_motion")
    assert motion["state"] == "unknown"
    assert motion["tags"] is None and motion["primary_tag"] is None
    assert motion["reason"] == "temporal_sequence_not_proven_by_cited_evidence"


def extended_reviewed_inputs():
    inputs, review = reviewed_inputs()
    _media, _transcript, visuals = inputs
    prototype_frame = visuals.keyframes[0]
    for index, time in enumerate(range(1_100, 5_101, 400), 4):
        visuals.keyframes.append(SimpleNamespace(timestamp_ms=time, path=prototype_frame.path,
            asset_id=f"synthetic_extra_{index}", ocr_text=f"可见步骤{index}", roles=("representative",)))
        visuals.observations.append(SimpleNamespace(kind="vision", start_ms=time, end_ms=time,
            text=f"真实抽样画面{index}：人物演示会议待办内容，镜头位置有明确可见依据。"))
    visuals.stats["temporal_groups"].append({"group_id": "cut-synthetic", "kind": "detected_cut",
        "start_ms": 3_100, "end_ms": 3_900, "timestamps_ms": [3_100, 3_500, 3_900],
        "source": "ordered_sampled_frames", "limitations": ["仅支持这一真实窗口。"]})
    return inputs, review


def test_v12_actual_14_visual_and_11_synthesis_refs_pass_sdk_and_decoder_without_truncation():
    inputs, review = extended_reviewed_inputs()
    observed = {}

    def request(module, wire, cap):
        response = compact_synthetic_response(module, wire, cap)
        if module in {"visual", "synthesis"}:
            vision = [row["i"] for row in wire["e"] if row["s"] == "v"]
            if module == "visual":
                dimension = next(row for row in wire["d"] if row["n"] == "首帧信息")
                refs = vision[:14]
            else:
                dimension = wire["d"][0]
                text = next(row["i"] for row in wire["e"] if row["s"] == "t")
                refs = [text, *vision[:10]]
            response["c"][dimension["i"]] = {"d": dimension["i"], "s": 0, "t": [0], "e": refs}
            observed[module] = len(refs)
            if module == "synthesis":
                template_refs = [row["i"] for row in wire["e"] if row["s"] in {"t", "v"}][:12]
                response["g"][0]["e"] = template_refs
                response["f"][0]["e"] = template_refs
                observed["template"] = len(template_refs)
                observed["finding"] = len(template_refs)
            model = create_compact_response_model(module, dimension_count=len(wire["d"]),
                                                   classification_evidence_limit=24)
            response = model.model_validate(response).model_dump(mode="json")
        return response

    result = build_content_analysis_bundle(*inputs, request, review_context=review)
    assert observed == {"visual": 14, "synthesis": 11, "template": 12, "finding": 12}
    assert result["content_analysis"]["module_status"]["visual"]["status"] == "completed"
    assert result["content_analysis"]["module_status"]["synthesis"]["status"] == "completed"
    first = next(row for row in result["content_analysis"]["classifications"]
                 if row["dimension_id"] == "visual.first_frame_information")
    assert first["state"] == "known" and len(first["evidence_ids"]) == 14


def test_v12_reference_limit_applies_to_all_e_fields_and_legacy_defaults_stay_eight():
    model = create_compact_response_model(MODULES[1], evidence_reference_limit=24)
    schema = model.model_json_schema()
    for name in ("CompactClassification", "CompactSegment", "CompactUnit", "CompactFinding"):
        assert schema["$defs"][name]["properties"]["e"]["maxItems"] == 24
    compatible = create_compact_response_model(MODULES[1], classification_evidence_limit=24).model_json_schema()
    assert compatible == schema
    legacy = create_compact_response_model(MODULES[1]).model_json_schema()
    for name in ("CompactClassification", "CompactSegment", "CompactUnit", "CompactFinding"):
        assert legacy["$defs"][name]["properties"]["e"]["maxItems"] == 8
    for invalid in (0, 9, 25, True):
        with pytest.raises(ValueError, match="classification_evidence_limit"):
            create_compact_response_model("visual", classification_evidence_limit=invalid)


@pytest.mark.parametrize("reference_count", [8, 14])
def test_v12_multiple_temporal_groups_are_only_unknown_and_cache_cannot_bypass_the_proof(reference_count):
    inputs, review = extended_reviewed_inputs()

    def request(module, wire, cap):
        response = compact_synthetic_response(module, wire, cap)
        if module == "visual":
            dimension = next(row for row in wire["d"] if row["n"] == "镜头运动")
            refs = [row["i"] for row in wire["e"] if row["s"] == "g" or (
                row["s"] == "v" and row["a"] in {0, 500, 1_000, 3_100, 3_500, 3_900})]
            if reference_count == 14:
                refs.extend([row["i"] for row in wire["e"] if row["s"] == "v" and row["i"] not in refs][:6])
            response["c"][dimension["i"]]["e"] = refs
        return response

    result = build_content_analysis_bundle(*inputs, request, review_context=review)
    assert result["content_analysis"]["module_status"]["visual"]["status"] == "completed"
    row = next(row for row in result["content_analysis"]["classifications"]
               if row["dimension_id"] == "visual.camera_motion")
    assert row["state"] == "unknown" and row["tags"] is None and row["primary_tag"] is None
    assert row["reason"] == "temporal_sequence_not_proven_by_cited_evidence"
    assert len(row["evidence_ids"]) == reference_count

    # Restored canonical response skips the wire decoder but must receive the
    # same conservative result from the full stored-result validator.
    cached = result["module_results"]["visual"]["response"]["classifications"]
    motion = next(row for row in cached if row["dimension_id"] == "visual.camera_motion")
    motion.update(state="known", tags=["visual.camera_motion.static"],
                  primary_tag="visual.camera_motion.static", reason=None)
    resumed = build_content_analysis_bundle(*inputs, lambda *_args: pytest.fail("cache must revalidate locally"),
        review_context=review, resume_modules=result["module_results"])
    row = next(row for row in resumed["content_analysis"]["classifications"]
               if row["dimension_id"] == "visual.camera_motion")
    assert row["state"] == "unknown"


@pytest.mark.parametrize("violation", ["duplicate", "out_of_range", "finding_duplicate"])
def test_v12_large_classification_limit_keeps_reference_hard_gates(violation):
    inputs, review = extended_reviewed_inputs()
    _, definitions, registry, base = _initial_content_state(*inputs, review_context=review)
    requested = [row for row in definitions.values() if row["module"] == "visual"]
    payload, _evidence, _complete = _module_payload("visual", requested, registry, list(base.values()),
        "max", {}, "asr", compact=True, review_context=review)
    wire, context = prepare_compact_request("visual", payload)
    response = compact_synthetic_response("visual", wire, 1_000)
    if violation == "finding_duplicate":
        response["f"][0]["e"] = [0, 0]
    elif violation == "duplicate":
        response["c"][0]["e"] = [0, 0]
    else:
        response["c"][0]["e"] = [len(wire["e"])]
    with pytest.raises(CompactProtocolError):
        decode_compact_response(response, context)


def test_v11_decoder_and_default_sdk_still_reject_more_than_eight_classification_refs():
    inputs, _review = extended_reviewed_inputs()
    _, definitions, registry, base = _initial_content_state(*inputs)
    requested = [row for row in definitions.values() if row["module"] == "visual"]
    payload, _evidence, _complete = _module_payload("visual", requested, registry, list(base.values()),
        "max", {}, "asr", compact=True)
    wire, context = prepare_compact_request("visual", payload)
    response = compact_synthetic_response("visual", wire, 1_000)
    response["c"][0]["e"] = list(range(9))
    with pytest.raises(CompactProtocolError, match="compact_evidence_index"):
        decode_compact_response(response, context)
    with pytest.raises(ValueError):
        create_compact_response_model("visual", dimension_count=len(wire["d"])).model_validate(response)


def test_visual_selection_and_signature_are_independent_of_large_review_metadata():
    inputs, _review = reviewed_inputs(())
    media, _transcript, visuals = inputs
    media.info.duration_ms = 120_000
    first_frame = visuals.keyframes[0]
    for index in range(4, 88):
        time = index * 1_000
        visuals.keyframes.append(SimpleNamespace(timestamp_ms=time, path=first_frame.path,
            asset_id=f"synthetic_dense_{index}", ocr_text=f"页面{index}" + "密集页面文字。" * 90,
            roles=("representative",)))
        visuals.observations.append(SimpleNamespace(kind="vision", start_ms=time, end_ms=time,
            text=f"画面{index}" + "真实画面内人物和文字版式有明确来源，模型只能判断这一抽样画面。" * 12))
    wires = []
    selected = []
    for pending in ({5}, set(range(2, 64))):
        segments = [SimpleNamespace(start_ms=index * 1_500, end_ms=index * 1_500 + 1_400,
                    text="" if index + 1 in pending else "这一条是已经核对的安全句子。") for index in range(66)]
        transcript = SimpleNamespace(segments=segments)
        review = {"total_segments": 66, "accepted_segments": 66 - len(pending),
            "uncertain_segment_ids": [f"transcript:{index:04d}" for index in sorted(pending)],
            "uncertain_ranges": [{"source_segment_id": f"transcript:{index:04d}",
                "start_ms": segments[index-1].start_ms, "end_ms": segments[index-1].end_ms}
                for index in sorted(pending)], "first_source_segment_id": "transcript:0001"}
        _, dimensions, registry, base = _initial_content_state(media, transcript, visuals, review)
        requested = [row for row in dimensions.values() if row["module"] == "visual"]
        payload, evidence, _ = _module_payload("visual", requested, registry, list(base.values()),
            "max", {}, "asr", compact=True, review_context=review)
        wire, _context = prepare_compact_request("visual", payload)
        wires.append(wire)
        selected.append(set(evidence))
    assert selected[0] == selected[1]
    assert wires[0]["e"] == wires[1]["e"] and wires[0]["d"] == wires[1]["d"]
    assert compact_signature(wires[0]) == compact_signature(wires[1])
    assert wires[0]["coverage"]["uncertain_segment_count"] != wires[1]["coverage"]["uncertain_segment_count"]


@pytest.mark.parametrize("field", ["g", "u", "f"])
@pytest.mark.parametrize("invalid", ["duplicate", "out_of_range", "over_24"])
def test_v12_event_unit_finding_refs_still_reject_invalid_evidence(field, invalid):
    inputs, review = extended_reviewed_inputs()
    _, definitions, registry, base = _initial_content_state(*inputs, review_context=review)
    requested = [row for row in definitions.values() if row["module"] == MODULES[1]]
    payload, _evidence, _complete = _module_payload(MODULES[1], requested, registry, list(base.values()),
        "max", {}, "asr", compact=True, review_context=review)
    wire, context = prepare_compact_request(MODULES[1], payload)
    response = compact_synthetic_response(MODULES[1], wire, 1_000)
    assert response[field]
    refs = [0, 0] if invalid == "duplicate" else [len(wire["e"])] if invalid == "out_of_range" else list(range(25))
    response[field][0]["e"] = refs
    with pytest.raises(CompactProtocolError):
        decode_compact_response(response, context)


def overflow_reviewed_payload(module="visual"):
    inputs, review = extended_reviewed_inputs()
    visuals = inputs[2]
    for index, time in enumerate((5_300, 5_400, 5_500), 20):
        visuals.keyframes.append(SimpleNamespace(timestamp_ms=time, path=visuals.keyframes[0].path,
            asset_id=f"synthetic_overflow_{index}", ocr_text=f"明确可见文字{index}", roles=("representative",)))
        visuals.observations.append(SimpleNamespace(kind="vision", start_ms=time, end_ms=time,
            text=f"真实画面{index}显示会议步骤。"))
    _, definitions, registry, base = _initial_content_state(*inputs, review_context=review)
    requested = [row for row in definitions.values() if row["module"] == module]
    payload, _evidence, _complete = _module_payload(module, requested, registry, list(base.values()),
        "max", {}, "asr", compact=True, review_context=review)
    wire, context = prepare_compact_request(module, payload)
    return inputs, review, payload, wire, context


def test_v12_over_limit_but_real_unique_refs_are_only_one_unknown_row_without_truncation():
    _inputs, _review, _payload, wire, context = overflow_reviewed_payload()
    response = compact_synthetic_response("visual", wire, 1_000)
    dimension = next(row for row in wire["d"] if row["n"] == "首帧信息")
    assert len(wire["e"]) >= 30
    response["c"][dimension["i"]] = {"d": dimension["i"], "s": 0, "t": [0], "e": list(range(30))}
    with pytest.raises(ValueError):
        create_compact_response_model("visual", dimension_count=len(wire["d"]), evidence_reference_limit=24).model_validate(response)
    decoded, _findings = decode_compact_response(response, context)
    row = next(row for row in decoded["classifications"] if row["dimension_id"] == "visual.first_frame_information")
    assert row == {"dimension_id": "visual.first_frame_information", "state": "unknown", "tags": None,
        "primary_tag": None, "reason": "classification_reference_limit_exceeded", "evidence_ids": []}
    assert len(response["c"][dimension["i"]]["e"]) == 30  # raw candidate is not mutated/truncated


def test_v12_tag_out_of_range_with_valid_dimension_is_unknown_and_other_labels_survive():
    _inputs, _review, _payload, wire, context = overflow_reviewed_payload(MODULES[0])
    response = compact_synthetic_response(MODULES[0], wire, 1_000)
    ending = next(index for index, row in enumerate(context.dimensions) if row["id"] == "structure.ending")
    response["c"][ending] = {"d": ending, "s": 0, "t": [8, 14], "e": [0]}
    decoded, _findings = decode_compact_response(response, context)
    row = next(row for row in decoded["classifications"] if row["dimension_id"] == "structure.ending")
    assert row["state"] == "unknown" and row["tags"] is None and row["primary_tag"] is None and row["evidence_ids"] == []
    assert row["reason"] == "classification_tag_index_not_in_taxonomy"
    assert next(row for row in decoded["classifications"] if row["dimension_id"] == "topic.category")["state"] == "known"


@pytest.mark.parametrize("violation", ["bad_d", "duplicate_d", "bad_ref", "duplicate_ref", "bad_shape", "bad_tag_shape"])
def test_local_unknown_never_masks_hard_dimension_shape_or_reference_errors(violation):
    _inputs, _review, _payload, wire, context = overflow_reviewed_payload()
    response = compact_synthetic_response("visual", wire, 1_000)
    row = response["c"][0]
    row.update(s=0, t=[999_999], e=list(range(30)))
    if violation == "bad_d": row["d"] = 999_999
    elif violation == "duplicate_d": row["d"] = response["c"][1]["d"]
    elif violation == "bad_ref": row["e"][-1] = len(wire["e"])
    elif violation == "duplicate_ref": row["e"][-1] = row["e"][0]
    elif violation == "bad_shape": row["unexpected"] = True
    else: row["t"] = ["not_an_index"]
    with pytest.raises(CompactProtocolError):
        decode_compact_response(response, context)


def test_sdk_rejected_bounded_candidate_is_locally_normalized_once_without_paid_retry(caplog):
    import logging
    inputs, review, _payload, _wire, _context = overflow_reviewed_payload()
    calls = []
    checkpoints = {}
    caplog.set_level(logging.INFO, logger="liming_analyzer.content_analysis")

    class SdkShapeError(RuntimeError):
        pass

    def request(module, wire, cap):
        calls.append(module)
        response = compact_synthetic_response(module, wire, cap)
        if module == "visual":
            dimension = next(row for row in wire["d"] if row["n"] == "首帧信息")
            response["c"][dimension["i"]] = {"d": dimension["i"], "s": 0, "t": [0], "e": list(range(30))}
            with pytest.raises(ValueError):
                create_compact_response_model(module, dimension_count=len(wire["d"]), evidence_reference_limit=24).model_validate(response)
            error = SdkShapeError("bounded SDK shape rejection")
            error.safe_candidate = response
            raise error
        return response

    result = build_content_analysis_bundle(*inputs, request, profile="max", review_context=review,
        on_module_checkpoint=lambda key, value: checkpoints.update({key: value}))
    assert calls.count("visual") == 1
    assert "visual" in checkpoints
    assert result["content_analysis"]["module_status"]["visual"]["status"] == "completed"
    assert "local_normalization module=visual source=sdk_candidate" in caplog.text

    calls.clear()
    cached = build_content_analysis_bundle(*inputs, request, profile="max", review_context=review,
        resume_modules=result["module_results"])
    assert calls == [] and cached["content_analysis"]["status"] == "complete"
