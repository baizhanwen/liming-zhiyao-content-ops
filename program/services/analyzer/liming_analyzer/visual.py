from __future__ import annotations

import base64
import copy
import hashlib
import json
import time
from collections.abc import Mapping, Sequence
from concurrent.futures import FIRST_COMPLETED, ThreadPoolExecutor, wait
from dataclasses import replace
from datetime import UTC, datetime
from itertools import pairwise
from pathlib import Path
from threading import Lock
from typing import Any, Protocol

from .adapters import Keyframe, NormalizedMedia, VisualObservation, VisualOutput
from .evidence import deduplicate_timed_rows, is_useful_ocr
from .ffmpeg import FfmpegFrameExtractor
from .model_calls import ModelCalls, exception_usage, usage_counts
from .model_compat import completion_options, is_minimax_flash


class OcrEngine(Protocol):
    def recognize(self, image: Path) -> tuple[str, int | None]: ...


class FrameExtractor(Protocol):
    def extract(self, media: NormalizedMedia, output_dir: Path) -> list[Keyframe]: ...


class VisionEngine(Protocol):
    last_stats: Mapping[str, Any]

    def analyze(self, frames: Sequence[Keyframe]) -> Sequence[VisualObservation]: ...


def vision_usage(value: Any) -> dict[str, int | None]:
    usage = value.get("usage") if isinstance(value, Mapping) else getattr(value, "usage", None)
    counts = usage_counts(usage)
    details = usage.get("completion_tokens_details") if isinstance(usage, Mapping) else getattr(usage, "completion_tokens_details", None)
    reasoning = details.get("reasoning_tokens") if isinstance(details, Mapping) else getattr(details, "reasoning_tokens", None)
    return {"input_tokens": counts.get("inputTokens"), "output_tokens": counts.get("outputTokens"),
            "total_tokens": counts.get("totalTokens"),
            "reasoning_tokens": reasoning if isinstance(reasoning, int) and not isinstance(reasoning, bool) and reasoning >= 0 else None}


def vision_usage_totals(records: Sequence[Mapping[str, Any]]) -> dict[str, int | None]:
    result = {}
    for field, target in (("input_tokens", "total_input_tokens"), ("output_tokens", "total_output_tokens"), ("total_tokens", "total_tokens")):
        values = [record.get(field) for record in records]
        result[target] = sum(values) if values and all(isinstance(value, int) and not isinstance(value, bool) for value in values) else None
    return result


def _failure_kind(error: Exception) -> str:
    status = getattr(error, "status_code", None) or getattr(getattr(error, "response", None), "status_code", None)
    if status in {429, 503, 529}:
        return "overloaded"
    if isinstance(error, TimeoutError) or "timeout" in type(error).__name__.lower():
        return "timeout"
    if isinstance(error, (ValueError, TypeError, json.JSONDecodeError)):
        return "invalid_response"
    return "provider_error"


def vision_batch_indices(frames: Sequence[Keyframe], batch_size: int) -> list[list[int]]:
    """Keep ordered temporal windows together rather than splitting them at arbitrary offsets."""
    groups: dict[str, list[int]] = {}
    for index, frame in enumerate(frames):
        for role in frame.roles:
            if role.startswith("temporal:"):
                groups.setdefault(role, []).append(index)
    batches: list[list[int]] = []
    used: set[int] = set()
    for indices in groups.values():
        remaining = sorted((index for index in indices if index not in used), key=lambda index: frames[index].timestamp_ms)
        batches.extend(remaining[offset:offset + batch_size] for offset in range(0, len(remaining), batch_size))
        used.update(remaining)
    remaining = [index for index in range(len(frames)) if index not in used]
    batches.extend(remaining[offset:offset + batch_size] for offset in range(0, len(remaining), batch_size))
    return batches


def temporal_groups_in_batch(frames: Sequence[Keyframe]) -> dict[str, list[int]]:
    groups: dict[str, set[int]] = {}
    for frame in frames:
        for role in frame.roles:
            if role.startswith("temporal:"):
                groups.setdefault(role.removeprefix("temporal:"), set()).add(frame.timestamp_ms)
    return {
        group: sorted(times) for group, times in groups.items()
        if len(times) >= 3 and max(right - left for left, right in zip(sorted(times), sorted(times)[1:])) <= 750
    }


VISUAL_EVIDENCE_INSTRUCTIONS = (
    "每帧分析构图和主体位置、人物数量/角色/动作、场景、景别/拍摄角度、内容形式和实拍/动画媒介、"
    "B-roll作用、文字呈现类型/可读性/可见遮挡、色彩质感。OCR负责具体文字，不要重复抄字。"
    "有first_frame角色时补首帧样式/主题或悬念信息；有opening角色时补开头画面吸引方式。"
    "新增可选字段content_form、screen_text、color_texture、opening、temporal，每字段至多30字，未知用unknown。"
    "运动、稳定性、转场只可依据同一temporal_group至少3张有序密集帧；时间相距较远的图片不可当连续运动。"
    "无合格时序组时temporal必须为unknown，camera_expression只写可见景别/机位；有组仍不确定也写unknown。"
    "不要推测声音，不输出人物出镜时间占比、字幕面积百分比或其他未测量精确数值。"
)


def _ocr_region_measurement(image_path: Path, raw_regions: Any) -> dict[str, Any]:
    result: dict[str, Any] = {"status": "unknown", "text_area_ratio": None, "region_count": None}
    if not isinstance(raw_regions, list):
        return result
    try:
        from PIL import Image
        with Image.open(image_path) as image:
            width, height = image.size
    except (OSError, ValueError):
        return result
    rectangles = []
    for region in raw_regions:
        confidence = region.get("confidence")
        if confidence is not None and confidence < 45:
            continue
        points = region.get("polygon") or []
        if len(points) < 4:
            continue
        left = max(0.0, min(width, min(point[0] for point in points)))
        right = max(0.0, min(width, max(point[0] for point in points)))
        top = max(0.0, min(height, min(point[1] for point in points)))
        bottom = max(0.0, min(height, max(point[1] for point in points)))
        if left < right and top < bottom:
            rectangles.append((left, top, right, bottom))
    area = 0.0
    xs = sorted({coordinate for rectangle in rectangles for coordinate in (rectangle[0], rectangle[2])})
    for left, right in pairwise(xs):
        intervals = sorted((top, bottom) for x1, top, x2, bottom in rectangles if x1 < right and x2 > left)
        covered = 0.0
        end = 0.0
        for top, bottom in intervals:
            covered += max(0.0, bottom - max(top, end))
            end = max(end, bottom)
        area += (right - left) * covered
    result.update({
        "status": "estimated", "text_area_ratio": round(area / (width * height), 6),
        "region_count": len(rectangles), "image_width": width, "image_height": height,
        "bounds": [list(rectangle) for rectangle in rectangles[:32]],
        "bounds_truncated": len(rectangles) > 32,
    })
    return result


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

    supports_ocr_overlap = True  # Prompts/images never read OCR text or confidence.

    def __init__(
        self,
        *,
        api_key: str,
        base_url: str,
        model: str,
        provider: str,
        batch_size: int = 6,
        max_output_tokens: int = 4_800,
        concurrency: int = 2,
        overload_backoff_seconds: float = 1.0,
        prompt_version: str = "video-vision.v2",
        client: Any | None = None,
    ) -> None:
        if not api_key and client is None:
            raise ValueError("vision API key is required")
        if batch_size < 1 or batch_size > 16:
            raise ValueError("vision batch size must be between 1 and 16")
        if concurrency not in {1, 2} or overload_backoff_seconds < 0:
            raise ValueError("vision concurrency must be 1 or 2 and backoff cannot be negative")
        if client is None:
            try:
                from openai import OpenAI
            except ImportError as error:
                raise RuntimeError("OpenAI SDK is required for visual understanding") from error
            client = OpenAI(api_key=api_key, base_url=base_url, max_retries=0, timeout=120)
        self.client = client
        self.model = model
        self.provider = provider
        self.batch_size = batch_size
        self.max_output_tokens = max_output_tokens
        self.prompt_version = prompt_version
        self.last_stats: dict[str, Any] = {}
        self.concurrency = concurrency
        self.overload_backoff_seconds = overload_backoff_seconds
        self._progress_callback = None
        self._model_calls = None

    def set_progress_callback(self, callback) -> None:
        self._progress_callback = callback

    def set_call_context(self, job, recorder=None) -> None:
        self._model_calls = ModelCalls(job, recorder)

    def _notify_progress(self, progress: Mapping[str, Any]) -> None:
        if self._progress_callback is not None:
            self._progress_callback(dict(progress))

    def _request_batch(
        self,
        batch: Sequence[Keyframe],
        *,
        batch_index: int,
        batch_count: int,
        batch_record: dict[str, Any] | None = None,
    ) -> list[VisualObservation]:
        temporal_groups = temporal_groups_in_batch(batch)
        frame_manifest = [
            {
                "frame_index": index + 1,
                "timestamp_ms": frame.timestamp_ms,
                "timestamp_seconds": round(frame.timestamp_ms / 1000, 3),
                "roles": list(frame.roles),
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
                + VISUAL_EVIDENCE_INSTRUCTIONS
                + " temporal_groups=" + json.dumps(temporal_groups, ensure_ascii=False)
                +
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
        def operation():
            response = self.client.chat.completions.create(**kwargs)
            return response, response
        response, _raw = self._model_calls.invoke("vision_batch", self.max_output_tokens, operation) if self._model_calls is not None else operation()
        if batch_record is not None:
            batch_record.update(vision_usage(response))
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
            if not isinstance(frame_index, int) or isinstance(frame_index, bool) or not 1 <= frame_index <= len(batch) or frame_index in seen:
                continue
            seen.add(frame_index)
            frame = batch[frame_index - 1]
            fields = [
                ("构图", raw.get("composition")),
                ("人物动作", raw.get("people_actions")),
                ("场景", raw.get("scene")),
                ("镜头表达", raw.get("camera_expression")),
                ("视觉作用", raw.get("visual_role")),
                ("内容形式与媒介", raw.get("content_form")),
                ("画面文字呈现", raw.get("screen_text")),
                ("色彩与质感", raw.get("color_texture")),
            ]
            if "first_frame" in frame.roles or "opening" in frame.roles:
                fields.append(("首帧与开头", raw.get("opening")))
            frame_groups = [group for group in temporal_groups if f"temporal:{group}" in frame.roles]
            if frame_groups:
                fields.append(("时序观察（有序抽样非全帧跟踪）", raw.get("temporal")))
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
            scope = ("时序组=" + ",".join(frame_groups)) if frame_groups else "单帧证据；运动/稳定性/转场无法判断"
            result.append(
                VisualObservation(
                    "vision",
                    frame.timestamp_ms,
                    frame.timestamp_ms,
                    ("证据范围：" + scope + "；" + description)[:1_000],
                    confidence,
                )
            )
        if not result:
            raise ValueError("vision response did not contain usable frame observations")
        return result

    def analyze(self, frames: Sequence[Keyframe]) -> Sequence[VisualObservation]:
        batches = [[frames[index] for index in indices] for indices in vision_batch_indices(frames, self.batch_size)]
        observations: list[VisualObservation] = []
        errors: list[dict[str, Any]] = []
        records: list[dict[str, Any]] = []
        terminal: set[int] = set()
        succeeded: set[int] = set()
        queue = [(index, 1) for index in range(len(batches))]
        effective_concurrency = self.concurrency
        retry_remaining = 1  # One shared overload retry; never N unbounded paid retries.
        cooldown = 0.0
        started = time.monotonic()

        def notify():
            self._notify_progress({"phase": "vision", "batch_completed": len(terminal), "batch_total": len(batches),
                                   "concurrency": effective_concurrency, "request_count": len(records),
                                   "backoff_seconds": max(0, round(cooldown - time.monotonic(), 2))})

        def run(index, attempt):
            record = {"index": index + 1, "attempt": attempt, "started_at": datetime.now(UTC).isoformat(),
                      "output_budget": self.max_output_tokens,
                      "input_tokens": None, "output_tokens": None, "total_tokens": None, "reasoning_tokens": None,
                      "status": "failed", "failure_kind": None}
            begin = time.monotonic()
            try:
                rows = self._request_batch(batches[index], batch_index=index + 1, batch_count=len(batches), batch_record=record)
                if len(rows) != len(batches[index]):
                    record["failure_kind"] = "incomplete_response"
                    return rows, record, {"batch": index + 1, "attempt": attempt, "error_type": "FrameCoverageIncomplete",
                                          "failure_kind": "incomplete_response", "message": "视觉批次未覆盖全部请求帧。"}
                record["status"] = "completed"
                return rows, record, None
            except Exception as error:  # noqa: BLE001 - independent batches retain successful evidence
                usage = exception_usage(error)
                if usage is not None:
                    record.update(vision_usage({"usage": usage}))
                record["failure_kind"] = _failure_kind(error)
                return [], record, {"batch": index + 1, "attempt": attempt,
                                    "error_type": type(error).__name__, "failure_kind": record["failure_kind"],
                                    "message": "视觉批次未完成：" + type(error).__name__}
            finally:
                record["elapsed_ms"] = round((time.monotonic() - begin) * 1000)
                record["completed_at"] = datetime.now(UTC).isoformat()

        notify()
        with ThreadPoolExecutor(max_workers=self.concurrency, thread_name_prefix="liming-vision") as executor:
            active: dict[Any, tuple[int, int]] = {}
            while queue or active:
                if queue and not active and cooldown > time.monotonic():
                    time.sleep(min(8.0, cooldown - time.monotonic()))
                while queue and len(active) < effective_concurrency and time.monotonic() >= cooldown:
                    index, attempt = queue.pop(0)
                    active[executor.submit(run, index, attempt)] = (index, attempt)
                if not active:
                    continue
                done, _ = wait(active, return_when=FIRST_COMPLETED)
                for future in done:
                    index, attempt = active.pop(future)
                    rows, record, error = future.result()
                    records.append(record)
                    observations.extend(rows)
                    if error is None:
                        succeeded.add(index); terminal.add(index)
                    else:
                        errors.append(error)
                        if record["failure_kind"] == "overloaded":
                            effective_concurrency = 1
                            cooldown = max(cooldown, time.monotonic() + min(8.0, self.overload_backoff_seconds))
                        if record["failure_kind"] == "overloaded" and attempt == 1 and retry_remaining:
                            retry_remaining -= 1
                            queue.insert(0, (index, 2))
                        else:
                            terminal.add(index)
                    notify()
        completed_batches = len(succeeded)
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
            "failed_batches": len(batches) - completed_batches,
            "observation_count": len(observations),
            "concurrency": self.concurrency, "effective_concurrency": effective_concurrency,
            "request_count": len(records), "overload_retry_count": 1 - retry_remaining,
            "output_budget": self.max_output_tokens,
            "elapsed_ms": round((time.monotonic() - started) * 1000),
            "batches": sorted(records, key=lambda record: (record["index"], record["attempt"])),
            **vision_usage_totals(records),
            "errors": errors[:10],
        }
        return sorted(observations, key=lambda row: (row.start_ms, row.end_ms))


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

    def set_call_context(self, job, recorder=None) -> None:
        setter = getattr(self.vision, "set_call_context", None)
        if callable(setter):
            setter(job, recorder)

    def analyze(self, media: NormalizedMedia, output_dir: Path) -> VisualOutput:
        self._set_progress({"phase": "extracting_frames"})
        extraction_started = time.monotonic()
        keyframes: list[Keyframe] = []
        ocr_observations: list[dict[str, object]] = []
        ocr_region_frames: list[dict[str, Any]] = []
        ocr_errors: list[dict[str, Any]] = []
        accepted_signatures: list[tuple[int, int]] = []
        candidates = self.extractor.extract(media, output_dir / "keyframes")
        extractor_stats = getattr(self.extractor, "last_stats", {})
        scene_aware = isinstance(extractor_stats, Mapping) and extractor_stats.get("sampling_strategy_id") == "content-frames.v3"
        seen_coverage: set[str] = set()
        seen_scenes: set[str] = set()
        scene_signatures: list[tuple[Keyframe, int, str]] = []
        same_scene_removed = 0
        extraction_elapsed_ms = round((time.monotonic() - extraction_started) * 1000)
        filtering_started = time.monotonic()
        self._set_progress({
            "phase": "filtering_frames",
            "keyframes_completed": 0,
            "keyframes_total": len(candidates),
            "candidates_checked": 0, "candidates_total": len(candidates),
            "sampled_frames": 0, "ocr_completed": 0,
        })
        low_contrast_removed = 0
        similar_removed = 0
        completed_candidates = 0
        selected_frames: list[Keyframe] = []
        duration_ms = max(0, media.info.duration_ms)
        candidate_interval_ms = duration_ms / max(1, len(candidates) - 1) if candidates else 0
        local_similarity_window_ms = max(
            2_000,
            min(10_000, round(candidate_interval_ms * 0.6) if candidate_interval_ms else 5_000),
        )
        for candidate_index, frame in enumerate(candidates):
            self._set_progress({
                "phase": "filtering_frames",
                "keyframes_completed": candidate_index,
                "keyframes_total": len(candidates),
                "candidates_checked": completed_candidates, "candidates_total": len(candidates),
                "sampled_frames": len(selected_frames), "ocr_completed": 0,
            })
            signature = self._image_signature(frame.path)
            forced = any(role in {"first_frame", "opening", "ending"} or role.startswith("temporal:") for role in frame.roles)
            scene_id = next((role for role in frame.roles if role.startswith("scene:")), "")
            coverage_id = next((role for role in frame.roles if role.startswith("coverage:")), "")
            coverage_guard = scene_aware and ((coverage_id and coverage_id not in seen_coverage) or (scene_id and scene_id not in seen_scenes))
            if signature is not None and not forced and not coverage_guard:
                image_hash, contrast = signature
                is_boundary = candidate_index in {0, len(candidates) - 1}
                if contrast < 4.0 and not is_boundary:
                    low_contrast_removed += 1
                    completed_candidates += 1
                    continue
                repeated_scene = scene_aware and scene_id and any(
                    previous_scene == scene_id and (image_hash ^ previous_hash).bit_count() <= 2
                    and self._near_identical_images(frame.path, previous_frame.path)
                    for previous_frame, previous_hash, previous_scene in scene_signatures
                )
                repeated_local = (not scene_aware or not scene_id) and any(
                    abs(frame.timestamp_ms - previous_timestamp) <= local_similarity_window_ms
                    and (image_hash ^ previous_hash).bit_count() <= 5
                    for previous_timestamp, previous_hash in accepted_signatures
                )
                if repeated_scene or repeated_local:
                    similar_removed += 1
                    same_scene_removed += int(bool(repeated_scene))
                    completed_candidates += 1
                    continue
            if signature is not None:
                accepted_signatures.append((frame.timestamp_ms, signature[0]))
                if scene_id:
                    scene_signatures.append((frame, signature[0], scene_id))
            selected_frames.append(frame)
            if coverage_id:
                seen_coverage.add(coverage_id)
            if scene_id:
                seen_scenes.add(scene_id)
            completed_candidates += 1

        filtering_elapsed_ms = round((time.monotonic() - filtering_started) * 1000)
        branch_lock = Lock()
        state: dict[str, Any] = {"ocr_completed": 0, "ocr_finished": False, "vision_finished": self.vision is None, "vision_progress": {}}
        branch_times: dict[str, float] = {}

        def update_progress(*, ocr_completed=None, ocr_finished=False, vision_progress=None, vision_finished=False):
            with branch_lock:
                if ocr_completed is not None:
                    state["ocr_completed"] = ocr_completed
                if ocr_finished:
                    state["ocr_finished"] = True
                if vision_progress is not None:
                    state["vision_progress"].update(vision_progress)
                if vision_finished:
                    state["vision_finished"] = True
                phase = "completed" if state["ocr_finished"] and state["vision_finished"] else (
                    str(state["vision_progress"].get("phase") or "vision") if state["ocr_finished"] else "ocr")
                self._set_progress({
                    **state["vision_progress"], "phase": phase,
                    "keyframes_completed": completed_candidates, "keyframes_total": len(candidates),
                    "candidates_checked": completed_candidates, "candidates_total": len(candidates),
                    "sampled_frames": len(selected_frames), "total_frames": len(selected_frames),
                    "ocr_completed": state["ocr_completed"], "ocr_total": len(selected_frames),
                })

        set_progress_callback = getattr(self.vision, "set_progress_callback", None)
        if callable(set_progress_callback):
            set_progress_callback(lambda progress: update_progress(vision_progress=progress))

        def run_vision(frames):
            branch_times["vision_started"] = time.monotonic()
            try:
                observations = self.vision.analyze(frames)
                stats = dict(getattr(self.vision, "last_stats", {}))
                if not stats:
                    stats = {"status": "completed" if observations else "failed", "observation_count": len(observations)}
                return observations, stats
            except Exception as error:  # noqa: BLE001 - OCR/keyframes remain usable
                return (), {"status": "failed", "reason": str(error)[:300], "observation_count": 0}
            finally:
                branch_times["vision_finished"] = time.monotonic()
                update_progress(vision_finished=True)

        vision_observations: Sequence[VisualObservation] = ()
        vision_stats: dict[str, Any] = {"status": "unavailable", "reason": self.vision_unavailable_reason, "observation_count": 0}
        vision_future = None
        exact_ocr_cache: dict[str, tuple[str, int | None, Any]] = {}
        ocr_engine_calls = 0
        ocr_exact_reused = 0
        overlap_allowed = self.vision is not None and getattr(self.vision, "supports_ocr_overlap", False) is True
        update_progress()
        try:
            # One orchestration future; the engine's own paid-call limit stays
            # unchanged. Unknown adapters receive completed OCR in serial mode.
            with ThreadPoolExecutor(max_workers=1, thread_name_prefix="liming-visual-overlap") as executor:
                branch_times["ocr_started"] = time.monotonic()
                for frame in selected_frames:
                    healthy = True
                    try:
                        digest = None
                        if getattr(self.ocr, "supports_exact_image_cache", False) is True:
                            try:
                                digest = hashlib.sha256(frame.path.read_bytes()).hexdigest()
                            except OSError:
                                pass
                        if digest is not None and digest in exact_ocr_cache:
                            text, confidence, cached_regions = exact_ocr_cache[digest]
                            regions = copy.deepcopy(cached_regions)
                            ocr_exact_reused += 1
                        else:
                            ocr_engine_calls += 1
                            text, confidence = self.ocr.recognize(frame.path)
                            regions = None if getattr(self.ocr, "regions_truncated", False) else getattr(self.ocr, "last_regions", None)
                            if digest is not None:
                                exact_ocr_cache[digest] = (text, confidence, copy.deepcopy(regions))
                    except Exception as error:  # noqa: BLE001 - a failed OCR frame must not erase image evidence
                        healthy = False
                        text, confidence, regions = "", None, None
                        ocr_errors.append({"timestamp_ms": frame.timestamp_ms, "error_type": type(error).__name__, "message": str(error)[:200]})
                    clean_text = text.strip()
                    useful_text = clean_text if is_useful_ocr(clean_text, confidence) else ""
                    keyframes.append(replace(frame, ocr_text=useful_text or None, confidence=confidence if useful_text else None))
                    ocr_region_frames.append({"timestamp_ms": frame.timestamp_ms, **_ocr_region_measurement(frame.path, regions)})
                    if useful_text:
                        ocr_observations.append({"kind": "ocr", "start_ms": frame.timestamp_ms, "end_ms": frame.timestamp_ms, "text": useful_text, "confidence": confidence})
                    update_progress(ocr_completed=len(keyframes))
                    # Do not spend on VLM until at least one actual OCR input
                    # has completed healthily (empty recognized text is valid).
                    if overlap_allowed and vision_future is None and healthy:
                        vision_future = executor.submit(run_vision, tuple(selected_frames))
                branch_times["ocr_finished"] = time.monotonic()
                update_progress(ocr_finished=True)
                if vision_future is not None:
                    vision_observations, vision_stats = vision_future.result()
                elif self.vision is not None:
                    vision_observations, vision_stats = run_vision(tuple(keyframes))
        finally:
            # Executor joins even during an unexpected OCR failure. Detach only
            # after that join so callbacks cannot outlive this analysis.
            if callable(set_progress_callback):
                set_progress_callback(None)

        protected_times = {frame.timestamp_ms for frame in keyframes if any(role in {"first_frame", "opening"} or role.startswith("temporal:") for role in frame.roles)}
        unique_ocr = deduplicate_timed_rows(
            [row for row in ocr_observations if row["start_ms"] not in protected_times],
            max_gap_ms=120_000,
            threshold=0.9,
        )
        unique_ocr.extend(row for row in ocr_observations if row["start_ms"] in protected_times)
        unique_ocr.sort(key=lambda row: int(row["start_ms"]))
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
            "same_scene_removed": same_scene_removed,
            "kept_count": len(keyframes),
            "ocr_observation_count": len(unique_ocr),
            "ocr_engine_call_count": ocr_engine_calls,
            "ocr_exact_reuse_count": ocr_exact_reused,
            "ocr_error_count": len(ocr_errors), "ocr_errors": ocr_errors[:20],
            "vision_observation_count": len(vision_observations),
            "visual_understanding": vision_stats,
            "stage_timing": {
                "frame_extraction_elapsed_ms": extraction_elapsed_ms, "frame_filter_elapsed_ms": filtering_elapsed_ms,
                "ocr_elapsed_ms": round((branch_times["ocr_finished"] - branch_times["ocr_started"]) * 1000),
                "vision_elapsed_ms": round((branch_times["vision_finished"] - branch_times["vision_started"]) * 1000) if "vision_finished" in branch_times else None,
                "ocr_vision_overlap_ms": round(max(0, min(branch_times["ocr_finished"], branch_times.get("vision_finished", 0)) - max(branch_times["ocr_started"], branch_times.get("vision_started", 0))) * 1000),
                "ocr_vision_wall_ms": round((max(branch_times["ocr_finished"], branch_times.get("vision_finished", 0)) - branch_times["ocr_started"]) * 1000),
                "mode": "overlapped" if vision_future is not None else "serial" if self.vision is not None else "ocr_only",
            },
            "frame_roles": [{"timestamp_ms": frame.timestamp_ms, "roles": list(frame.roles)} for frame in keyframes],
            "ocr_text_regions": {
                "status": "estimated" if any(row["text_area_ratio"] is not None for row in ocr_region_frames) else "unknown",
                "method": "clipped_ocr_axis_aligned_bounds_union.v1",
                "frames": ocr_region_frames,
                "limitations": "仅抽样帧OCR文字检测框并集的面积估计，不是字幕专属面积、全片文字占比或可读性评分；无框时unknown。",
            },
            "local_similarity_window_seconds": round(local_similarity_window_ms / 1000, 1),
        }
        if scene_aware:
            retained_times = {frame.timestamp_ms for frame in keyframes}
            timeline = [{**row, "retained_timestamps_ms": [frame.timestamp_ms for frame in keyframes if row["id"] in frame.roles]}
                        for row in extractor_stats.get("timeline_segments", [])]
            scenes = [{**row, "retained_timestamps_ms": [frame.timestamp_ms for frame in keyframes if row["id"] in frame.roles]}
                      for row in extractor_stats.get("scene_intervals", [])]
            expected_opening = extractor_stats.get("opening_timestamps_ms", [])
            stats["sampling_coverage"] = {
                "scope": "sampled_frames_only", "full_video_motion_coverage": False,
                "timeline_segments": timeline, "timeline_complete": all(row["retained_timestamps_ms"] for row in timeline),
                "detected_scenes": scenes, "detected_scenes_complete": bool(scenes) and all(row["retained_timestamps_ms"] for row in scenes),
                "scene_interval_source": "raw_detected_boundaries",
                "representative_scenes_complete": bool(scenes) and all(row["retained_timestamps_ms"] for row in scenes if row.get("representative_required", True)),
                "opening_complete": all(timestamp in retained_times for timestamp in expected_opening),
                "ending_retained": extractor_stats.get("ending_timestamp_ms") in retained_times,
                "temporal_groups": [{"group_id": group["group_id"],
                    "retained_timestamps_ms": [timestamp for timestamp in group["timestamps_ms"] if timestamp in retained_times],
                    "complete": all(timestamp in retained_times for timestamp in group["timestamps_ms"])}
                    for group in extractor_stats.get("temporal_groups", [])],
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
    def _near_identical_images(left: Path, right: Path) -> bool:
        """Require pixel similarity as well as a coarse hash before merging scenes.

        A perceptual hash alone often treats different slides and text overlays
        as identical. The small pixel comparison preserves those visible changes.
        """
        try:
            from PIL import Image, ImageChops, ImageStat

            with Image.open(left) as left_image, Image.open(right) as right_image:
                difference = ImageChops.difference(
                    left_image.convert("RGB").resize((160, 90)), right_image.convert("RGB").resize((160, 90)))
                return max(ImageStat.Stat(difference).mean) <= 1.5
        except (OSError, ValueError):
            return False

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
