from __future__ import annotations

from collections.abc import Callable, Mapping, Sequence
from pathlib import Path
from typing import Any

from .adapters import (
    Keyframe,
    NormalizedMedia,
    StructureOutput,
    TranscriptOutput,
    TranscriptSegment,
    VisualOutput,
)
from .api_client import ClaimedJob
from .ffmpeg import FfmpegFrameExtractor, FfmpegMediaProcessor


def _confidence(value: Any) -> int | None:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return None
    normalized = value * 100 if 0 <= value <= 1 else value
    return max(0, min(100, round(normalized)))


def _timestamp_span(value: Any) -> tuple[int, int]:
    if not isinstance(value, Sequence) or isinstance(value, (str, bytes)):
        return 0, 0
    valid = [
        item
        for item in value
        if isinstance(item, Sequence)
        and not isinstance(item, (str, bytes))
        and len(item) >= 2
        and isinstance(item[0], (int, float))
        and isinstance(item[1], (int, float))
    ]
    if not valid:
        return 0, 0
    start = max(0, round(float(valid[0][0])))
    return start, max(start, round(float(valid[-1][1])))


def estimate_text_tokens(value: str) -> int:
    cjk = sum(1 for character in value if "\u3400" <= character <= "\u9fff")
    return cjk + max(1, (len(value) - cjk + 3) // 4)


def _deduplicate_rows(rows: list[dict[str, Any]]) -> list[dict[str, Any]]:
    seen: set[str] = set(); unique: list[dict[str, Any]] = []
    for row in rows:
        text = str(row.get("text") or "").strip()
        if not text or text in seen:
            continue
        seen.add(text); unique.append(row)
    return unique


def _row_tokens(row: Mapping[str, Any]) -> int:
    return estimate_text_tokens(str(row.get("text") or "")) + 12


def _select_evenly(rows: list[dict[str, Any]], budget: int) -> list[dict[str, Any]]:
    total = sum(_row_tokens(row) for row in rows)
    if total <= budget or len(rows) <= 2:
        return rows
    average = max(1, total // len(rows)); target = max(2, min(len(rows), budget // average))
    indices = sorted({round(index * (len(rows) - 1) / max(1, target - 1)) for index in range(target)})
    selected = [rows[index] for index in indices]
    while len(selected) > 1 and sum(_row_tokens(row) for row in selected) > budget:
        selected.pop(-2 if len(selected) > 2 else -1)
    return selected


def _chunk_rows(rows: list[dict[str, Any]], budget: int) -> list[list[dict[str, Any]]]:
    chunks: list[list[dict[str, Any]]] = []; current: list[dict[str, Any]] = []; used = 0
    for row in rows:
        cost = _row_tokens(row)
        if current and used + cost > budget:
            chunks.append(current); current = []; used = 0
        current.append(row); used += cost
    if current:
        chunks.append(current)
    return chunks


class FunAsrSpeechRecognizer:
    def __init__(
        self,
        model: str = "paraformer-zh",
        *,
        device: str = "cpu",
        vad_model: str | None = "fsmn-vad",
        punc_model: str | None = "ct-punc",
        engine: Any | None = None,
    ) -> None:
        if engine is None:
            try:
                from funasr import AutoModel
            except ImportError as error:
                raise RuntimeError("FunASR is required for speech recognition") from error
            options = {
                "model": model,
                "device": device,
                "disable_update": True,
                "vad_kwargs": {"max_single_segment_time": 30_000},
            }
            if vad_model:
                options["vad_model"] = vad_model
            if punc_model:
                options["punc_model"] = punc_model
            engine = AutoModel(**options)
        self.engine = engine

    def transcribe(self, audio: Path) -> TranscriptOutput:
        result = self.engine.generate(
            input=str(audio),
            batch_size_s=300,
            sentence_timestamp=True,
        )
        payload = result[0] if isinstance(result, list) and result else result
        if not isinstance(payload, Mapping):
            raise TypeError("FunASR returned invalid output")
        segments: list[TranscriptSegment] = []
        sentence_info = payload.get("sentence_info")
        if isinstance(sentence_info, Sequence) and not isinstance(sentence_info, (str, bytes)):
            for item in sentence_info:
                if not isinstance(item, Mapping):
                    continue
                text = self._clean_text(str(item.get("text") or item.get("sentence") or ""))
                if not text:
                    continue
                start = max(0, round(float(item.get("start", 0))))
                end = max(start, round(float(item.get("end", start))))
                segments.append(
                    TranscriptSegment(
                        start,
                        end,
                        text,
                        _confidence(item.get("confidence") or item.get("score")),
                    )
                )
        if not segments:
            text = self._clean_text(str(payload.get("text") or ""))
            if text:
                start, end = _timestamp_span(payload.get("timestamp"))
                segments.append(TranscriptSegment(start, end, text, _confidence(payload.get("confidence"))))
        if not segments:
            raise RuntimeError("FunASR returned an empty transcript")
        scores = [item.confidence for item in segments if item.confidence is not None]
        confidence = round(sum(scores) / len(scores)) if scores else None
        language = str(payload.get("language") or "zh-CN")[:32]
        return TranscriptOutput(language, tuple(segments), confidence)

    @staticmethod
    def _clean_text(value: str) -> str:
        text = value.strip()
        if "<|" not in text:
            return text
        try:
            from funasr.utils.postprocess_utils import rich_transcription_postprocess
        except ImportError:
            return text
        return rich_transcription_postprocess(text).strip()


class PaddleOcrEngine:
    def __init__(
        self,
        engine: Any | None = None,
        *,
        detection_model: str = "PP-OCRv5_mobile_det",
        recognition_model: str = "PP-OCRv5_mobile_rec",
    ) -> None:
        if engine is None:
            try:
                from paddleocr import PaddleOCR
            except ImportError as error:
                raise RuntimeError("PaddleOCR is required for visual text recognition") from error
            engine = PaddleOCR(
                text_detection_model_name=detection_model,
                text_recognition_model_name=recognition_model,
                use_doc_orientation_classify=False,
                use_doc_unwarping=False,
                use_textline_orientation=False,
                enable_mkldnn=False,
            )
        self.engine = engine

    def recognize(self, image: Path) -> tuple[str, int | None]:
        if hasattr(self.engine, "predict"):
            rows = self.engine.predict(input=str(image))
        else:
            rows = self.engine.ocr(str(image), cls=True)
        texts: list[str] = []
        scores: list[int] = []

        def visit(value: Any) -> None:
            if not isinstance(value, (Mapping, list, tuple)) and hasattr(value, "json"):
                visit(value.json)
                return
            if not isinstance(value, (Mapping, list, tuple)) and hasattr(value, "to_dict"):
                visit(value.to_dict())
                return
            if isinstance(value, Mapping):
                candidates = value.get("rec_texts") or value.get("texts")
                confidences = value.get("rec_scores") or value.get("scores")
                if isinstance(candidates, Sequence) and not isinstance(candidates, (str, bytes)):
                    for index, item in enumerate(candidates):
                        clean = str(item).strip()
                        if clean:
                            texts.append(clean)
                            score = confidences[index] if isinstance(confidences, Sequence) and index < len(confidences) else None
                            normalized = _confidence(score)
                            if normalized is not None:
                                scores.append(normalized)
                for item in value.values():
                    if isinstance(item, (list, tuple, dict)):
                        visit(item)
            elif isinstance(value, (list, tuple)):
                if len(value) == 2 and isinstance(value[0], str) and isinstance(value[1], (int, float)):
                    clean = value[0].strip()
                    if clean:
                        texts.append(clean)
                        normalized = _confidence(value[1])
                        if normalized is not None:
                            scores.append(normalized)
                    return
                for item in value:
                    visit(item)

        visit(rows)
        unique = list(dict.fromkeys(texts))
        return "\n".join(unique), round(sum(scores) / len(scores)) if scores else None


class PySceneDetectFrameExtractor:
    def __init__(
        self,
        processor: FfmpegMediaProcessor,
        *,
        minimum_scene_seconds: float = 1.0,
        maximum_frames: int = 24,
        detector: Callable[[Path], Sequence[tuple[float, float]]] | None = None,
    ) -> None:
        self.processor = processor
        self.minimum_scene_seconds = minimum_scene_seconds
        self.maximum_frames = maximum_frames
        self.detector = detector or self._detect
        self.fallback = FfmpegFrameExtractor(processor, interval_seconds=5)

    def _detect(self, source: Path) -> Sequence[tuple[float, float]]:
        try:
            from scenedetect import AdaptiveDetector, detect
        except ImportError as error:
            raise RuntimeError("PySceneDetect is required for scene-aware keyframes") from error
        scenes = detect(
            str(source),
            AdaptiveDetector(min_scene_len=f"{self.minimum_scene_seconds}s"),
            show_progress=False,
        )
        return [(start.get_seconds(), end.get_seconds()) for start, end in scenes]

    def extract(self, media: NormalizedMedia, output_dir: Path) -> list[Keyframe]:
        if not media.info.video_codec:
            return []
        scenes = list(self.detector(media.source_path))
        if not scenes:
            return self.fallback.extract(media, output_dir)
        if len(scenes) > self.maximum_frames:
            step = len(scenes) / self.maximum_frames
            scenes = [scenes[min(len(scenes) - 1, round(index * step))] for index in range(self.maximum_frames)]
        output_dir.mkdir(parents=True, exist_ok=True)
        frames: list[Keyframe] = []
        for index, (start, end) in enumerate(scenes):
            timestamp = max(0.0, start + max(0.0, end - start) / 2)
            path = output_dir / f"scene-{index + 1:04d}.jpg"
            self.processor._execute(
                [
                    self.processor.ffmpeg,
                    "-nostdin",
                    "-y",
                    "-v",
                    "error",
                    "-ss",
                    f"{timestamp:.3f}",
                    "-i",
                    str(media.source_path),
                    "-frames:v",
                    "1",
                    "-q:v",
                    "2",
                    str(path),
                ]
            )
            frames.append(Keyframe(round(timestamp * 1000), path))
        return frames


class InstructorStructureAnalyzer:
    def __init__(
        self,
        *,
        api_key: str,
        base_url: str,
        model: str,
        provider: str,
        prompt_version: str = "video-analysis.v2",
        max_source_tokens: int = 18_000,
        window_tokens: int = 6_000,
        client: Any | None = None,
        report_model: Any | None = None,
    ) -> None:
        if not api_key and client is None:
            raise ValueError("LLM API key is required")
        if client is None or report_model is None:
            try:
                import instructor
                from openai import OpenAI
                from pydantic import BaseModel, ConfigDict, Field
            except ImportError as error:
                raise RuntimeError("Instructor, OpenAI and Pydantic are required") from error

            class Evidence(BaseModel):
                model_config = ConfigDict(extra="forbid")
                start_ms: int | None = Field(default=None, ge=0)
                text: str = Field(min_length=1, max_length=1000)
                source: str = Field(min_length=1, max_length=80)
                confidence: int | None = Field(default=None, ge=0, le=100)

            class Report(BaseModel):
                model_config = ConfigDict(extra="forbid")
                summary: str = Field(min_length=1, max_length=4000)
                hook: str = Field(min_length=1, max_length=2000)
                structure: list[str] = Field(min_length=1, max_length=20)
                audience: str = Field(min_length=1, max_length=2000)
                visual: list[str] = Field(default_factory=list, max_length=30)
                language: list[str] = Field(default_factory=list, max_length=30)
                highlights: list[str] = Field(default_factory=list, max_length=30)
                risks: list[str] = Field(default_factory=list, max_length=30)
                recommendations: list[str] = Field(default_factory=list, max_length=30)
                evidence: list[Evidence] = Field(min_length=1, max_length=50)
                confidence: int = Field(ge=0, le=100)

            report_model = Report
            client = instructor.from_openai(OpenAI(api_key=api_key, base_url=base_url))
        self.client = client
        self.report_model = report_model
        self.model = model
        self.provider = provider
        self.prompt_version = prompt_version
        self.max_source_tokens = max_source_tokens
        self.window_tokens = window_tokens

    def analyze(
        self,
        job: ClaimedJob,
        media: NormalizedMedia,
        transcript: TranscriptOutput,
        visuals: VisualOutput,
    ) -> StructureOutput:
        raw_transcript_rows = [
            {
                "start_ms": row.start_ms,
                "end_ms": row.end_ms,
                "text": row.text,
                "confidence": row.confidence,
            }
            for row in transcript.segments
        ]
        raw_visual_rows = [
            {
                "start_ms": row.start_ms,
                "end_ms": row.end_ms,
                "text": row.text,
                "confidence": row.confidence,
            }
            for row in visuals.observations
        ]
        transcript_rows = _deduplicate_rows(raw_transcript_rows)
        visual_rows = _deduplicate_rows(raw_visual_rows)
        original_tokens = sum(_row_tokens(row) for row in transcript_rows + visual_rows)
        visual_budget = min(3_000, max(1_000, self.max_source_tokens // 5))
        selected_visuals = _select_evenly(visual_rows, visual_budget)
        transcript_budget = max(1_000, self.max_source_tokens - sum(_row_tokens(row) for row in selected_visuals))
        selected_transcript = _select_evenly(transcript_rows, transcript_budget)
        windows = _chunk_rows(selected_transcript, self.window_tokens)
        selected_tokens = sum(_row_tokens(row) for row in selected_transcript + selected_visuals)
        provider_options: dict[str, Any] = {}
        if self.provider.strip().lower() == "deepseek":
            provider_options["extra_body"] = {"thinking": {"type": "disabled"}}
        request_kwargs = {
            "model": self.model,
            "response_model": self.report_model,
            "max_retries": 2,
            "temperature": 0.2,
            "messages": [
                {
                    "role": "system",
                    "content": (
                        "你是短视频内容分析员。统计数字只能使用输入值，不能猜测。"
                        "每条 evidence.text 必须逐字引用转写或 OCR，start_ms 必须来自同一证据。"
                        "输出结构、受众、画面、语言、亮点、风险和可执行复用建议。"
                    ),
                },
                {
                    "role": "user",
                    "content": str(
                        {
                            "video_id": job.video_id,
                            "duration_ms": media.info.duration_ms,
                            "transcript_windows": windows,
                            "visual_evidence": selected_visuals,
                            "input_budget": {
                                "estimated_source_tokens": original_tokens,
                                "estimated_model_input_tokens": selected_tokens + 1_200,
                                "maximum_source_tokens": self.max_source_tokens,
                                "coverage_percent": 100 if original_tokens == 0 else round(selected_tokens / original_tokens * 100),
                            },
                        }
                    ),
                },
            ],
            **provider_options,
        }
        completions = self.client.chat.completions
        create_with_completion = getattr(completions, "create_with_completion", None)
        raw_response = None
        if callable(create_with_completion):
            response, raw_response = create_with_completion(**request_kwargs)
        else:
            response = completions.create(**request_kwargs)
        report = response.model_dump(mode="json") if hasattr(response, "model_dump") else dict(response)
        confidence = report.pop("confidence", None)
        evidence_text = {row.text for row in transcript.segments}
        evidence_text.update(row.text for row in visuals.observations)
        report["evidence"] = [
            row for row in report.get("evidence", []) if isinstance(row, dict) and row.get("text") in evidence_text
        ]
        if not report["evidence"]:
            raise RuntimeError("model report did not preserve exact source evidence")
        report["analysis_meta"] = {
            "mode": "full" if selected_tokens >= original_tokens else "budgeted",
            "estimated_source_tokens": original_tokens,
            "estimated_model_input_tokens": selected_tokens + 1_200,
            "maximum_source_tokens": self.max_source_tokens,
            "source_segments": len(raw_transcript_rows),
            "analyzed_segments": len(selected_transcript),
            "deduplicated_segments": len(transcript_rows),
            "chunk_count": len(windows),
            "coverage_percent": 100 if original_tokens == 0 else min(100, round(selected_tokens / original_tokens * 100)),
            "duration_minutes": round(media.info.duration_ms / 60_000, 1),
        }
        usage = getattr(raw_response, "usage", None)
        if usage is not None:
            input_tokens = int(getattr(usage, "prompt_tokens", 0) or 0)
            output_tokens = int(getattr(usage, "completion_tokens", 0) or 0)
            total_tokens = int(getattr(usage, "total_tokens", input_tokens + output_tokens) or input_tokens + output_tokens)
            if total_tokens > 0:
                report["analysis_meta"].update({
                    "actual_input_tokens": input_tokens,
                    "actual_output_tokens": output_tokens,
                    "actual_total_tokens": total_tokens,
                })
        return StructureOutput(
            "analysis.v2",
            report,
            _confidence(confidence),
            self.provider,
            self.model,
            self.prompt_version,
        )
