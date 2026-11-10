from __future__ import annotations

import base64
import json
from collections.abc import Mapping, Sequence
from pathlib import Path
from threading import Lock
from typing import Any, Protocol

from .adapters import Keyframe, NormalizedMedia, VisualObservation, VisualOutput
from .evidence import deduplicate_timed_rows, is_useful_ocr
from .ffmpeg import FfmpegFrameExtractor
from .model_compat import completion_options, is_minimax_flash


class OcrEngine(Protocol):
    def recognize(self, image: Path) -> tuple[str, int | None]: ...


class FrameExtractor(Protocol):
    def extract(self, media: NormalizedMedia, output_dir: Path) -> list[Keyframe]: ...


class VisionEngine(Protocol):
    last_stats: Mapping[str, Any]

    def analyze(self, frames: Sequence[Keyframe]) -> Sequence[VisualObservation]: ...


def _completion_text(response: Any) -> str:
    choices = getattr(response, "choices", None)
    if not isinstance(choices, Sequence) or not choices:
        return ""
    message = getattr(choices[0], "message", None)
    content = getattr(message, "content", None)
    if isinstance(content, str):
        return content.strip()
    tool_calls = getattr(message, "tool_calls", None)
    if isinstance(tool_calls, Sequence) and tool_calls:
        function = getattr(tool_calls[0], "function", None)
        arguments = getattr(function, "arguments", None)
        if isinstance(arguments, str):
            return arguments.strip()
    return ""


def _json_object(value: str) -> Mapping[str, Any]:
    clean = value.strip()
    if clean.startswith("```"):
        clean = _strip_json_fence(clean)
    parsed = json.loads(clean)
    if not isinstance(parsed, Mapping):
        raise TypeError("vision response must be a JSON object")
    return parsed


def _strip_json_fence(value: str) -> str:
    lines = value.strip().splitlines()
    if lines and lines[0].strip().startswith("```"):
        lines.pop(0)
    if lines and lines[-1].strip() == "```":
        lines.pop()
    return "\n".join(lines).strip()


class OpenAiCompatibleVisionEngine:
    """Analyze representative frames with an API isolated from OCR and structure analysis."""

    def __init__(
        self,
        *,
        api_key: str,
        base_url: str,
        model: str,
        provider: str,
        batch_size: int = 8,
        max_output_tokens: int = 2_400,
        prompt_version: str = "video-vision.v1",
        client: Any | None = None,
    ) -> None:
        if not api_key and client is None:
            raise ValueError("vision API key is required")
        if batch_size < 1 or batch_size > 16:
            raise ValueError("vision batch size must be between 1 and 16")
        if client is None:
            try:
                from openai import OpenAI
            except ImportError as error:
                raise RuntimeError("OpenAI SDK is required for visual understanding") from error
            client = OpenAI(api_key=api_key, base_url=base_url)
        self.client = client
        self.model = model
        self.provider = provider
        self.batch_size = batch_size
        self.max_output_tokens = max_output_tokens
        self.prompt_version = prompt_version
        self.last_stats: dict[str, Any] = {}

    def _request_batch(
        self,
        batch: Sequence[Keyframe],
        *,
        batch_index: int,
        batch_count: int,
    ) -> list[VisualObservation]:
        frame_manifest = [
            {
                "frame_index": index + 1,
                "timestamp_ms": frame.timestamp_ms,
                "timestamp_seconds": round(frame.timestamp_ms / 1000, 3),
            }
            for index, frame in enumerate(batch)
        ]
        content: list[dict[str, Any]] = [{
            "type": "text",
            "text": (
                "按 frame_manifest 与随后图片的一一对应关系分析每一帧。"
                "只描述图片中实际可见的信息，不推断人物身份、业绩或未出现的事件。"
                "返回 JSON 对象：observations 数组内每项必须含 frame_index、composition、"
                "people_actions、scene、camera_expression、visual_role、confidence。"
                "composition 分析构图；people_actions 分析人物和动作；scene 分析环境变化；"
                "camera_expression 分析景别、机位或镜头表达；visual_role 说明该画面对内容的作用。"
                f"这是第 {batch_index}/{batch_count} 批。frame_manifest="
                + json.dumps(frame_manifest, ensure_ascii=False, separators=(",", ":"))
            ),
        }]
        for frame in batch:
            encoded = base64.b64encode(frame.path.read_bytes()).decode("ascii")
            content.append({
                "type": "image_url",
                "image_url": {"url": f"data:image/jpeg;base64,{encoded}", "detail": "low"},
            })
        kwargs: dict[str, Any] = {
            "model": self.model,
            "temperature": 0.1,
            **completion_options(self.provider, self.model, self.max_output_tokens),
            "messages": [
                {
                    "role": "system",
                    "content": (
                        "你是视频画面分析员。OCR 由另一个模块负责；你只分析构图、人物动作、"
                        "场景变化、镜头表达和视觉节奏，禁止把画面文字识别冒充视觉理解。"
                    ),
                },
                {"role": "user", "content": content},
            ],
        }
        if not is_minimax_flash(self.provider, self.model):
            kwargs["response_format"] = {"type": "json_object"}
        if self.provider.strip().lower() == "deepseek":
            kwargs["extra_body"] = {"thinking": {"type": "disabled"}}
        response = self.client.chat.completions.create(**kwargs)
        payload = _json_object(_completion_text(response))
        raw_observations = payload.get("observations")
        if not isinstance(raw_observations, Sequence) or isinstance(raw_observations, (str, bytes)):
            raise TypeError("vision response observations must be an array")
        result: list[VisualObservation] = []
        seen: set[int] = set()
        for raw in raw_observations:
            if not isinstance(raw, Mapping):
                continue
            frame_index = raw.get("frame_index")
            if not isinstance(frame_index, int) or not 1 <= frame_index <= len(batch) or frame_index in seen:
                continue
            seen.add(frame_index)
            fields = [
                ("构图", raw.get("composition")),
                ("人物动作", raw.get("people_actions")),
                ("场景", raw.get("scene")),
                ("镜头表达", raw.get("camera_expression")),
                ("视觉作用", raw.get("visual_role")),
            ]
            description = "；".join(
                f"{label}：{str(value).strip()}"
                for label, value in fields
                if isinstance(value, str) and value.strip()
            )
            if not description:
                continue
            confidence_value = raw.get("confidence")
            confidence = None
            if isinstance(confidence_value, (int, float)) and not isinstance(confidence_value, bool):
                normalized = confidence_value * 100 if 0 <= confidence_value <= 1 else confidence_value
                confidence = max(0, min(100, round(normalized)))
            frame = batch[frame_index - 1]
            result.append(
                VisualObservation(
                    "vision",
                    frame.timestamp_ms,
                    frame.timestamp_ms,
                    description[:1_000],
                    confidence,
                )
            )
        if not result:
            raise ValueError("vision response did not contain usable frame observations")
        return result

    def analyze(self, frames: Sequence[Keyframe]) -> Sequence[VisualObservation]:
        batches = [
            frames[index:index + self.batch_size]
            for index in range(0, len(frames), self.batch_size)
        ]
        observations: list[VisualObservation] = []
        errors: list[dict[str, Any]] = []
        completed_batches = 0
        for index, batch in enumerate(batches, start=1):
            try:
                observations.extend(
                    self._request_batch(batch, batch_index=index, batch_count=len(batches))
                )
                completed_batches += 1
            except Exception as error:  # noqa: BLE001 - failure is recorded as partial evidence
                errors.append({
                    "batch": index,
                    "error_type": type(error).__name__,
                    "message": str(error)[:300],
                })
        if batches and completed_batches == len(batches):
            status = "completed"
        elif completed_batches:
            status = "partial"
        else:
            status = "failed"
        self.last_stats = {
            "status": status,
            "provider": self.provider,
            "model": self.model,
            "prompt_version": self.prompt_version,
            "batch_size": self.batch_size,
            "batch_count": len(batches),
            "completed_batches": completed_batches,
            "failed_batches": len(errors),
            "observation_count": len(observations),
            "errors": errors[:10],
        }
        return observations


class KeyframeVisualAnalyzer:
    def __init__(
        self,
        extractor: FrameExtractor | FfmpegFrameExtractor,
        ocr: OcrEngine,
        vision: VisionEngine | None = None,
        *,
        vision_unavailable_reason: str = "独立视觉模型未配置。",
    ) -> None:
        self.extractor = extractor
        self.ocr = ocr
        self.vision = vision
        self.vision_unavailable_reason = vision_unavailable_reason
        self.analysis_profile = "standard"
        self._progress_lock = Lock()
        self._progress: dict[str, Any] = {"phase": "idle"}

    def _set_progress(self, progress: Mapping[str, Any]) -> None:
        with self._progress_lock:
            self._progress = dict(progress)

    def progress_snapshot(self) -> dict[str, Any]:
        with self._progress_lock:
            return dict(self._progress)

    def set_analysis_profile(self, profile: str) -> None:
        self.analysis_profile = "max" if profile == "max" else "standard"
        configure_extractor = getattr(self.extractor, "set_analysis_profile", None)
        if callable(configure_extractor):
            configure_extractor(self.analysis_profile)

    def analyze(self, media: NormalizedMedia, output_dir: Path) -> VisualOutput:
        self._set_progress({"phase": "extracting_frames"})
        keyframes: list[Keyframe] = []
        ocr_observations: list[dict[str, object]] = []
        accepted_signatures: list[tuple[int, int]] = []
        candidates = self.extractor.extract(media, output_dir / "keyframes")
        self._set_progress({
            "phase": "ocr",
            "keyframes_completed": 0,
            "keyframes_total": len(candidates),
            "candidates_checked": 0, "candidates_total": len(candidates),
            "sampled_frames": 0, "ocr_completed": 0,
        })
        low_contrast_removed = 0
        similar_removed = 0
        completed_candidates = 0
        duration_ms = max(0, media.info.duration_ms)
        candidate_interval_ms = duration_ms / max(1, len(candidates) - 1) if candidates else 0
        local_similarity_window_ms = max(
            2_000,
            min(10_000, round(candidate_interval_ms * 0.6) if candidate_interval_ms else 5_000),
        )
        for candidate_index, frame in enumerate(candidates):
            self._set_progress({
                "phase": "ocr",
                "keyframes_completed": candidate_index,
                "keyframes_total": len(candidates),
                "candidates_checked": completed_candidates, "candidates_total": len(candidates),
                "sampled_frames": len(keyframes), "ocr_completed": len(keyframes),
            })
            signature = self._image_signature(frame.path)
            if signature is not None:
                image_hash, contrast = signature
                is_boundary = candidate_index in {0, len(candidates) - 1}
                if contrast < 4.0 and not is_boundary:
                    low_contrast_removed += 1
                    completed_candidates += 1
                    continue
                if any(
                    abs(frame.timestamp_ms - previous_timestamp) <= local_similarity_window_ms
                    and (image_hash ^ previous_hash).bit_count() <= 5
                    for previous_timestamp, previous_hash in accepted_signatures
                ):
                    similar_removed += 1
                    completed_candidates += 1
                    continue
                accepted_signatures.append((frame.timestamp_ms, image_hash))
            text, confidence = self.ocr.recognize(frame.path)
            clean_text = text.strip()
            useful_text = clean_text if is_useful_ocr(clean_text, confidence) else ""
            keyframes.append(
                Keyframe(
                    frame.timestamp_ms,
                    frame.path,
                    useful_text or None,
                    confidence if useful_text else None,
                )
            )
            completed_candidates += 1
            if useful_text:
                ocr_observations.append({
                    "kind": "ocr",
                    "start_ms": frame.timestamp_ms,
                    "end_ms": frame.timestamp_ms,
                    "text": useful_text,
                    "confidence": confidence,
                })

        unique_ocr = deduplicate_timed_rows(
            ocr_observations,
            max_gap_ms=120_000,
            threshold=0.9,
        )
        vision_observations: Sequence[VisualObservation] = ()
        if self.vision is None:
            vision_stats: dict[str, Any] = {
                "status": "unavailable",
                "reason": self.vision_unavailable_reason,
                "observation_count": 0,
            }
        else:
            set_progress_callback = getattr(
                self.vision,
                "set_progress_callback",
                None,
            )

            def update_vision_progress(progress: Mapping[str, Any]) -> None:
                self._set_progress({
                    **progress,
                    "keyframes_completed": len(candidates),
                    "keyframes_total": len(candidates),
                    "candidates_checked": len(candidates), "candidates_total": len(candidates),
                    "sampled_frames": len(keyframes), "total_frames": len(keyframes),
                    "ocr_completed": len(keyframes), "ocr_total": len(keyframes),
                })

            if callable(set_progress_callback):
                set_progress_callback(update_vision_progress)
            try:
                vision_observations = self.vision.analyze(keyframes)
                vision_stats = dict(getattr(self.vision, "last_stats", {}))
                if not vision_stats:
                    vision_stats = {
                        "status": "completed" if vision_observations else "failed",
                        "observation_count": len(vision_observations),
                    }
            except Exception as error:  # noqa: BLE001 - OCR/keyframes remain usable
                vision_stats = {
                    "status": "failed",
                    "reason": str(error)[:300],
                    "observation_count": 0,
                }
                vision_observations = ()
            finally:
                if callable(set_progress_callback):
                    set_progress_callback(None)

        combined = [
            *(
                VisualObservation(
                    str(row["kind"]),
                    int(row["start_ms"]),
                    int(row["end_ms"]),
                    str(row["text"]),
                    int(row["confidence"]) if row.get("confidence") is not None else None,
                )
                for row in unique_ocr
            ),
            *vision_observations,
        ]
        combined.sort(key=lambda row: (row.start_ms, row.kind))
        extractor_stats = getattr(self.extractor, "last_stats", {})
        stats = {
            **(dict(extractor_stats) if isinstance(extractor_stats, Mapping) else {}),
            "analysis_profile": self.analysis_profile,
            "candidate_count": len(candidates),
            "low_contrast_removed": low_contrast_removed,
            "similar_removed": similar_removed,
            "kept_count": len(keyframes),
            "ocr_observation_count": len(unique_ocr),
            "vision_observation_count": len(vision_observations),
            "visual_understanding": vision_stats,
            "local_similarity_window_seconds": round(local_similarity_window_ms / 1000, 1),
        }
        current_progress = self.progress_snapshot()
        self._set_progress({
            **current_progress,
            "phase": "completed",
            "keyframes_completed": len(candidates),
            "keyframes_total": len(candidates),
            "candidates_checked": len(candidates), "candidates_total": len(candidates),
            "sampled_frames": len(keyframes), "total_frames": len(keyframes),
            "ocr_completed": len(keyframes), "ocr_total": len(keyframes),
        })
        return VisualOutput(tuple(keyframes), tuple(combined), stats)

    @staticmethod
    def _image_signature(path: Path) -> tuple[int, float] | None:
        try:
            from PIL import Image, ImageStat

            with Image.open(path) as image:
                source_grayscale = image.convert("L")
                grayscale = source_grayscale.resize((8, 8))
                pixels = list(grayscale.getdata())
                average = sum(pixels) / len(pixels)
                image_hash = sum(
                    1 << index for index, value in enumerate(pixels) if value >= average
                )
                contrast = float(ImageStat.Stat(source_grayscale).stddev[0])
                return image_hash, contrast
        except (OSError, ValueError):
            return None
