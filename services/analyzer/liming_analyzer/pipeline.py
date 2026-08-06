from __future__ import annotations

from collections.abc import Mapping
from concurrent.futures import ALL_COMPLETED, ThreadPoolExecutor, wait
from pathlib import Path
from tempfile import TemporaryDirectory
from typing import Any

from .adapters import (
    AcquiredSource,
    AnalysisArtifactStore,
    AnalysisCheckpointStore,
    Keyframe,
    MediaInfo,
    MediaProcessor,
    NormalizedMedia,
    SourceProvider,
    SourceMetadata,
    SpeechRecognizer,
    StructureAnalyzer,
    TranscriptOutput,
    TranscriptSegment,
    VisualAnalyzer,
    VisualObservation,
    VisualOutput,
    build_analysis_result,
)
from .api_client import AnalysisResult, ClaimedJob


def _manual_transcript(job: ClaimedJob) -> TranscriptOutput | None:
    value = job.source.get("manual_transcript")
    if value is None:
        return None
    if not isinstance(value, Mapping) or not isinstance(value.get("segments"), list):
        raise TypeError("manual transcript is malformed")
    language = str(value.get("language") or "zh-CN").strip()
    rows: list[TranscriptSegment] = []
    for item in value["segments"]:
        if not isinstance(item, Mapping):
            raise TypeError("manual transcript segment is malformed")
        rows.append(TranscriptSegment(
            int(item.get("start_ms", item.get("startMs", 0))),
            int(item.get("end_ms", item.get("endMs", 0))),
            str(item.get("text", "")).strip(),
            None,
        ))
    if not rows:
        raise ValueError("manual transcript is empty")
    return TranscriptOutput(language, tuple(rows), None)


def _metadata_payload(metadata: SourceMetadata | None) -> dict[str, Any] | None:
    if metadata is None:
        return None
    return {
        "platform_work_id": metadata.platform_work_id, "title": metadata.title,
        "author_name": metadata.author_name, "published_at": metadata.published_at,
        "duration_sec": metadata.duration_sec, "plays": metadata.plays, "likes": metadata.likes,
        "comments": metadata.comments, "favorites": metadata.favorites, "shares": metadata.shares,
    }


def _evidence_checkpoint(media: NormalizedMedia, transcript: TranscriptOutput, visuals: VisualOutput, metadata: SourceMetadata | None) -> dict[str, Any]:
    return {
        "checkpoint_version": 1,
        "media": {
            "duration_ms": media.info.duration_ms, "width": media.info.width, "height": media.info.height,
            "video_codec": media.info.video_codec, "audio_codec": media.info.audio_codec,
        },
        "transcript": {
            "language": transcript.language, "confidence": transcript.confidence,
            "segments": [{"start_ms": row.start_ms, "end_ms": row.end_ms, "text": row.text, "confidence": row.confidence} for row in transcript.segments],
        },
        "visuals": {
            "keyframes": [{"timestamp_ms": row.timestamp_ms, "ocr_text": row.ocr_text, "confidence": row.confidence, "asset_id": row.asset_id} for row in visuals.keyframes],
            "observations": [{"kind": row.kind, "start_ms": row.start_ms, "end_ms": row.end_ms, "text": row.text, "confidence": row.confidence} for row in visuals.observations],
        },
        "source_metadata": _metadata_payload(metadata),
    }


def _restore_evidence_checkpoint(job: ClaimedJob, workspace: Path) -> tuple[NormalizedMedia, TranscriptOutput, VisualOutput, SourceMetadata | None] | None:
    value = job.checkpoint
    if job.checkpoint_stage != "evidence_ready" or not isinstance(value, Mapping) or value.get("checkpoint_version") != 1:
        return None
    try:
        media_value = value["media"]; transcript_value = value["transcript"]; visuals_value = value["visuals"]
        if not all(isinstance(item, Mapping) for item in (media_value, transcript_value, visuals_value)):
            return None
        info = MediaInfo(
            int(media_value["duration_ms"]),
            int(media_value["width"]) if media_value.get("width") is not None else None,
            int(media_value["height"]) if media_value.get("height") is not None else None,
            str(media_value["video_codec"]) if media_value.get("video_codec") else None,
            str(media_value["audio_codec"]) if media_value.get("audio_codec") else None,
        )
        raw_segments = transcript_value.get("segments")
        if not isinstance(raw_segments, list): return None
        transcript = TranscriptOutput(
            str(transcript_value.get("language") or "zh-CN"),
            tuple(TranscriptSegment(int(row["start_ms"]), int(row["end_ms"]), str(row["text"]), int(row["confidence"]) if row.get("confidence") is not None else None) for row in raw_segments if isinstance(row, Mapping)),
            int(transcript_value["confidence"]) if transcript_value.get("confidence") is not None else None,
        )
        raw_frames = visuals_value.get("keyframes"); raw_observations = visuals_value.get("observations")
        if not isinstance(raw_frames, list) or not isinstance(raw_observations, list): return None
        visuals = VisualOutput(
            tuple(Keyframe(int(row["timestamp_ms"]), workspace / f"restored-{index}.jpg", str(row["ocr_text"]) if row.get("ocr_text") else None, int(row["confidence"]) if row.get("confidence") is not None else None, str(row["asset_id"]) if row.get("asset_id") else None) for index, row in enumerate(raw_frames) if isinstance(row, Mapping)),
            tuple(VisualObservation(str(row["kind"]), int(row["start_ms"]), int(row["end_ms"]), str(row["text"]), int(row["confidence"]) if row.get("confidence") is not None else None) for row in raw_observations if isinstance(row, Mapping)),
        )
        metadata_value = value.get("source_metadata")
        metadata = SourceMetadata(**{key: metadata_value.get(key) for key in SourceMetadata.__dataclass_fields__}) if isinstance(metadata_value, Mapping) else None
        return NormalizedMedia(workspace / "checkpoint-source", None, info), transcript, visuals, metadata
    except (KeyError, TypeError, ValueError):
        return None


class AnalysisPipeline:
    def __init__(
        self,
        source: SourceProvider,
        media: MediaProcessor,
        speech: SpeechRecognizer,
        visual: VisualAnalyzer,
        structure: StructureAnalyzer,
        artifacts: AnalysisArtifactStore | None = None,
        checkpoints: AnalysisCheckpointStore | None = None,
        heartbeat_seconds: float = 30.0,
    ) -> None:
        if heartbeat_seconds <= 0:
            raise ValueError("heartbeat_seconds must be positive")
        self.source = source
        self.media = media
        self.speech = speech
        self.visual = visual
        self.structure = structure
        self.artifacts = artifacts
        self.checkpoints = checkpoints
        self.heartbeat_seconds = heartbeat_seconds

    def process(self, job: ClaimedJob, heartbeat) -> AnalysisResult:
        with TemporaryDirectory(prefix="liming-analysis-") as temporary:
            workspace = Path(temporary)
            restored = _restore_evidence_checkpoint(job, workspace)
            if restored is not None:
                media, transcript, visuals, source_metadata = restored
                current = heartbeat("analyzing", max(84, job.progress), "已从证据检查点恢复，正在继续结构分析")
                structure = self.structure.analyze(current, media, transcript, visuals)
                return build_analysis_result(transcript, structure, source_metadata)
            current = heartbeat("downloading", 5, "正在安全获取源媒体")
            acquired = self.source.acquire(current, workspace / "source-media")
            acquired = acquired if isinstance(acquired, AcquiredSource) else AcquiredSource(acquired)

            current = heartbeat("processing", 18, "正在规范化媒体并提取音轨")
            media = self.media.prepare(acquired.path, workspace / "normalized")
            manual_transcript = _manual_transcript(current)
            current = heartbeat("transcribing", 35, "正在使用人工校正版并提取画面" if manual_transcript else "正在并行转写语音与提取画面")

            with ThreadPoolExecutor(max_workers=2, thread_name_prefix="liming-evidence") as executor:
                transcript_future = executor.submit(self.speech.transcribe, media.audio_path) if media.audio_path and manual_transcript is None else None
                visuals_future = executor.submit(self.visual.analyze, media, workspace / "visuals")
                pending = {visuals_future}
                if transcript_future:
                    pending.add(transcript_future)
                progress = 40
                while pending:
                    _done, pending = wait(pending, timeout=self.heartbeat_seconds, return_when=ALL_COMPLETED)
                    if pending:
                        progress = min(64, progress + 4)
                        current = heartbeat("transcribing", progress, "正在转写语音并识别关键画面")
                transcript = manual_transcript or (transcript_future.result() if transcript_future else TranscriptOutput("zh-CN", ()))
                visuals = visuals_future.result()

            current = heartbeat("extracting", 70, "正在整理字幕、OCR 与关键帧证据")
            if self.artifacts:
                visuals = self.artifacts.persist(current, transcript, visuals, workspace)
            if self.checkpoints:
                try:
                    self.checkpoints.save(current, "evidence_ready", _evidence_checkpoint(media, transcript, visuals, acquired.metadata))
                except Exception:
                    pass
            current = heartbeat("analyzing", 84, "正在生成可追溯结构化结论")
            structure = self.structure.analyze(current, media, transcript, visuals)
            return build_analysis_result(transcript, structure, acquired.metadata)
