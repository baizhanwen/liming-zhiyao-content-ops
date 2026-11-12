"""Synthetic, offline checks for the shared taxonomy and evidence-bound annotations."""

import copy
import importlib.util
import json
import subprocess
import sys
import unittest
from pathlib import Path
from types import SimpleNamespace

from liming_analyzer.content_analysis import (
    MODULES,
    build_content_analysis,
    build_evidence_registry,
    create_content_response_model,
    estimate_content_tokens,
    load_taxonomy,
)


def synthetic_inputs():
    media = SimpleNamespace(info=SimpleNamespace(
        duration_ms=6_000, width=1080, height=1920, video_codec="h264", audio_codec="aac",
        rotation_degrees=0.0, sample_aspect_ratio="1:1",
    ))
    transcript = SimpleNamespace(segments=[
        SimpleNamespace(start_ms=0, end_ms=2_200, text="为什么开完会，还是没人知道下一步做什么？"),
        SimpleNamespace(start_ms=3_000, end_ms=5_900, text="把记录拆成动作、负责人、截止时间，下次开会就照这三项整理。"),
    ])
    visuals = SimpleNamespace(
        keyframes=[SimpleNamespace(
            timestamp_ms=time, path=Path(f"/private/customer-secret/frame-{index}.jpg"),
            asset_id=f"synthetic_frame_{index}", ocr_text="会议待办三要素" if index == 1 else None,
            roles=("first_frame", "opening", "temporal:opening") if index == 1
            else ("opening", "temporal:opening"),
        ) for index, time in enumerate((0, 500, 1_000), 1)],
        observations=[SimpleNamespace(
            kind="vision", start_ms=time, end_ms=time,
            text="单人居中讲解，画面标题为会议待办，人物位置和背景保持一致。",
        ) for time in (0, 500, 1_000)],
        stats={
            "evidence_version": "visual-evidence.v2", "sampling_strategy_id": "content-frames.v2",
            "sampling_config": {"opening_interval_ms": 500, "temporal_interval_ms": 500},
            "temporal_groups": [{
                "group_id": "opening", "kind": "opening", "start_ms": 0, "end_ms": 1_000,
                "timestamps_ms": [0, 500, 1_000], "source": "ordered_sampled_frames",
                "limitations": ["稀疏采样，仅支持这一采样窗口内的判断。"],
            }],
            "shot_detection": {"status": "measured", "method": "ffmpeg_scene_score.v1",
                               "threshold": 0.32, "boundaries_ms": [0, 6_000]},
        },
    )
    return media, transcript, visuals


def synthetic_response(module, payload, _budget):
    known = {
        "topic.category": ("topic.category.career", ["transcript:0001"]),
        "topic.problem": ("topic.problem.execution", ["transcript:0001"]),
        "topic.granularity": ("topic.granularity.problem", ["transcript:0001"]),
        "structure.type": ("structure.type.problem_solution", ["transcript:0001", "transcript:0002"]),
        "structure.role": ("structure.role.question", ["transcript:0001"]),
        "hook.type": ("hook.type.question", ["transcript:0001"]),
        "hook.channel": ("hook.channel.spoken_text", ["transcript:0001"]),
        "emotion.expressed": ("emotion.expressed.none", ["transcript:0001", "vision:0001"]),
        "value.evidence_form": ("value.evidence_form.none", ["transcript:0001", "transcript:0002"]),
        "value.information_type": ("value.information_type.step", ["transcript:0002"]),
        "language.memory_marker": ("language.memory_marker.none", ["transcript:0001", "transcript:0002"]),
        "cta.action": ("cta.action.practice", ["transcript:0002"]),
        "cta.position": ("cta.position.ending", ["transcript:0002"]),
        "visual.first_frame_style": ("visual.first_frame_style.person_title", ["vision:0001"]),
        "visual.camera_motion": ("visual.camera_motion.static", [
            "vision:0001", "vision:0002", "vision:0003", "temporal:opening",
        ]),
        "content.form": ("content.form.talking_head", ["vision:0001"]),
        "synthesis.opening_fulfillment": ("synthesis.opening_fulfillment.fulfilled", [
            "transcript:0001", "transcript:0002",
        ]),
    }
    available = {row["id"] for row in payload["evidence_registry"]}
    rows = []
    for dimension in payload["dimensions"]:
        identifier = dimension["id"]
        row = {"dimension_id": identifier, "state": "unknown", "tags": None,
               "primary_tag": None, "reason": "合成样本材料不足，保留无法判断。", "evidence_ids": []}
        if identifier in known and set(known[identifier][1]).issubset(available):
            tag, refs = known[identifier]
            row.update(state="known", tags=[tag], primary_tag=tag if dimension["primary_required"] else None,
                       reason=None, evidence_ids=refs)
        rows.append(row)
    segments = []
    units = []
    if module == "text_topic_structure_audience":
        segments.extend([{
            "id": "structure-one", "kind": "structure", "dimension_id": "structure.role",
            "tags": ["structure.role.question"], "start_ms": 0, "end_ms": 2_200,
            "text": "先提出会后缺少行动安排的问题。", "evidence_ids": ["transcript:0001"],
        }, {
            "id": "subject", "kind": "topic_subject", "dimension_id": "topic.category",
            "tags": ["topic.category.career"], "start_ms": None, "end_ms": None,
            "text": "将会议记录整理成明确的可执行待办。", "evidence_ids": ["transcript:0001", "transcript:0002"],
        }, {
            "id": "problem", "kind": "topic_problem", "dimension_id": "topic.problem",
            "tags": ["topic.problem.execution"], "start_ms": None, "end_ms": None,
            "text": "会后不知道具体下一步行动。", "evidence_ids": ["transcript:0001"],
        }])
    if module == "text_expression_value":
        segments.extend([{
            "id": "first-sentence", "kind": "hook_first_sentence", "dimension_id": "hook.type",
            "tags": ["hook.type.question"], "start_ms": 0, "end_ms": 2_200,
            "text": "为什么开完会，还是没人知道下一步做什么？", "evidence_ids": ["transcript:0001"],
        }, {
            "id": "cta-one", "kind": "cta", "dimension_id": "cta.action",
            "tags": ["cta.action.practice"], "start_ms": 3_000, "end_ms": 5_900,
            "text": "下次开会就照这三项整理。", "evidence_ids": ["transcript:0002"],
        }])
        units.extend([{
            "id": "one", "type_tag": "value.information_type.step",
            "text": "会后待办明确动作、负责人、截止时间。", "evidence_ids": ["transcript:0002"],
            "duplicate_of": None,
        }, {
            "id": "two", "type_tag": "value.information_type.step",
            "text": "会后待办明确动作、负责人、截止时间。", "evidence_ids": ["transcript:0002"],
            "duplicate_of": "one",
        }])
    return {"classifications": rows, "segments": segments, "information_units": units}


def build_synthetic_fixture():
    return build_content_analysis(*synthetic_inputs(), synthetic_response)


class ContentAnalysisTests(unittest.TestCase):
    def test_taxonomy_is_shared_complete_and_stable(self):
        taxonomy = load_taxonomy()
        self.assertEqual(taxonomy["version"], "video-taxonomy.v1")
        dimensions = taxonomy["dimensions"]
        self.assertEqual(len(dimensions), 65)
        self.assertEqual(len({row["id"] for row in dimensions}), 65)
        all_tags = [tag["id"] for row in dimensions for tag in row["tags"]]
        self.assertEqual(len(set(all_tags)), len(all_tags))
        hook = next(row for row in dimensions if row["id"] == "hook.type")
        self.assertEqual(len(hook["tags"]), 23)
        self.assertTrue(next(tag for tag in hook["tags"] if tag["id"] == "hook.type.sound")["disabled"])
        taxonomy["dimensions"].clear()
        self.assertEqual(len(load_taxonomy()["dimensions"]), 65)

    def test_complete_offline_fixture_and_measured_metrics(self):
        calls = []
        def request(module, payload, budget):
            calls.append((module, payload, budget))
            return synthetic_response(module, payload, budget)
        result = build_content_analysis(*synthetic_inputs(), request, transcript_source="manual")
        self.assertEqual([row[0] for row in calls], list(MODULES))
        self.assertEqual(result["status"], "complete", result["validation"])
        self.assertTrue(result["validation"]["passed"], result["validation"])
        self.assertEqual(len(result["classifications"]), 65)
        self.assertEqual(result["methodology"]["transcript_source"], "manual")
        self.assertEqual(result["metrics"]["version"], "content-metrics.v1")
        self.assertEqual(result["metrics"]["media"]["duration_ms"], 6_000)
        self.assertEqual(result["information_units"][1]["duplicate_of"], result["information_units"][0]["id"])
        self.assertNotIn("customer-secret", json.dumps(result, ensure_ascii=False))
        self.assertEqual(result["evidence_registry"][0]["text"], synthetic_inputs()[1].segments[0].text)
        self.assertTrue(all(estimate_content_tokens(payload) + 800 <= 6_000 for _, payload, _ in calls))

    def test_import_and_supplied_metrics_need_no_sdk(self):
        code = """
import builtins, sys
sys.path.insert(0, sys.argv[1])
original = builtins.__import__
def guarded(name, *args, **kwargs):
    if name.split('.')[0] in {'pydantic', 'openai', 'instructor', 'httpx'}:
        raise AssertionError('unexpected SDK import: ' + name)
    return original(name, *args, **kwargs)
builtins.__import__ = guarded
from liming_analyzer.content_analysis import build_content_analysis
result = build_content_analysis({}, {}, {}, lambda *args: None, metrics={})
assert len(result['classifications']) == 65
"""
        source = str(Path(__file__).resolve().parents[1])
        result = subprocess.run([sys.executable, "-B", "-c", code, source], capture_output=True,
                                text=True, check=False)
        self.assertEqual(result.returncode, 0, result.stderr)

    def test_request_failure_is_partial_safe_and_other_modules_continue(self):
        def request(module, payload, budget):
            if module == "text_expression_value":
                raise RuntimeError("https://secret.test?token=private /customer/private.txt")
            return synthetic_response(module, payload, budget)
        result = build_content_analysis(*synthetic_inputs(), request)
        self.assertEqual(result["status"], "partial")
        self.assertEqual(result["module_status"]["text_expression_value"]["status"], "failed")
        self.assertEqual(result["module_status"]["visual"]["status"], "completed")
        self.assertNotIn("secret.test", json.dumps(result))
        self.assertNotIn("private.txt", json.dumps(result))

    def test_invalid_model_labels_and_references_are_never_stored_as_known(self):
        mutations = {
            "invented_tag": {"tags": ["hook.type.magic"]},
            "disabled_sound": {"tags": ["hook.type.sound"], "primary_tag": "hook.type.sound"},
            "visual_hook_with_only_text": {"tags": ["hook.type.visual_action"],
                                           "primary_tag": "hook.type.visual_action"},
            "invalid_primary": {"primary_tag": "hook.type.benefit"},
            "fake_evidence": {"evidence_ids": ["transcript:9999"]},
            "known_without_evidence": {"evidence_ids": []},
            "none_combination": {"tags": ["hook.type.none", "hook.type.question"]},
            "known_empty_with_none_dictionary": {"tags": [], "primary_tag": None},
            "nonknown_nonnull": {"state": "unknown", "reason": "不确定"},
        }
        for label, mutation in mutations.items():
            with self.subTest(label=label):
                def request(module, payload, budget, change=mutation):
                    result = synthetic_response(module, payload, budget)
                    for row in result["classifications"]:
                        if row["dimension_id"] == "hook.type":
                            row.update(change)
                    return result
                result = build_content_analysis(*synthetic_inputs(), request)
                hook = next(row for row in result["classifications"] if row["dimension_id"] == "hook.type")
                self.assertEqual(hook["state"], "unknown")
                self.assertIsNone(hook["tags"])
                self.assertFalse(result["validation"]["passed"])

    def test_missing_visual_understanding_is_not_inferred_from_ocr_or_frames(self):
        media, transcript, visuals = synthetic_inputs()
        visuals.observations = []
        calls = []
        def request(module, payload, budget):
            calls.append(module)
            return synthetic_response(module, payload, budget)
        result = build_content_analysis(media, transcript, visuals, request)
        self.assertNotIn("visual", calls)
        self.assertEqual(result["module_status"]["visual"]["status"], "not_acquired")
        self.assertTrue(all(row["state"] == "not_acquired" for row in result["classifications"]
                            if row["dimension_id"].startswith("visual.") and row["dimension_id"] != "visual.cut_pattern"))
        retired = next(row for row in result["classifications"] if row["dimension_id"] == "visual.cut_pattern")
        self.assertEqual(retired["reason"], "analysis_dimension_retired")
        self.assertNotIn("temporal", {row["source"] for row in result["evidence_registry"]})

    def test_explicit_audio_only_marks_visual_not_applicable_and_completes_text_modules(self):
        media, transcript, visuals = synthetic_inputs()
        media.info.video_codec = None
        media.info.width = media.info.height = None
        visuals.keyframes = []
        visuals.observations = []
        visuals.stats = {}
        calls = []
        def request(module, payload, budget):
            calls.append(module)
            return synthetic_response(module, payload, budget)
        result = build_content_analysis(media, transcript, visuals, request)
        self.assertEqual(result["status"], "complete", result["validation"])
        self.assertTrue(result["validation"]["passed"], result["validation"])
        self.assertEqual(calls, [module for module in MODULES if module != "visual"])
        self.assertEqual(result["module_status"]["visual"]["status"], "not_applicable")
        self.assertEqual(result["module_status"]["visual"]["reason"], "no_video_track")
        rows = {row["dimension_id"]: row for row in result["classifications"]}
        for dimension in load_taxonomy()["dimensions"]:
            if dimension["requires"] in {"visual", "temporal"}:
                self.assertEqual(rows[dimension["id"]]["state"], "not_applicable")
                self.assertEqual(rows[dimension["id"]]["reason"],
                                 "analysis_dimension_retired" if dimension["id"] == "visual.cut_pattern" else "no_video_track")
        self.assertEqual(rows["synthesis.visual_text_relation"]["state"], "not_applicable")
        self.assertEqual(rows["topic.category"]["state"], "known")
        self.assertEqual(result["module_status"]["synthesis"]["status"], "completed")

    def test_missing_unknown_or_real_video_codec_does_not_hide_visual_failure(self):
        for variant in ("missing", "unknown", "real_video", "no_audio_either"):
            with self.subTest(variant=variant):
                media, transcript, visuals = synthetic_inputs()
                if variant == "missing":
                    del media.info.video_codec
                elif variant == "unknown":
                    media.info.video_codec = ""
                elif variant == "no_audio_either":
                    media.info.video_codec = None
                    media.info.audio_codec = None
                visuals.keyframes = []
                visuals.observations = []
                visuals.stats = {}
                result = build_content_analysis(media, transcript, visuals, synthetic_response,
                                                metrics={})
                self.assertEqual(result["status"], "partial")
                self.assertEqual(result["module_status"]["visual"]["status"], "not_acquired")
                row = next(item for item in result["classifications"]
                           if item["dimension_id"] == "visual.camera_motion")
                self.assertEqual(row["state"], "not_acquired")
                self.assertNotEqual(row["reason"], "no_video_track")

    def test_dynamic_opening_tags_and_visual_text_relation_need_their_modalities(self):
        def request(module, payload, budget):
            result = synthetic_response(module, payload, budget)
            for row in result["classifications"]:
                if row["dimension_id"] == "visual.opening":
                    row.update(state="known", tags=["visual.opening.montage"],
                               primary_tag="visual.opening.montage", reason=None,
                               evidence_ids=["vision:0001"])
                if row["dimension_id"] == "synthesis.visual_text_relation":
                    row.update(state="known", tags=["synthesis.visual_text_relation.demonstration"],
                               primary_tag="synthesis.visual_text_relation.demonstration", reason=None,
                               evidence_ids=["vision:0001"])
            return result
        result = build_content_analysis(*synthetic_inputs(), request)
        selected = {row["dimension_id"]: row for row in result["classifications"]}
        self.assertEqual(selected["visual.opening"]["state"], "unknown")
        self.assertEqual(selected["synthesis.visual_text_relation"]["state"], "unknown")
        self.assertFalse(result["validation"]["passed"])

    def test_temporal_groups_require_three_real_ordered_understood_frames(self):
        for variant in ("two", "unordered", "missing_frame", "missing_vision", "fabricated_time"):
            with self.subTest(variant=variant):
                media, transcript, visuals = synthetic_inputs()
                group = visuals.stats["temporal_groups"][0]
                if variant == "two":
                    group["timestamps_ms"] = [0, 500]
                if variant == "unordered":
                    group["timestamps_ms"] = [500, 0, 1_000]
                if variant == "missing_frame":
                    visuals.keyframes.pop()
                if variant == "missing_vision":
                    visuals.observations.pop()
                if variant == "fabricated_time":
                    group["timestamps_ms"] = [0, 500, 2_000]
                registry = build_evidence_registry(media, transcript, visuals)
                self.assertNotIn("temporal", {row["source"] for row in registry})
                result = build_content_analysis(media, transcript, visuals, synthetic_response)
                motion = next(row for row in result["classifications"] if row["dimension_id"] == "visual.camera_motion")
                self.assertEqual(motion["state"], "not_acquired")

    def test_long_inputs_are_bounded_and_absence_is_not_guessed_from_samples(self):
        media, transcript, visuals = synthetic_inputs()
        transcript.segments.extend(SimpleNamespace(
            start_ms=3_000, end_ms=5_900, text=f"第{index}项" + "这是需要独立检查的合成内容。" * 100,
        ) for index in range(100))
        calls = []
        def request(module, payload, budget):
            calls.append((module, copy.deepcopy(payload)))
            return synthetic_response(module, payload, budget)
        result = build_content_analysis(media, transcript, visuals, request)
        self.assertTrue(calls)
        self.assertTrue(all(estimate_content_tokens(payload) + 800 <= 6_000 for _, payload in calls))
        self.assertTrue(any(not payload["source_coverage"]["complete"] for _, payload in calls))
        self.assertEqual(result["status"], "complete", result["validation"])
        self.assertTrue(result["validation"]["passed"], result["validation"])
        absence = next(row for row in result["classifications"] if row["dimension_id"] == "value.evidence_form")
        self.assertEqual(absence["state"], "unknown")
        self.assertEqual(absence["reason"], "absence_not_verifiable_from_representative_sample")
        for _, payload in calls:
            by_id = {row["id"]: row for row in payload["evidence_registry"]}
            times = {row["start_ms"] for row in by_id.values() if row["source"] == "vision"}
            for row in by_id.values():
                if row["source"] == "temporal":
                    self.assertTrue(set(json.loads(row["text"])["timestamps_ms"]).issubset(times))

    def test_ordinary_many_frame_sampling_is_complete_with_explicit_coverage(self):
        media, transcript, visuals = synthetic_inputs()
        for index in range(80):
            timestamp = 3_000 + index * 30
            visuals.keyframes.append(SimpleNamespace(
                timestamp_ms=timestamp, path=Path("/private/not-read.jpg"),
                asset_id=f"synthetic_later_{index}", ocr_text=None, roles=(),
            ))
            visuals.observations.append(SimpleNamespace(
                kind="vision", start_ms=timestamp, end_ms=timestamp,
                text="这是稍后段落的合成画面，人物仍在居中展示会议待办内容。" * 8,
            ))
        result = build_content_analysis(media, transcript, visuals, synthetic_response)
        self.assertEqual(result["status"], "complete", result["validation"])
        self.assertTrue(result["validation"]["passed"], result["validation"])
        visual = result["module_status"]["visual"]
        self.assertEqual(visual["status"], "completed")
        self.assertEqual(visual["reason"], "representative_evidence_sample")
        self.assertFalse(visual["source_coverage"]["complete"])
        self.assertTrue(visual["source_coverage"]["required_opening_complete"])
        self.assertLess(visual["source_coverage"]["included_evidence_count"],
                        visual["source_coverage"]["available_evidence_count"])

    def test_missing_real_first_frame_understanding_is_partial_without_fabricated_tags(self):
        media, transcript, visuals = synthetic_inputs()
        visuals.observations = visuals.observations[1:]
        result = build_content_analysis(media, transcript, visuals, synthetic_response)
        self.assertEqual(result["status"], "partial")
        visual = result["module_status"]["visual"]
        self.assertFalse(visual["source_coverage"]["required_opening_complete"])
        first = next(row for row in result["classifications"] if row["dimension_id"] == "visual.first_frame_style")
        self.assertEqual(first["state"], "not_acquired")
        self.assertIsNone(first["tags"])

    def test_oversized_opening_keeps_first_frame_but_never_half_a_temporal_group(self):
        media, transcript, visuals = synthetic_inputs()
        for row in visuals.observations:
            row.text = "合成画面说明。" * 160
        captured = {}
        def request(module, payload, budget):
            captured[module] = payload
            return synthetic_response(module, payload, budget)
        result = build_content_analysis(media, transcript, visuals, request)
        payload = captured["visual"]
        sources = {row["id"] for row in payload["evidence_registry"]}
        self.assertIn("vision:0001", sources)
        self.assertIn("frame:0001", sources)
        self.assertNotIn("temporal:opening", sources)
        self.assertFalse(payload["source_coverage"]["opening_complete"])
        self.assertFalse(payload["source_coverage"]["complete"])
        self.assertLessEqual(estimate_content_tokens(payload) + 800, 6_000)
        self.assertEqual(result["status"], "partial")
        motion = next(row for row in result["classifications"] if row["dimension_id"] == "visual.camera_motion")
        self.assertNotEqual(motion["state"], "known")

    def test_no_cta_is_absence_not_an_occurrence(self):
        def request(module, payload, budget):
            result = synthetic_response(module, payload, budget)
            if module == "text_expression_value":
                result["segments"][1]["tags"] = ["cta.action.none"]
            return result
        result = build_content_analysis(*synthetic_inputs(), request)
        self.assertFalse(any(row["kind"] == "cta" for row in result["segments"]))
        self.assertFalse(result["validation"]["passed"])

    def test_positive_labels_without_annotations_become_unknown_instead_of_zero(self):
        def request(module, payload, budget):
            response = synthetic_response(module, payload, budget)
            response["segments"] = []
            response["information_units"] = []
            return response
        result = build_content_analysis(*synthetic_inputs(), request)
        rows = {row["dimension_id"]: row for row in result["classifications"]}
        for dimension in ("cta.action", "cta.position", "value.information_type", "structure.role",
                          "structure.type", "topic.problem", "topic.granularity"):
            with self.subTest(dimension=dimension):
                self.assertEqual(rows[dimension]["state"], "unknown")
                self.assertIsNone(rows[dimension]["tags"])
                self.assertTrue(rows[dimension]["reason"])
        self.assertEqual(rows["topic.category"]["state"], "known")
        self.assertTrue(result["validation"]["passed"], result["validation"])
        self.assertFalse(any(row["kind"] == "cta" for row in result["segments"]))
        self.assertEqual(result["information_units"], [])

    def test_information_type_requires_same_type_and_source_unit(self):
        for variation in ("different_type", "different_source"):
            with self.subTest(variation=variation):
                def request(module, payload, budget, variant=variation):
                    response = synthetic_response(module, payload, budget)
                    if module == "text_expression_value":
                        for unit in response["information_units"]:
                            if variant == "different_type":
                                unit["type_tag"] = "value.information_type.conclusion"
                            else:
                                unit["evidence_ids"] = ["transcript:0001"]
                    return response
                result = build_content_analysis(*synthetic_inputs(), request)
                row = next(item for item in result["classifications"]
                           if item["dimension_id"] == "value.information_type")
                self.assertEqual(row["state"], "unknown")
                self.assertEqual(row["reason"], "information_units_not_identified")

    def test_visual_ambience_does_not_require_invented_semantic_units(self):
        media, transcript, visuals = synthetic_inputs()
        transcript.segments = []
        def request(module, payload, budget):
            response = synthetic_response(module, payload, budget)
            if module != "visual":
                for row in response["classifications"]:
                    row.update(state="not_applicable", tags=None, primary_tag=None,
                               reason="纯画面氛围样本没有适用文案、问题、语义信息单元或CTA。", evidence_ids=[])
            response["segments"] = []
            response["information_units"] = []
            return response
        result = build_content_analysis(media, transcript, visuals, request)
        self.assertTrue(result["validation"]["passed"], result["validation"])
        self.assertEqual(result["status"], "complete")
        self.assertEqual(result["information_units"], [])
        self.assertEqual(result["segments"], [])

    def test_deterministic_opening_preserves_source_precision_without_trimming_at_three_seconds(self):
        def unknown_response(_module, payload, _budget):
            return {"classifications": [{
                "dimension_id": row["id"], "state": "unknown", "tags": None, "primary_tag": None,
                "reason": "合成样本不作语义分类。", "evidence_ids": [],
            } for row in payload["dimensions"]], "segments": [], "information_units": []}
        for end in (2_200, 4_200):
            with self.subTest(end=end):
                media, transcript, visuals = synthetic_inputs()
                transcript.segments[0].text = "第一句。第二句仍在同一转写段。"
                transcript.segments[0].end_ms = end
                result = build_content_analysis(media, transcript, visuals, unknown_response)
                first = next(row for row in result["segments"] if row["kind"] == "hook_first_sentence")
                self.assertEqual(first["text"], "第一句。")
                self.assertEqual((first["start_ms"], first["end_ms"]), (0, end))
                self.assertEqual(first["evidence_ids"], ["transcript:0001"])
                early = [row for row in result["segments"] if row["kind"] == "hook_first_3s"]
                self.assertEqual(bool(early), end <= 3_000)
                self.assertTrue(all(row["end_ms"] <= 3_000 for row in early))

    def test_max_profile_uses_shared_caps_and_preserves_metrics(self):
        calls = []
        def request(module, payload, budget):
            calls.append((module, payload, budget))
            return synthetic_response(module, payload, budget)
        result = build_content_analysis(*synthetic_inputs(), request, profile="max")
        shared = load_taxonomy()["budgets"]["max"]
        self.assertEqual({module: cap for module, _, cap in calls}, shared["modules"])
        self.assertTrue(all(estimate_content_tokens(payload) + shared["sdk_schema_reserve_tokens"]
                            <= shared["input_token_limit"] for _, payload, _ in calls))
        self.assertEqual(result["metrics"], build_synthetic_fixture()["metrics"])

    def test_malformed_unhashable_model_fields_are_rejected_without_crashing(self):
        def request(module, payload, budget):
            response = synthetic_response(module, payload, budget)
            if module == "text_expression_value":
                response["segments"][0]["kind"] = {}
                response["information_units"][0]["type_tag"] = []
                response["information_units"][1]["duplicate_of"] = {}
            return response
        result = build_content_analysis(*synthetic_inputs(), request)
        self.assertEqual(result["status"], "partial")
        self.assertFalse(result["validation"]["passed"])

    def test_segments_cannot_fabricate_time_or_first_three_second_alignment(self):
        def request(module, payload, budget):
            response = synthetic_response(module, payload, budget)
            if module == "text_expression_value":
                response["segments"][0].update(start_ms=0, end_ms=3_000)
                response["segments"][1].update(kind="hook_first_3s", start_ms=3_000, end_ms=5_900)
            return response
        result = build_content_analysis(*synthetic_inputs(), request)
        self.assertFalse(result["validation"]["passed"])
        self.assertFalse(any(row["kind"] == "hook_first_3s" and row["end_ms"] > 3_000
                             for row in result["segments"]))
        self.assertTrue(any("alignment_unavailable" in issue for issue in result["validation"]["issues"]))

    def test_model_cannot_overwrite_metrics_or_add_top_level_fields(self):
        def request(module, payload, budget):
            response = synthetic_response(module, payload, budget)
            if module == "synthesis":
                response["metrics"] = {"duration_ms": 999}
            return response
        metrics = {"version": "test-metrics", "media": {"duration_ms": 6_000}}
        result = build_content_analysis(*synthetic_inputs(), request, metrics=metrics)
        self.assertEqual(result["metrics"], metrics)
        self.assertFalse(result["validation"]["passed"])

    def test_fixture_file_matches_python_builder(self):
        path = Path(__file__).parent / "fixtures" / "content-analysis-v1.json"
        self.assertEqual(json.loads(path.read_text(encoding="utf-8")), build_synthetic_fixture())

    @unittest.skipUnless(importlib.util.find_spec("pydantic"), "optional SDK schema dependency unavailable")
    def test_lazy_sdk_schema_is_module_scoped_and_forbids_unknown_fields(self):
        model = create_content_response_model("visual")
        schema = model.model_json_schema()
        self.assertFalse(schema["additionalProperties"])
        enum = schema["$defs"]["ContentClassification"]["properties"]["dimension_id"]["enum"]
        self.assertIn("visual.camera_motion", enum)
        self.assertNotIn("topic.category", enum)
        payload = {"dimensions": [], "evidence_registry": []}
        model.model_validate(synthetic_response("visual", payload, 1_000))


if __name__ == "__main__":
    unittest.main()
