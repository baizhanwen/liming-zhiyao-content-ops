from __future__ import annotations

from collections.abc import Mapping
from dataclasses import replace
from pathlib import Path
from typing import Any

from .adapters import NormalizedMedia, TranscriptOutput, VisualOutput
from .api_client import AnalyzerApiClient, ClaimedJob


def _vtt_time(milliseconds: int) -> str:
    total = max(0, milliseconds)
    hours, remainder = divmod(total, 3_600_000)
    minutes, remainder = divmod(remainder, 60_000)
    seconds, millis = divmod(remainder, 1000)
    return f"{hours:02d}:{minutes:02d}:{seconds:02d}.{millis:03d}"


def transcript_vtt(transcript: TranscriptOutput) -> str:
    cues = ["WEBVTT", ""]
    for index, item in enumerate(transcript.segments, start=1):
        end = max(item.end_ms, item.start_ms + 500)
        cues.extend(
            [
                str(index),
                f"{_vtt_time(item.start_ms)} --> {_vtt_time(end)}",
                item.text.replace("\n", " "),
                "",
            ]
        )
    return "\n".join(cues)


class ApiArtifactStore:
    def __init__(self, client: AnalyzerApiClient) -> None:
        self.client = client

    def persist_source(self, job: ClaimedJob, media: NormalizedMedia) -> Mapping[str, Any] | None:
        if job.source_type != "url":
            return None
        suffix = media.source_path.suffix.lower()
        content_type = {".webm": "video/webm", ".mov": "video/quicktime", ".mp3": "audio/mpeg",
                        ".m4a": "audio/mp4", ".wav": "audio/wav", ".ogg": "audio/ogg"}.get(suffix, "video/mp4" if media.info.video_codec else "audio/mp4")
        return self.client.upload_artifact(job,
            kind="source_video" if media.info.video_codec else "source_audio",
            path=media.source_path, content_type=content_type)

    def persist(
        self,
        job: ClaimedJob,
        transcript: TranscriptOutput,
        visuals: VisualOutput,
        workspace: Path,
    ) -> VisualOutput:
        if transcript.segments:
            subtitle = workspace / "transcript.vtt"
            subtitle.write_text(transcript_vtt(transcript), encoding="utf-8")
            self.client.upload_artifact(
                job,
                kind="subtitle",
                path=subtitle,
                content_type="text/vtt; charset=utf-8",
            )
        keyframes = []
        for frame in visuals.keyframes:
            asset = self.client.upload_artifact(
                job,
                kind="keyframe",
                path=frame.path,
                content_type="image/jpeg",
                timestamp_ms=frame.timestamp_ms,
                ocr_text=frame.ocr_text,
                confidence=frame.confidence,
            )
            keyframes.append(replace(frame, asset_id=str(asset["id"])))
        return VisualOutput(tuple(keyframes), visuals.observations, visuals.stats)

    def save(self, job: ClaimedJob, stage: str, checkpoint: Mapping[str, Any]) -> None:
        self.client.save_checkpoint(job, stage, checkpoint)
