from __future__ import annotations

import logging
import hashlib
import json
import re
import time
from collections.abc import Callable, Mapping
from concurrent.futures import ALL_COMPLETED, ThreadPoolExecutor, wait
from dataclasses import replace
from pathlib import Path
from tempfile import TemporaryDirectory
from threading import RLock
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
    StructureOutput,
    TranscriptOutput,
    TranscriptSegment,
    VisualAnalyzer,
    VisualObservation,
    VisualOutput,
    build_analysis_result,
)
from .api_client import AnalysisResult, ClaimedJob
from .evidence import clean_transcript
from .task_progress import observe
from .visual import OcrEngine

logger = logging.getLogger(__name__)
T = TypeVar("T")


def _digest(value: Any) -> str:
    return hashlib.sha256(json.dumps(value, ensure_ascii=False, sort_keys=True,
        separators=(",", ":"), allow_nan=False).encode("utf-8")).hexdigest()


def _transcript_payload(transcript: TranscriptOutput) -> dict[str, Any]:
    return {"language": transcript.language, "confidence": transcript.confidence,
            "segments": [{"start_ms": row.start_ms, "end_ms": row.end_ms, "text": row.text,
                          "confidence": row.confidence} for row in transcript.segments]}


def _read_transcript(value: Any) -> TranscriptOutput:
    if not isinstance(value, Mapping) or not isinstance(value.get("segments"), list):
        raise ValueError("invalid saved transcript")
    rows = []
    for row in value["segments"]:
        if (not isinstance(row, Mapping) or type(row.get("start_ms")) is not int
                or type(row.get("end_ms")) is not int or not isinstance(row.get("text"), str)):
            raise ValueError("invalid saved transcript segment")
        rows.append(TranscriptSegment(row["start_ms"], row["end_ms"], row["text"], row.get("confidence")))
    return TranscriptOutput(str(value.get("language") or "zh-CN"), tuple(rows), value.get("confidence"))


def _manual_source_hash(job: ClaimedJob) -> str | None:
    manual = _manual_transcript(job)
    return _digest(_transcript_payload(manual)) if manual is not None else None


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
    ocr_completed = _progress_count(snapshot.get("ocr_completed"))
    ocr_total = _progress_count(snapshot.get("ocr_total"))
    details: list[str] = []
    if keyframes_total:
        details.append(
            f"候选画面 {min(keyframes_completed, keyframes_total)}/{keyframes_total}"
        )
    if batch_total:
        batch_label = "视觉补全" if phase == "vision_retry" else "视觉批次"
        details.append(
            f"{batch_label} {min(batch_completed, batch_total)}/{batch_total}"
        )
    if ocr_total:
        details.append(f"OCR {min(ocr_completed, ocr_total)}/{ocr_total}")
    if phase == "ocr" and ocr_total:
        # Independent OCR/VLM work can now overlap. Neither branch may pretend
        # the other's counters are complete or erase already reported work.
        progress = 40 + round(12 * min(ocr_completed, ocr_total) / ocr_total
                              + (14 * min(batch_completed, batch_total) / batch_total if batch_total else 0))
    elif phase == "ocr" and keyframes_total:
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


def _evidence_checkpoint(media: NormalizedMedia, transcript: TranscriptOutput, visuals: VisualOutput, metadata: SourceMetadata | None, *, transcript_review_enabled: bool = True) -> dict[str, Any]:
    return {
        "checkpoint_version": 1,
        "transcript_review_enabled": transcript_review_enabled,
        "media": {
            "duration_ms": media.info.duration_ms, "width": media.info.width, "height": media.info.height,
            "video_codec": media.info.video_codec, "audio_codec": media.info.audio_codec,
            "rotation_degrees": media.info.rotation_degrees,
            "sample_aspect_ratio": media.info.sample_aspect_ratio,
            "display_aspect_ratio": media.info.display_aspect_ratio,
        },
        "transcript": {
            "language": transcript.language, "confidence": transcript.confidence,
            "segments": [{"start_ms": row.start_ms, "end_ms": row.end_ms, "text": row.text, "confidence": row.confidence} for row in transcript.segments],
        },
        "visuals": {
            "keyframes": [{"timestamp_ms": row.timestamp_ms, "ocr_text": row.ocr_text, "confidence": row.confidence, "asset_id": row.asset_id, "roles": list(row.roles)} for row in visuals.keyframes],
            "observations": [{"kind": row.kind, "start_ms": row.start_ms, "end_ms": row.end_ms, "text": row.text, "confidence": row.confidence} for row in visuals.observations],
            "stats": dict(visuals.stats),
        },
        "source_metadata": _metadata_payload(metadata),
    }


def _restore_evidence_checkpoint(job: ClaimedJob, workspace: Path) -> tuple[NormalizedMedia, TranscriptOutput, VisualOutput, SourceMetadata | None] | None:
    value = job.checkpoint
    if job.checkpoint_stage not in {"evidence_ready", "segment_progress"} or not isinstance(value, Mapping) or value.get("checkpoint_version") != 1:
        return None
    if (value.get("transcript_review_enabled", True) is not
            (job.source.get("transcript_review_enabled") is not False)):
        # Reviewed checkpoints may already contain subtitle substitutions. A
        # change of mode must reacquire the unedited source instead of relabeling it.
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
            float(media_value.get("rotation_degrees") or 0),
            str(media_value["sample_aspect_ratio"]) if media_value.get("sample_aspect_ratio") else None,
            str(media_value["display_aspect_ratio"]) if media_value.get("display_aspect_ratio") else None,
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
            tuple(Keyframe(int(row["timestamp_ms"]), workspace / f"restored-{index}.jpg", str(row["ocr_text"]) if row.get("ocr_text") else None, int(row["confidence"]) if row.get("confidence") is not None else None, str(row["asset_id"]) if row.get("asset_id") else None, tuple(str(role) for role in row.get("roles", []) if isinstance(role, str)) if isinstance(row.get("roles", []), list) else ()) for index, row in enumerate(raw_frames) if isinstance(row, Mapping)),
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
        visual: VisualAnalyzer | None,
        structure: StructureAnalyzer | None,
        artifacts: AnalysisArtifactStore | None = None,
        checkpoints: AnalysisCheckpointStore | None = None,
        heartbeat_seconds: float = 8.0,
        *,
        manuscript_ocr: OcrEngine | None = None,
    ) -> None:
        if heartbeat_seconds <= 0:
            raise ValueError("heartbeat_seconds must be positive")
        self.manuscript_ocr = manuscript_ocr
        self.source = source
        self.media = media
        self.speech = speech
        self.visual = visual
        self.structure = structure
        self.artifacts = artifacts
        self.checkpoints = checkpoints
        self.heartbeat_seconds = heartbeat_seconds

    def _phase(self, phase: str) -> None:
        monitor = getattr(self, "runtime_monitor", None)
        if callable(monitor):
            monitor("phase", phase)

    def _speech_fingerprint(self) -> str:
        configured = getattr(self, "asr_fingerprint", None)
        if isinstance(configured, str) and re.fullmatch(r"[a-f0-9]{64}", configured):
            return configured
        return _digest({"version": "injected-asr.v1", "class": type(self.speech).__module__ + "." + type(self.speech).__qualname__,
                        **{name: value for name in ("backend", "model", "language", "device")
                           if isinstance(value := getattr(self.speech, name, None), (str, int, bool))}})

    def _restore_transcript(self, job: ClaimedJob) -> Mapping[str, Any] | None:
        value = job.checkpoint
        if job.checkpoint_stage != "transcript_ready" or not isinstance(value, Mapping) or value.get("checkpoint_version") != 2:
            return None
        try:
            if (value.get("transcript_review_enabled") is not (job.source.get("transcript_review_enabled") is not False)
                    or value.get("manual_source_hash") != _manual_source_hash(job)
                    or value.get("asr_fingerprint") != self._speech_fingerprint()
                    or _digest(value.get("transcript")) != value.get("transcript_sha256")):
                return None
            _read_transcript(value["transcript"])
            source = value["source_asset"]
            if (not isinstance(value.get("media"), Mapping) or not isinstance(source, Mapping)
                    or not isinstance(source.get("id"), str) or not source["id"]
                    or not isinstance(source.get("sha256"), str) or not re.fullmatch(r"[a-f0-9]{64}", source["sha256"])
                    or type(source.get("size_bytes")) is not int or source["size_bytes"] <= 0
                    or source.get("kind") not in {"source_video", "source_audio"}):
                return None
            return value
        except (KeyError, TypeError, ValueError):
            return None

    def _save_transcript(self, job: ClaimedJob, media: NormalizedMedia, transcript: TranscriptOutput,
                         source_asset: Mapping[str, Any], metadata: SourceMetadata | None) -> None:
        payload = _transcript_payload(transcript)
        value = {"checkpoint_version": 2, "transcript": payload, "transcript_sha256": _digest(payload),
                 "media": _evidence_checkpoint(media, transcript, VisualOutput(), metadata)["media"],
                 "source_asset": {name: source_asset[name] for name in ("id", "sha256", "size_bytes", "kind")},
                 "source_metadata": _metadata_payload(metadata), "asr_fingerprint": self._speech_fingerprint(),
                 "transcript_review_enabled": job.source.get("transcript_review_enabled") is not False,
                 "manual_source_hash": _manual_source_hash(job)}
        self.checkpoints.save(job, "transcript_ready", value)

    def _run_monitored(
        self,
        operation: Callable[[], T],
        current: ClaimedJob,
        heartbeat,
        status: str,
        progress: int,
        stage: str | Callable[[], str],
        on_current: Callable[[ClaimedJob], None] | None = None,
    ) -> tuple[ClaimedJob, T]:
        """Keep worker presence and the job lease alive during one blocking operation."""
        with ThreadPoolExecutor(max_workers=1, thread_name_prefix="liming-stage") as executor:
            future = executor.submit(operation)
            while not future.done():
                wait((future,), timeout=self.heartbeat_seconds, return_when=ALL_COMPLETED)
                if not future.done():
                    current = heartbeat(status, progress, stage() if callable(stage) else stage)
                    if on_current is not None:
                        on_current(current)
            return current, future.result()

    def _extract_manuscript(
        self, current: ClaimedJob, media: NormalizedMedia, manual: TranscriptOutput | None,
        workspace: Path, heartbeat, *, restored_raw: TranscriptOutput | None = None,
        source_asset: Mapping[str, Any] | None = None, source_metadata: SourceMetadata | None = None,
    ) -> tuple[ClaimedJob, TranscriptOutput]:
        from .manuscript_punctuation import punctuate_manuscript
        from .subtitle_evidence import SubtitleRecovery, recover_burned_subtitles

        self._phase("speech")
        current = heartbeat("transcribing", max(35, current.progress), "已复用完整原始转写" if restored_raw is not None else "正在从原声提取完整口播稿")
        counted_progress = [False]
        observer = getattr(heartbeat, "observe", None)
        def speech_progress(payload):
            if isinstance(payload, Mapping) and "total_chunks" in payload:
                counted_progress[0] = True
            if callable(observer):
                observer(payload)
        set_progress = getattr(self.speech, "set_progress", None)
        if callable(set_progress):
            set_progress(speech_progress)
        if restored_raw is not None:
            transcript = restored_raw
        elif manual is not None:
            transcript = manual
        elif media.audio_path is not None:
            observe(heartbeat, "model_transcription", transcribed_chunks=0, total_chunks=1)
            current, raw = self._run_monitored(
                lambda: self.speech.transcribe(media.audio_path), current, heartbeat,
                "transcribing", 35, "正在转写完整音轨",
            )
            transcript = raw
        else:
            transcript = TranscriptOutput("zh-CN", ())
        if source_asset is not None and restored_raw is None:
            # Persist the unedited words before any subtitle/OCR or visual work.
            # A later isolated-stage timeout must not pay for ASR a second time.
            self._phase("artifacts")
            current, _ = self._run_monitored(
                lambda: self._save_transcript(current, media, transcript, source_asset, source_metadata),
                current, heartbeat, "transcribing", max(36, current.progress), "正在保存转写恢复检查点",
            )
            persist_raw = getattr(self.artifacts, "persist_manuscript", None)
            if callable(persist_raw) and transcript.segments:
                current, _ = self._run_monitored(
                    lambda: persist_raw(current, transcript, workspace, {}, manual=manual is not None, original=transcript),
                    current, heartbeat, "transcribing", max(36, current.progress), "正在保存完整原始转写",
                )
        if not transcript.segments:
            return current, transcript

        if current.source.get("transcript_review_enabled") is not False and manual is None:
            transcript = clean_transcript(transcript)
        recovered = SubtitleRecovery(transcript, {})
        review_enabled = current.source.get("transcript_review_enabled") is not False
        if review_enabled and manual is None and media.info.video_codec and self.manuscript_ocr is not None:
            self._phase("subtitle")
            def read_captions():
                try:
                    read_timing = getattr(self.speech, "timing_transcript_for", None)
                    timing = read_timing(media.audio_path) if callable(read_timing) else None
                    return recover_burned_subtitles(
                        media.source_path, transcript, ocr=self.manuscript_ocr,
                        timing_transcript=timing if isinstance(timing, TranscriptOutput) else None,
                    )
                except Exception as error:  # noqa: BLE001 - optional captions cannot discard a valid audio transcript
                    logger.warning("同期字幕读取失败，保留原声转写 (%s)", type(error).__name__)
                    return SubtitleRecovery(transcript, {})
            current, recovered = self._run_monitored(
                read_captions, current, heartbeat, "transcribing", max(37, current.progress), "正在对齐原片字幕与口播时间",
            )
        manuscript = (transcript if not review_enabled or manual is not None
                      else punctuate_manuscript(transcript, recovered.transcript))
        persist = getattr(self.artifacts, "persist_manuscript", None)
        if callable(persist):
            self._phase("artifacts")
            # This scoped artifact survives downstream service errors and report retries.
            if source_asset is not None:
                current, _ = self._run_monitored(
                    lambda: persist(current, manuscript, workspace, recovered.evidence, manual=manual is not None, original=transcript),
                    current, heartbeat, "transcribing", max(37, current.progress), "正在保存口播稿与字幕依据",
                )
            else:
                persist(current, manuscript, workspace, recovered.evidence, manual=manual is not None, original=transcript)
        observe(heartbeat, "model_transcription", **({"transcribed_chunks": 1, "total_chunks": 1} if not counted_progress[0] else {}))
        return current, manuscript

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
        self._phase("model")
        set_checkpoint = getattr(self.structure, "set_segment_checkpoint", None)
        set_unified = getattr(self.structure, "set_unified_checkpoint", None)
        latest = [current]
        unified_stage = [stage]
        state_lock = RLock()
        retry_metadata: dict[str, Any] = {}
        retry_keys = current.checkpoint.get("retry_module_keys") if isinstance(current.checkpoint, Mapping) else None
        if isinstance(retry_keys, list) and 0 < len(retry_keys) <= 5 and all(
            isinstance(key, str) and key in {"canonical", "text_topic_structure_audience", "text_expression_value", "visual", "synthesis"}
            for key in retry_keys
        ):
            retry_metadata["retry_module_keys"] = list(dict.fromkeys(retry_keys))

        retry_ids = current.checkpoint.get("retry_review_segment_ids") if isinstance(current.checkpoint, Mapping) else None
        if isinstance(retry_ids, list) and 0 < len(retry_ids) <= 1_000 and all(
            isinstance(value, str) and re.fullmatch(r"transcript:\d{4,}", value) for value in retry_ids
        ):
            retry_metadata["retry_review_segment_ids"] = list(dict.fromkeys(retry_ids))

        def synchronized_heartbeat(status: str, value: int, detail: str) -> ClaimedJob:
            # The owner may commit the new version before its heartbeat ACK
            # returns over HTTP/the process pipe. Checkpoints must not observe
            # that half-completed transition and retry an already-paid module.
            with state_lock:
                updated = heartbeat(status, value, detail)
                latest[0] = updated
                return updated

        if callable(set_checkpoint) and self.checkpoints is not None:
            base_checkpoint = {**_evidence_checkpoint(media, transcript, visuals, source_metadata,
                transcript_review_enabled=current.source.get("transcript_review_enabled") is not False), **retry_metadata}

            def persist_segment_progress(progress_payload: Mapping[str, Any]) -> None:
                rows = progress_payload.get("segments")
                if isinstance(rows, list):
                    observe(heartbeat, "model_analysis", completed=sum(1 for row in rows if isinstance(row, Mapping) and row.get("status") == "completed"), total=len(rows))
                try:
                    with state_lock:
                        self.checkpoints.save(latest[0], "segment_progress", {**base_checkpoint, "segment_progress": dict(progress_payload)})
                except Exception as error:  # noqa: BLE001 - checkpoint is resumability only
                    logger.warning("Could not persist segment checkpoint: %s", error)

            set_checkpoint(persist_segment_progress)
        if callable(set_unified) and self.checkpoints is not None:
            base_checkpoint = {**_evidence_checkpoint(media, transcript, visuals, source_metadata,
                transcript_review_enabled=current.source.get("transcript_review_enabled") is not False), **retry_metadata}

            def persist_unified_progress(payload: Mapping[str, Any]) -> None:
                modules = payload.get("modules", {})
                completed = len(modules) if isinstance(modules, Mapping) else 0
                canonical_state = payload.get("canonical")
                needs_review = isinstance(canonical_state, Mapping) and canonical_state.get("status") in {"needs_review", "failed"}
                unified_stage[0] = ("正在更新并核对分析报告" if completed and payload.get("protocol_version") == "unified-analysis.v2" else
                    f"正在生成报告，已完成 {completed}/4 个内容部分" if completed else
                    "口播疑义已单独标记，正在分析可靠文字与画面" if needs_review else
                    "正在按原始转写分析（未自动校对）" if isinstance(canonical_state, Mapping) and canonical_state.get("status") == "original" else
                    "口播已核对，正在分析选题、文案与画面" if canonical_state else "正在逐句核对口播")
                observe(heartbeat, "model_analysis", completed=completed, total=4)
                checkpoint_payload = {**base_checkpoint, "unified_progress": dict(payload)}
                with state_lock:
                    self.checkpoints.save(latest[0], "evidence_ready", checkpoint_payload)

            set_unified(persist_unified_progress)
        try:
            return self._run_monitored(
                lambda: self.structure.analyze(current, media, transcript, visuals),
                current, synchronized_heartbeat, "analyzing", progress, lambda: unified_stage[0],
            )
        finally:
            if callable(set_checkpoint):
                set_checkpoint(None)
            if callable(set_unified):
                set_unified(None)

    def process(self, job: ClaimedJob, heartbeat) -> AnalysisResult:
        with TemporaryDirectory(prefix="liming-analysis-") as temporary:
            workspace = Path(temporary)
            restored = _restore_evidence_checkpoint(job, workspace)
            if isinstance(job.checkpoint, Mapping) and job.checkpoint.get("report_revalidation_only") is True and restored is None:
                raise RuntimeError("报告复验所需的原始证据检查点无效，未重新获取或转写媒体。")
            if restored is not None:
                media, transcript, visuals, source_metadata = restored
                visuals = replace(visuals, stats={**visuals.stats, "evidence_reused": True})
                monitor = getattr(self, "runtime_monitor", None)
                if callable(monitor):
                    monitor("duration", media.info.duration_ms / 1000)
                observe(heartbeat, "model_analysis")
                current = heartbeat("analyzing", max(84, job.progress), "已从证据检查点恢复，正在继续结构分析")
                current, structure = self._run_structure(current, media, transcript, visuals, source_metadata, heartbeat, max(84, current.progress), "正在从证据检查点继续生成结构化结论")
                return build_analysis_result(transcript, structure, source_metadata)
            durable_transcript = (self.checkpoints is not None
                and callable(getattr(type(self.artifacts), "restore_source", None)))
            transcript_checkpoint = self._restore_transcript(job) if durable_transcript else None
            configure_visual_profile = getattr(self.visual, "set_analysis_profile", None)
            if callable(configure_visual_profile):
                configure_visual_profile(job.analysis_profile)
            configure_source_progress = getattr(self.source, "set_progress", None)
            if callable(configure_source_progress):
                configure_source_progress(getattr(heartbeat, "observe", None))
            observe(heartbeat, "public_page")
            current = heartbeat("downloading", max(5, job.progress), "正在读取转写检查点绑定的原片" if transcript_checkpoint else "正在安全获取源媒体")
            current, acquired = self._run_monitored(
                (lambda: self.artifacts.restore_source(current, transcript_checkpoint["source_asset"], workspace / "source-media"))
                    if transcript_checkpoint else (lambda: self.source.acquire(current, workspace / "source-media")),
                current,
                heartbeat,
                "downloading",
                max(8, current.progress),
                "正在下载源媒体并保持分析服务在线",
            )
            acquired = acquired if isinstance(acquired, AcquiredSource) else AcquiredSource(acquired)
            if transcript_checkpoint and isinstance(transcript_checkpoint.get("source_metadata"), Mapping):
                saved_metadata = transcript_checkpoint["source_metadata"]
                acquired = replace(acquired, metadata=SourceMetadata(**{
                    key: saved_metadata.get(key) for key in SourceMetadata.__dataclass_fields__}))

            observe(heartbeat, "validating_media", completed=1, total=1, downloaded_bytes=acquired.path.stat().st_size)
            current = heartbeat("downloading", max(8, current.progress), "已取得源媒体")
            observe(heartbeat, "audio_chunks")
            self._phase("media")
            current = heartbeat("processing", max(18, current.progress), "正在规范化媒体并提取音轨")
            current, media = self._run_monitored(
                lambda: self.media.prepare(acquired.path, workspace / "normalized"),
                current,
                heartbeat,
                "processing",
                max(22, current.progress),
                "正在规范化媒体并保持分析服务在线",
            )
            monitor = getattr(self, "runtime_monitor", None)
            if callable(monitor):
                monitor("duration", media.info.duration_ms / 1000)
            manual_transcript = _manual_transcript(current)
            source_asset = transcript_checkpoint["source_asset"] if transcript_checkpoint else None
            if durable_transcript and source_asset is None:
                self._phase("artifacts")
                current, source_asset = self._run_monitored(
                    lambda: self.artifacts.persist_source(current, media), current, heartbeat,
                    "processing", max(25, current.progress), "正在保存原片以支持转写恢复",
                )
                if (not isinstance(source_asset, Mapping) or not isinstance(source_asset.get("id"), str)
                        or not re.fullmatch(r"[a-f0-9]{64}", str(source_asset.get("sha256", "")))
                        or type(source_asset.get("size_bytes")) is not int or source_asset["size_bytes"] <= 0):
                    raise RuntimeError("Durable transcript source asset is unavailable")
            restored_raw = _read_transcript(transcript_checkpoint["transcript"]) if transcript_checkpoint else None
            call_context = getattr(self.visual, "set_call_context", None)
            if callable(call_context):
                call_context(current, getattr(self.structure, "call_recorder", None))
            configure_speech_context = getattr(self.speech, "set_context", None)
            if callable(configure_speech_context):
                configure_speech_context(acquired.metadata.title if acquired.metadata else None)
            prepared_transcript = manual_transcript
            transcript_only = current.source.get("transcript_only") is True
            extraction_started = time.monotonic()
            if (durable_transcript or current.source.get("transcript_review_enabled") is False or self.manuscript_ocr is not None
                    or transcript_only or callable(getattr(self.artifacts, "persist_manuscript", None))):
                current, prepared_transcript = self._extract_manuscript(current, media, manual_transcript, workspace, heartbeat,
                    restored_raw=restored_raw, source_asset=source_asset, source_metadata=acquired.metadata)
                if transcript_only:
                    if not prepared_transcript.segments:
                        raise RuntimeError("Speech recognition: 这段素材没有识别到可提取的口播。")
                    current = heartbeat("extracting", 95, "正在保存完整口播稿")
                    persist_source = getattr(self.artifacts, "persist_source", None)
                    if callable(persist_source) and source_asset is None:
                        self._phase("artifacts")
                        current, _ = self._run_monitored(
                            lambda: persist_source(current, media), current, heartbeat,
                            "extracting", 95, "正在保存原片与口播稿",
                        )
                    return build_analysis_result(prepared_transcript, StructureOutput("transcript.v1", {}, None), acquired.metadata)
            observe(heartbeat, "model_transcription", **({"transcribed_chunks": 0, "total_chunks": 1} if media.audio_path and prepared_transcript is None else {}))
            current = heartbeat("transcribing", max(35, current.progress), "口播稿已提取，正在处理画面" if prepared_transcript else "正在并行转写语音与提取画面")

            branch_timing: dict[str, int] = {}
            if prepared_transcript and manual_transcript is None:
                branch_timing["transcription_elapsed_ms"] = round((time.monotonic() - extraction_started) * 1000)

            def timed_branch(name: str, operation):
                began = time.monotonic()
                try:
                    return operation()
                finally:
                    branch_timing[name] = round((time.monotonic() - began) * 1000)

            self._phase("visual")
            with ThreadPoolExecutor(max_workers=2, thread_name_prefix="liming-evidence") as executor:
                transcript_future = executor.submit(timed_branch, "transcription_elapsed_ms", lambda: self.speech.transcribe(media.audio_path)) if media.audio_path and prepared_transcript is None else None
                visuals_future = executor.submit(timed_branch, "visual_elapsed_ms", lambda: self.visual.analyze(media, workspace / "visuals"))
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
                            # No provider counters means no measurable new work.
                            progress = max(40, progress)
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
                        observed_phase = "frames" if visual_pending and snapshot.get("phase") == "extracting_frames" else "model_vision" if visual_pending else "model_transcription"
                        observed_metrics = {
                            key: _progress_count(snapshot[source]) for key, source in (
                                ("candidates_checked", "candidates_checked" if "candidates_checked" in snapshot else "keyframes_completed"),
                                ("candidates_total", "candidates_total" if "candidates_total" in snapshot else "keyframes_total"),
                                ("sampled_frames", "sampled_frames"), ("total_frames", "total_frames"),
                                ("ocr_completed", "ocr_completed"), ("ocr_total", "ocr_total"),
                                ("vision_batches_completed", "batch_completed"), ("vision_batches_total", "batch_total"),
                            ) if source in snapshot
                        }
                        if transcript_future is not None:
                            observed_metrics.update(transcribed_chunks=int(transcript_future.done() and transcript_future.exception() is None), total_chunks=1)
                        observe(heartbeat, observed_phase, **observed_metrics)
                        current = heartbeat("transcribing", progress, stage)
                transcript = prepared_transcript or clean_transcript(transcript_future.result() if transcript_future else TranscriptOutput("zh-CN", ()))
                visuals = visuals_future.result()
            visuals = replace(visuals, stats={**visuals.stats, "branch_timing": branch_timing})

            observe(heartbeat, "vision_complete", **({"transcribed_chunks": 1, "total_chunks": 1} if transcript_future is not None else {}), sampled_frames=len(visuals.keyframes), total_frames=len(visuals.keyframes))
            current = heartbeat("transcribing", max(68, current.progress), "语音与画面证据已取得")
            observe(heartbeat, "saving")
            self._phase("artifacts")
            current = heartbeat("extracting", 70, "正在整理字幕、OCR 与关键帧证据")
            if self.artifacts:
                persist_source = getattr(self.artifacts, "persist_source", None)
                if callable(persist_source) and source_asset is None:
                    current, _source_asset = self._run_monitored(
                        lambda: persist_source(current, media), current, heartbeat,
                        "extracting", 72, "正在保存原片以支持报告中的时间定位",
                    )
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
                    self.checkpoints.save(current, "evidence_ready", _evidence_checkpoint(media, transcript, visuals, acquired.metadata,
                        transcript_review_enabled=current.source.get("transcript_review_enabled") is not False))
                except Exception as error:  # noqa: BLE001 - checkpoint is resumability only
                    logger.warning("Could not persist the analysis checkpoint: %s", error)
            observe(heartbeat, "model_analysis")
            current = heartbeat("analyzing", 84, "正在生成可追溯结构化结论")
            current, structure = self._run_structure(current, media, transcript, visuals, acquired.metadata, heartbeat, 88, "模型正在生成可追溯结构化结论")
            return build_analysis_result(transcript, structure, acquired.metadata)
