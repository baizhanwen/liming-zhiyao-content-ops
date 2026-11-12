from __future__ import annotations

import json
import io
import math
import re
import subprocess
from collections.abc import Callable, Sequence
from pathlib import Path
from dataclasses import dataclass

from .adapters import Keyframe, MediaInfo, NormalizedMedia


class MediaProcessingError(RuntimeError):
    pass


class FrameExtractionError(MediaProcessingError):
    """A requested image could not be decoded and verified."""


Runner = Callable[..., subprocess.CompletedProcess[str]]


@dataclass(frozen=True)
class VideoFrameTiming:
    origin_seconds: float = 0.0
    video_start_ms: int = 0
    video_end_ms: int | None = None


class FfmpegMediaProcessor:
    def __init__(self, ffmpeg: str = "ffmpeg", ffprobe: str = "ffprobe", timeout_seconds: int = 900, runner: Runner = subprocess.run) -> None:
        self.ffmpeg = ffmpeg
        self.ffprobe = ffprobe
        self.timeout_seconds = timeout_seconds
        self._runner = runner
        self._video_packet_endpoints: dict[str, float] = {}

    def _execute(self, command: Sequence[str]) -> subprocess.CompletedProcess[str]:
        try:
            result = self._runner(
                list(command),
                capture_output=True,
                text=True,
                encoding="utf-8",
                errors="replace",
                timeout=self.timeout_seconds,
                check=False,
            )
        except FileNotFoundError as error:
            executable = str(command[0]) if command else "media executable"
            raise MediaProcessingError(
                f"{executable} executable was not found; run tools\\setup-analyzer.bat "
                "to repair FFmpeg and ffprobe"
            ) from error
        except (OSError, subprocess.TimeoutExpired) as error:
            executable = str(command[0]) if command else "media executable"
            raise MediaProcessingError(f"{executable} media processing failed: {error}") from error
        if result.returncode != 0:
            message = (result.stderr or result.stdout or "media command failed").strip()[-2000:]
            raise MediaProcessingError(message)
        return result

    def video_frame_timing(self, source: Path) -> VideoFrameTiming:
        """Cheap stream bounds; frame timestamps are still verified after decoding.

        The container may include a much longer audio track. FFmpeg input seeks
        are relative to the format start, not the video stream's first PTS.
        """
        result = self._execute([
            self.ffprobe, "-v", "error", "-select_streams", "v:0", "-show_entries",
            "stream=start_time,duration:format=start_time,duration", "-of", "json", str(source),
        ])
        try:
            payload = json.loads(result.stdout)
            stream = payload["streams"][0]
            def number(value):
                parsed = float(value)
                if not math.isfinite(parsed):
                    raise ValueError("non-finite time")
                return parsed
            raw_origin = payload.get("format", {}).get("start_time")
            origin = number(raw_origin) if raw_origin not in {None, "N/A"} else 0.0
            raw_start = stream.get("start_time")
            start = number(raw_start) if raw_start not in {None, "N/A"} else origin
            duration = stream.get("duration")
            end_ms = round((start + number(duration) - origin) * 1000) if duration not in {None, "N/A"} else None
            return VideoFrameTiming(origin, max(0, round((start - origin) * 1000)), end_ms)
        except (KeyError, IndexError, TypeError, ValueError, json.JSONDecodeError) as error:
            raise FrameExtractionError("无法读取视频画面的时间范围，未生成空白画面。") from error

    @staticmethod
    def _verify_frame(path: Path) -> None:
        try:
            from PIL import Image
            if not path.is_file() or path.stat().st_size == 0:
                raise ValueError("missing image")
            with Image.open(path) as image:
                image.load()
                if image.width < 1 or image.height < 1:
                    raise ValueError("empty image")
        except (OSError, ValueError) as error:
            raise FrameExtractionError("抽帧命令没有生成可读取的图片。") from error

    def _nearby_frame_time(self, source: Path, target_ms: int, timing: VideoFrameTiming) -> float:
        """Decode a bounded nearby interval only after a requested frame is absent.

        Seeking after the final PTS can make MJPEG report a misleading color
        error. Do not guess duration-minus-one or silently accept an empty file.
        """
        endpoint = min(target_ms, timing.video_end_ms) if timing.video_end_ms is not None else target_ms
        # With absent stream duration, a long audio tail can put every nearby
        # seek well beyond the video. Only this uncommon recovery scans packet
        # timestamps (demuxing, not decoding the full film), then locally decodes
        # the real video tail. CSV has one scalar per packet, not large frame JSON.
        if timing.video_end_ms is None:
            key = str(source.resolve())
            if key not in self._video_packet_endpoints:
                result = self._execute([
                    self.ffprobe, "-v", "error", "-select_streams", "v:0", "-show_packets",
                    "-show_entries", "packet=pts_time", "-of", "csv=p=0", str(source),
                ])
                last_point = None
                for line in io.StringIO(result.stdout):
                    try:
                        point = float(line.split(",", 1)[0]) - timing.origin_seconds
                    except ValueError:
                        continue
                    if math.isfinite(point):
                        last_point = point if last_point is None else max(last_point, point)
                if last_point is None:
                    raise FrameExtractionError("视频没有可验证的画面时间。")
                if len(self._video_packet_endpoints) >= 8:
                    self._video_packet_endpoints.clear()
                self._video_packet_endpoints[key] = last_point
            endpoint = min(endpoint, round(self._video_packet_endpoints[key] * 1000))
        for window in (2, 8, 32):
            start = max(timing.video_start_ms / 1000, endpoint / 1000 - window)
            interval_start = f"{start + timing.origin_seconds:.9f}" if start > timing.video_start_ms / 1000 else ""
            result = self._execute([
                self.ffprobe, "-v", "error", "-select_streams", "v:0", "-read_intervals",
                f"{interval_start}%{endpoint / 1000 + timing.origin_seconds + 1:.9f}", "-show_frames", "-show_entries",
                "frame=best_effort_timestamp_time", "-of", "json", str(source),
            ])
            try:
                frames = json.loads(result.stdout).get("frames", [])
                points = sorted({float(row["best_effort_timestamp_time"]) - timing.origin_seconds for row in frames
                                 if row.get("best_effort_timestamp_time") not in {None, "N/A"}})
                points = [point for point in points if math.isfinite(point) and point >= 0]
            except (TypeError, ValueError, KeyError, json.JSONDecodeError) as error:
                raise FrameExtractionError("无法验证临近画面的真实时间，未使用猜测时间。") from error
            preceding = [point for point in points if point <= target_ms / 1000]
            if preceding:
                return preceding[-1]
            if points:
                return points[0]
        raise FrameExtractionError("请求时间附近没有可解码画面，请检查原视频。")

    def extract_video_frame(self, source: Path, timestamp_ms: int, path: Path,
                            timing: VideoFrameTiming) -> int:
        """Return the actual first encoded frame's media-relative timestamp."""
        target = max(timing.video_start_ms, timestamp_ms)
        if timing.video_end_ms is not None:
            target = min(target, max(timing.video_start_ms, timing.video_end_ms - 1))
        def write(seconds: float, *, decode_from: float | None = None) -> int:
            path.unlink(missing_ok=True)
            seek = max(0, seconds if decode_from is None else decode_from)
            filter_graph = "showinfo" if decode_from is None else f"select=gte(t\\,{seconds:.9f}),showinfo"
            result = self._execute([
                self.ffmpeg, "-hide_banner", "-nostdin", "-y", "-v", "info", "-copyts", "-start_at_zero",
                *(["-ss", f"{seek:.9f}"] if seek > 0 else []), "-i", str(source), "-vf", filter_graph,
                "-frames:v", "1", "-q:v", "2", str(path),
            ])
            self._verify_frame(path)
            match = re.search(
                r"\bn:\s*0\s+pts:.*?\bpts_time:\s*([+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?)(?![\w.])",
                result.stderr or "",
            )
            if match is None:
                raise FrameExtractionError("已生成图片但缺少真实画面时间，未将请求时间冒充画面时间。")
            actual = float(match.group(1))
            if not math.isfinite(actual) or actual < -0.001:
                raise FrameExtractionError("抽帧返回的真实画面时间无效。")
            return max(0, round(actual * 1000))
        try:
            return write(target / 1000)
        except MediaProcessingError as first_error:
            # One bounded recovery uses an observed frame PTS and seeks just
            # before it, avoiding decimal rounding past a fractional-rate frame.
            try:
                actual_seconds = self._nearby_frame_time(source, target, timing)
                return write(max(0, actual_seconds - 0.000001), decode_from=max(0, actual_seconds - 2))
            except MediaProcessingError as error:
                path.unlink(missing_ok=True)
                raise FrameExtractionError(f"无法取得 {timestamp_ms / 1000:.3f} 秒附近的有效画面：{error}") from first_error

    def probe(self, source: Path) -> MediaInfo:
        result = self._execute([self.ffprobe, "-v", "error", "-show_streams", "-show_format", "-of", "json", str(source)])
        try:
            payload = json.loads(result.stdout); streams = payload.get("streams", []); media_format = payload.get("format", {})
            video = next((item for item in streams if item.get("codec_type") == "video"), None)
            audio = next((item for item in streams if item.get("codec_type") == "audio"), None)
            duration_ms = max(0, round(float(media_format.get("duration", 0)) * 1000))
            rotation = 0.0
            if video:
                tags = video.get("tags") or {}
                raw_rotation = tags.get("rotate", 0)
                for side_data in video.get("side_data_list") or []:
                    if isinstance(side_data, dict) and side_data.get("rotation") is not None:
                        raw_rotation = side_data["rotation"]
                        break
                try:
                    rotation = float(raw_rotation)
                    if not math.isfinite(rotation):
                        rotation = 0.0
                except (TypeError, ValueError):
                    rotation = 0.0
            return MediaInfo(
                duration_ms, video.get("width") if video else None,
                video.get("height") if video else None,
                video.get("codec_name") if video else None,
                audio.get("codec_name") if audio else None,
                rotation, str(video["sample_aspect_ratio"]) if video and video.get("sample_aspect_ratio") else None,
                str(video["display_aspect_ratio"]) if video and video.get("display_aspect_ratio") else None,
            )
        except (TypeError, ValueError, json.JSONDecodeError) as error:
            raise MediaProcessingError("ffprobe returned invalid metadata") from error

    def prepare(self, source: Path, output_dir: Path) -> NormalizedMedia:
        if not source.is_file():
            raise MediaProcessingError("source media does not exist")
        output_dir.mkdir(parents=True, exist_ok=True); info = self.probe(source)
        if not info.audio_codec:
            return NormalizedMedia(source, None, info)
        audio_path = output_dir / "audio-16k-mono.wav"
        self._execute([
            self.ffmpeg, "-nostdin", "-y", "-v", "error", "-i", str(source),
            "-vn", "-ac", "1", "-ar", "16000",
            "-af", "highpass=f=80,lowpass=f=7600,loudnorm=I=-16:LRA=11:TP=-1.5",
            "-c:a", "pcm_s16le", str(audio_path),
        ])
        return NormalizedMedia(source, audio_path, info)


class FfmpegFrameExtractor:
    def __init__(self, processor: FfmpegMediaProcessor, interval_seconds: int = 5) -> None:
        if interval_seconds < 1:
            raise ValueError("interval_seconds must be positive")
        self.processor = processor
        self.interval_seconds = interval_seconds

    def extract(self, media: NormalizedMedia, output_dir: Path) -> list[Keyframe]:
        if not media.info.video_codec:
            return []
        output_dir.mkdir(parents=True, exist_ok=True)
        timing = self.processor.video_frame_timing(media.source_path)
        end = min(media.info.duration_ms, timing.video_end_ms) if timing.video_end_ms is not None else media.info.duration_ms
        frames = {}
        for index, requested in enumerate(range(0, max(1, end), self.interval_seconds * 1000), 1):
            path = output_dir / f"frame-{index:06d}.jpg"
            actual = self.processor.extract_video_frame(media.source_path, requested, path, timing)
            if actual in frames:
                path.unlink(missing_ok=True)
            else:
                frames[actual] = Keyframe(actual, path)
        return [frames[time] for time in sorted(frames)]
