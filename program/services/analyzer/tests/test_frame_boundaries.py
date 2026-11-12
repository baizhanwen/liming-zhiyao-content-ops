"""Real decoder boundaries, rather than container duration or exit status."""
import json
import shutil
import subprocess
from pathlib import Path

import pytest
from PIL import Image

from liming_analyzer.adapters import NormalizedMedia
from liming_analyzer.ffmpeg import FfmpegMediaProcessor, FrameExtractionError, VideoFrameTiming
from liming_analyzer.providers import PySceneDetectFrameExtractor


def result(command, stdout="", stderr="", code=0):
    return subprocess.CompletedProcess(command, code, stdout, stderr)


@pytest.mark.parametrize("image_bytes", [None, b"truncated-jpeg"])
def test_successful_command_without_a_decodable_image_is_not_success(tmp_path, image_bytes):
    def runner(command, **_kwargs):
        if command[0] == "ffprobe":
            return result(command, json.dumps({"frames": [{"best_effort_timestamp_time": "0"}]}))
        if image_bytes is not None:
            Path(command[-1]).write_bytes(image_bytes)
        return result(command, stderr="n: 0 pts: 0 pts_time:0")
    target = tmp_path / "empty.jpg"
    with pytest.raises(FrameExtractionError):
        FfmpegMediaProcessor(runner=runner).extract_video_frame(Path("fixture.mp4"), 999, target, VideoFrameTiming(video_end_ms=1000))
    assert not target.exists()


def test_actual_first_output_pts_is_used_instead_of_request_or_prefetched_frame(tmp_path):
    def runner(command, **_kwargs):
        Image.new("RGB", (16, 16), "red").save(command[-1])
        return result(command, stderr="n: 0 pts: 1024 pts_time:0.033333\nn: 1 pts: 2048 pts_time:0.066667")
    actual = FfmpegMediaProcessor(runner=runner).extract_video_frame(Path("fixture.mp4"), 1, tmp_path / "frame.jpg", VideoFrameTiming())
    assert actual == 33


@pytest.mark.parametrize("timestamp,expected", [
    ("1.11111e-05", 0), ("-1.11111e-05", 0),
    ("+1.11111E-05", 0), ("1.25e+1", 12500),
])
def test_showinfo_scientific_pts_keeps_the_exponent_and_first_frame(tmp_path, timestamp, expected):
    def runner(command, **_kwargs):
        Image.new("RGB", (16, 16), "red").save(command[-1])
        return result(command, stderr=f"n: 0 pts: 1 pts_time:{timestamp}\nn: 1 pts: 5400000 pts_time:60")
    actual = FfmpegMediaProcessor(runner=runner).extract_video_frame(
        Path("fixture.mp4"), 0, tmp_path / "frame.jpg", VideoFrameTiming(),
    )
    assert actual == expected


def test_unknown_stream_duration_uses_packet_hint_then_decodes_actual_tail(tmp_path):
    commands = []
    def runner(command, **_kwargs):
        commands.append(command)
        if "-show_packets" in command:
            return result(command, "0.000000\n9.500000\n9.900000\n")
        if "-show_frames" in command:
            assert command[command.index("-read_intervals") + 1] == "7.900000000%10.900000000"
            return result(command, json.dumps({"frames": [{"best_effort_timestamp_time": "9.900000"}]}))
        if float(command[command.index("-ss") + 1]) > 10:
            return result(command, stderr="no frames", code=234)
        Image.new("RGB", (16, 16), "red").save(command[-1])
        return result(command, stderr="n: 0 pts: 99 pts_time:9.9")
    actual = FfmpegMediaProcessor(runner=runner).extract_video_frame(Path("fixture.mp4"), 3_599_000, tmp_path / "frame.jpg", VideoFrameTiming())
    assert actual == 9900
    assert sum("-show_packets" in command for command in commands) == 1
    assert sum("-show_frames" in command for command in commands) == 1


def test_missing_start_metadata_has_a_defined_origin():
    def runner(command, **_kwargs):
        return result(command, json.dumps({"streams": [{"start_time": "N/A", "duration": "N/A"}], "format": {"start_time": "N/A"}}))
    assert FfmpegMediaProcessor(runner=runner).video_frame_timing(Path("fixture.ts")) == VideoFrameTiming()


@pytest.fixture
def processor():
    ffmpeg, ffprobe = shutil.which("ffmpeg"), shutil.which("ffprobe")
    if not ffmpeg or not ffprobe:
        pytest.skip("real FFmpeg pair unavailable")
    return FfmpegMediaProcessor(ffmpeg, ffprobe)


def make_video(processor, target, *options):
    subprocess.run([processor.ffmpeg, "-hide_banner", "-nostdin", "-y", "-v", "error", *options, str(target)], check=True, capture_output=True)


@pytest.mark.parametrize("rate", ["30", "30000/1001"])
def test_real_fractional_rate_tail_uses_last_actual_frame(processor, tmp_path, rate):
    source = tmp_path / "fractional.mp4"
    make_video(processor, source, "-f", "lavfi", "-i", f"testsrc=size=160x90:rate={rate}:duration=1", "-c:v", "libx264", "-pix_fmt", "yuv420p")
    timing = processor.video_frame_timing(source)
    target = tmp_path / "tail.jpg"
    actual = processor.extract_video_frame(source, timing.video_end_ms - 1, target, timing)
    assert 960 <= actual <= 970
    with Image.open(target) as image:
        image.load()


def test_real_long_gop_recovery_reaches_actual_end_not_seek_keyframe(processor, tmp_path):
    source = tmp_path / "long-gop.mp4"
    make_video(processor, source, "-f", "lavfi", "-i", "testsrc=size=160x90:rate=30:duration=4", "-c:v", "libx264", "-g", "300", "-keyint_min", "300", "-sc_threshold", "0", "-pix_fmt", "yuv420p")
    timing = processor.video_frame_timing(source)
    actual = processor.extract_video_frame(source, 3999, tmp_path / "tail.jpg", timing)
    assert actual == 3967


def test_real_eof_cut_merges_same_image_and_rebuilds_temporal_manifest(processor, tmp_path):
    source = tmp_path / "short-cut.mp4"
    make_video(processor, source, "-f", "lavfi", "-i", "testsrc=size=160x90:rate=30:duration=1", "-c:v", "libx264", "-pix_fmt", "yuv420p")
    extractor = PySceneDetectFrameExtractor(processor, analysis_profile="max", detector=lambda _: [(0, .9), (.9, 1)])
    frames = extractor.extract(NormalizedMedia(source, None, processor.probe(source)), tmp_path / "frames")
    times = [frame.timestamp_ms for frame in frames]
    assert len(times) == len(set(times))
    assert max(times) == 967
    assert extractor.last_stats["resolved_duplicate_count"] > 0
    for group in extractor.last_stats["temporal_groups"]:
        members = [frame.timestamp_ms for frame in frames if f"temporal:{group['group_id']}" in frame.roles]
        assert members == group["timestamps_ms"]
        assert len(members) >= 3
    for frame in frames:
        with Image.open(frame.path) as image:
            image.load()


def test_real_delayed_video_and_longer_audio_keep_the_audio_time_origin(processor, tmp_path):
    source = tmp_path / "delayed.mp4"
    make_video(processor, source, "-f", "lavfi", "-i", "testsrc=size=160x90:rate=10:duration=1", "-f", "lavfi", "-i", "sine=duration=2", "-filter:v", "setpts=PTS+3", "-fps_mode", "passthrough", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac")
    media = NormalizedMedia(source, None, processor.probe(source))
    extractor = PySceneDetectFrameExtractor(processor, detector=lambda _: [(0, 2)])
    frames = extractor.extract(media, tmp_path / "frames")
    assert media.info.duration_ms == 2000
    assert extractor.last_stats["video_sampling_end_ms"] == 1300
    assert frames[0].timestamp_ms == 300
    assert extractor.last_stats["first_frame_timestamp_ms"] == 300
    assert max(frame.timestamp_ms for frame in frames) == 1100  # Protected ending request is 250ms before the stream end.
    opening = next(group for group in extractor.last_stats["temporal_groups"] if group["kind"] == "opening")
    assert opening["first_frame_timestamp_ms"] == 300
    assert opening["timestamps_ms"][0] == 300


def test_real_vfr_requests_never_create_duplicate_fake_timestamps(processor, tmp_path):
    source = tmp_path / "vfr.mp4"
    make_video(processor, source, "-f", "lavfi", "-i", "testsrc=size=160x90:rate=10:duration=1", "-vf", "select='eq(n,0)+eq(n,1)+eq(n,5)+eq(n,9)'", "-fps_mode", "vfr", "-c:v", "libx264", "-pix_fmt", "yuv420p")
    extractor = PySceneDetectFrameExtractor(processor, detector=lambda _: [(0, 1)])
    frames = extractor.extract(NormalizedMedia(source, None, processor.probe(source)), tmp_path / "frames")
    times = [frame.timestamp_ms for frame in frames]
    assert set(times) <= {0, 100, 500, 900}
    assert len(times) == len(set(times))
    assert extractor.last_stats["resolved_duplicate_count"] > 0


@pytest.mark.parametrize("offset", [5, -5])
def test_real_nonzero_positive_and_negative_container_origins(processor, tmp_path, offset):
    source = tmp_path / "offset.ts"
    make_video(processor, source, "-f", "lavfi", "-i", "testsrc=size=160x90:rate=10:duration=1", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-output_ts_offset", str(offset), "-avoid_negative_ts", "disabled", "-muxdelay", "0")
    timing = processor.video_frame_timing(source)
    assert timing.origin_seconds == offset
    assert timing.video_start_ms == 0
    assert processor.extract_video_frame(source, 0, tmp_path / "first.jpg", timing) == 0
    assert processor.extract_video_frame(source, 999, tmp_path / "last.jpg", timing) == 900
