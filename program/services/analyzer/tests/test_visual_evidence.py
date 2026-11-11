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


def test_required_opening_and_cut_windows_ignore_general_frame_cap(tmp_path):
    extractor = PySceneDetectFrameExtractor(Processor(), maximum_frames=3, detector=lambda _: [(0, 4), (4, 7), (7, 10)])
    frames = extractor.extract(NormalizedMedia(Path("video.mp4"), None, MediaInfo(10_000, 160, 90, "h264", None)), tmp_path)
    opening = [frame.timestamp_ms for frame in frames if "opening" in frame.roles]
    assert opening == [0, 500, 1000, 1500, 2000, 2500]
    assert "first_frame" in frames[0].roles
    assert len(frames) <= extractor.last_stats["maximum_total_frames"]
    groups = extractor.last_stats["temporal_groups"]
    assert len(groups) == 3
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
    assert extractor.last_stats["temporal_groups"][1]["start_ms"] < 400


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
    assert output.stats["low_contrast_removed"] == 0
    assert output.stats["similar_removed"] == 0
    with Image.open(opening[0].path) as image:
        assert ImageStat.Stat(image.convert("L")).mean[0] < 5
    with Image.open(opening[-1].path) as image:
        assert ImageStat.Stat(image.convert("L")).mean[0] > 245
    assert output.stats["shot_detection"]["boundaries_ms"] == [0, 1000, 2000]
