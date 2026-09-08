from __future__ import annotations

import json
import subprocess
from collections.abc import Callable, Sequence
from pathlib import Path

from .adapters import Keyframe, MediaInfo, NormalizedMedia


class MediaProcessingError(RuntimeError):
    pass


Runner = Callable[..., subprocess.CompletedProcess[str]]


class FfmpegMediaProcessor:
    def __init__(self, ffmpeg: str = "ffmpeg", ffprobe: str = "ffprobe", timeout_seconds: int = 900, runner: Runner = subprocess.run) -> None:
        self.ffmpeg = ffmpeg
        self.ffprobe = ffprobe
        self.timeout_seconds = timeout_seconds
        self._runner = runner

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

    def probe(self, source: Path) -> MediaInfo:
        result = self._execute([self.ffprobe, "-v", "error", "-show_streams", "-show_format", "-of", "json", str(source)])
        try:
            payload = json.loads(result.stdout); streams = payload.get("streams", []); media_format = payload.get("format", {})
            video = next((item for item in streams if item.get("codec_type") == "video"), None)
            audio = next((item for item in streams if item.get("codec_type") == "audio"), None)
            duration_ms = max(0, round(float(media_format.get("duration", 0)) * 1000))
            return MediaInfo(duration_ms, video.get("width") if video else None, video.get("height") if video else None, video.get("codec_name") if video else None, audio.get("codec_name") if audio else None)
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
        output_dir.mkdir(parents=True, exist_ok=True); pattern = output_dir / "frame-%06d.jpg"
        self.processor._execute([self.processor.ffmpeg, "-nostdin", "-y", "-v", "error", "-i", str(media.source_path), "-vf", f"fps=1/{self.interval_seconds}", "-q:v", "2", str(pattern)])
        return [Keyframe(index * self.interval_seconds * 1000, path) for index, path in enumerate(sorted(output_dir.glob("frame-*.jpg")))]
