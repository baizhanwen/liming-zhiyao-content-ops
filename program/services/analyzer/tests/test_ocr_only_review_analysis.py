"""A pending speech slot does not erase independently observed screen text."""
from copy import deepcopy
from types import SimpleNamespace

from test_content_analysis import synthetic_inputs
from test_content_module_protocol import compact_synthetic_response, wire_label_index

from liming_analyzer.content_analysis import (
    MODULES,
    _initial_content_state,
    _validate_segments,
    build_content_analysis_bundle,
)


def pending_inputs(*, ocr=True):
    media, transcript, visuals = synthetic_inputs()
    transcript.segments = [SimpleNamespace(start_ms=0, end_ms=5900,
                                           text="口播候选实体_不得传出")]
    for frame in visuals.keyframes:
        frame.ocr_text = "会议待办三要素：会后行动清单" if ocr else None
    tail = deepcopy(visuals.keyframes[-1])
    tail.timestamp_ms, tail.roles = 5000, ("representative",)
    tail.ocr_text = "下次开会就照这三项整理。" if ocr else None
    visuals.keyframes.append(tail)
    visuals.observations.append(SimpleNamespace(kind="vision", start_ms=5000, end_ms=5000,
                                                text="结尾展示待办清单示意图。"))
    review = {"total_segments": 1, "accepted_segments": 0,
              "uncertain_segment_ids": ["transcript:0001"],
              "uncertain_ranges": [{"source_segment_id": "transcript:0001", "start_ms": 0, "end_ms": 5900}],
              "first_source_segment_id": "transcript:0001"}
    return (media, transcript, visuals), review


def observed_text_response(module, wire, budget):
    response = compact_synthetic_response(module, wire, budget)
    assert "口播候选实体_不得传出" not in str(wire)
    assert not any(row["s"] == "t" for row in wire["e"])
    if module not in MODULES[:2]:
        return response
    assert any("仅按输入o" in rule for rule in wire["rules"])
    title = next(row["i"] for row in wire["e"] if row["s"] == "o" and "会后行动清单" in row["x"])
    tail = next(row["i"] for row in wire["e"] if row["s"] == "o" and "下次开会" in row["x"])
    dimension = next(row for row in wire["d"] if row["n"] == ("选题赛道" if module == MODULES[0] else "行动引导"))
    tag = wire_label_index(dimension["t"], "职场成长" if module == MODULES[0] else "立即实践")
    response["c"][dimension["i"]] = {"d": dimension["i"], "s": 0, "t": [tag], "e": [title if module == MODULES[0] else tail]}
    if module == MODULES[0]:
        response["g"] = [{"k": "topic_subject", "t": [], "e": [title], "x": "可见文字介绍会议待办清单。"}]
    else:
        response["g"] = [{"k": "cta", "t": [wire_label_index(wire["g"][0]["t"], "立即实践")],
                          "e": [tail], "x": "下次开会就照这三项整理。"}]
    return response


def test_one_pending_asr_slot_still_allows_both_text_modules_from_real_ocr():
    inputs, review = pending_inputs()
    called = []
    def request(module, wire, budget):
        called.append(module)
        return observed_text_response(module, wire, budget)
    bundle = build_content_analysis_bundle(*inputs, request, review_context=review)
    assert set(called) == set(MODULES)
    content = bundle["content_analysis"]
    assert content["status"] == "complete", content["validation"]
    assert all(content["module_status"][module]["status"] == "completed" for module in MODULES)
    assert not any(row["source"] == "transcript" for row in content["evidence_registry"])
    assert all(content["module_status"][module]["source_coverage"]["review_limited"] for module in MODULES)


def test_one_pending_asr_slot_without_ocr_still_leaves_text_modules_unacquired():
    inputs, review = pending_inputs(ocr=False)
    called = []
    def request(module, wire, budget):
        called.append(module)
        return compact_synthetic_response(module, wire, budget)
    content = build_content_analysis_bundle(*inputs, request, review_context=review)["content_analysis"]
    assert set(called) == {"visual", "synthesis"}
    assert all(content["module_status"][module]["status"] == "not_acquired" for module in MODULES[:2])


def test_later_ocr_cannot_become_first_spoken_sentence_or_spoken_hook():
    inputs, review = pending_inputs()
    def request(module, wire, budget):
        response = observed_text_response(module, wire, budget)
        if module != MODULES[1]:
            return response
        tail = next(row["i"] for row in wire["e"] if row["s"] == "o" and "下次开会" in row["x"])
        for name, label in (("开头Hook", "直接指令"), ("Hook呈现渠道", "口播文案")):
            dimension = next(row for row in wire["d"] if row["n"] == name)
            response["c"][dimension["i"]] = {"d": dimension["i"], "s": 0,
                "t": [wire_label_index(dimension["t"], label)], "e": [tail]}
        return response
    content = build_content_analysis_bundle(*inputs, request, review_context=review)["content_analysis"]
    assert content["status"] == "complete", content["validation"]
    assert not any(row["kind"].startswith("hook_first") for row in content["segments"])
    assert all(row["state"] == "unknown" for row in content["classifications"]
               if row["dimension_id"] in {"hook.type", "hook.channel"})


def test_legacy_opening_annotations_cannot_promote_later_ocr_to_spoken_opening():
    inputs, review = pending_inputs()
    _, definitions, registry, _ = _initial_content_state(*inputs, review_context=review)
    evidence = {row["id"]: row for row in registry}
    tail = next(row for row in registry if row["source"] == "ocr" and row["start_ms"] == 5000)
    for kind in ("hook_first_sentence", "hook_first_3s"):
        row = {"id": "opening", "kind": kind, "dimension_id": None, "tags": [],
               "start_ms": 5000, "end_ms": 5000, "text": tail["text"], "evidence_ids": [tail["id"]]}
        issues = []
        assert _validate_segments([row], MODULES[1], definitions, evidence, 6000, issues, review) == []
        assert issues == []


def test_visible_opening_words_may_support_screen_text_hook_without_claiming_speech():
    inputs, review = pending_inputs()
    def request(module, wire, budget):
        response = observed_text_response(module, wire, budget)
        if module == MODULES[1]:
            first = next(row["i"] for row in wire["e"] if row["s"] == "o" and row["a"] == 0)
            dimension = next(row for row in wire["d"] if row["n"] == "Hook呈现渠道")
            response["c"][dimension["i"]] = {"d": dimension["i"], "s": 0,
                "t": [wire_label_index(dimension["t"], "画面文字")], "e": [first]}
        return response
    content = build_content_analysis_bundle(*inputs, request, review_context=review)["content_analysis"]
    channel = next(row for row in content["classifications"] if row["dimension_id"] == "hook.channel")
    assert channel["state"] == "known"
    assert channel["tags"] == ["hook.channel.on_screen_text"]


def test_only_failed_text_modules_are_requested_while_visual_and_synthesis_reuse_cache():
    inputs, review = pending_inputs()
    first = build_content_analysis_bundle(*inputs, observed_text_response, review_context=review)
    caches = {key: value for key, value in first["module_results"].items() if key not in MODULES[:2]}
    called = []
    def request(module, wire, budget):
        called.append(module)
        return observed_text_response(module, wire, budget)
    second = build_content_analysis_bundle(*inputs, request, review_context=review,
        resume_modules=caches, retry_module_keys=MODULES[:2], allow_revalidated_synthesis_cache=True)
    assert called == list(MODULES[:2])
    assert second["content_analysis"]["status"] == "complete"
    assert second["module_results"]["visual"]["signature"] == caches["visual"]["signature"]
    assert second["module_results"]["synthesis"]["signature"] == caches["synthesis"]["signature"]
