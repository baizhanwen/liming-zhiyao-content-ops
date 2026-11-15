"""Vision-only adapter boundaries, using synthetic images and offline SDK replies."""
from __future__ import annotations

import base64
import json
from types import SimpleNamespace

import pytest
from PIL import Image

from liming_analyzer.adapters import Keyframe
from liming_analyzer.visual import OpenAiCompatibleVisionEngine


def frames_at(tmp_path, count=2):
    frames = []
    for index in range(count):
        path = tmp_path / f"original-{index}.png"
        Image.new("RGB", (1280, 720), (index * 20, 100, 180)).save(path)
        frames.append(Keyframe(index * 1_000, path, ocr_text="stale OCR must never enter the model prompt"))
    return frames


def manifest_for(kwargs):
    return json.loads(kwargs["messages"][1]["content"][0]["text"].split("frame_manifest=", 1)[1])


def payload_for(kwargs):
    return {"observations": [{
        "frame_index": frame["frame_index"], "composition": "人物居中，右侧为操作界面", "confidence": 90,
        "visible_text": f"步骤 {frame['timestamp_ms']}：填写 12.5，不要删除原文件",
    } for frame in manifest_for(kwargs)]}


def response_for(payload):
    return SimpleNamespace(
        choices=[SimpleNamespace(message=SimpleNamespace(content=json.dumps(payload, ensure_ascii=False)))],
        usage=SimpleNamespace(prompt_tokens=10, completion_tokens=5, total_tokens=15),
    )


def engine_for(create, **kwargs):
    client = SimpleNamespace(chat=SimpleNamespace(completions=SimpleNamespace(create=create)))
    engine = OpenAiCompatibleVisionEngine(
        api_key="", base_url="https://fixture.invalid", model="fixture-vision", provider="fixture", client=client,
        **kwargs,
    )
    engine.set_visual_analysis_mode("vision_only")
    return engine


def test_original_high_detail_images_and_separate_text_do_not_double_coverage_or_usage(tmp_path):
    calls, receipts = [], []

    def create(**kwargs):
        calls.append(kwargs)
        return response_for(payload_for(kwargs))

    frames = frames_at(tmp_path)
    original_bytes = [frame.path.read_bytes() for frame in frames]
    engine = engine_for(create, batch_size=2)
    engine.set_call_context(SimpleNamespace(id="fixture"), lambda _job, row: receipts.append(row))
    observations = engine.analyze(frames)

    assert [(row.kind, row.start_ms) for row in observations] == [
        ("vision", 0), ("vision_text", 0), ("vision", 1_000), ("vision_text", 1_000),
    ]
    assert [row.text for row in observations if row.kind == "vision_text"] == [
        "步骤 0：填写 12.5，不要删除原文件", "步骤 1000：填写 12.5，不要删除原文件",
    ]
    assert all(row.confidence is None for row in observations if row.kind == "vision_text")
    image_inputs = calls[0]["messages"][1]["content"][1:]
    assert all(image["image_url"]["detail"] == "high" for image in image_inputs)
    assert all(image["image_url"]["url"].startswith("data:image/png;base64,") for image in image_inputs)
    assert [base64.b64decode(image["image_url"]["url"].split(",", 1)[1]) for image in image_inputs] == original_bytes
    prompt = calls[0]["messages"][1]["content"][0]["text"]
    assert "visible_text" in prompt and "不猜测、不补全" in prompt
    assert "OCR负责具体文字" not in prompt and "stale OCR" not in prompt
    assert [frame.path.read_bytes() for frame in frames] == original_bytes
    assert engine.last_stats["status"] == "completed"
    assert engine.last_stats["frames_requested"] == engine.last_stats["frames_understood"] == 2
    assert engine.last_stats["observation_count"] == 4
    assert engine.last_stats["text_observation_count"] == 2
    assert engine.last_stats["frame_coverage_percent"] == 100
    assert engine.last_stats["batches"][0]["understood_count"] == 2
    assert engine.last_stats["total_tokens"] == 15
    assert engine.last_stats["request_count"] == 1
    assert len(receipts) == 2 and receipts[-1]["totalTokens"] == 15


@pytest.mark.parametrize("text", [None, False, ["猜测"], "字" * 2_001])
def test_invalid_text_field_fails_without_spending_unbounded_retry(tmp_path, text):
    calls = []

    def create(**kwargs):
        calls.append(kwargs)
        payload = payload_for(kwargs)
        payload["observations"][0]["visible_text"] = text
        return response_for(payload)

    engine = engine_for(create, batch_size=1)
    assert engine.analyze(frames_at(tmp_path, 1)) == []
    assert len(calls) == 1
    assert engine.last_stats["status"] == "failed"
    assert engine.last_stats["frames_understood"] == 0
    assert engine.last_stats["total_tokens"] == 15
    assert engine.last_stats["batches"][0]["failure_kind"] == "invalid_response"


@pytest.mark.parametrize("failure", ["text", "frame"])
def test_missing_visible_text_or_missing_frame_cannot_be_reported_complete(tmp_path, failure):
    frames = frames_at(tmp_path)
    calls = []

    def create(**kwargs):
        calls.append(kwargs)
        payload = payload_for(kwargs)
        if failure == "text":
            payload["observations"][0].pop("visible_text")
        else:
            payload["observations"].pop()
        return response_for(payload)

    engine = engine_for(create, batch_size=2)
    assert engine.analyze(frames) == []
    assert engine.last_stats["status"] == "failed"
    assert engine.last_stats["frame_coverage_percent"] == 0
    assert engine.last_stats["total_tokens"] == 15
    assert len(calls) == 1


@pytest.mark.parametrize("visible_text", ["", "unknown", " UNKNOWN ", "无法辨认"])
def test_unreadable_text_keeps_visual_observation_without_fake_text_evidence(tmp_path, visible_text):
    def create(**kwargs):
        payload = payload_for(kwargs)
        payload["observations"][0]["visible_text"] = visible_text
        return response_for(payload)

    engine = engine_for(create, batch_size=1)
    observations = engine.analyze(frames_at(tmp_path, 1))
    assert [row.kind for row in observations] == ["vision"]
    assert engine.last_stats["status"] == "completed"
    assert engine.last_stats["frames_understood"] == 1
    assert engine.last_stats["text_observation_count"] == 0


def test_partial_batch_failure_retains_only_grounded_success_and_actual_call_usage(tmp_path):
    def create(**kwargs):
        payload = payload_for(kwargs)
        if manifest_for(kwargs)[0]["timestamp_ms"] == 1_000:
            payload["observations"][0].pop("visible_text")
        return response_for(payload)

    engine = engine_for(create, batch_size=1)
    observations = engine.analyze(frames_at(tmp_path))
    assert [(row.kind, row.start_ms) for row in observations] == [("vision", 0), ("vision_text", 0)]
    assert engine.last_stats["status"] == "partial"
    assert engine.last_stats["frames_understood"] == 1
    assert engine.last_stats["frame_coverage_percent"] == 50
    assert engine.last_stats["total_tokens"] == 30
    assert engine.last_stats["completed_batches"] == engine.last_stats["failed_batches"] == 1


@pytest.mark.parametrize("recover", [False, True])
def test_overload_has_only_one_shared_retry_in_vision_only_mode(tmp_path, recover):
    class Overloaded(RuntimeError):
        status_code = 529

    calls = []

    def create(**kwargs):
        calls.append(kwargs)
        if len(calls) == 1 or not recover:
            raise Overloaded("offline overload fixture")
        return response_for(payload_for(kwargs))

    engine = engine_for(create, batch_size=1, concurrency=1, overload_backoff_seconds=0)
    observations = engine.analyze(frames_at(tmp_path, 1))
    assert len(calls) == 2
    assert engine.last_stats["overload_retry_count"] == 1
    assert engine.last_stats["frames_understood"] == (1 if recover else 0)
    assert engine.last_stats["status"] == ("completed" if recover else "failed")
    assert len(observations) == (2 if recover else 0)
    assert engine.last_stats["total_tokens"] is None


def test_later_hybrid_job_keeps_original_low_detail_contract_and_ignores_model_text(tmp_path):
    calls = []

    def create(**kwargs):
        calls.append(kwargs)
        payload = payload_for(kwargs)
        payload["observations"][0].pop("visible_text")
        return response_for(payload)

    engine = engine_for(create, batch_size=1)
    engine.set_visual_analysis_mode("hybrid")
    observations = engine.analyze(frames_at(tmp_path, 1))
    assert [row.kind for row in observations] == ["vision"]
    assert calls[0]["messages"][1]["content"][1]["image_url"]["detail"] == "low"
    assert "OCR负责具体文字" in calls[0]["messages"][1]["content"][0]["text"]
    assert engine.last_stats["status"] == "completed"
    assert engine.last_stats["prompt_version"] == "video-vision.v2"
