"""Offline compact-wire, bounded parallelism, and evidence-bound cache regressions."""

import copy
import importlib.util
import json
import threading
import unittest
from concurrent.futures import ALL_COMPLETED
from concurrent.futures import wait as wait_for_all
from dataclasses import replace
from unittest.mock import patch

from test_content_analysis import synthetic_inputs

from liming_analyzer.content_analysis import (
    MODULES,
    _checked_bundle_module,
    _initial_content_state,
    _module_payload,
    build_content_analysis_bundle,
    estimate_content_tokens,
)
from liming_analyzer.content_module_protocol import (
    FINDING_SECTIONS,
    PROTOCOL_VERSION,
    CompactProtocolError,
    create_compact_response_model,
    decode_compact_response,
    omission_tolerance,
    prepare_compact_request,
)


def wire_label_index(table, label):
    return next(int(index) for index, value in table.items() if value == label)


def compact_synthetic_response(module, wire, _budget):
    """Use labels solely to construct an offline model response with numeric indices."""
    classes = [{"d": index, "s": 1} for index in range(len(wire["d"]))]
    dimensions = {row["n"]: index for index, row in enumerate(wire["d"])}
    sources = {code: [index for index, row in enumerate(wire["e"]) if row["s"] == code]
               for code in ("t", "o", "v", "g")}
    def known(name, labels, refs):
        if name not in dimensions or not refs:
            return
        index = dimensions[name]
        tags = [wire_label_index(wire["d"][index]["t"], label) for label in labels]
        classes[index] = {"d": index, "s": 0, "t": tags, "e": refs,
                          "p": tags[0] if wire["d"][index]["p"] and tags else None}
    g, units = [], []
    text = sources["t"]
    if module == MODULES[0] and text:
        known("选题赛道", ["职场成长"], text[:1])
        known("问题类型", ["不会做"], text[:1])
        known("选题粒度", ["具体问题"], text[:1])
        known("整体结构", ["问题解决"], text[:2])
        known("段落功能", ["问题"], text[:1])
        for kind, sentence, tag in ((0, "将会议记录转成明确待办。", None),
                                    (1, "会后缺少下一步明确行动。", None),
                                    (3, "先提出会后不知道做什么的问题。", "问题")):
            option = wire["g"][kind]
            tags = [] if tag is None else [wire_label_index(option["t"], tag)]
            g.append({"k": option["k"], "t": tags, "e": text[:1], "x": sentence})
    elif module == MODULES[1] and len(text) >= 2:
        known("开头Hook", ["提问"], text[:1])
        known("行动引导", ["立即实践"], text[1:2])
        known("CTA出现位置", ["结尾"], text[1:2])
        known("信息点类型", ["行动步骤"], text[1:2])
        g.append({"k": "cta", "t": [wire_label_index(wire["g"][0]["t"], "立即实践")],
                  "e": text[1:2], "x": "下次开会就照这三项整理。"})
        units.append({"t": wire_label_index(wire["u"], "行动步骤"), "e": text[1:2],
                      "x": "待办明确动作、负责人和截止时间。", "q": None})
    elif module == "visual" and sources["v"]:
        known("首帧样式", ["人物+标题"], sources["v"][:1])
        known("内容表现形式", ["真人口播"], sources["v"][:1])
        if sources["g"] and len(sources["v"]) >= 3:
            known("镜头运动", ["固定"], [*sources["v"][:3], sources["g"][0]])
    elif module == "synthesis" and len(text) >= 2:
        known("开头与正文对应", ["已展开"], text[:2])
        g.append({"k": "content_template", "t": [], "e": text[:2],
                  "x": "提出会后行动不清的问题，再给出动作、负责人和截止时间。"})
    reference = (sources["v"] if module == "visual" else text or sources["v"] or sources["o"])[:1]
    findings = [{"k": index, "e": reference, "x": label + "：合成证据支持的简短结论。"}
                for index, (_section, label) in enumerate(FINDING_SECTIONS[module])]
    return {"c": classes, "g": g, "u": units, "f": findings}


def wire_guided_response(_module, wire, _budget):
    """No taxonomy or hidden validator knowledge: use the published wire tables.

    The synthetic source explicitly names its audience, feeling and repeated
    action, so these known results have positive support instead of filling the
    table with unknowns to pass the gate.
    """
    classes = {index: {"d": index, "s": 1} for index in wire["expected_d"]}
    dimensions = {row["n"]: row for row in wire["d"]}
    text = [row["i"] for row in wire["e"] if row["s"] == "t"]
    vision = [row["i"] for row in wire["e"] if row["s"] == "v"]
    events, units = [], []

    def known(name, labels, evidence):
        if name not in dimensions:
            return None
        dimension = dimensions[name]
        tags = [wire_label_index(dimension["t"], label) for label in labels]
        if dimension["one"]:
            assert len(tags) <= 1
        assert dimension["z"] not in tags or tags == [dimension["z"]]
        classes[dimension["i"]] = {"d": dimension["i"], "s": 0, "t": tags, "e": evidence}
        return dimension

    if wire["m"] == "text_topic_structure_audience":
        known("选题赛道", ["职场成长"], text[:1])
        known("问题类型", ["不会做"], text[:1])
        known("选题粒度", ["具体问题"], text[:1])
        known("整体结构", ["问题解决"], text[:2])
        known("段落功能", ["问题"], text[:1])
        known("知识前提", ["零基础"], text[:1])
        for kind in wire["g"]:
            if kind["n"] not in {"具体主题", "本条实际问题", "语义段落角色"}:
                continue
            tags = [wire_label_index(kind["t"], "问题")] if kind["positive_tags_required"] else []
            events.append({"k": kind["k"], "t": tags, "e": text[:1],
                           "x": "会议结束后缺少下一步行动，需要把记录变成明确待办。"})
    elif wire["m"] == "text_expression_value":
        known("开头Hook", ["提问"], text[:1])
        known("可操作程度", ["可直接执行"], text[1:2])
        known("行动引导", ["立即实践"], text[1:2])
        known("CTA出现位置", ["结尾"], text[1:2])
        known("内容呈现的情绪", ["焦虑"], text[:1])
        known("重复内容", ["必要重申"], text[1:2])
        known("信息点类型", ["行动步骤"], text[1:2])
        for kind in wire["g"]:
            dimension = dimensions[{"cta": "行动引导", "emotion": "内容呈现的情绪", "repetition": "重复内容"}[kind["k"]]]
            classification = classes[dimension["i"]]
            assert kind["positive_tags_required"]
            events.append({"k": kind["k"], "t": classification["t"], "e": classification["e"],
                           "x": "下次开会就照这三项整理。" if kind["n"] == "实际CTA原句"
                           else "明确表示焦虑。" if kind["n"] == "文本情绪区间" else "再次强调动作、负责人、截止时间。"})
        units.append({"t": wire_label_index(wire["u"], "行动步骤"), "e": text[1:2],
                      "x": "把会议记录拆成动作、负责人和截止时间。"})
    elif wire["m"] == "visual":
        for name, label in (("首帧样式", "人物+标题"), ("首帧信息", "主题说明"),
                            ("前3秒画面", "人物直视"), ("内容表现形式", "真人口播"),
                            ("镜头运动", "固定"), ("镜头稳定性", "稳定固定")):
            dimension = dimensions[name]
            refs = dimension.get("anchor_e", vision)[:1]
            if dimension["need"] == "temporal":
                group = wire["e"][dimension["group_e"][0]]
                refs = group["required_e"]
                assert group["s"] == "g" and len(group["v"]) >= 3
                assert all(wire["e"][index]["s"] == "v" for index in group["v"])
            known(name, [label], refs)
    else:
        known("开头与正文对应", ["已展开"], text[:2])
    refs = vision[:1] if wire["m"] == "visual" else text[:1]
    findings = [{"k": int(index), "e": refs, "x": label + "：围绕会议待办给出有依据的分析。"}
                for index, label in wire["f"].items()]
    return {"c": list(classes.values()), "g": events, "u": units, "f": findings}


def module_payload(module, profile="max"):
    media, transcript, visuals = synthetic_inputs()
    _taxonomy, dimensions, registry, base = _initial_content_state(media, transcript, visuals)
    requested = [row for row in dimensions.values() if row["module"] == module]
    payload, _evidence, _complete = _module_payload(
        module, requested, registry, list(base.values()), profile,
        {"media": {"duration_ms": 6_000}}, "asr", compact=True,
    )
    return payload


class CompactProtocolTests(unittest.TestCase):
    def test_missing_non_temporal_required_modality_is_unknown_with_legal_refs_preserved(self):
        for missing in ("visual", "text"):
            with self.subTest(missing=missing):
                def request(module, wire, budget, missing=missing):
                    raw = compact_synthetic_response(module, wire, budget)
                    if module == "synthesis":
                        dimension = next(row for row in wire["d"] if row.get("text_required"))
                        source = "t" if missing == "visual" else "v"
                        reference = next(row["i"] for row in wire["e"] if row["s"] == source)
                        raw["c"][dimension["i"]] = {"d": dimension["i"], "s": 0, "t": [0], "e": [reference]}
                    return raw
                result = build_content_analysis_bundle(*synthetic_inputs(), request)
                self.assertEqual(result["content_analysis"]["status"], "complete")
                row = next(row for row in result["content_analysis"]["classifications"]
                           if row["dimension_id"] == "synthesis.visual_text_relation")
                self.assertEqual((row["state"], row["tags"], row["primary_tag"], row["reason"]),
                                 ("unknown", None, None, "required_modalities_not_cited"))
                self.assertEqual(len(row["evidence_ids"]), 1)
                self.assertTrue(row["evidence_ids"][0].startswith("transcript:" if missing == "visual" else "vision:"))
                self.assertTrue(result["findings_by_module"]["synthesis"])

    def test_cached_non_temporal_modality_failure_is_unknown_without_new_model_calls(self):
        def request(module, wire, budget):
            raw = compact_synthetic_response(module, wire, budget)
            if module == "synthesis":
                dimension = next(row for row in wire["d"] if row.get("text_required"))
                references = [next(row["i"] for row in wire["e"] if row["s"] == source) for source in ("t", "v")]
                raw["c"][dimension["i"]] = {"d": dimension["i"], "s": 0, "t": [0], "e": references}
            return raw
        original = build_content_analysis_bundle(*synthetic_inputs(), request)
        cache = copy.deepcopy(original["module_results"])
        row = next(row for row in cache["synthesis"]["response"]["classifications"]
                   if row["dimension_id"] == "synthesis.visual_text_relation")
        self.assertEqual(row["state"], "known")
        row["evidence_ids"] = [ref for ref in row["evidence_ids"] if ref.startswith("vision:")]
        def no_call(*_args):
            raise AssertionError("valid module caches must not create a new request")
        resumed = build_content_analysis_bundle(*synthetic_inputs(), no_call, resume_modules=cache)
        self.assertEqual(resumed["content_analysis"]["status"], "complete")
        row = next(row for row in resumed["module_results"]["synthesis"]["response"]["classifications"]
                   if row["dimension_id"] == "synthesis.visual_text_relation")
        self.assertEqual((row["state"], row["tags"], row["reason"]),
                         ("unknown", None, "required_modalities_not_cited"))

    def test_modality_unknown_normalization_cannot_bypass_temporal_or_first_frame_gates(self):
        payload = module_payload("visual")
        wire, context = prepare_compact_request("visual", payload)
        _taxonomy, _definitions, _registry, base = _initial_content_state(*synthetic_inputs())
        decoded, findings = decode_compact_response(compact_synthetic_response("visual", wire, 6_000), context)
        for variation in ("temporal_dimension", "temporal_tag", "first_frame"):
            with self.subTest(variation=variation):
                response = copy.deepcopy(decoded)
                key = {"temporal_dimension": "visual.camera_motion", "temporal_tag": "visual.opening",
                       "first_frame": "visual.first_frame_style"}[variation]
                row = next(row for row in response["classifications"] if row["dimension_id"] == key)
                if variation == "temporal_tag":
                    row.update(state="known", tags=["visual.opening.ongoing_action"],
                               primary_tag="visual.opening.ongoing_action", reason=None)
                row["evidence_ids"] = ["ocr:0001"] if variation == "first_frame" else ["vision:0001"]
                with self.assertRaises(CompactProtocolError):
                    _checked_bundle_module("visual", response, findings, payload, base, 6_000)

    def test_one_omitted_expression_dimension_preserves_valid_cta_and_upstream_caches(self):
        original = build_content_analysis_bundle(*synthetic_inputs(), compact_synthetic_response)
        upstream = {module: original["module_results"][module] for module in (MODULES[0], "visual")}
        calls = []
        def request(module, wire, budget):
            calls.append(module)
            raw = compact_synthetic_response(module, wire, budget)
            if module == MODULES[1]:
                omitted = next(row["i"] for row in wire["d"] if row["n"] == "记忆标识")
                raw["c"] = [row for row in raw["c"] if row["d"] != omitted]
                create_compact_response_model(module, dimension_count=len(wire["d"])).model_validate(raw)
            return raw
        result = build_content_analysis_bundle(*synthetic_inputs(), request, resume_modules=upstream)
        self.assertEqual(calls, [MODULES[1], "synthesis"])
        self.assertEqual(result["content_analysis"]["status"], "complete")
        row = next(row for row in result["content_analysis"]["classifications"]
                   if row["dimension_id"] == "language.memory_marker")
        self.assertEqual((row["state"], row["reason"], row["tags"], row["primary_tag"], row["evidence_ids"]),
                         ("unknown", "model_omitted_dimension", None, None, []))
        cta = next(row for row in result["content_analysis"]["classifications"] if row["dimension_id"] == "cta.action")
        self.assertEqual(cta["tags"], ["cta.action.practice"])
        self.assertTrue(any(row["kind"] == "cta" for row in result["content_analysis"]["segments"]))
        for module in upstream:
            self.assertEqual(result["module_results"][module]["signature"], upstream[module]["signature"])

    def test_small_omissions_are_unknown_and_other_returned_rows_remain_strict(self):
        for module in MODULES:
            wire, context = prepare_compact_request(module, module_payload(module))
            tolerance = omission_tolerance(len(wire["d"]))
            model = create_compact_response_model(module, dimension_count=len(wire["d"]))
            raw = compact_synthetic_response(module, wire, 6_000)
            if tolerance:
                del raw["c"][-tolerance:]
                model.model_validate(raw)
                decoded, _findings = decode_compact_response(raw, context)
                self.assertEqual(len(decoded["classifications"]), len(wire["d"]))
                self.assertEqual([row["dimension_id"] for row in decoded["classifications"]],
                                 [row["id"] for row in context.dimensions])
                omitted = decoded["classifications"][-tolerance:]
                self.assertTrue(all(row["state"] == "unknown" and row["reason"] == "model_omitted_dimension"
                                    and row["tags"] is None and row["primary_tag"] is None
                                    and row["evidence_ids"] == [] for row in omitted))
                self.assertTrue(any(row["state"] == "known" for row in decoded["classifications"][:-tolerance]))
            raw = compact_synthetic_response(module, wire, 6_000)
            del raw["c"][-(tolerance + 1):]
            with self.assertRaisesRegex(CompactProtocolError, "compact_missing_dimension"):
                decode_compact_response(raw, context)
        wire, context = prepare_compact_request(MODULES[1], module_payload(MODULES[1]))
        for variation in ("duplicate", "bad_dimension", "bad_tag", "single_multiple", "none_mixed"):
            with self.subTest(variation=variation):
                raw = compact_synthetic_response(MODULES[1], wire, 6_000)
                raw["c"].pop()
                if variation == "duplicate":
                    raw["c"][1]["d"] = raw["c"][0]["d"]
                elif variation == "bad_dimension":
                    raw["c"][0]["d"] = 999
                elif variation == "bad_tag":
                    raw["c"][0].update(s=0, t=[999], e=[0])
                elif variation == "single_multiple":
                    index = next(row["i"] for row in wire["d"] if row["n"] == "可操作程度")
                    raw["c"][index].update(s=0, t=[0, 1], e=[0])
                else:
                    dimension = next(row for row in wire["d"] if row["n"] == "内容呈现的情绪")
                    raw["c"][dimension["i"]].update(s=0, t=[0, dimension["z"]], e=[0])
                with self.assertRaises(CompactProtocolError):
                    decode_compact_response(raw, context)

    def test_wire_only_known_results_pass_the_complete_strict_gate(self):
        media, transcript, visuals = synthetic_inputs()
        transcript.segments[0].text = "零基础的同事开完会，还是不知道下一步做什么，我很焦虑。"
        transcript.segments[1].text = "把记录拆成动作、负责人、截止时间。再强调一次：动作、负责人、截止时间。下次开会就照这三项整理。"
        seen = {}
        def request(module, wire, budget):
            self.assertEqual(wire["expected_d"], [row["i"] for row in wire["d"]])
            self.assertEqual(list(range(len(wire["e"]))), [row["i"] for row in wire["e"]])
            self.assertIn("所有数字索引从0开始", "".join(wire["rules"]))
            seen[module] = wire
            raw = wire_guided_response(module, wire, budget)
            create_compact_response_model(module, dimension_count=len(wire["d"])).model_validate(raw)
            return raw
        result = build_content_analysis_bundle(media, transcript, visuals, request, profile="max", max_workers=2)
        content = result["content_analysis"]
        self.assertEqual(content["status"], "complete", content["validation"])
        self.assertTrue(content["validation"]["passed"], content["validation"])
        self.assertGreaterEqual(sum(row["state"] == "known" for row in content["classifications"]), 19)
        self.assertEqual(set(seen), set(MODULES))
        actions = [row for row in content["segments"] if row["kind"] in {"cta", "emotion", "repetition"}]
        self.assertEqual({row["kind"] for row in actions}, {"cta", "emotion", "repetition"})
        self.assertTrue(all(row["tags"] for row in actions))
        first = next(row for row in seen["visual"]["d"] if row.get("anchor") == "first_frame")
        self.assertTrue(first["anchor_e"])
        self.assertEqual(seen["visual"]["e"][first["anchor_e"][0]]["a"], 0)

    def test_full_fitting_canonical_text_precedes_auxiliary_frames_in_all_text_modules(self):
        media, transcript, visuals = synthetic_inputs()
        media.info.duration_ms = 128_000
        prototype = transcript.segments[0]
        transcript.segments = []
        for index in range(64):
            row = copy.deepcopy(prototype)
            row.start_ms, row.end_ms = index * 1_500, index * 1_500 + 1_000
            row.text = f"第{index + 1}条合成讲解，整理工作中的待办。"
            if index == 59:
                row.text = "如果你还没有尝试过这个方法，"
            elif index == 60:
                row.text = "真的推荐你立即去试一试。"
            transcript.segments.append(row)
        for index in range(120):
            frame = copy.deepcopy(visuals.keyframes[0])
            frame.timestamp_ms = 3_000 + index * 500
            frame.asset_id, frame.roles = f"auxiliary_frame_{index}", ()
            frame.ocr_text = "辅助画面中的重复说明。" * 10
            visuals.keyframes.append(frame)
            observation = copy.deepcopy(visuals.observations[0])
            observation.start_ms = observation.end_ms = frame.timestamp_ms
            observation.text = "辅助画面描述，不能挤掉实际结尾的行动引导。" * 30
            visuals.observations.append(observation)
        taxonomy, dimensions, registry, base = _initial_content_state(media, transcript, visuals)
        expected = [row.text for row in transcript.segments]
        for profile in ("standard", "max"):
            for module in (MODULES[0], MODULES[1], "synthesis"):
                with self.subTest(profile=profile, module=module):
                    payload, _evidence, _complete = _module_payload(
                        module, [row for row in dimensions.values() if row["module"] == module],
                        registry, list(base.values()), profile,
                        {"media": {"duration_ms": media.info.duration_ms}}, "asr", compact=True,
                    )
                    wire, _context = prepare_compact_request(module, payload)
                    self.assertEqual([row["x"] for row in wire["e"] if row["s"] == "t"], expected)
                    self.assertTrue(wire["coverage"]["valid_transcript_complete"])
                    budget = taxonomy["budgets"][profile]["compact"]
                    self.assertLessEqual(estimate_content_tokens(wire) + budget["sdk_schema_reserve_tokens"], budget["input_token_limit"])
                    self.assertFalse(payload["source_coverage"]["complete"])
                    if module == MODULES[1]:
                        self.assertTrue(payload["source_coverage"]["required_opening_complete"])
                        self.assertTrue(any(row["s"] == "g" and row["a"] == 0 for row in wire["e"]))

    def test_overlong_canonical_text_remains_bounded_and_declares_sampling(self):
        media, transcript, visuals = synthetic_inputs()
        media.info.duration_ms = 500_000
        prototype = transcript.segments[0]
        transcript.segments = []
        for index in range(300):
            row = copy.deepcopy(prototype)
            row.start_ms, row.end_ms = index * 1_000, index * 1_000 + 900
            row.text = "这是一段较长的合成讲解，用来验证全文无法容纳时仍然保留有界取证。" * 8
            transcript.segments.append(row)
        taxonomy, dimensions, registry, base = _initial_content_state(media, transcript, visuals)
        for module in (MODULES[0], MODULES[1], "synthesis"):
            with self.subTest(module=module):
                payload, _evidence, _complete = _module_payload(
                    module, [row for row in dimensions.values() if row["module"] == module],
                    registry, list(base.values()), "standard",
                    {"media": {"duration_ms": media.info.duration_ms}}, "asr", compact=True,
                )
                wire, _context = prepare_compact_request(module, payload)
                budget = taxonomy["budgets"]["standard"]["compact"]
                self.assertLessEqual(estimate_content_tokens(wire) + budget["sdk_schema_reserve_tokens"], budget["input_token_limit"])
                self.assertLess(sum(row["s"] == "t" for row in wire["e"]), 300)
                self.assertFalse(wire["coverage"]["valid_transcript_complete"])
                self.assertFalse(payload["source_coverage"]["complete"])
                if module == MODULES[1]:
                    self.assertTrue(payload["source_coverage"]["required_opening_complete"])

    def test_single_none_and_event_tag_rules_are_explicit_and_enforced(self):
        wire, context = prepare_compact_request(MODULES[1], module_payload(MODULES[1]))
        single = next(row for row in wire["d"] if row["n"] == "可操作程度")
        self.assertTrue(single["one"])
        self.assertIsNone(single["z"])
        none_dimension = next(row for row in wire["d"] if row["n"] == "内容呈现的情绪")
        for variation in ("single", "none_mixed", "cta_tags", "emotion_tags", "repetition_tags"):
            with self.subTest(variation=variation):
                raw = compact_synthetic_response(MODULES[1], wire, 6_000)
                if variation == "single":
                    raw["c"][single["i"]] = {"d": single["i"], "s": 0, "t": [0, 1], "e": [0]}
                    expected = "compact_single_tag_only"
                elif variation == "none_mixed":
                    raw["c"][none_dimension["i"]] = {"d": none_dimension["i"], "s": 0,
                                                    "t": [none_dimension["z"], 0], "e": [0]}
                    expected = "compact_none_is_exclusive"
                else:
                    kind = {"cta_tags": 0, "emotion_tags": 1, "repetition_tags": 2}[variation]
                    self.assertTrue(wire["g"][kind]["positive_tags_required"])
                    raw["g"] = [{"k": kind, "e": [0], "x": "有据片段"}]
                    expected = "compact_segment_positive_tags_required"
                with self.assertRaisesRegex(CompactProtocolError, expected):
                    decode_compact_response(raw, context)
        raw = compact_synthetic_response(MODULES[1], wire, 6_000)
        raw["c"][none_dimension["i"]] = {"d": none_dimension["i"], "s": 0, "t": [], "e": [0]}
        decoded, _findings = decode_compact_response(raw, context)
        absence = next(row for row in decoded["classifications"] if row["dimension_id"] == "emotion.expressed")
        self.assertEqual(absence["tags"], ["emotion.expressed.none"])
        other_wire, other_context = prepare_compact_request(MODULES[0], module_payload(MODULES[0]))
        beginner = next(row for row in other_wire["d"] if "零基础" in row["t"].values())
        self.assertIsNone(beginner["z"])
        raw = compact_synthetic_response(MODULES[0], other_wire, 6_000)
        raw["c"][beginner["i"]] = {"d": beginner["i"], "s": 0, "t": [wire_label_index(beginner["t"], "零基础")], "e": [0]}
        decoded, _findings = decode_compact_response(raw, other_context)
        row = next(row for row in decoded["classifications"] if row["dimension_id"] == "audience.knowledge")
        self.assertEqual(row["tags"], ["audience.knowledge.none"])
        self.assertEqual(row["state"], "known")

    def test_temporal_completion_requires_three_distinct_point_frames(self):
        wire, context = prepare_compact_request("visual", module_payload("visual"))
        evidence = list(context.evidence)
        first = next(index for index, row in enumerate(evidence) if row["source"] == "vision")
        for number in (1, 2):
            evidence.append({**evidence[first], "id": f"vision:same-frame-{number}"})
        raw = compact_synthetic_response("visual", wire, 6_000)
        motion = next(row["i"] for row in wire["d"] if row["n"] == "镜头运动")
        raw["c"][motion]["e"] = [first, len(evidence) - 2, len(evidence) - 1]
        with self.assertRaisesRegex(CompactProtocolError, "compact_temporal_requires_three_distinct_frames"):
            decode_compact_response(raw, replace(context, evidence=tuple(evidence)))

    def test_named_segment_kinds_use_direct_options_and_never_guess_legacy_wrong_kind(self):
        wire, context = prepare_compact_request(MODULES[1], module_payload(MODULES[1]))
        for option in wire["g"]:
            self.assertIsInstance(option["k"], str)
            self.assertNotIn("d", option)
            self.assertNotIn("i", option)
            self.assertIn("one", option)
            self.assertIn("z", option)
            self.assertTrue(option["t"])
        model = create_compact_response_model(MODULES[1], dimension_count=len(wire["d"]))
        raw = compact_synthetic_response(MODULES[1], wire, 6_000)
        model.model_validate(raw)
        self.assertEqual(raw["g"][0]["k"], "cta")
        legacy = copy.deepcopy(raw)
        cta_dimension = next(row["i"] for row in wire["d"] if row["n"] == "行动引导")
        legacy["g"][0].update(k=0, d=cta_dimension)
        decoded, _findings = decode_compact_response(legacy, context)
        self.assertEqual(decoded["segments"][0]["kind"], "cta")
        emotion = next(option for option in wire["g"] if option["k"] == "emotion")
        tags = [wire_label_index(emotion["t"], label) for label in ("兴奋", "愉悦")]
        raw["g"] = [{"k": "emotion", "t": tags, "e": [0], "x": "明确表达兴奋和愉悦。"}]
        model.model_validate(raw)
        decoded, _findings = decode_compact_response(raw, context)
        self.assertEqual(decoded["segments"][0]["dimension_id"], "emotion.expressed")
        self.assertEqual(decoded["segments"][0]["tags"], ["emotion.expressed.excitement", "emotion.expressed.pleasure"])
        raw["g"][0]["k"] = 0
        with self.assertRaisesRegex(CompactProtocolError, "compact_tag_index"):
            decode_compact_response(raw, context)

    def test_other_without_an_explanation_becomes_unknown_without_discarding_valid_results(self):
        for reason in (None, "", " \n\t ", "会议结束后的待办复盘属于其他具体场景。"):
            with self.subTest(reason=reason):
                def request(module, wire, budget, reason=reason):
                    raw = compact_synthetic_response(module, wire, budget)
                    if module == MODULES[0]:
                        dimension = next(row for row in wire["d"] if row["n"] == "使用场景")
                        raw["c"][dimension["i"]] = {"d": dimension["i"], "s": 0,
                                                     "t": dimension["r_for"], "r": reason, "e": [0]}
                    return raw
                result = build_content_analysis_bundle(*synthetic_inputs(), request)
                content = result["content_analysis"]
                self.assertEqual(content["status"], "complete", content["validation"])
                row = next(row for row in content["classifications"] if row["dimension_id"] == "audience.use_case")
                if reason and reason.strip():
                    self.assertEqual(row["state"], "known")
                    self.assertEqual(row["reason"], reason)
                else:
                    self.assertEqual(row["state"], "unknown")
                    self.assertIsNone(row["tags"])
                    self.assertIsNone(row["primary_tag"])
                    self.assertEqual(row["reason"], "other_category_explanation_missing")
                topic = next(row for row in content["classifications"] if row["dimension_id"] == "topic.category")
                self.assertEqual(topic["state"], "known")
                self.assertTrue(result["findings_by_module"][MODULES[0]])

    def test_three_real_sequence_refs_are_completed_before_the_original_strict_gate(self):
        def request(module, wire, budget):
            raw = compact_synthetic_response(module, wire, budget)
            if module == "visual":
                refs = [row["i"] for row in wire["e"] if row["s"] == "v"][:3]
                for dimension in wire["d"]:
                    if dimension["n"] in {"镜头运动", "前3秒画面"}:
                        raw["c"][dimension["i"]] = {"d": dimension["i"], "s": 0,
                                                      "t": [1] if dimension["n"] == "前3秒画面" else [0],
                                                      "e": refs}
            return raw
        result = build_content_analysis_bundle(*synthetic_inputs(), request)
        self.assertEqual(result["content_analysis"]["status"], "complete")
        for row in result["module_results"]["visual"]["response"]["classifications"]:
            if row["dimension_id"] in {"visual.camera_motion", "visual.opening"}:
                self.assertEqual(row["state"], "known")
                self.assertEqual(set(row["evidence_ids"]), {"temporal:opening", "vision:0001", "vision:0002", "vision:0003"})

    def test_temporal_completion_refuses_missing_ambiguous_cross_group_and_over_budget_proof(self):
        wire, context = prepare_compact_request("visual", module_payload("visual"))
        base_vision = [i for i, row in enumerate(context.evidence) if row["source"] == "vision"]
        group = next(i for i, row in enumerate(context.evidence) if row["source"] == "temporal")
        motion = next(row["i"] for row in wire["d"] if row["n"] == "镜头运动")
        for variation in ("two_frames", "non_point", "no_group", "missing_member", "ambiguous_group", "cross_group", "union_over_eight"):
            with self.subTest(variation=variation):
                evidence = copy.deepcopy(list(context.evidence))
                refs = base_vision[:3]
                if variation == "two_frames":
                    refs = base_vision[:2]
                elif variation == "non_point":
                    evidence[refs[0]]["end_ms"] += 1
                elif variation == "no_group":
                    evidence[group]["source"] = "ocr"
                elif variation == "missing_member":
                    evidence[group]["text"] = json.dumps({"timestamps_ms": [0, 500, 1_000, 1_500]})
                elif variation == "ambiguous_group":
                    evidence.append({**evidence[group], "id": "temporal:another-group"})
                else:
                    added = []
                    for number, timestamp in enumerate((1_500, 2_000, 2_500, 3_000, 3_500)):
                        added.append(len(evidence))
                        evidence.append({**evidence[base_vision[0]], "id": f"vision:extra-{number}",
                                         "start_ms": timestamp, "end_ms": timestamp})
                    if variation == "cross_group":
                        evidence.append({**evidence[group], "id": "temporal:later-group",
                                         "start_ms": 1_500, "end_ms": 2_500,
                                         "text": json.dumps({"timestamps_ms": [1_500, 2_000, 2_500]})})
                        refs = [*base_vision[:2], added[0]]
                    else:
                        evidence[group]["end_ms"] = 3_500
                        evidence[group]["text"] = json.dumps({"timestamps_ms": [0, 500, 1_000, 1_500, 2_000, 2_500, 3_000, 3_500]})
                raw = compact_synthetic_response("visual", wire, 6_000)
                raw["c"][motion]["e"] = refs
                with self.assertRaisesRegex(CompactProtocolError, "compact_temporal_"):
                    decode_compact_response(raw, replace(context, evidence=tuple(evidence)))

    def test_cached_temporal_proof_is_revalidated_without_repair_or_trusting_passed_flag(self):
        original = build_content_analysis_bundle(*synthetic_inputs(), compact_synthetic_response)
        cache = copy.deepcopy(original["module_results"])
        visual = cache["visual"]["response"]["classifications"]
        motion = next(row for row in visual if row["dimension_id"] == "visual.camera_motion")
        motion["evidence_ids"] = ["temporal:opening", "vision:0001"]
        calls = []
        def request(module, wire, budget):
            calls.append(module)
            return compact_synthetic_response(module, wire, budget)
        resumed = build_content_analysis_bundle(*synthetic_inputs(), request, resume_modules=cache)
        self.assertEqual(calls, ["visual"])
        self.assertEqual(resumed["content_analysis"]["status"], "complete")
        proof = next(row for row in resumed["module_results"]["visual"]["response"]["classifications"]
                     if row["dimension_id"] == "visual.camera_motion")
        self.assertEqual(set(proof["evidence_ids"]), {"temporal:opening", "vision:0001", "vision:0002", "vision:0003"})

    def test_anchor_and_full_temporal_group_requirements_do_not_weaken_modality_gates(self):
        for variation in ("first_frame_ocr", "opening_ocr", "temporal_group_only"):
            with self.subTest(variation=variation):
                def request(module, wire, budget, variation=variation):
                    raw = compact_synthetic_response(module, wire, budget)
                    if module != "visual":
                        return raw
                    dimension = next(row for row in wire["d"] if row["n"] == {
                        "first_frame_ocr": "首帧样式", "opening_ocr": "前3秒画面", "temporal_group_only": "镜头运动",
                    }[variation])
                    evidence = dimension.get("group_e") or [next(row["i"] for row in wire["e"] if row["s"] == "o")]
                    if dimension.get("group_e"):
                        group = wire["e"][evidence[0]]
                        self.assertEqual(group["required_e"], [group["i"], *group["v"]])
                    else:
                        self.assertTrue(dimension["anchor_e"])
                        self.assertNotIn(evidence[0], dimension["anchor_e"])
                    raw["c"][dimension["i"]] = {"d": dimension["i"], "s": 0, "t": [0], "e": evidence}
                    return raw
                result = build_content_analysis_bundle(*synthetic_inputs(), request)
                if variation == "opening_ocr":
                    self.assertEqual(result["content_analysis"]["status"], "complete")
                    row = next(row for row in result["content_analysis"]["classifications"]
                               if row["dimension_id"] == "visual.opening")
                    self.assertEqual((row["state"], row["reason"]), ("unknown", "required_modalities_not_cited"))
                else:
                    self.assertEqual(result["content_analysis"]["status"], "partial")
                    self.assertNotIn("visual", result["module_results"])
                    issues = result["content_analysis"]["module_status"]["visual"]["validation"]["issues"]
                    self.assertTrue(any("insufficient_evidence_modality" in issue or
                                        "compact_temporal_requires_three_vision_refs" in issue for issue in issues), issues)

    def test_complete_raw_failures_checkpoint_privately_on_the_caller_thread(self):
        caller = threading.get_ident()
        failed = {}
        def request(module, wire, budget):
            raw = compact_synthetic_response(module, wire, budget)
            if module == MODULES[0]:
                raw["c"].pop(2)
                raw["c"].pop(2)
            return raw
        def checkpoint(module, value):
            self.assertEqual(threading.get_ident(), caller)
            failed[module] = value
        result = build_content_analysis_bundle(*synthetic_inputs(), request, max_workers=2,
                                               on_module_failure=checkpoint)
        self.assertEqual(set(failed), {MODULES[0]})
        entry = failed[MODULES[0]]
        self.assertRegex(entry["signature"], r"^[a-f0-9]{64}$")
        self.assertEqual(entry["status"], "failed")
        self.assertFalse(entry["validation"]["passed"])
        self.assertIn("compact_missing_dimension_index:2", entry["validation"]["issues"])
        self.assertEqual(set(entry["candidate"]), {"c", "g", "u", "f"})
        self.assertNotIn(MODULES[0], result["module_results"])
        self.assertNotIn("candidate", json.dumps(result))
        self.assertLessEqual(len(json.dumps(entry["candidate"], ensure_ascii=False).encode("utf-8")), 65_536)

    def test_failure_candidate_bound_and_sdk_candidate_passthrough(self):
        for variation in ("sdk_complete", "sdk_no_candidate", "over_64k", "synthesis"):
            with self.subTest(variation=variation):
                failures = {}
                module = "synthesis" if variation == "synthesis" else MODULES[0]
                caller = threading.get_ident()
                def request(key, wire, budget, module=module, variation=variation):
                    raw = compact_synthetic_response(key, wire, budget)
                    if key != module:
                        return raw
                    if variation == "over_64k":
                        return {"invalid": "字" * 22_000}
                    if variation.startswith("sdk_"):
                        error = RuntimeError("private response must not appear in report")
                        error.safe_failure_kind = "schema_invalid"
                        error.safe_validation_issues = ["sdk_schema_invalid", "https://secret.invalid/?token=private"]
                        if variation == "sdk_complete":
                            error.safe_candidate = raw
                        raise error
                    raw["c"].pop()
                    return raw
                def checkpoint(key, value, caller=caller, failures=failures):
                    self.assertEqual(threading.get_ident(), caller)
                    failures[key] = value
                result = build_content_analysis_bundle(*synthetic_inputs(), request, on_module_failure=checkpoint)
                expected = {module} if variation in {"sdk_complete", "synthesis"} else set()
                self.assertEqual(set(failures), expected)
                if variation == "sdk_complete":
                    self.assertEqual(failures[module]["validation"]["issues"], ["sdk_schema_invalid"])
                self.assertNotIn("candidate", json.dumps(result))
                self.assertEqual(result["content_analysis"]["status"], "partial")

    def test_failure_checkpoint_ack_stops_new_calls_and_is_not_swallowed(self):
        for failing_module in (MODULES[0], "synthesis"):
            with self.subTest(failing_module=failing_module):
                calls = []
                def request(module, wire, budget, calls=calls, failing_module=failing_module):
                    calls.append(module)
                    raw = compact_synthetic_response(module, wire, budget)
                    if module == failing_module:
                        raw["c"].pop()
                        if module == MODULES[0]:
                            raw["c"].pop()
                    return raw
                def checkpoint(_module, _value):
                    raise RuntimeError("private checkpoint unavailable")
                with self.assertRaisesRegex(RuntimeError, "private checkpoint unavailable"):
                    build_content_analysis_bundle(*synthetic_inputs(), request, max_workers=1,
                                                   on_module_failure=checkpoint)
                self.assertEqual(calls, [MODULES[0]] if failing_module == MODULES[0] else list(MODULES))

    def test_parallel_returned_results_are_all_acknowledged_before_the_next_request(self):
        calls = []
        def request(module, wire, budget):
            calls.append(module)
            raw = compact_synthetic_response(module, wire, budget)
            if module == MODULES[0]:
                raw["c"].pop()
                raw["c"].pop()
            return raw
        def failure(_module, _value):
            raise RuntimeError("failed checkpoint not acknowledged")
        def both_results(pending, **_kwargs):
            done, waiting = wait_for_all(pending, return_when=ALL_COMPLETED)
            # Force the successful result first: it must not cause visual to be
            # scheduled before the already-returned failure is acknowledged.
            return sorted(done, key=lambda future: future.exception() is not None), waiting
        with (
            patch("liming_analyzer.content_analysis.wait", side_effect=both_results),
            self.assertRaisesRegex(RuntimeError, "failed checkpoint not acknowledged"),
        ):
            build_content_analysis_bundle(*synthetic_inputs(), request, max_workers=2,
                                           on_module_failure=failure)
        self.assertEqual(set(calls), set(MODULES[:2]))

    def test_numeric_round_trip_preserves_full_ids_and_source_envelope(self):
        payload = module_payload(MODULES[1])
        wire, context = prepare_compact_request(MODULES[1], payload)
        raw = compact_synthetic_response(MODULES[1], wire, 6_000)
        decoded, findings = decode_compact_response(raw, context)
        cta = next(row for row in decoded["classifications"] if row["dimension_id"] == "cta.action")
        self.assertEqual(cta["tags"], ["cta.action.practice"])
        segment = decoded["segments"][0]
        self.assertEqual((segment["start_ms"], segment["end_ms"]), (3_000, 5_900))
        self.assertEqual(segment["evidence_ids"], ["transcript:0002"])
        self.assertEqual(decoded["information_units"][0]["type_tag"], "value.information_type.step")
        self.assertEqual(len(findings), 6)
        self.assertNotIn("hook.type.question", json.dumps(wire))
        self.assertNotIn("customer-secret", json.dumps(wire))
        self.assertLess(estimate_content_tokens(wire), estimate_content_tokens(payload))
        hook_index = next(index for index, row in enumerate(wire["d"]) if row["n"] == "开头Hook")
        raw["c"][hook_index] = {"d": hook_index, "s": 0, "t": [
            wire_label_index(wire["d"][hook_index]["t"], "提问"), wire_label_index(wire["d"][hook_index]["t"], "痛点直击"),
        ], "e": [next(index for index, row in enumerate(wire["e"]) if row["s"] == "t")]}
        decoded, _findings = decode_compact_response(raw, context)
        hook = next(row for row in decoded["classifications"] if row["dimension_id"] == "hook.type")
        self.assertEqual(hook["primary_tag"], "hook.type.question")

    def test_out_of_range_indices_and_module_scope_are_rejected(self):
        for variation in ("dimension", "tag", "evidence", "duplicate_dimension", "visual_units", "visual_ocr_only"):
            with self.subTest(variation=variation):
                module = "visual" if variation.startswith("visual_") else MODULES[1]
                wire, context = prepare_compact_request(module, module_payload(module))
                raw = compact_synthetic_response(module, wire, 6_000)
                if variation == "dimension":
                    raw["c"][0]["d"] = 99
                elif variation == "tag":
                    raw["c"][0].update(s=0, t=[999])
                elif variation == "evidence":
                    raw["f"][0]["e"] = [999]
                elif variation == "duplicate_dimension":
                    raw["c"][1]["d"] = raw["c"][0]["d"]
                elif variation == "visual_units":
                    raw["u"] = [{"t": 0, "e": [0], "x": "不允许的单元"}]
                else:
                    raw["f"][0]["e"] = [next(i for i, row in enumerate(wire["e"]) if row["s"] == "o")]
                with self.assertRaises(CompactProtocolError):
                    decode_compact_response(raw, context)

    def test_complete_bundle_has_evidence_findings_and_legacy_content_shape(self):
        result = build_content_analysis_bundle(*synthetic_inputs(), compact_synthetic_response,
                                               profile="max", max_workers=2)
        content = result["content_analysis"]
        self.assertEqual(content["status"], "complete", content["validation"])
        self.assertTrue(content["validation"]["passed"], content["validation"])
        self.assertEqual(len(content["classifications"]), 65)
        self.assertEqual(content["methodology"]["transcript_basis"], "canonical")
        self.assertNotIn("findings", content)
        self.assertEqual(set(result["module_results"]), set(MODULES))
        evidence = {row["id"] for row in content["evidence_registry"]}
        for module in MODULES:
            self.assertTrue(result["findings_by_module"][module])
            self.assertTrue(all(set(row["evidence_ids"]).issubset(evidence)
                                for row in result["findings_by_module"][module]))

    def test_successful_modules_resume_without_paid_calls_and_bad_cache_revalidates(self):
        checkpoints = {}
        original = build_content_analysis_bundle(
            *synthetic_inputs(), compact_synthetic_response,
            on_module_checkpoint=lambda module, result: checkpoints.update({module: result}),
        )
        self.assertEqual(set(checkpoints), set(MODULES))
        def no_call(*_args):
            raise AssertionError("valid checkpoint must not invoke a model")
        resumed = build_content_analysis_bundle(*synthetic_inputs(), no_call, resume_modules=checkpoints)
        self.assertEqual(resumed["content_analysis"], original["content_analysis"])
        bad = copy.deepcopy(checkpoints)
        bad["visual"]["findings"][0]["evidence_ids"] = ["vision:9999"]
        calls = []
        def request(module, payload, budget):
            calls.append(module)
            return compact_synthetic_response(module, payload, budget)
        repaired = build_content_analysis_bundle(*synthetic_inputs(), request, resume_modules=bad)
        self.assertEqual(calls, ["visual"])
        self.assertEqual(repaired["content_analysis"]["status"], "complete")

    def test_profile_and_protocol_are_bound_to_resume_signature(self):
        standard = build_content_analysis_bundle(*synthetic_inputs(), compact_synthetic_response)
        calls = []
        def request(module, payload, budget):
            calls.append(module)
            self.assertEqual(payload["v"], PROTOCOL_VERSION)
            return compact_synthetic_response(module, payload, budget)
        result = build_content_analysis_bundle(*synthetic_inputs(), request, profile="max",
                                               resume_modules=standard["module_results"])
        self.assertEqual(set(calls), set(MODULES))
        self.assertEqual(result["content_analysis"]["status"], "complete")

    def test_concurrency_is_bounded_and_synthesis_runs_after_first_three(self):
        lock, barrier = threading.Lock(), threading.Barrier(2)
        active = 0
        maximum = 0
        ended = set()
        def request(module, payload, budget):
            nonlocal active, maximum
            with lock:
                active += 1
                maximum = max(maximum, active)
                if module == "synthesis":
                    self.assertEqual(ended, set(MODULES[:3]))
            if module in MODULES[:2]:
                barrier.wait(timeout=3)
            response = compact_synthetic_response(module, payload, budget)
            with lock:
                active -= 1
                ended.add(module)
            return response
        result = build_content_analysis_bundle(*synthetic_inputs(), request, max_workers=2)
        self.assertEqual(maximum, 2)
        self.assertEqual(result["content_analysis"]["status"], "complete")

    def test_failure_kind_is_safe_and_successful_modules_remain_checkpointable(self):
        calls = []
        def request(module, payload, budget):
            calls.append(module)
            if module == MODULES[1]:
                error = RuntimeError("https://private.invalid/?token=secret customer text")
                error.safe_failure_kind = "overloaded"
                raise error
            return compact_synthetic_response(module, payload, budget)
        result = build_content_analysis_bundle(*synthetic_inputs(), request, max_workers=2)
        self.assertEqual(result["content_analysis"]["status"], "partial")
        self.assertEqual(result["content_analysis"]["module_status"][MODULES[1]]["reason"], "overloaded")
        self.assertNotIn(MODULES[1], result["module_results"])
        self.assertEqual(len(result["module_results"]), 2)
        self.assertNotIn("synthesis", calls)
        self.assertEqual(result["content_analysis"]["module_status"]["synthesis"]["reason"], "upstream_module_failed")
        self.assertNotIn("token=secret", json.dumps(result))
        calls.clear()
        def repaired(module, payload, budget):
            calls.append(module)
            return compact_synthetic_response(module, payload, budget)
        resumed = build_content_analysis_bundle(*synthetic_inputs(), repaired,
                                               resume_modules=result["module_results"])
        self.assertEqual(calls, [MODULES[1], "synthesis"])
        self.assertEqual(resumed["content_analysis"]["status"], "complete")

    def test_explicit_inapplicable_visual_module_does_not_block_synthesis(self):
        media, transcript, visuals = synthetic_inputs()
        media.info.video_codec = None
        media.info.width = media.info.height = None
        visuals.keyframes, visuals.observations, visuals.stats = [], [], {}
        calls = []
        def request(module, payload, budget):
            calls.append(module)
            return compact_synthetic_response(module, payload, budget)
        result = build_content_analysis_bundle(media, transcript, visuals, request, max_workers=2)
        self.assertNotIn("visual", calls)
        self.assertIn("synthesis", calls)
        self.assertEqual(result["content_analysis"]["status"], "complete")
        self.assertEqual(result["content_analysis"]["module_status"]["visual"]["status"], "not_applicable")

    def test_checkpoint_ack_failure_stops_before_submitting_more_work(self):
        calls = []
        def request(module, payload, budget):
            calls.append(module)
            return compact_synthetic_response(module, payload, budget)
        def checkpoint(_module, _result):
            raise RuntimeError("checkpoint unavailable")
        with self.assertRaisesRegex(RuntimeError, "checkpoint unavailable"):
            build_content_analysis_bundle(*synthetic_inputs(), request, max_workers=1,
                                           on_module_checkpoint=checkpoint)
        self.assertEqual(calls, [MODULES[0]])

    @unittest.skipUnless(importlib.util.find_spec("pydantic"), "optional SDK dependency unavailable")
    def test_module_sdk_schema_forbids_irrelevant_arrays(self):
        for module in MODULES:
            wire, _context = prepare_compact_request(module, module_payload(module))
            raw = compact_synthetic_response(module, wire, 6_000)
            model = create_compact_response_model(module)
            model.model_validate(raw)
            schema = model.model_json_schema()
            self.assertFalse(schema["additionalProperties"])
            if module != MODULES[1]:
                self.assertEqual(schema["properties"]["u"]["maxItems"], 0)
            if module == "visual":
                self.assertEqual(schema["properties"]["g"]["maxItems"], 0)

    @unittest.skipUnless(importlib.util.find_spec("pydantic"), "optional SDK dependency unavailable")
    def test_sdk_schema_omission_bound_matches_the_current_request_including_na_subsets(self):
        from pydantic import ValidationError
        for module in MODULES:
            payload = module_payload(module)
            payload["dimensions"].pop()
            wire, _context = prepare_compact_request(module, payload)
            raw = compact_synthetic_response(module, wire, 6_000)
            model = create_compact_response_model(module, dimension_count=len(wire["d"]))
            model.model_validate(raw)
            schema = model.model_json_schema()["properties"]["c"]
            tolerance = omission_tolerance(len(wire["d"]))
            self.assertEqual((schema["minItems"], schema["maxItems"]), (len(wire["d"]) - tolerance, len(wire["d"])))
            del raw["c"][-(tolerance + 1):]
            with self.assertRaises(ValidationError):
                model.model_validate(raw)


if __name__ == "__main__":
    unittest.main()
