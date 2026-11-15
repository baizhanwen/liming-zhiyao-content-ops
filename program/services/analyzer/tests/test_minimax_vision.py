import asyncio
import json
import tempfile
import unittest
from pathlib import Path

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
                if self.omit_first_text and len(self.calls) == 1 and request_index == 0:
                    row.pop("visible_text")
                observations.append(row)
            results.append(McpVisionCallResult(json.dumps({"observations": observations}, ensure_ascii=False)))
        return results, {"tool_connected": True, "available_tools": ["understand_image"]}


class MiniMaxVisionTests(unittest.TestCase):
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
