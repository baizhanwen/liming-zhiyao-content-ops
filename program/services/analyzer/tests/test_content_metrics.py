from pathlib import Path

import pytest

from liming_analyzer.adapters import (
    MediaInfo,
    NormalizedMedia,
    TranscriptOutput,
    TranscriptSegment,
    VisualOutput,
)
from liming_analyzer.content_metrics import build_content_metrics


def metrics(info, segments=(), stats=None):
    return build_content_metrics(NormalizedMedia(Path("fixture.mp4"), None, info), TranscriptOutput("zh-CN", segments), VisualOutput(stats=stats or {}))


@pytest.mark.parametrize(("duration", "bucket"), [(14_999, "under_15s"), (15_000, "15_to_under_30s"), (30_000, "30_to_under_60s"), (60_000, "60_to_under_180s"), (180_000, "180s_and_above")])
def test_duration_buckets_do_not_overlap(duration, bucket):
    assert metrics(MediaInfo(duration, 1080, 1920, "h264", None))["media"]["duration_bucket"] == bucket


def test_display_aspect_uses_rotation_and_non_square_pixels():
    rotated = metrics(MediaInfo(10_000, 1920, 1080, "h264", None, -90, "1:1"))["media"]
    assert rotated["aspect_category"] == "9:16"
    assert rotated["display_aspect_ratio"] == "9:16"
    anamorphic = metrics(MediaInfo(10_000, 1440, 1080, "h264", None, 0, "4:3"))["media"]
    assert anamorphic["aspect_category"] == "16:9"
    invalid = metrics(MediaInfo(10_000, 1440, 1080, "h264", None, 0, "broken"))["media"]
    assert invalid["aspect_category"] is None
    assert invalid["aspect_status"] == "unknown"


def test_raw_detected_boundaries_are_measured_before_frame_sampling():
    result = metrics(MediaInfo(10_000, 1080, 1920, "h264", None), stats={
        "shot_detection": {"status": "measured", "method": "ffmpeg_scene_score.v1", "threshold": .32, "boundaries_ms": [0, 400, 500, 2_000, 10_000]},
    })["shot_detection"]
    assert result["detected_cut_count"] == 3
    assert result["detected_shot_count"] == 4
    assert result["mean_shot_seconds"] == 2.5
    assert result["cuts_per_minute"] == 18
    assert sum(row["duration_ms"] for row in result["segments"]) == 10_000


def test_legacy_scene_count_is_not_fabricated_as_measured_cuts():
    result = metrics(MediaInfo(10_000, 1080, 1920, "h264", None), stats={"scene_count": 6})
    assert result["shot_detection"]["status"] == "unknown"
    assert result["shot_detection"]["detected_cut_count"] is None


def test_character_rates_use_uncorrected_text_and_explicit_denominators():
    result = metrics(MediaInfo(10_000, None, None, None, "pcm"), (
        TranscriptSegment(0, 2_000, "你好，AI 2！"),
        TranscriptSegment(4_000, 4_000, "没时间戳"),
    ))["transcript_statistics"]
    assert result["character_count"] == 9
    assert result["characters_per_video_second"] == .9
    assert result["segments"][0]["characters_per_second"] == 2.5
    assert result["segments"][1]["characters_per_second"] is None
    assert result["segments"][1]["status"] == "unknown"
    assert result["source"] == "uncorrected_transcript_after_overlap_dedup"


def test_empty_media_does_not_produce_false_zero_rates_or_audio_measurements():
    result = metrics(MediaInfo(0, None, None, None, None))
    assert result["media"]["duration_bucket"] is None
    assert result["shot_detection"]["status"] == "not_applicable"
    assert result["transcript_statistics"]["characters_per_video_second"] is None
    assert result["transcript_statistics"]["character_count"] is None
    assert result["methodology"]["audio_analysis"] == "out_of_scope"
