import asyncio
import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from PIL import Image

from liming_analyzer.adapters import Keyframe
from liming_analyzer.minimax_vision import (
    McpVisionCallResult,
    MiniMaxTokenPlanMcpVisionEngine,
    _run_bounded_calls,
)
from liming_analyzer.vision_capabilities import (
    normalize_minimax_token_plan_host,
    resolve_vision_capability,
)


def response_for(indices, *, fenced=False):
    payload = {
        "observations": [
            {
                "frame_index": index,
                "composition": f"主体位于画面 {index}",
                "people_actions": "人物正在讲解" if index % 2 else "无人物",
                "scene": "室内场景",
                "camera_expression": "固定中景",
                "visual_role": "承接当前内容",
                "confidence": 0.9,
            }
            for index in indices
        ]
    }
    text = json.dumps(payload, ensure_ascii=False)
    return f"```json\n{text}\n```" if fenced else text


class RecoveringRunner:
    def __init__(self):
        self.calls = []
        self.concurrencies = []

    def call_many(self, requests, on_progress=None, concurrency=None):
        self.calls.append(list(requests))
        self.concurrencies.append(concurrency)
        if len(self.calls) == 1:
            results = [
                McpVisionCallResult(response_for([1, 2, 4])),
                McpVisionCallResult(response_for([1, 2])),
            ]
            metadata = {
                "tool_connected": True,
                "available_tools": ["understand_image", "web_search"],
                "server_name": "Minimax",
                "server_version": "0.0.5",
            }
        else:
            results = [McpVisionCallResult(response_for([1], fenced=True))]
            metadata = {
                "tool_connected": True,
                "available_tools": ["understand_image", "web_search"],
            }
        if on_progress is not None:
            for completed in range(1, len(results) + 1):
                on_progress(completed, len(results))
        return results, metadata


class FailedRunner:
    def __init__(self):
        self.calls = []

    def call_many(self, requests, on_progress=None, concurrency=None):
        self.calls.append(list(requests))
        results = [
            McpVisionCallResult(
                "Failed to perform VLM analysis: API Error: 1033-Gemini API error Trace-Id: trace-fixture",
                is_error=True,
                response_type="text",
                request_id="trace-fixture",
                error_type="MCPToolError",
                message="API Error: 1033-Gemini API error Trace-Id: trace-fixture",
            )
            for _ in requests
        ]
        if on_progress is not None:
            for completed in range(1, len(results) + 1):
                on_progress(completed, len(results))
        return results, {"tool_connected": True, "available_tools": ["understand_image"]}


class RateLimitedRunner:
    def __init__(self):
        self.calls = []
        self.concurrencies = []

    def call_many(self, requests, on_progress=None, concurrency=None):
        self.calls.append(list(requests))
        self.concurrencies.append(concurrency)
        if len(self.calls) == 1:
            results = [
                McpVisionCallResult(
                    "HTTP 429 rate limit",
                    is_error=True,
                    error_type="MCPToolError",
                    message="HTTP 429 rate limit",
                )
                for _ in requests
            ]
        else:
            results = [McpVisionCallResult(response_for([1, 2, 3, 4]))]
        if on_progress is not None:
            for completed in range(1, len(results) + 1):
                on_progress(completed, len(results))
        return results, {"tool_connected": True, "available_tools": ["understand_image"]}


class OriginalFrameRunner:
    """Return per-image text without invoking a model or reading credentials."""

    def __init__(self, *, omit_first_text=False):
        self.calls = []
        self.concurrencies = []
        self.omit_first_text = omit_first_text

    def call_many(self, requests, on_progress=None, concurrency=None):
        self.calls.append(list(requests))
        self.concurrencies.append(concurrency)
        results = []
        for request_index, request in enumerate(requests):
            manifest = json.loads(request["prompt"].split("manifest=", 1)[1])
            observations = []
            for frame in manifest:
                row = {
                    "frame_index": frame["frame_index"],
                    "composition": "人物位于左侧，右侧展示教程界面",
                    "visible_text": f"步骤 {frame['timestamp_ms']}：输入 12.5，不要删除原文件",
                    "temporal": "此字段没有连续图片支持，不可成为时序事实",
                    "confidence": 90,
                }
                if self.omit_first_text and len(self.calls) == 1 and request_index == 0 and frame["frame_index"] == 1:
                    row.pop("visible_text")
                observations.append(row)
            results.append(McpVisionCallResult(json.dumps({"observations": observations}, ensure_ascii=False)))
        return results, {"tool_connected": True, "available_tools": ["understand_image"]}


class MiniMaxVisionTests(unittest.TestCase):
    def test_quick_four_frame_grid_keeps_native_dimensions_per_frame_mapping_and_original_tail(self):
        runner = OriginalFrameRunner()
        with tempfile.TemporaryDirectory() as directory:
            frames = []
            for index in range(5):
                path = Path(directory) / f"frame-{index}.png"
                Image.new("RGB", (1280, 720), (40 + index * 30, 80, 120)).save(path)
                frames.append(Keyframe(index * 1_000, path))
            originals = [frame.path.read_bytes() for frame in frames]
            engine = MiniMaxTokenPlanMcpVisionEngine(api_key="", api_host="", runner=runner)
            engine.set_visual_analysis_mode("vision_only")
            engine.set_visual_sampling_level("quick")
            observations = engine.analyze(frames)
            requests = runner.calls[0]
            self.assertEqual(len(requests), 2)
            with Image.open(requests[0]["image_source"]) as sheet:
                self.assertEqual(sheet.size, (2560, 1600))
            self.assertEqual(requests[1]["image_source"], str(frames[4].path.resolve()))
            self.assertIn("只有4帧有效图片", requests[0]["prompt"])
            self.assertIn("单张视频原始关键帧", requests[1]["prompt"])
            info = engine.last_stats["batches"][0]["input_details"]
            self.assertEqual((info["layout"], info["columns"], info["rows"], info["frame_count"]), ("grid", 2, 2, 4))
            self.assertEqual([row["source_frame_index"] for row in info["frames"]], [1, 2, 3, 4])
            self.assertTrue(all(not row["resized"] and row["input_dimensions"] == [1280, 720] for row in info["frames"]))
            self.assertEqual([frame.path.read_bytes() for frame in frames], originals)
            self.assertEqual([row.text for row in observations if row.kind == "vision_text"], [
                f"步骤 {index * 1_000}：输入 12.5，不要删除原文件" for index in range(5)
            ])
        self.assertEqual(engine.last_stats["batch_size"], 4)
        self.assertEqual(engine.last_stats["batching_policy"], "quick-quads.v1")
        self.assertEqual(engine.last_stats["prompt_version"], "minimax-quick-quads-text.v1")
        self.assertEqual(engine.last_stats["frames_understood"], 5)
        self.assertEqual(engine.last_stats["text_observation_count"], 5)
        self.assertEqual(engine.last_stats["contact_sheet_count"], 1)
        self.assertEqual(engine.last_stats["original_frame_request_count"], 1)
        self.assertTrue(engine.last_stats["temporal_model_input_supported"])
        self.assertEqual(engine.last_stats["temporal_group_batch_count"], 0)

    def test_quick_tail_batches_of_two_three_and_four_do_not_invent_placeholder_frames(self):
        for total, tail in ((6, 2), (7, 3), (8, 4)):
            with self.subTest(total=total), tempfile.TemporaryDirectory() as directory:
                frames = []
                for index in range(total):
                    path = Path(directory) / f"frame-{index}.jpg"
                    Image.new("RGB", (640, 360), "white").save(path)
                    frames.append(Keyframe(index * 1_000, path))
                runner = OriginalFrameRunner()
                engine = MiniMaxTokenPlanMcpVisionEngine(api_key="", api_host="", runner=runner)
                engine.set_visual_analysis_mode("vision_only")
                engine.set_visual_sampling_level("quick")
                observations = engine.analyze(frames)
                self.assertEqual([row["frame_count"] for row in engine.last_stats["batches"]], [4, tail])
                self.assertEqual(len(runner.calls[0]), 2)
                info = engine.last_stats["batches"][-1]["input_details"]
                self.assertEqual(len(info["frames"]), tail)
                self.assertEqual([row["source_frame_index"] for row in info["frames"]], list(range(5, total + 1)))
                self.assertIn(f"只有{tail}帧有效图片", runner.calls[0][-1]["prompt"])
                self.assertEqual([row.start_ms for row in observations if row.kind == "vision"], [index * 1_000 for index in range(total)])
                if tail == 3:
                    self.assertEqual((info["columns"], info["rows"]), (2, 2))
                    with Image.open(runner.calls[0][-1]["image_source"]) as sheet:
                        empty = sheet.crop((sheet.width // 2 + 20, sheet.height // 2 + 20, sheet.width - 20, sheet.height - 20)).convert("L")
                        self.assertLess(empty.getextrema()[1], 60)

    def test_quick_four_frame_temporal_claims_need_an_actual_dense_ordered_group(self):
        for interval in (125, 1_000):
            with self.subTest(interval=interval), tempfile.TemporaryDirectory() as directory:
                frames = []
                for index in range(4):
                    path = Path(directory) / f"frame-{index}.png"
                    Image.new("RGB", (640, 360), (40 + index * 30, 80, 120)).save(path)
                    frames.append(Keyframe(index * interval, path, roles=("temporal:opening",)))
                runner = OriginalFrameRunner()
                engine = MiniMaxTokenPlanMcpVisionEngine(api_key="", api_host="", runner=runner)
                engine.set_visual_analysis_mode("vision_only")
                engine.set_visual_sampling_level("quick")
                observations = engine.analyze(frames)
                dense = interval == 125
                self.assertEqual(engine.last_stats["temporal_group_batch_count"], int(dense))
                self.assertTrue(engine.last_stats["temporal_model_input_supported"])
                self.assertTrue(all(("时序组=opening" in row.text) is dense for row in observations if row.kind == "vision"))
                self.assertEqual("temporal_groups={}" in runner.calls[0][0]["prompt"], not dense)
                engine.set_visual_sampling_level("balanced")
                balanced = engine.analyze(frames)
                self.assertEqual([row["frame_count"] for row in engine.last_stats["batches"]], [2, 2])
                self.assertFalse(engine.last_stats["temporal_model_input_supported"])
                self.assertEqual(engine.last_stats["temporal_group_batch_count"], 0)
                self.assertTrue(all("时序组=" not in row.text for row in balanced if row.kind == "vision"))

    def test_quick_four_frame_mode_switches_reset_to_balanced_detailed_and_historical(self):
        with tempfile.TemporaryDirectory() as directory:
            frames = []
            for index in range(5):
                path = Path(directory) / f"frame-{index}.jpg"
                Image.new("RGB", (640, 360), "white").save(path)
                frames.append(Keyframe(index * 1_000, path))
            runner = OriginalFrameRunner()
            engine = MiniMaxTokenPlanMcpVisionEngine(api_key="", api_host="", runner=runner)
            for mode in ("vision_only", "hybrid"):
                engine.set_visual_analysis_mode(mode)
                for level, expected, policy in (
                    ("quick", [4, 1], "quick-quads.v1"),
                    ("balanced", [2, 2, 1], "balanced-pairs.v1"),
                    ("detailed", [1] * 5 if mode == "vision_only" else [5], "configured"),
                    (None, [1] * 5 if mode == "vision_only" else [5], "configured"),
                ):
                    engine.set_visual_sampling_level(level)
                    engine.analyze(frames)
                    self.assertEqual([row["frame_count"] for row in engine.last_stats["batches"]], expected)
                    self.assertEqual(engine.last_stats["batching_policy"], policy)
                    self.assertEqual(engine.last_stats["frames_understood"], 5)

    def test_quick_four_frame_partial_response_retries_only_the_missing_original(self):
        runner = OriginalFrameRunner(omit_first_text=True)
        with tempfile.TemporaryDirectory() as directory:
            frames = []
            for index in range(5):
                path = Path(directory) / f"frame-{index}.png"
                Image.new("RGB", (640, 360), "white").save(path)
                frames.append(Keyframe(index * 1_000, path))
            engine = MiniMaxTokenPlanMcpVisionEngine(api_key="", api_host="", runner=runner)
            engine.set_visual_analysis_mode("vision_only")
            engine.set_visual_sampling_level("quick")
            observations = engine.analyze(frames)
            self.assertEqual([len(call) for call in runner.calls], [2, 1])
            self.assertEqual(runner.calls[1][0]["image_source"], str(frames[0].path.resolve()))
            self.assertEqual([row["frame_count"] for row in engine.last_stats["batches"]], [4, 1, 1])
        self.assertEqual(runner.concurrencies, [2, 1])
        self.assertEqual(engine.last_stats["frames_understood"], 5)
        self.assertEqual(engine.last_stats["retry_frame_count"], 1)
        self.assertEqual(engine.last_stats["recovered_frame_count"], 1)
        self.assertEqual([row.start_ms for row in observations if row.kind == "vision_text"], [0, 1000, 2000, 3000, 4000])

    def test_quick_four_portrait_frames_preserve_normal_sizes_and_bound_larger_inputs(self):
        for source_size in ((1080, 1920), (2160, 3840)):
            with self.subTest(source_size=source_size), tempfile.TemporaryDirectory() as directory:
                frames = []
                for index in range(4):
                    path = Path(directory) / f"frame-{index}.jpg"
                    Image.new("RGB", source_size, (40, 80, 120)).save(path)
                    frames.append(Keyframe(index * 1_000, path))
                engine = MiniMaxTokenPlanMcpVisionEngine(api_key="", api_host="", runner=OriginalFrameRunner())
                engine.set_visual_analysis_mode("vision_only")
                engine.set_visual_sampling_level("quick")
                engine.analyze(frames)
                info = engine.last_stats["batches"][0]["input_details"]
                width, height = info["input_dimensions"]
                self.assertEqual((info["columns"], info["rows"]), (2, 2))
                self.assertLessEqual(max(width, height), 4096)
                self.assertLessEqual(width * height, 12_000_000)
                if source_size == (1080, 1920):
                    self.assertEqual((width, height), (2160, 4000))
                    self.assertEqual(engine.last_stats["resized_source_frame_count"], 0)
                    self.assertTrue(all(row["input_dimensions"] == [1080, 1920] for row in info["frames"]))
                else:
                    self.assertEqual(engine.last_stats["resized_source_frame_count"], 4)
                    self.assertTrue(all(row["resized"] for row in info["frames"]))

    def test_quick_pair_labels_support_pillow_10_bitmap_default_without_system_fonts(self):
        from PIL import ImageFont

        original_default = ImageFont.load_default

        def legacy_default(*args, **kwargs):
            if kwargs:
                raise TypeError("load_default has no size parameter in Pillow 10.0")
            return original_default(*args)

        with tempfile.TemporaryDirectory() as directory:
            frames = []
            for index in range(2):
                path = Path(directory) / f"frame-{index}.jpg"
                Image.new("RGB", (640, 360), "black").save(path)
                frames.append(Keyframe(index * 1_000, path))
            runner = OriginalFrameRunner()
            engine = MiniMaxTokenPlanMcpVisionEngine(api_key="", api_host="", runner=runner)
            engine.set_visual_analysis_mode("vision_only")
            engine.set_visual_sampling_level("quick")
            with patch("PIL.ImageFont.load_default", side_effect=legacy_default):
                engine.analyze(frames)
            with Image.open(runner.calls[0][0]["image_source"]) as sheet:
                # Bright label pixels span a large readable height in the top
                # banner even when the available bundled font starts as bitmap.
                marker = sheet.crop((0, 0, 512, 80)).convert("L").point(lambda value: 255 if value > 200 else 0)
                bounds = marker.getbbox()
                self.assertIsNotNone(bounds)
                self.assertGreaterEqual(bounds[3] - bounds[1], 35)
            self.assertEqual(engine.last_stats["frames_understood"], 2)

    def test_balanced_vision_pairs_preserve_dimensions_mapping_and_original_tail(self):
        runner = OriginalFrameRunner()
        with tempfile.TemporaryDirectory() as directory:
            frames = []
            for index, size in enumerate(((1280, 720), (1456, 720), (1920, 1080))):
                path = Path(directory) / f"source-{index}.png"
                Image.new("RGB", size, (50 + index * 50, 100, 180)).save(path)
                frames.append(Keyframe(125 + index * 1_000, path, roles=("temporal:opening",)))
            originals = [frame.path.read_bytes() for frame in frames]
            engine = MiniMaxTokenPlanMcpVisionEngine(api_key="", api_host="", runner=runner)
            engine.set_visual_analysis_mode("vision_only")
            engine.set_visual_sampling_level("balanced")
            observations = engine.analyze(frames)
            requests = runner.calls[0]
            self.assertEqual(len(requests), 2)
            self.assertNotEqual(requests[0]["image_source"], str(frames[0].path.resolve()))
            self.assertEqual(requests[1]["image_source"], str(frames[2].path.resolve()))
            with Image.open(requests[0]["image_source"]) as sheet:
                self.assertEqual(sheet.size, (1456, 1600))
            self.assertIn("每格必须恰好一条", requests[0]["prompt"])
            self.assertIn("单张视频原始关键帧", requests[1]["prompt"])
            self.assertNotIn("这是一张视频关键帧联系表", requests[1]["prompt"])
            self.assertTrue(all("visible_text" in row["prompt"] and "temporal_groups={}" in row["prompt"] for row in requests))
            self.assertEqual([row.start_ms for row in observations if row.kind == "vision_text"], [125, 1125, 2125])
            self.assertEqual([frame.path.read_bytes() for frame in frames], originals)
            info = engine.last_stats["batches"][0]["input_details"]
            self.assertEqual(info["layout"], "vertical")
            self.assertEqual([row["source_dimensions"] for row in info["frames"]], [[1280, 720], [1456, 720]])
            self.assertTrue(all(not row["resized"] and row["input_dimensions"] == row["source_dimensions"] for row in info["frames"]))
        self.assertEqual(engine.last_stats["batching_policy"], "balanced-pairs.v1")
        self.assertEqual(engine.last_stats["batch_size"], 2)
        self.assertEqual(engine.last_stats["configured_batch_size"], 6)
        self.assertEqual(engine.last_stats["image_input_mode"], "high_resolution_contact_sheets")
        self.assertEqual(engine.last_stats["frames_understood"], 3)
        self.assertEqual(engine.last_stats["text_observation_count"], 3)
        self.assertEqual(engine.last_stats["contact_sheet_count"], 1)
        self.assertEqual(engine.last_stats["original_frame_request_count"], 1)
        self.assertEqual(engine.last_stats["resized_source_frame_count"], 0)
        self.assertFalse(engine.last_stats["temporal_model_input_supported"])
        self.assertEqual(engine.last_stats["prompt_version"], "minimax-balanced-pairs-text.v1")

    def test_balanced_pairs_keep_portrait_frames_side_by_side_and_bound_large_canvases(self):
        for source_size in ((1080, 1920), (4096, 2304)):
            with self.subTest(source_size=source_size), tempfile.TemporaryDirectory() as directory:
                frames = []
                for index in range(2):
                    path = Path(directory) / f"frame-{index}.jpg"
                    Image.new("RGB", source_size, (40, 80, 120)).save(path)
                    frames.append(Keyframe(index * 1_000, path))
                runner = OriginalFrameRunner()
                engine = MiniMaxTokenPlanMcpVisionEngine(api_key="", api_host="", runner=runner)
                engine.set_visual_analysis_mode("vision_only")
                engine.set_visual_sampling_level("balanced")
                engine.analyze(frames)
                info = engine.last_stats["batches"][0]["input_details"]
                width, height = info["input_dimensions"]
                self.assertLessEqual(max(width, height), 4096)
                self.assertLessEqual(width * height, 12_000_000)
                if source_size == (1080, 1920):
                    self.assertEqual(info["layout"], "horizontal")
                    self.assertEqual((width, height), (2160, 2000))
                    self.assertTrue(all(not row["resized"] for row in info["frames"]))
                else:
                    self.assertTrue(all(row["resized"] for row in info["frames"]))
                    self.assertEqual(engine.last_stats["resized_source_frame_count"], 2)

    def test_balanced_pair_missing_frame_retries_just_that_original_once(self):
        runner = OriginalFrameRunner(omit_first_text=True)
        with tempfile.TemporaryDirectory() as directory:
            frames = []
            for index in range(3):
                path = Path(directory) / f"frame-{index}.png"
                Image.new("RGB", (1280, 720), "white").save(path)
                frames.append(Keyframe(index * 1_000, path))
            engine = MiniMaxTokenPlanMcpVisionEngine(api_key="", api_host="", runner=runner)
            engine.set_visual_analysis_mode("vision_only")
            engine.set_visual_sampling_level("balanced")
            observations = engine.analyze(frames)
            self.assertEqual([len(call) for call in runner.calls], [2, 1])
            self.assertEqual(runner.calls[1][0]["image_source"], str(frames[0].path.resolve()))
            self.assertIn("单张视频原始关键帧", runner.calls[1][0]["prompt"])
        self.assertEqual(runner.concurrencies, [2, 1])
        self.assertEqual(engine.last_stats["retry_frame_count"], 1)
        self.assertEqual(engine.last_stats["recovered_frame_count"], 1)
        self.assertEqual(engine.last_stats["request_count"], 3)
        self.assertEqual([row.start_ms for row in observations if row.kind == "vision"], [0, 1000, 2000])

    def test_balanced_hybrid_keeps_ocr_contract_and_sampling_setter_resets_shared_engine(self):
        with tempfile.TemporaryDirectory() as directory:
            frames = []
            for index in range(3):
                path = Path(directory) / f"frame-{index}.jpg"
                Image.new("RGB", (640, 360), "white").save(path)
                frames.append(Keyframe(index * 1_000, path))
            runner = OriginalFrameRunner()
            engine = MiniMaxTokenPlanMcpVisionEngine(api_key="", api_host="", runner=runner)
            engine.set_visual_sampling_level("balanced")
            observations = engine.analyze(frames)
            self.assertEqual([row.kind for row in observations], ["vision"] * 3)
            self.assertEqual(engine.last_stats["batch_size"], 2)
            self.assertEqual(len(runner.calls[0]), 2)
            self.assertIn("OCR负责具体文字", runner.calls[0][0]["prompt"])
            self.assertIn("单张视频原始关键帧", runner.calls[0][1]["prompt"])
            for level in ("detailed", None):
                engine.set_visual_sampling_level(level)
                engine.analyze(frames)
                self.assertEqual(len(runner.calls[-1]), 1)
                self.assertEqual(engine.last_stats["batch_size"], 6)
                self.assertEqual(engine.last_stats["image_input_mode"], "contact_sheet")
                self.assertEqual(engine.last_stats["prompt_version"], "minimax-contact-sheet.v2")
            engine.set_visual_analysis_mode("vision_only")
            engine.analyze(frames)
            self.assertEqual(len(runner.calls[-1]), 3)
            self.assertEqual(engine.last_stats["batch_size"], 1)
            self.assertTrue(all(request["image_source"] == str(frame.path.resolve()) for request, frame in zip(runner.calls[-1], frames)))
        with self.assertRaises(ValueError):
            engine.set_visual_sampling_level("unbounded")

    def test_quick_rejects_extreme_source_dimensions_before_any_model_request(self):
        runner = OriginalFrameRunner()
        with tempfile.TemporaryDirectory() as directory:
            frames = []
            for index in range(2):
                path = Path(directory) / f"extreme-{index}.png"
                Image.new("RGB", (32, 20_000), "white").save(path)
                frames.append(Keyframe(index * 1_000, path))
            engine = MiniMaxTokenPlanMcpVisionEngine(api_key="", api_host="", runner=runner)
            engine.set_visual_analysis_mode("vision_only")
            engine.set_visual_sampling_level("quick")
            with self.assertRaisesRegex(ValueError, "safe image bounds"):
                engine.analyze(frames)
            with self.assertRaisesRegex(ValueError, "safe image bounds"):
                engine.analyze(frames[:1])
        self.assertEqual(runner.calls, [])

    def test_balanced_repeated_missing_frame_has_no_third_request_round_or_fake_completion(self):
        class MissingRunner(OriginalFrameRunner):
            def call_many(self, requests, on_progress=None, concurrency=None):
                self.calls.append(list(requests))
                self.concurrencies.append(concurrency)
                results = [McpVisionCallResult(json.dumps({"observations": [{
                    "frame_index": 1, "composition": "主体位于左侧", "visible_text": "清晰文字",
                }]})) for _ in requests]
                return results, {"tool_connected": True}

        runner = MissingRunner()
        with tempfile.TemporaryDirectory() as directory:
            frames = []
            for index in range(4):
                path = Path(directory) / f"frame-{index}.png"
                Image.new("RGB", (640, 360), "white").save(path)
                frames.append(Keyframe(index * 1_000, path))
            engine = MiniMaxTokenPlanMcpVisionEngine(api_key="", api_host="", runner=runner)
            engine.set_visual_analysis_mode("vision_only")
            engine.set_visual_sampling_level("balanced")
            observations = engine.analyze(frames)
        self.assertEqual([len(call) for call in runner.calls], [2, 1])
        self.assertEqual(runner.concurrencies, [2, 1])
        self.assertEqual([row.start_ms for row in observations if row.kind == "vision"], [0, 1000, 2000])
        self.assertEqual(engine.last_stats["retry_frame_count"], 2)
        self.assertEqual(engine.last_stats["recovered_frame_count"], 1)
        self.assertEqual(engine.last_stats["missing_frame_count"], 1)
        self.assertEqual(engine.last_stats["frame_coverage_percent"], 75)
        self.assertEqual(engine.last_stats["status"], "partial")

    def test_quick_low_confidence_is_preserved_without_claiming_automatic_correction(self):
        class LowConfidenceRunner(OriginalFrameRunner):
            def call_many(self, requests, on_progress=None, concurrency=None):
                results, metadata = super().call_many(requests, on_progress, concurrency)
                adjusted = []
                for result in results:
                    payload = json.loads(result.text)
                    for row in payload["observations"]:
                        row.update(confidence=10, text_confidence=5)
                    adjusted.append(McpVisionCallResult(json.dumps(payload)))
                return adjusted, metadata

        runner = LowConfidenceRunner()
        with tempfile.TemporaryDirectory() as directory:
            frames = []
            for index in range(2):
                path = Path(directory) / f"frame-{index}.png"
                Image.new("RGB", (640, 360), "white").save(path)
                frames.append(Keyframe(index * 1_000, path))
            engine = MiniMaxTokenPlanMcpVisionEngine(api_key="", api_host="", runner=runner)
            engine.set_visual_analysis_mode("vision_only")
            engine.set_visual_sampling_level("quick")
            observations = engine.analyze(frames)
            self.assertEqual(len(runner.calls), 1)
            self.assertTrue(all(row.confidence == 5 for row in observations if row.kind == "vision_text"))
            self.assertEqual(engine.last_stats["retry_frame_count"], 0)
            engine.set_visual_sampling_level("detailed")
            engine.analyze(frames)
            self.assertEqual(len(runner.calls[-1]), 2)
            self.assertTrue(all(request["image_source"] == str(frame.path.resolve()) for request, frame in zip(runner.calls[-1], frames)))
            self.assertEqual(engine.last_stats["image_input_mode"], "original_frame")

    def test_vision_only_uses_original_images_and_keeps_text_provenance_separate(self):
        runner = OriginalFrameRunner()
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            frames = []
            for index in range(2):
                path = root / f"original-{index}.png"
                Image.new("RGB", (1920, 1080), "white").save(path)
                frames.append(Keyframe(index * 500, path, roles=("temporal:opening",)))
            engine = MiniMaxTokenPlanMcpVisionEngine(api_key="", api_host="", runner=runner)
            engine.set_visual_analysis_mode("vision_only")
            observations = engine.analyze(frames)

            self.assertEqual([request["image_source"] for request in runner.calls[0]],
                             [str(frame.path.resolve()) for frame in frames])
            self.assertFalse((root / "vision-contact-sheets").exists())
            for request in runner.calls[0]:
                self.assertIn("单张视频原始关键帧", request["prompt"])
                self.assertIn("不运行本地OCR", request["prompt"])
                self.assertNotIn("OCR负责具体文字", request["prompt"])
                self.assertIn("temporal_groups={}", request["prompt"])
            self.assertEqual([(row.kind, row.start_ms) for row in observations],
                             [("vision", 0), ("vision_text", 0), ("vision", 500), ("vision_text", 500)])
            self.assertEqual([row.text for row in observations if row.kind == "vision_text"],
                             ["步骤 0：输入 12.5，不要删除原文件", "步骤 500：输入 12.5，不要删除原文件"])
            self.assertTrue(all(row.confidence is None for row in observations if row.kind == "vision_text"))
            self.assertTrue(all("此字段没有连续图片支持" not in row.text for row in observations))
            self.assertEqual(engine.last_stats["frames_understood"], 2)
            self.assertEqual(engine.last_stats["observation_count"], 4)
            self.assertEqual(engine.last_stats["text_observation_count"], 2)
            self.assertEqual(engine.last_stats["batch_size"], 1)
            self.assertEqual(engine.last_stats["contact_sheet_count"], 0)
            self.assertEqual(engine.last_stats["image_input_mode"], "original_frame")
            self.assertFalse(engine.last_stats["temporal_model_input_supported"])
            self.assertEqual(engine.last_stats["prompt_version"], "minimax-original-frame.v1")

            # The shared engine must return to the original contact-sheet path
            # for a later hybrid task, with no stale model-text observations.
            engine.set_visual_analysis_mode("hybrid")
            hybrid = engine.analyze(frames)
            self.assertTrue((root / "vision-contact-sheets").exists())
            self.assertTrue(all(row.kind == "vision" for row in hybrid))
            self.assertEqual(engine.last_stats["image_input_mode"], "contact_sheet")
            self.assertEqual(engine.last_stats["batch_size"], 6)

    def test_vision_only_retries_only_missing_text_contract_once(self):
        runner = OriginalFrameRunner(omit_first_text=True)
        with tempfile.TemporaryDirectory() as directory:
            frames = []
            for index in range(2):
                path = Path(directory) / f"original-{index}.png"
                Image.new("RGB", (64, 32), "white").save(path)
                frames.append(Keyframe(index * 1_000, path))
            engine = MiniMaxTokenPlanMcpVisionEngine(api_key="", api_host="", runner=runner)
            engine.set_visual_analysis_mode("vision_only")
            observations = engine.analyze(frames)
        self.assertEqual([len(call) for call in runner.calls], [2, 1])
        self.assertEqual(runner.calls[1][0]["image_source"], str(frames[0].path.resolve()))
        self.assertEqual(runner.concurrencies, [2, 1])
        self.assertEqual(engine.last_stats["request_count"], 3)
        self.assertEqual(engine.last_stats["frames_understood"], 2)
        self.assertEqual(engine.last_stats["frame_coverage_percent"], 100)
        self.assertEqual(len(observations), 4)

    def test_visual_analysis_mode_rejects_unknown_configuration(self):
        engine = MiniMaxTokenPlanMcpVisionEngine(api_key="", api_host="", runner=OriginalFrameRunner())
        with self.assertRaises(ValueError):
            engine.set_visual_analysis_mode("silent_ocr_fallback")

    def test_vision_only_allows_unreadable_text_without_inventing_text_evidence(self):
        class UnreadableRunner(OriginalFrameRunner):
            def call_many(self, requests, on_progress=None, concurrency=None):
                self.calls.append(list(requests))
                return [McpVisionCallResult(json.dumps({"observations": [{
                    "frame_index": 1, "composition": "右侧展示小字教程界面", "visible_text": "",
                }]})) for _ in requests], {"tool_connected": True}

        runner = UnreadableRunner()
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "small-text.png"
            Image.new("RGB", (64, 32), "white").save(path)
            engine = MiniMaxTokenPlanMcpVisionEngine(api_key="", api_host="", runner=runner)
            engine.set_visual_analysis_mode("vision_only")
            observations = engine.analyze([Keyframe(500, path)])
        self.assertEqual([row.kind for row in observations], ["vision"])
        self.assertEqual(engine.last_stats["text_observation_count"], 0)
        self.assertEqual(engine.last_stats["frames_understood"], 1)
        self.assertEqual(engine.last_stats["request_count"], 1)

    def test_bounded_calls_limit_concurrency_and_preserve_request_order(self):
        active = 0
        maximum_active = 0
        progress = []

        async def operation(request):
            nonlocal active, maximum_active
            active += 1
            maximum_active = max(maximum_active, active)
            await asyncio.sleep(float(request["delay"]))
            active -= 1
            return request["id"]

        requests = [
            {"id": "first", "delay": "0.03"},
            {"id": "second", "delay": "0.01"},
            {"id": "third", "delay": "0.02"},
            {"id": "fourth", "delay": "0.001"},
        ]
        results = asyncio.run(_run_bounded_calls(
            requests,
            concurrency=2,
            operation=operation,
            on_progress=lambda completed, total: progress.append((completed, total)),
        ))

        self.assertEqual(results, ["first", "second", "third", "fourth"])
        self.assertEqual(maximum_active, 2)
        self.assertEqual(progress, [(1, 4), (2, 4), (3, 4), (4, 4)])

    def test_contact_sheets_retry_only_missing_frames_and_restore_full_timeline(self):
        runner = RecoveringRunner()
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            frames = []
            for index in range(6):
                path = root / f"frame-{index}.jpg"
                Image.new("RGB", (320, 180), (30 * index, 80, 160)).save(path)
                frames.append(Keyframe((index + 1) * 5_000, path))
            engine = MiniMaxTokenPlanMcpVisionEngine(
                api_key="",
                api_host="https://api.minimaxi.com/v1",
                batch_size=4,
                runner=runner,
            )
            observations = engine.analyze(frames)
            contact_sheets = sorted((root / "vision-contact-sheets").glob("*.jpg"))
            with Image.open(contact_sheets[0]) as sheet:
                self.assertGreaterEqual(sheet.width, 960)
                self.assertGreaterEqual(sheet.height, 624)

        self.assertEqual([item.start_ms for item in observations], [5_000, 10_000, 15_000, 20_000, 25_000, 30_000])
        self.assertEqual([len(call) for call in runner.calls], [2, 1])
        self.assertEqual(len(runner.calls[1]), 1)
        self.assertIn("每格必须恰好一条", runner.calls[0][0]["prompt"])
        self.assertTrue(runner.calls[0][0]["image_source"].endswith("minimax-a1-b001.jpg"))
        self.assertEqual(engine.last_stats["status"], "completed")
        self.assertEqual(engine.last_stats["frames_requested"], 6)
        self.assertEqual(engine.last_stats["frames_understood"], 6)
        self.assertEqual(engine.last_stats["frame_coverage_percent"], 100.0)
        self.assertEqual(engine.last_stats["retry_frame_count"], 1)
        self.assertEqual(engine.last_stats["recovered_frame_count"], 1)
        self.assertEqual(engine.last_stats["request_count"], 3)
        self.assertEqual(engine.last_stats["concurrency"], 2)
        self.assertEqual(runner.concurrencies, [2, 1])
        self.assertTrue(engine.last_stats["tool_connected"])

    def test_rate_limit_retries_all_missing_frames_serially(self):
        runner = RateLimitedRunner()
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            frames = []
            for index in range(4):
                path = root / f"frame-{index}.jpg"
                Image.new("RGB", (160, 90), "white").save(path)
                frames.append(Keyframe(index * 1_000, path))
            engine = MiniMaxTokenPlanMcpVisionEngine(
                api_key="",
                api_host="https://api.minimaxi.com",
                batch_size=4,
                runner=runner,
            )
            observations = engine.analyze(frames)

        self.assertEqual(len(observations), 4)
        self.assertEqual(runner.concurrencies, [2, 1])
        self.assertTrue(engine.last_stats["serial_retry"])

    def test_external_failure_keeps_http_shape_request_id_and_provider_code(self):
        runner = FailedRunner()
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            frames = []
            for index in range(4):
                path = root / f"frame-{index}.jpg"
                Image.new("RGB", (160, 90), "white").save(path)
                frames.append(Keyframe(index * 1_000, path))
            engine = MiniMaxTokenPlanMcpVisionEngine(
                api_key="",
                api_host="https://api.minimaxi.com",
                batch_size=4,
                runner=runner,
            )
            observations = engine.analyze(frames)

        self.assertEqual(observations, ())
        self.assertEqual(len(runner.calls), 1)
        self.assertEqual(engine.last_stats["status"], "failed")
        self.assertEqual(engine.last_stats["frames_understood"], 0)
        self.assertEqual(engine.last_stats["errors"][0]["provider_code"], 1033)
        self.assertEqual(engine.last_stats["errors"][0]["request_id"], "trace-fixture")
        self.assertEqual(engine.last_stats["errors"][0]["response_type"], "text")

    def test_capability_registry_routes_token_plan_away_from_minimax_m3_chat(self):
        capability = resolve_vision_capability(
            provider="minimax",
            model="MiniMax-M3",
            api_key="sk-cp-fixture",
            base_url="https://api.minimaxi.com/v1",
        )
        self.assertTrue(capability.supported)
        self.assertEqual(capability.adapter, "minimax_token_plan_mcp")
        self.assertEqual(capability.model, "understand_image")
        self.assertEqual(capability.api_host, "https://api.minimaxi.com")
        self.assertIn("understand_image", capability.reason)
        self.assertEqual(
            normalize_minimax_token_plan_host("https://unknown.invalid/v1"),
            "https://api.minimaxi.com",
        )

    def test_unregistered_minimax_model_is_explicitly_rejected_as_visual_input(self):
        capability = resolve_vision_capability(
            provider="minimax",
            model="MiniMax-M3",
            api_key="ordinary-key",
            base_url="https://api.minimaxi.com/v1",
        )
        self.assertFalse(capability.supported)
        self.assertIsNone(capability.adapter)
        self.assertIn("图片适配器", capability.reason)


if __name__ == "__main__":
    unittest.main()
