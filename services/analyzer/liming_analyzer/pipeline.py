from __future__ import annotations

import logging
from collections.abc import Callable, Mapping
from concurrent.futures import ALL_COMPLETED, ThreadPoolExecutor, wait
from pathlib import Path
from tempfile import TemporaryDirectory
from typing import Any, TypeVar

from .adapters import (
    AcquiredSource,
    AnalysisArtifactStore,
    AnalysisCheckpointStore,
    Keyframe,
    MediaInfo,
    MediaProcessor,
    NormalizedMedia,
    SourceMetadata,
    SourceProvider,
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
from .evidence import clean_transcript

logger = logging.getLogger(__name__)
T = TypeVar("T")


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


def _progress_count(value: Any) -> int:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return 0
    return max(0, int(value))


def _visual_heartbeat_progress(
    snapshot: Mapping[str, Any],
) -> tuple[int, str]:
    phase = str(snapshot.get("phase") or "")
    keyframes_completed = _progress_count(snapshot.get("keyframes_completed"))
    keyframes_total = _progress_count(snapshot.get("keyframes_total"))
    batch_completed = _progress_count(snapshot.get("batch_completed"))
    batch_total = _progress_count(snapshot.get("batch_total"))
    details: list[str] = []
    if keyframes_total:
        details.append(
            f"关键帧 {min(keyframes_completed, keyframes_total)}/{keyframes_total}"
        )
    if batch_total:
        batch_label = "视觉补全" if phase == "vision_retry" else "视觉批次"
        details.append(
            f"{batch_label} {min(batch_completed, batch_total)}/{batch_total}"
        )
    if phase == "ocr" and keyframes_total:
        progress = 40 + round(12 * keyframes_completed / keyframes_total)
    elif phase == "vision" and batch_total:
        progress = 52 + round(14 * batch_completed / batch_total)
    elif phase == "vision_retry" and batch_total:
        progress = 66 + round(2 * batch_completed / batch_total)
    elif phase == "completed":
        progress = 68
    else:
        progress = 40
    return min(68, progress), " · ".join(details)


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
            "stats": dict(visuals.stats),
        },
        "source_metadata": _metadata_payload(metadata),
    }


def _restore_evidence_checkpoint(job: ClaimedJob, workspace: Path) -> tuple[NormalizedMedia, TranscriptOutput, VisualOutput, SourceMetadata | None] | None:
    value = job.checkpoint
    if job.checkpoint_stage not in {"evidence_ready", "segment_progress"} or not isinstance(value, Mapping) or value.get("checkpoint_version") != 1:
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
            dict(visuals_value.get("stats")) if isinstance(visuals_value.get("stats"), Mapping) else {},
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
        heartbeat_seconds: float = 8.0,
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

    def _run_monitored(
        self,
        operation: Callable[[], T],
        current: ClaimedJob,
        heartbeat,
        status: str,
        progress: int,
        stage: str,
        on_current: Callable[[ClaimedJob], None] | None = None,
    ) -> tuple[ClaimedJob, T]:
        """Keep worker presence and the job lease alive during one blocking operation."""
        with ThreadPoolExecutor(max_workers=1, thread_name_prefix="liming-stage") as executor:
            future = executor.submit(operation)
            while not future.done():
                wait((future,), timeout=self.heartbeat_seconds, return_when=ALL_COMPLETED)
                if not future.done():
                    current = heartbeat(status, progress, stage)
                    if on_current is not None:
                        on_current(current)
            return current, future.result()

    def _run_structure(
        self,
        current: ClaimedJob,
        media: NormalizedMedia,
        transcript: TranscriptOutput,
        visuals: VisualOutput,
        source_metadata: SourceMetadata | None,
        heartbeat,
        progress: int,
        stage: str,
    ) -> tuple[ClaimedJob, Any]:
        set_checkpoint = getattr(self.structure, "set_segment_checkpoint", None)
        latest = [current]
        if callable(set_checkpoint) and self.checkpoints is not None:
            base_checkpoint = _evidence_checkpoint(media, transcript, visuals, source_metadata)

            def persist_segment_progress(progress_payload: Mapping[str, Any]) -> None:
                try:
                    self.checkpoints.save(latest[0], "segment_progress", {**base_checkpoint, "segment_progress": dict(progress_payload)})
                except Exception as error:  # noqa: BLE001 - checkpoint is resumability only
                    logger.warning("Could not persist segment checkpoint: %s", error)

            set_checkpoint(persist_segment_progress)
        try:
            return self._run_monitored(
                lambda: self.structure.analyze(current, media, transcript, visuals),
                current, heartbeat, "analyzing", progress, stage,
                on_current=lambda job: latest.__setitem__(0, job),
            )
        finally:
            if callable(set_checkpoint):
                set_checkpoint(None)

    def process(self, job: ClaimedJob, heartbeat) -> AnalysisResult:
        with TemporaryDirectory(prefix="liming-analysis-") as temporary:
            workspace = Path(temporary)
            restored = _restore_evidence_checkpoint(job, workspace)
            if restored is not None:
                media, transcript, visuals, source_metadata = restored
                current = heartbeat("analyzing", max(84, job.progress), "已从证据检查点恢复，正在继续结构分析")
                current, structure = self._run_structure(current, media, transcript, visuals, source_metadata, heartbeat, max(84, current.progress), "正在从证据检查点继续生成结构化结论")
                return build_analysis_result(transcript, structure, source_metadata)
            configure_visual_profile = getattr(self.visual, "set_analysis_profile", None)
            if callable(configure_visual_profile):
                configure_visual_profile(job.analysis_profile)
            current = heartbeat("downloading", 5, "正在安全获取源媒体")
            current, acquired = self._run_monitored(
                lambda: self.source.acquire(current, workspace / "source-media"),
                current,
                heartbeat,
                "downloading",
                8,
                "正在下载源媒体并保持分析服务在线",
            )
            acquired = acquired if isinstance(acquired, AcquiredSource) else AcquiredSource(acquired)

            current = heartbeat("processing", 18, "正在规范化媒体并提取音轨")
            current, media = self._run_monitored(
                lambda: self.media.prepare(acquired.path, workspace / "normalized"),
                current,
                heartbeat,
                "processing",
                22,
                "正在规范化媒体并保持分析服务在线",
            )
            manual_transcript = _manual_transcript(current)
            configure_speech_context = getattr(self.speech, "set_context", None)
            if callable(configure_speech_context):
                configure_speech_context(acquired.metadata.title if acquired.metadata else None)
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
                        progress_snapshot = getattr(
                            self.visual,
                            "progress_snapshot",
                            None,
                        )
                        snapshot = (
                            progress_snapshot()
                            if callable(progress_snapshot)
                            else {}
                        )
                        if snapshot:
                            visual_progress, detail = _visual_heartbeat_progress(snapshot)
                            progress = max(progress, visual_progress)
                        else:
                            detail = ""
                            progress = min(64, progress + 4)
                        speech_pending = (
                            transcript_future is not None
                            and transcript_future in pending
                        )
                        visual_pending = visuals_future in pending
                        if speech_pending and visual_pending:
                            stage = "正在转写语音并识别关键画面"
                        elif visual_pending:
                            stage = "正在识别关键画面"
                        else:
                            stage = "正在转写语音"
                        if detail:
                            stage += f" · {detail}"
                        current = heartbeat("transcribing", progress, stage)
                transcript = manual_transcript or clean_transcript(transcript_future.result() if transcript_future else TranscriptOutput("zh-CN", ()))
                visuals = visuals_future.result()

            current = heartbeat("extracting", 70, "正在整理字幕、OCR 与关键帧证据")
            if self.artifacts:
                current, visuals = self._run_monitored(
                    lambda: self.artifacts.persist(current, transcript, visuals, workspace),
                    current,
                    heartbeat,
                    "extracting",
                    76,
                    "正在保存字幕和关键画面证据",
                )
            if self.checkpoints:
                try:
                    self.checkpoints.save(current, "evidence_ready", _evidence_checkpoint(media, transcript, visuals, acquired.metadata))
                except Exception as error:  # noqa: BLE001 - checkpoint is resumability only
                    logger.warning("Could not persist the analysis checkpoint: %s", error)
            current = heartbeat("analyzing", 84, "正在生成可追溯结构化结论")
            current, structure = self._run_structure(current, media, transcript, visuals, acquired.metadata, heartbeat, 88, "模型正在生成可追溯结构化结论")
            return build_analysis_result(transcript, structure, acquired.metadata)
