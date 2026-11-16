"""Sampling caps include protected evidence; quick still produces all report sections."""
import base64
import json
from dataclasses import replace
from types import SimpleNamespace

import pytest
from PIL import Image
from test_reviewed_analysis import review_inputs, run_reviewed
from test_transcript_checkpoints import job

from liming_analyzer.adapters import Keyframe, VisualObservation
from liming_analyzer.ffmpeg import VideoFrameTiming
from liming_analyzer.pipeline import _evidence_checkpoint, _restore_evidence_checkpoint
from liming_analyzer.providers import PySceneDetectFrameExtractor
from liming_analyzer.visual import KeyframeVisualAnalyzer, OpenAiCompatibleVisionEngine
from liming_analyzer.visual_sampling import normalize_visual_sampling_level, visual_sampling_budget


class Processor:
    def __init__(self, duration_ms):
        self.duration_ms = duration_ms

    def video_frame_timing(self, _source):
        return VideoFrameTiming(video_end_ms=self.duration_ms)

    def extract_video_frame(self, _source, timestamp, path, _timing):
        Image.new("RGB", (32, 32), (timestamp % 255, 80, 120)).save(path)
        return timestamp


def extractor_for(media, level):
    duration = media.info.duration_ms / 1000
    cuts = [(stamp, min(duration, stamp + 2.5)) for stamp in range(0, int(duration), 3)]
    extractor = PySceneDetectFrameExtractor(Processor(media.info.duration_ms), detector=lambda _source: cuts)
    extractor.set_visual_sampling_level(level)
    return extractor


@pytest.mark.parametrize("level,limit", [("quick", 32), ("balanced", 56), ("detailed", 96)])
def test_five_minute_dense_cuts_respect_total_cap_and_keep_required_evidence(tmp_path, level, limit):
    media, _, _ = review_inputs()
    media = replace(media, info=replace(media.info, duration_ms=300_000))
    extractor = extractor_for(media, level)
    frames = extractor.extract(media, tmp_path / level)
    assert len(frames) <= limit
    assert extractor.last_stats["maximum_total_frames"] == limit
    assert extractor.last_stats["sampling_config"]["total_frame_limit"] == limit
    assert set(range(0, 3000, 500)).issubset({frame.timestamp_ms for frame in frames})
    assert any("first_frame" in frame.roles for frame in frames)
    assert any("ending" in frame.roles for frame in frames)
    assert all(any(segment["id"] in frame.roles for frame in frames) for segment in extractor.last_stats["timeline_segments"])
    assert extractor.last_stats["temporal_groups"]


@pytest.mark.parametrize("mode", ["hybrid", "vision_only"])
def test_quick_actual_sampling_feeds_completed_visual_and_all_other_sections(tmp_path, mode):
    media, transcript, _ = review_inputs()
    media = replace(media, info=replace(media.info, duration_ms=300_000))

    class Ocr:
        def recognize(self, _path):
            return "将会议记录转成明确待办。", 90

    class Vision:
        def analyze(self, frames):
            return tuple(row for frame in frames for row in (
                VisualObservation("vision", frame.timestamp_ms, frame.timestamp_ms,
                                  "真人口播，人物居中，右侧展示会议待办清单；景别固定。"),
                VisualObservation("vision_text", frame.timestamp_ms, frame.timestamp_ms, "会议待办：动作、负责人、截止时间。"),
            ))

    visual = KeyframeVisualAnalyzer(extractor_for(media, "quick"), Ocr(), Vision())
    visual.set_visual_analysis_mode(mode)
    visual.set_visual_sampling_level("quick")
    evidence = visual.analyze(media, tmp_path)
    report, _, _, _ = run_reviewed(source={"transcript_review_enabled": False,
        "visual_analysis_mode": mode, "visual_sampling_level": "quick"}, custom_inputs=(media, transcript, evidence))
    sections = report.report["unified_report"]["sections"]
    assert len(sections) == 4
    assert all(section["status"] == "completed" for section in sections), report.report["unified_report"]["validation"]
    visual_section = next(section for section in sections if section["key"] == "visual")
    assert visual_section["findings"]
    assert evidence.stats["sampling_coverage"]["opening_complete"]
    assert evidence.stats["sampling_coverage"]["timeline_complete"]
    assert evidence.stats["visual_sampling_level"] == "quick"


@pytest.mark.parametrize("level", [None, "quick", "balanced", "detailed"])
def test_checkpoints_only_restore_their_saved_sampling_level(tmp_path, level):
    media, transcript, visuals = review_inputs()
    checkpoint = _evidence_checkpoint(media, transcript, visuals, None, visual_sampling_level=level)
    current = job(tmp_path, source={"visual_sampling_level": level}, checkpoint_stage="evidence_ready", checkpoint=checkpoint)
    assert _restore_evidence_checkpoint(current, tmp_path)
    other = "quick" if level != "quick" else "balanced"
    assert _restore_evidence_checkpoint(replace(current, source={"visual_sampling_level": other}), tmp_path) is None


def test_level_cache_cannot_cross_to_another_level_with_identical_evidence():
    first, _, _, checkpoints = run_reviewed(source={"transcript_review_enabled": False, "visual_sampling_level": "quick"})
    second, sdk, _, _ = run_reviewed(checkpoint=checkpoints[-1], source={"transcript_review_enabled": False, "visual_sampling_level": "balanced"})
    assert first.report["unified_report"]["source_signature"] != second.report["unified_report"]["source_signature"]
    assert sdk.calls
    assert second.report["analysis_meta"]["visual_sampling_level"] == "balanced"


def test_budget_increases_with_detail_without_changing_legacy_policy():
    for duration in (0, 1, 30, 300, 600, 1200, 1800, 7200):
        budgets = [visual_sampling_budget(duration, level) for level in ("quick", "balanced", "detailed")]
        assert budgets[0]["total_frame_limit"] < budgets[1]["total_frame_limit"] < budgets[2]["total_frame_limit"]
        assert all(budget["target_count"] >= 3 for budget in budgets)
    media, _, _ = review_inputs()
    extractor = extractor_for(media, None)
    assert extractor._target_frame_count(300) == (18, 90)
    extractor.set_analysis_profile("max")
    assert extractor._target_frame_count(300) == (36, 180)
    with pytest.raises(ValueError):
        normalize_visual_sampling_level("economy")


@pytest.mark.parametrize("mode", ["hybrid", "vision_only"])
def test_sampling_batches_preserve_every_original_and_reset_for_other_jobs(tmp_path, mode):
    frames = []
    for index in range(7):
        path = tmp_path / f"pair-{index}.png"
        Image.new("RGB", (320, 180), (index * 25, 80, 120)).save(path)
        frames.append(Keyframe(index * 125, path, roles=("temporal:cut",) if index < 6 else ()))
    originals = {frame.timestamp_ms: frame.path.read_bytes() for frame in frames}
    calls = []

    def create(**kwargs):
        calls.append(kwargs)
        prompt = kwargs["messages"][1]["content"][0]["text"]
        manifest = json.loads(prompt.split("frame_manifest=", 1)[1])
        images = kwargs["messages"][1]["content"][1:]
        assert len(images) == len(manifest)
        for frame, image in zip(manifest, images):
            assert base64.b64decode(image["image_url"]["url"].split(",", 1)[1]) == originals[frame["timestamp_ms"]]
            assert image["image_url"]["detail"] == ("high" if mode == "vision_only" else "low")
        payload = {"observations": [{"frame_index": frame["frame_index"],
                   "composition": f"原图时间 {frame['timestamp_ms']}", "confidence": 90,
                   "visible_text": f"可见文字 {frame['timestamp_ms']}", "temporal": "时序组内的示例动作"}
                   for frame in manifest]}
        return SimpleNamespace(choices=[SimpleNamespace(message=SimpleNamespace(content=json.dumps(payload)))])

    client = SimpleNamespace(chat=SimpleNamespace(completions=SimpleNamespace(create=create)))
    engine = OpenAiCompatibleVisionEngine(api_key="", base_url="https://fixture.invalid", model="fixture",
                                          provider="fixture", client=client)
    engine.set_visual_analysis_mode(mode)
    for level, sizes, limit, policy in (
        ("quick", [1, 2, 4], 4, "quick-quads.v1"),
        ("balanced", [1, 2, 2, 2], 2, "balanced-pairs.v1"),
        ("detailed", [1, 6], 6, "configured"),
        (None, [1, 6], 6, "configured"),
        ("quick", [1, 2, 4], 4, "quick-quads.v1"),
    ):
        calls.clear()
        engine.set_visual_sampling_level(level)
        rows = engine.analyze(frames)
        assert sorted(len(call["messages"][1]["content"]) - 1 for call in calls) == sizes
        assert [row.start_ms for row in rows if row.kind == "vision"] == [frame.timestamp_ms for frame in frames]
        if mode == "vision_only":
            assert [row.text for row in rows if row.kind == "vision_text"] == [f"可见文字 {frame.timestamp_ms}" for frame in frames]
        assert engine.last_stats["frames_understood"] == engine.last_stats["frames_requested"] == 7
        assert engine.last_stats["configured_batch_size"] == 6
        assert engine.last_stats["batch_size"] == limit
        assert engine.last_stats["visual_sampling_level"] == level
        assert engine.last_stats["batching_policy"] == policy
        assert engine.last_stats["temporal_model_input_supported"] is (limit >= 3)
        temporal_rows = [row.start_ms for row in rows if "时序组内的示例动作" in row.text]
        expected = [] if level == "balanced" else [frame.timestamp_ms for frame in frames[:4 if level == "quick" else 6]]
        assert temporal_rows == expected


def test_sampling_level_propagates_to_extractor_and_provider_without_sticky_quick():
    extractor_levels, vision_levels = [], []
    extractor = SimpleNamespace(set_visual_sampling_level=extractor_levels.append)
    vision = SimpleNamespace(set_visual_sampling_level=vision_levels.append)
    analyzer = KeyframeVisualAnalyzer(extractor, None, vision)
    for level in ("quick", "balanced", "detailed", None):
        analyzer.set_visual_sampling_level(level)
    assert extractor_levels == vision_levels == ["quick", "balanced", "detailed", None]
