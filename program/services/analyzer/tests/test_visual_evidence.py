import json
import shutil
import subprocess
from dataclasses import replace
from pathlib import Path
from types import SimpleNamespace

import pytest
from PIL import Image, ImageStat

from liming_analyzer.adapters import (
    Keyframe,
    MediaInfo,
    NormalizedMedia,
    TranscriptOutput,
    VisualOutput,
)
from liming_analyzer.api_client import ClaimedJob
from liming_analyzer.ffmpeg import FfmpegMediaProcessor
from liming_analyzer.minimax_vision import (
    McpVisionCallResult,
    MiniMaxTokenPlanMcpVisionEngine,
    PreparedVisionBatch,
)
from liming_analyzer.pipeline import _evidence_checkpoint, _restore_evidence_checkpoint
from liming_analyzer.providers import PaddleOcrEngine, PySceneDetectFrameExtractor
from liming_analyzer.visual import (
    KeyframeVisualAnalyzer,
    OpenAiCompatibleVisionEngine,
    _ocr_region_measurement,
    temporal_groups_in_batch,
    vision_batch_indices,
)


class Processor:
    ffmpeg = "ffmpeg"

    def _execute(self, command):
        return subprocess.CompletedProcess(command, 0, "", "")

    def video_frame_timing(self, _source):
        from liming_analyzer.ffmpeg import VideoFrameTiming
        return VideoFrameTiming()

    def extract_video_frame(self, _source, timestamp_ms, _path, _timing):
        return timestamp_ms


def test_required_opening_and_cut_windows_ignore_general_frame_cap(tmp_path):
    extractor = PySceneDetectFrameExtractor(Processor(), maximum_frames=3, detector=lambda _: [(0, 4), (4, 7), (7, 10)])
    frames = extractor.extract(NormalizedMedia(Path("video.mp4"), None, MediaInfo(10_000, 160, 90, "h264", None)), tmp_path)
    opening = [frame.timestamp_ms for frame in frames if "opening" in frame.roles]
    assert opening == [0, 500, 1000, 1500, 2000, 2500]
    assert "first_frame" in frames[0].roles
    assert len(frames) <= extractor.last_stats["maximum_total_frames"]
    groups = extractor.last_stats["temporal_groups"]
    assert len(groups) == 2  # Opening plus one bounded standard-profile cut window.
    for group in groups:
        assert len(group["timestamps_ms"]) >= 3
        assert all(any(frame.timestamp_ms == stamp and f"temporal:{group['group_id']}" in frame.roles for frame in frames) for stamp in group["timestamps_ms"])


def test_short_video_opening_never_seeks_past_end(tmp_path):
    extractor = PySceneDetectFrameExtractor(Processor(), detector=lambda _: [(0, .2)])
    frames = extractor.extract(NormalizedMedia(Path("short.mp4"), None, MediaInfo(200, 160, 90, "h264", None)), tmp_path)
    assert all(0 <= frame.timestamp_ms < 200 for frame in frames)
    assert [frame.timestamp_ms for frame in frames if "opening" in frame.roles] == [0]
    assert temporal_groups_in_batch(frames) == {}


def test_measurements_keep_rapid_boundaries_merged_only_for_representative_sampling(tmp_path):
    class DetectProcessor(Processor):
        def _execute(self, command):
            return subprocess.CompletedProcess(command, 0, "", "pts_time:0.4 pts_time:0.5 pts_time:2.0")

        def probe(self, _source):
            return MediaInfo(10_000, 160, 90, "h264", None)

    extractor = PySceneDetectFrameExtractor(DetectProcessor())
    extractor.extract(NormalizedMedia(Path("video.mp4"), None, MediaInfo(10_000, 160, 90, "h264", None)), tmp_path)
    assert extractor.last_stats["shot_detection"]["boundaries_ms"] == [0, 400, 500, 2000, 10_000]
    assert extractor.last_stats["scene_count"] == 2  # Representative scene sampling still merges short intervals.
    assert len(extractor.last_stats["temporal_groups"]) == 2
    assert extractor.last_stats["temporal_groups"][1]["start_ms"] < 2000


def test_temporal_batches_preserve_windows_and_reject_sparse_single_images(tmp_path):
    frames = [Keyframe(time, tmp_path / str(time), roles=("temporal:a",)) for time in (0, 125, 250, 375, 500, 625)]
    frames += [Keyframe(9000, tmp_path / "far")]
    assert vision_batch_indices(frames, 6) == [[0, 1, 2, 3, 4, 5], [6]]
    assert temporal_groups_in_batch(frames)["a"] == [0, 125, 250, 375, 500, 625]
    assert temporal_groups_in_batch([replace(frame, timestamp_ms=index * 2000) for index, frame in enumerate(frames[:3])]) == {}
    assert temporal_groups_in_batch(frames[:2]) == {}


def test_ocr_area_requires_actual_boxes_and_counts_overlap_once(tmp_path):
    path = tmp_path / "frame.jpg"
    Image.new("RGB", (100, 100), "black").save(path)
    assert _ocr_region_measurement(path, None)["text_area_ratio"] is None
    result = _ocr_region_measurement(path, [
        {"polygon": [[0, 0], [50, 0], [50, 50], [0, 50]], "confidence": 90},
        {"polygon": [[25, 0], [75, 0], [75, 50], [25, 50]], "confidence": 90},
        {"polygon": [[0, 0], [100, 0], [100, 100], [0, 100]], "confidence": 10},
    ])
    assert result["text_area_ratio"] == .375
    assert result["region_count"] == 2


def test_paddle_preserves_region_evidence_but_missing_geometry_stays_unknown():
    class Ocr:
        def predict(self, **kwargs):
            return [{"rec_texts": ["测试标题"], "rec_scores": [.9], "rec_polys": [[[0, 0], [50, 0], [50, 10], [0, 10]]]}]

    engine = PaddleOcrEngine(engine=Ocr())
    assert engine.recognize(Path("fixture.jpg")) == ("测试标题", 90)
    assert len(engine.last_regions) == 1
    engine.engine.predict = lambda **kwargs: [{"rec_texts": ["缺少框"], "rec_scores": [.9]}]
    engine.recognize(Path("fixture.jpg"))
    assert engine.last_regions is None


def test_failed_ocr_does_not_drop_forced_image_or_reuse_previous_geometry(tmp_path):
    image = tmp_path / "black.jpg"
    Image.new("RGB", (32, 32), "black").save(image)

    class Extractor:
        def extract(self, *_args):
            return [Keyframe(0, image, roles=("first_frame", "opening"))]

    class BrokenOcr:
        def __init__(self):
            self.last_regions = [{"polygon": [[0, 0], [32, 0], [32, 32], [0, 32]], "confidence": 99}]

        def recognize(self, _path):
            raise ValueError("synthetic OCR failure")

    result = KeyframeVisualAnalyzer(Extractor(), BrokenOcr()).analyze(NormalizedMedia(Path("fixture"), None, MediaInfo(1000, 32, 32, "h264", None)), tmp_path)
    assert len(result.keyframes) == 1
    assert result.keyframes[0].roles == ("first_frame", "opening")
    assert result.stats["ocr_error_count"] == 1
    assert result.stats["ocr_text_regions"]["frames"][0]["text_area_ratio"] is None


def test_checkpoint_round_trip_preserves_visual_roles_rotation_and_old_defaults(tmp_path):
    job = ClaimedJob("fixture", "organization", "project", "material", "upload", "queued", 0, 1, {})
    media = NormalizedMedia(tmp_path / "source", None, MediaInfo(2000, 1920, 1080, "h264", None, -90, "1:1"))
    visuals = VisualOutput((Keyframe(0, tmp_path / "frame.jpg", asset_id="asset-fixture", roles=("first_frame", "opening")),), stats={"sampling_strategy_id": "content-frames.v2"})
    checkpoint = _evidence_checkpoint(media, TranscriptOutput("zh-CN", ()), visuals, None)
    restored = _restore_evidence_checkpoint(replace(job, checkpoint_stage="evidence_ready", checkpoint=checkpoint), tmp_path)
    assert restored[0].info.rotation_degrees == -90
    assert restored[2].keyframes[0].roles == ("first_frame", "opening")
    assert restored[2].keyframes[0].asset_id == "asset-fixture"
    for key in ("rotation_degrees", "sample_aspect_ratio", "display_aspect_ratio"):
        checkpoint["media"].pop(key)
    checkpoint["visuals"]["keyframes"][0].pop("roles")
    legacy = _restore_evidence_checkpoint(replace(job, checkpoint_stage="evidence_ready", checkpoint=json.loads(json.dumps(checkpoint))), tmp_path)
    assert legacy[0].info.rotation_degrees == 0
    assert legacy[2].keyframes[0].roles == ()


@pytest.mark.parametrize("adapter", ["openai", "minimax"])
@pytest.mark.parametrize("temporal", [False, True])
def test_vision_adapters_ignore_motion_claims_without_ordered_frame_evidence(tmp_path, adapter, temporal):
    frames = []
    for index in range(3 if temporal else 1):
        image = tmp_path / f"{index}.jpg"
        Image.new("RGB", (32, 32), "white").save(image)
        frames.append(Keyframe(index * 125, image, roles=("temporal:g",) if temporal else ()))
    payload = json.dumps({"observations": [{"frame_index": index + 1, "composition": "人物居中", "temporal": "镜头推近", "confidence": 90} for index in range(len(frames))]})
    if adapter == "openai":
        calls = []

        def create(**kwargs):
            calls.append(kwargs)
            return SimpleNamespace(choices=[SimpleNamespace(message=SimpleNamespace(content=payload))])

        client = SimpleNamespace(chat=SimpleNamespace(completions=SimpleNamespace(create=create)))
        engine = OpenAiCompatibleVisionEngine(api_key="", base_url="https://fixture.invalid", model="fixture", provider="fixture", client=client)
        observations = engine._request_batch(frames, batch_index=1, batch_count=1)
        assert "temporal_groups=" in calls[0]["messages"][1]["content"][0]["text"]
    else:
        engine = MiniMaxTokenPlanMcpVisionEngine(api_key="", api_host="https://api.minimax.io", runner=object())
        batch = PreparedVisionBatch(1, 1, tuple(enumerate(frames)), tmp_path / "sheet.jpg", "fixture")
        observations = list(engine._parse_batch(batch, McpVisionCallResult(payload))[0].values())
    assert len(observations) == len(frames)
    assert ("镜头推近" in observations[0].text) is temporal
    assert ("时序组=g" in observations[0].text) is temporal


@pytest.mark.skipif(not shutil.which("ffmpeg") or not shutil.which("ffprobe"), reason="local FFmpeg is not installed")
def test_real_synthetic_video_keeps_black_first_frame_and_opening_sequence(tmp_path):
    source = tmp_path / "synthetic.mp4"
    subprocess.run(["ffmpeg", "-nostdin", "-v", "error", "-f", "lavfi", "-i", "color=black:s=160x90:r=8:d=1", "-f", "lavfi", "-i", "color=white:s=160x90:r=8:d=1", "-filter_complex", "[0:v][1:v]concat=n=2:v=1:a=0", "-c:v", "mpeg4", "-y", str(source)], check=True, timeout=30)
    processor = FfmpegMediaProcessor()
    media = processor.prepare(source, tmp_path / "media")

    class EmptyOcr:
        def recognize(self, _path):
            return "", None

    output = KeyframeVisualAnalyzer(PySceneDetectFrameExtractor(processor), EmptyOcr()).analyze(media, tmp_path / "evidence")
    opening = [frame for frame in output.keyframes if "opening" in frame.roles]
    assert [frame.timestamp_ms for frame in opening] == [0, 500, 1000, 1500]
    assert output.stats["sampling_coverage"]["opening_complete"]
    assert output.stats["sampling_coverage"]["ending_retained"]
    assert output.stats["sampling_coverage"]["timeline_complete"]
    assert output.stats["sampling_coverage"]["detected_scenes_complete"]
    assert output.stats["similar_removed"] == 0
    with Image.open(opening[0].path) as image:
        assert ImageStat.Stat(image.convert("L")).mean[0] < 5
    with Image.open(opening[-1].path) as image:
        assert ImageStat.Stat(image.convert("L")).mean[0] > 245
    assert output.stats["shot_detection"]["boundaries_ms"] == [0, 1000, 2000]


@pytest.mark.parametrize("profile,cut_count", [("standard", 1), ("max", 2)])
def test_sparse_cut_windows_keep_opening_timeline_ending_and_each_scene(tmp_path, profile, cut_count):
    scenes = [(start, start + 4) for start in range(0, 80, 4)]
    extractor = PySceneDetectFrameExtractor(Processor(), analysis_profile=profile, detector=lambda _: scenes)
    frames = extractor.extract(NormalizedMedia(Path("video.mp4"), None, MediaInfo(80_000, 160, 90, "h264", None)), tmp_path)
    stats = extractor.last_stats
    assert stats["sampling_strategy_id"] == "content-frames.v3"
    assert [frame.timestamp_ms for frame in frames if "opening" in frame.roles] == [0, 500, 1000, 1500, 2000, 2500]
    assert any(frame.timestamp_ms == 79_750 and "ending" in frame.roles for frame in frames)
    cut_groups = [group for group in stats["temporal_groups"] if group["kind"] == "detected_cut"]
    assert len(cut_groups) == cut_count
    assert stats["temporal_sampling"]["selected_cut_count"] == cut_count
    assert stats["temporal_sampling"]["detected_cut_count"] == 19
    assert stats["temporal_sampling"]["full_video_motion_coverage"] is False
    assert all(len(group["timestamps_ms"]) == 6 for group in cut_groups)
    group_ids = {group["group_id"] for group in stats["temporal_groups"]}
    assert {role.removeprefix("temporal:") for frame in frames for role in frame.roles if role.startswith("temporal:")} == group_ids
    for interval in [*stats["timeline_segments"], *stats["scene_intervals"]]:
        assert any(interval["id"] in frame.roles for frame in frames)
    # Clear scene changes still get a representative after the boundary even
    # when no dense motion window was spent on that cut.
    assert all(any(frame.timestamp_ms == start * 1000 + 250 for frame in frames) for start, _ in scenes)


def test_same_scene_dedup_preserves_changed_slides_coverage_and_motion_groups(tmp_path, monkeypatch):
    plain = tmp_path / "plain.jpg"
    changed = tmp_path / "changed.jpg"
    Image.new("RGB", (160, 90), (80, 120, 180)).save(plain)
    Image.new("RGB", (160, 90), (100, 120, 180)).save(changed)

    class Extractor:
        last_stats = {
            "sampling_strategy_id": "content-frames.v3", "opening_timestamps_ms": [0], "ending_timestamp_ms": 8000,
            "timeline_segments": [{"id": "coverage:0001"}, {"id": "coverage:0002"}],
            "scene_intervals": [{"id": "scene:0001"}, {"id": "scene:0002"}],
            "temporal_groups": [{"group_id": "cut-001", "timestamps_ms": [7000, 7125, 7250]}],
        }

        def extract(self, *_args):
            rows = [(0, plain, ("first_frame",)), (1000, plain, ()), (2000, changed, ()),
                    (5000, plain, ()), (6000, plain, ()), (7000, plain, ("temporal:cut-001",)),
                    (7125, plain, ("temporal:cut-001",)), (7250, plain, ("temporal:cut-001",)),
                    (8000, plain, ("ending",))]
            return [Keyframe(time, path, roles=(*roles, "scene:0001" if time < 6000 else "scene:0002",
                                               "coverage:0001" if time < 5000 else "coverage:0002"))
                    for time, path, roles in rows]

    class Ocr:
        def recognize(self, _path):
            return "", None

    analyzer = KeyframeVisualAnalyzer(Extractor(), Ocr())
    # Coarse image hashes can collide on different slides. Pixel similarity is
    # still required, so the changed slide cannot disappear on a hash collision.
    monkeypatch.setattr(analyzer, "_image_signature", lambda _path: (0, 100))
    output = analyzer.analyze(NormalizedMedia(Path("fixture.mp4"), None, MediaInfo(9000, 160, 90, "h264", None)), tmp_path / "output")
    assert [frame.timestamp_ms for frame in output.keyframes] == [0, 2000, 5000, 6000, 7000, 7125, 7250, 8000]
    assert output.stats["same_scene_removed"] == 1
    coverage = output.stats["sampling_coverage"]
    assert coverage["timeline_complete"] and coverage["detected_scenes_complete"]
    assert coverage["ending_retained"] and coverage["opening_complete"]
    assert coverage["temporal_groups"] == [{"group_id": "cut-001", "retained_timestamps_ms": [7000, 7125, 7250], "complete": True}]


def test_short_insert_between_merged_boundaries_gets_its_own_representative(tmp_path):
    class DetectProcessor(Processor):
        def _execute(self, command):
            return subprocess.CompletedProcess(command, 0, "", " ".join(f"pts_time:{value}" for value in (10, 20, 30, 30.2, 40, 50, 60, 70, 80, 90, 99.8)))

        def probe(self, _source):
            return MediaInfo(100_000, 160, 90, "h264", None)

    extractor = PySceneDetectFrameExtractor(DetectProcessor(), analysis_profile="max")
    frames = extractor.extract(NormalizedMedia(Path("video.mp4"), None, MediaInfo(100_000, 160, 90, "h264", None)), tmp_path)
    insert = next(row for row in extractor.last_stats["scene_intervals"] if row["start_ms"] == 30_000)
    assert insert["end_ms"] == 30_200 and insert["representative_required"] is True
    assert any(frame.timestamp_ms == 30_100 and insert["id"] in frame.roles for frame in frames)
    assert any(frame.timestamp_ms == 99_900 for frame in frames)
    assert extractor.last_stats["raw_scene_count"] > extractor.last_stats["merged_scene_count"]
    assert not any(group["start_ms"] <= 30_100 <= group["end_ms"] for group in extractor.last_stats["temporal_groups"])


def test_exhausted_scene_budget_reports_missing_raw_coverage(tmp_path):
    class Ocr:
        def recognize(self, _path):
            return "", None

    extractor = PySceneDetectFrameExtractor(Processor(), maximum_frames=3, detector=lambda _: [(start, start + 2) for start in range(0, 20, 2)])
    result = KeyframeVisualAnalyzer(extractor, Ocr()).analyze(
        NormalizedMedia(Path("video.mp4"), None, MediaInfo(20_000, 160, 90, "h264", None)), tmp_path)
    coverage = result.stats["sampling_coverage"]
    assert coverage["timeline_complete"] and coverage["opening_complete"] and coverage["ending_retained"]
    assert coverage["detected_scenes_complete"] is False
    assert coverage["representative_scenes_complete"] is False
    assert any(not row["retained_timestamps_ms"] for row in coverage["detected_scenes"])
