from __future__ import annotations

import base64
import gzip
import json
from collections.abc import Mapping
from dataclasses import replace
from pathlib import Path
from typing import Any

from .adapters import NormalizedMedia, TranscriptOutput, VisualOutput
from .api_client import AnalyzerApiClient, ClaimedJob

# Paired with the dedicated manuscript.json receiver limit. Other subtitle
# artifacts keep their existing cap.
_MANUSCRIPT_MAX_BYTES = 16 * 1024 * 1024


def _json_bytes(value: Any) -> bytes:
    return json.dumps(value, ensure_ascii=False, separators=(",", ":")).encode("utf-8")


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

    def persist_manuscript(self, job: ClaimedJob, transcript: TranscriptOutput, workspace: Path,
                           evidence: Mapping[str, Any], *, manual: bool, original: TranscriptOutput | None = None) -> None:
        path = workspace / "manuscript.json"
        rows = [
            {"start_ms": row.start_ms, "end_ms": row.end_ms, "text": row.text}
            for row in transcript.segments
        ]
        if original is not None:
            for row, source in zip(rows, original.segments, strict=True):
                if row["text"] != source.text:
                    row["original_text"] = source.text
        document = {"version": "manuscript.v1", "language": transcript.language, "segments": rows,
                    "basis": "manual" if manual else "audio", "subtitle_evidence": evidence}
        data = _json_bytes(document)
        if len(data) > _MANUSCRIPT_MAX_BYTES:
            # Frame-level provenance can dwarf a valid long transcript. Keep
            # both wordings and the UI fields directly accessible; retain every
            # original proof record in a reversible, self-contained archive.
            archive = gzip.compress(_json_bytes(evidence), compresslevel=4, mtime=0)
            document["subtitle_evidence"] = {
                key: {name: value for name, value in proof.items() if name not in ("timestamps_ms", "captions")}
                for key, proof in evidence.items()
            }
            document["subtitle_evidence_archive"] = {
                "encoding": "gzip+base64", "format": "subtitle_evidence.json",
                "data": base64.b64encode(archive).decode("ascii"),
            }
            data = _json_bytes(document)
        if len(data) > _MANUSCRIPT_MAX_BYTES:
            raise ValueError("完整口播原稿、校订稿和字幕依据无损压缩后仍超过 16 MiB，稿件未提交。")
        path.write_bytes(data)
        self.client.upload_artifact(job, kind="subtitle", path=path, content_type="application/json")

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
