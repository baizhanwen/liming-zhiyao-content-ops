from __future__ import annotations

import asyncio
import json
import logging
import math
import os
import re
import sys
import tempfile
from collections.abc import Awaitable, Callable, Mapping, Sequence
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from .adapters import Keyframe, VisualObservation
from .vision_capabilities import normalize_minimax_token_plan_host
from .visual import VISUAL_EVIDENCE_INSTRUCTIONS, temporal_groups_in_batch, vision_batch_indices

_SECRET_PATTERN = re.compile(r"sk-cp[-_A-Za-z0-9]{8,}", re.IGNORECASE)
_TRACE_PATTERN = re.compile(r"(?:trace[-_ ]?id|request[-_ ]?id)\s*[:=]\s*([A-Za-z0-9._:-]+)", re.IGNORECASE)
_API_CODE_PATTERN = re.compile(r"API Error:\s*(\d+)", re.IGNORECASE)
_HTTP_STATUS_PATTERN = re.compile(r"(?:HTTP(?:Error)?|status)\s*[:= ]\s*(\d{3})", re.IGNORECASE)


def _safe_message(value: object, limit: int = 500) -> str:
    clean = _SECRET_PATTERN.sub("<redacted>", str(value or "").strip())
    clean = re.sub(r"Bearer\s+[A-Za-z0-9._~-]+", "Bearer <redacted>", clean, flags=re.IGNORECASE)
    return clean[:limit]


def _request_id(value: str) -> str | None:
    match = _TRACE_PATTERN.search(value)
    return match.group(1)[:160] if match else None


def _json_mapping(value: str) -> Mapping[str, Any]:
    clean = value.strip()
    if clean.startswith("```"):
        lines = clean.splitlines()
        if lines and lines[0].lstrip().startswith("```"):
            lines.pop(0)
        if lines and lines[-1].strip() == "```":
            lines.pop()
        clean = "\n".join(lines).strip()
    candidates = [clean]
    start = clean.find("{")
    end = clean.rfind("}")
    if 0 <= start < end:
        candidates.append(clean[start:end + 1])
    last_error: Exception | None = None
    for candidate in candidates:
        try:
            parsed: Any = json.loads(candidate)
            if isinstance(parsed, str):
                parsed = json.loads(parsed)
            if isinstance(parsed, Mapping):
                return parsed
        except (json.JSONDecodeError, TypeError) as error:
            last_error = error
    raise ValueError(f"MiniMax 图片理解没有返回可解析的 JSON：{last_error}")


def _normalized_confidence(value: Any) -> int | None:
    if not isinstance(value, (int, float)) or isinstance(value, bool):
        return None
    normalized = value * 100 if 0 <= value <= 1 else value
    return max(0, min(100, round(normalized)))


def _local_frame_index(value: Any) -> int | None:
    if isinstance(value, int) and not isinstance(value, bool):
        return value
    if isinstance(value, str):
        match = re.search(r"(\d+)", value)
        if match:
            return int(match.group(1))
    return None


def _time_label(timestamp_ms: int) -> str:
    total_seconds = max(0, timestamp_ms) // 1000
    hours, remainder = divmod(total_seconds, 3600)
    minutes, seconds = divmod(remainder, 60)
    return f"{hours:02d}:{minutes:02d}:{seconds:02d}"


@dataclass(frozen=True)
class McpVisionCallResult:
    text: str
    is_error: bool = False
    response_type: str = "text"
    request_id: str | None = None
    error_type: str | None = None
    message: str | None = None


@dataclass(frozen=True)
class PreparedVisionBatch:
    batch_index: int
    attempt: int
    refs: tuple[tuple[int, Keyframe], ...]
    image_path: Path
    prompt: str


async def _run_bounded_calls(
    requests: Sequence[Mapping[str, str]],
    *,
    concurrency: int,
    operation: Callable[[Mapping[str, str]], Awaitable[Any]],
    on_progress: Callable[[int, int], None] | None = None,
) -> list[Any]:
    semaphore = asyncio.Semaphore(concurrency)

    async def run_one(
        index: int,
        request: Mapping[str, str],
    ) -> tuple[int, Any]:
        async with semaphore:
            return index, await operation(request)

    tasks = [
        asyncio.create_task(run_one(index, request))
        for index, request in enumerate(requests)
    ]
    results: list[Any] = [None] * len(tasks)
    completed = 0
    try:
        for task in asyncio.as_completed(tasks):
            index, result = await task
            results[index] = result
            completed += 1
            if on_progress is not None:
                on_progress(completed, len(tasks))
    except BaseException:
        for task in tasks:
            task.cancel()
        await asyncio.gather(*tasks, return_exceptions=True)
        raise
    return results


class MiniMaxTokenPlanMcpRunner:
    """Run the official Coding Plan MCP server over stdio and call understand_image."""

    def __init__(
        self,
        *,
        api_key: str,
        api_host: str,
        timeout_seconds: float = 120,
        concurrency: int = 2,
        command: str | None = None,
    ) -> None:
        if not api_key.strip():
            raise ValueError("MiniMax Token Plan Key is required")
        if not 1 <= concurrency <= 3:
            raise ValueError("MiniMax vision concurrency must be between 1 and 3")
        self.api_key = api_key.strip()
        self.api_host = normalize_minimax_token_plan_host(api_host)
        self.timeout_seconds = timeout_seconds
        self.concurrency = concurrency
        self.command = command or sys.executable

    def call_many(
        self,
        requests: Sequence[Mapping[str, str]],
        on_progress: Callable[[int, int], None] | None = None,
        concurrency: int | None = None,
    ) -> tuple[list[McpVisionCallResult], dict[str, Any]]:
        if not requests:
            return [], {"tool_connected": False}
        effective_concurrency = self.concurrency if concurrency is None else concurrency
        if not 1 <= effective_concurrency <= 3:
            raise ValueError("MiniMax vision concurrency must be between 1 and 3")
        try:
            asyncio.get_running_loop()
        except RuntimeError:
            return asyncio.run(self._call_many(
                requests,
                on_progress=on_progress,
                concurrency=effective_concurrency,
            ))
        raise RuntimeError("MiniMax MCP runner cannot start inside an existing asyncio event loop")

    async def _call_many(
        self,
        requests: Sequence[Mapping[str, str]],
        *,
        on_progress: Callable[[int, int], None] | None = None,
        concurrency: int,
    ) -> tuple[list[McpVisionCallResult], dict[str, Any]]:
        try:
            from mcp import ClientSession, StdioServerParameters
            from mcp.client.stdio import stdio_client
        except ImportError as error:
            raise RuntimeError("MCP client is not installed; run uv sync for the analyzer") from error

        server_environment = os.environ.copy()
        server_environment.update({
            "MINIMAX_API_KEY": self.api_key,
            "MINIMAX_API_HOST": self.api_host,
            "FASTMCP_LOG_LEVEL": "ERROR",
            "PYTHONUTF8": "1",
        })
        params = StdioServerParameters(
            command=self.command,
            args=["-m", "minimax_mcp.server"],
            env=server_environment,
            cwd=tempfile.gettempdir(),
            encoding="utf-8",
            encoding_error_handler="replace",
        )
        client_logger = logging.getLogger("mcp.client.stdio")
        prior_level = client_logger.level
        client_logger.setLevel(logging.CRITICAL)
        stderr_buffer = tempfile.TemporaryFile(mode="w+", encoding="utf-8")  # noqa: SIM115
        try:
            async with stdio_client(params, errlog=stderr_buffer) as (read_stream, write_stream):  # noqa: SIM117
                async with ClientSession(read_stream, write_stream) as session:
                    initialized = await session.initialize()
                    available = await session.list_tools()
                    tool_names = {tool.name for tool in available.tools}
                    if "understand_image" not in tool_names:
                        raise RuntimeError(
                            "MiniMax MCP 已连接，但未提供 understand_image 工具；可用工具："
                            + ", ".join(sorted(tool_names))
                        )
                    server_info = getattr(initialized, "serverInfo", None)
                    metadata = {
                        "tool_connected": True,
                        "available_tools": sorted(tool_names),
                        "server_name": getattr(server_info, "name", None),
                        "server_version": getattr(server_info, "version", None),
                    }
                    async def call_one(
                        request: Mapping[str, str],
                    ) -> McpVisionCallResult:
                        try:
                            response = await session.call_tool(
                                "understand_image",
                                {
                                    "prompt": request["prompt"],
                                    "image_source": request["image_source"],
                                },
                                read_timeout_seconds=self.timeout_seconds,
                            )
                            content = getattr(response, "content", ())
                            texts = [
                                str(getattr(item, "text", "")).strip()
                                for item in content
                                if str(getattr(item, "text", "")).strip()
                            ]
                            text = "\n".join(texts).strip()
                            response_types = sorted({
                                str(getattr(item, "type", type(item).__name__))
                                for item in content
                            })
                            is_error = bool(getattr(response, "isError", False)) or text.lower().startswith(
                                "failed to perform"
                            )
                            return McpVisionCallResult(
                                text=text,
                                is_error=is_error,
                                response_type="+".join(response_types) or type(response).__name__,
                                request_id=_request_id(text),
                                error_type="MCPToolError" if is_error else None,
                                message=_safe_message(text) if is_error else None,
                            )
                        except Exception as error:  # noqa: BLE001 - each batch remains independently retryable
                            return McpVisionCallResult(
                                text="",
                                is_error=True,
                                response_type="exception",
                                error_type=type(error).__name__,
                                message=_safe_message(error),
                            )
                    results = await _run_bounded_calls(
                        requests,
                        concurrency=concurrency,
                        operation=call_one,
                        on_progress=on_progress,
                    )
                    return results, metadata
        except Exception as error:
            stderr_buffer.flush()
            stderr_buffer.seek(0)
            server_error = _safe_message(stderr_buffer.read())
            detail = _safe_message(error)
            if server_error:
                detail = f"{detail}；MCP stderr: {server_error}"[:800]
            raise RuntimeError(f"MiniMax MCP 连接失败：{detail}") from error
        finally:
            client_logger.setLevel(prior_level)


class MiniMaxTokenPlanMcpVisionEngine:
    """Analyze numbered contact sheets through MiniMax Token Plan understand_image."""

    def __init__(
        self,
        *,
        api_key: str,
        api_host: str,
        batch_size: int = 6,
        concurrency: int = 2,
        coverage_threshold: float = 0.85,
        prompt_version: str = "minimax-contact-sheet.v2",
        runner: Any | None = None,
    ) -> None:
        if not api_key.strip() and runner is None:
            raise ValueError("MiniMax Token Plan Key is required")
        if not 4 <= batch_size <= 8:
            raise ValueError("MiniMax contact-sheet batch size must be between 4 and 8")
        if not 1 <= concurrency <= 3:
            raise ValueError("MiniMax vision concurrency must be between 1 and 3")
        if not 0.5 <= coverage_threshold <= 1:
            raise ValueError("vision coverage threshold must be between 0.5 and 1")
        self.api_host = normalize_minimax_token_plan_host(api_host)
        self.batch_size = batch_size
        self.concurrency = concurrency
        self.coverage_threshold = coverage_threshold
        self.prompt_version = prompt_version
        self.runner = runner or MiniMaxTokenPlanMcpRunner(
            api_key=api_key,
            api_host=self.api_host,
            concurrency=concurrency,
        )
        self.last_stats: dict[str, Any] = {}
        self._progress_callback: Callable[[Mapping[str, Any]], None] | None = None

    def set_progress_callback(
        self,
        callback: Callable[[Mapping[str, Any]], None] | None,
    ) -> None:
        self._progress_callback = callback

    def _notify_progress(self, progress: Mapping[str, Any]) -> None:
        if self._progress_callback is not None:
            self._progress_callback(progress)

    def _contact_sheet(
        self,
        refs: Sequence[tuple[int, Keyframe]],
        *,
        batch_index: int,
        attempt: int,
    ) -> Path:
        try:
            from PIL import Image, ImageDraw
        except ImportError as error:
            raise RuntimeError("Pillow is required to build MiniMax vision contact sheets") from error
        columns = 2 if len(refs) <= 4 else 3
        rows = max(1, math.ceil(len(refs) / columns))
        cell_width = 480
        image_height = 270
        banner_height = 42
        cell_height = image_height + banner_height
        sheet = Image.new("RGB", (columns * cell_width, rows * cell_height), (20, 24, 31))
        draw = ImageDraw.Draw(sheet)
        resampling = getattr(Image, "Resampling", Image).LANCZOS
        for local_index, (_, frame) in enumerate(refs, start=1):
            column = (local_index - 1) % columns
            row = (local_index - 1) // columns
            left = column * cell_width
            top = row * cell_height
            draw.rectangle((left, top, left + cell_width, top + banner_height), fill=(35, 43, 56))
            label = f"F{local_index:02d}  {_time_label(frame.timestamp_ms)}"
            draw.text((left + 12, top + 13), label, fill=(255, 255, 255))
            with Image.open(frame.path) as source:
                picture = source.convert("RGB")
                picture.thumbnail((cell_width - 12, image_height - 12), resampling)
                x = left + (cell_width - picture.width) // 2
                y = top + banner_height + (image_height - picture.height) // 2
                sheet.paste(picture, (x, y))
        directory = refs[0][1].path.parent / "vision-contact-sheets"
        directory.mkdir(parents=True, exist_ok=True)
        path = directory / f"minimax-a{attempt}-b{batch_index:03d}.jpg"
        sheet.save(path, format="JPEG", quality=82, optimize=True, progressive=True)
        return path

    def _prompt(self, refs: Sequence[tuple[int, Keyframe]], *, batch_index: int, batch_count: int) -> str:
        manifest = [
            {
                "frame_index": local_index,
                "label": f"F{local_index:02d}",
                "timestamp_ms": frame.timestamp_ms,
                "timecode": _time_label(frame.timestamp_ms),
                "roles": list(frame.roles),
            }
            for local_index, (_, frame) in enumerate(refs, start=1)
        ]
        return (
            "这是一张视频关键帧联系表，每格顶部都有 F 编号和时间码。"
            "只分析实际可见画面，不识别人名身份，不推断业绩或未出现的事实。"
            "必须覆盖每一个格子，并且只返回一个 JSON 对象，不要 Markdown、解释或代码围栏。"
            "JSON 格式为 {\"observations\":[{\"frame_index\":1,\"composition\":\"\","
            "\"people_actions\":\"\",\"scene\":\"\",\"camera_expression\":\"\","
            "\"visual_role\":\"\",\"confidence\":90}]}。"
            "composition 写构图和主体位置；people_actions 写人物、动作或明确无人物；"
            "scene 写环境与场景；camera_expression 只写可见景别、机位；"
            "visual_role 写该画面对视频表达的作用。每格必须恰好一条 observation。"
            + VISUAL_EVIDENCE_INSTRUCTIONS
            + " temporal_groups=" + json.dumps(temporal_groups_in_batch([frame for _, frame in refs]), ensure_ascii=False)
            +
            f"当前为第 {batch_index}/{batch_count} 张联系表，manifest="
            + json.dumps(manifest, ensure_ascii=False, separators=(",", ":"))
        )

    def _prepare(
        self,
        groups: Sequence[Sequence[tuple[int, Keyframe]]],
        *,
        attempt: int,
    ) -> list[PreparedVisionBatch]:
        prepared: list[PreparedVisionBatch] = []
        for batch_index, group in enumerate(groups, start=1):
            refs = tuple(group)
            prepared.append(PreparedVisionBatch(
                batch_index=batch_index,
                attempt=attempt,
                refs=refs,
                image_path=self._contact_sheet(refs, batch_index=batch_index, attempt=attempt),
                prompt=self._prompt(refs, batch_index=batch_index, batch_count=len(groups)),
            ))
        return prepared

    @staticmethod
    def _diagnostic(
        *,
        batch: PreparedVisionBatch,
        stage: str,
        result: McpVisionCallResult | None,
        error: object,
    ) -> dict[str, Any]:
        text = _safe_message(result.message if result and result.message else error)
        api_code = _API_CODE_PATTERN.search(text)
        http_status = _HTTP_STATUS_PATTERN.search(text)
        return {
            "batch": batch.batch_index,
            "attempt": batch.attempt,
            "stage": stage,
            "error_type": result.error_type if result and result.error_type else type(error).__name__,
            "http_status": int(http_status.group(1)) if http_status else None,
            "provider_code": int(api_code.group(1)) if api_code else None,
            "response_type": result.response_type if result else "exception",
            "request_id": result.request_id if result else _request_id(text),
            "message": text,
        }

    def _parse_batch(
        self,
        batch: PreparedVisionBatch,
        result: McpVisionCallResult,
    ) -> tuple[dict[int, VisualObservation], dict[str, Any], list[dict[str, Any]]]:
        record: dict[str, Any] = {
            "batch": batch.batch_index,
            "attempt": batch.attempt,
            "frame_count": len(batch.refs),
            "response_type": result.response_type,
            "request_id": result.request_id,
        }
        if result.is_error:
            record.update({"status": "failed", "understood_count": 0, "missing_count": len(batch.refs)})
            return {}, record, [self._diagnostic(
                batch=batch,
                stage="tool_call",
                result=result,
                error=result.message or "MiniMax MCP tool call failed",
            )]
        try:
            payload = _json_mapping(result.text)
            raw_observations = payload.get("observations")
            if not isinstance(raw_observations, Sequence) or isinstance(raw_observations, (str, bytes)):
                raise TypeError("observations must be an array")
            observations: dict[int, VisualObservation] = {}
            temporal_groups = temporal_groups_in_batch([frame for _, frame in batch.refs])
            for raw in raw_observations:
                if not isinstance(raw, Mapping):
                    continue
                local_index = _local_frame_index(raw.get("frame_index") or raw.get("label"))
                if local_index is None or not 1 <= local_index <= len(batch.refs):
                    continue
                global_index, frame = batch.refs[local_index - 1]
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
                if not description and isinstance(raw.get("description"), str):
                    description = f"画面：{str(raw['description']).strip()}"
                if not description:
                    continue
                scope = ("时序组=" + ",".join(frame_groups)) if frame_groups else "单帧证据；运动/稳定性/转场无法判断"
                observations[global_index] = VisualObservation(
                    "vision",
                    frame.timestamp_ms,
                    frame.timestamp_ms,
                    ("证据范围：" + scope + "；" + description)[:1_000],
                    _normalized_confidence(raw.get("confidence")),
                )
            missing_count = len(batch.refs) - len(observations)
            record.update({
                "status": "completed" if missing_count == 0 else "partial",
                "understood_count": len(observations),
                "missing_count": missing_count,
            })
            return observations, record, []
        except Exception as error:  # noqa: BLE001 - invalid provider output remains diagnosable and retryable
            record.update({"status": "failed", "understood_count": 0, "missing_count": len(batch.refs)})
            return {}, record, [self._diagnostic(
                batch=batch,
                stage="response_parse",
                result=result,
                error=error,
            )]

    def _call_prepared(
        self,
        prepared: Sequence[PreparedVisionBatch],
    ) -> tuple[
        dict[int, VisualObservation],
        list[dict[str, Any]],
        list[dict[str, Any]],
        dict[str, Any],
        int,
    ]:
        requests = [
            {"prompt": batch.prompt, "image_source": str(batch.image_path.resolve())}
            for batch in prepared
        ]
        attempt = prepared[0].attempt if prepared else 1
        phase = "vision" if attempt == 1 else "vision_retry"
        self._notify_progress({
            "phase": phase,
            "batch_completed": 0,
            "batch_total": len(prepared),
            "attempt": attempt,
        })

        def on_progress(completed: int, total: int) -> None:
            self._notify_progress({
                "phase": phase,
                "batch_completed": completed,
                "batch_total": total,
                "attempt": attempt,
            })

        results, metadata = self.runner.call_many(
            requests,
            on_progress=on_progress,
            concurrency=1 if attempt > 1 else self.concurrency,
        )
        observations: dict[int, VisualObservation] = {}
        records: list[dict[str, Any]] = []
        errors: list[dict[str, Any]] = []
        successful_responses = 0
        for index, batch in enumerate(prepared):
            if index >= len(results):
                result = McpVisionCallResult(
                    text="",
                    is_error=True,
                    response_type="missing_result",
                    error_type="MCPResultMissing",
                    message="MCP 返回的批次数少于请求数。",
                )
            else:
                result = results[index]
            if not result.is_error:
                successful_responses += 1
            parsed, record, batch_errors = self._parse_batch(batch, result)
            observations.update(parsed)
            records.append(record)
            errors.extend(batch_errors)
        return observations, records, errors, metadata, successful_responses

    def analyze(self, frames: Sequence[Keyframe]) -> Sequence[VisualObservation]:
        if not frames:
            self.last_stats = {
                "status": "failed",
                "reason": "没有可供 MiniMax 图片理解处理的关键帧。",
                "provider": "MiniMax Token Plan",
                "model": "understand_image",
                "adapter": "minimax_token_plan_mcp",
                "observation_count": 0,
                "frames_requested": 0,
                "frames_understood": 0,
                "frame_coverage_percent": 0,
            }
            return ()

        refs = list(enumerate(frames))
        initial_groups = [[refs[index] for index in indices] for indices in vision_batch_indices(frames, self.batch_size)]
        initial = self._prepare(initial_groups, attempt=1)
        observations: dict[int, VisualObservation] = {}
        records: list[dict[str, Any]] = []
        errors: list[dict[str, Any]] = []
        metadata: dict[str, Any] = {"tool_connected": False}
        request_count = 0
        retry_frame_count = 0
        recovered_frame_count = 0
        successful_responses = 0
        try:
            parsed, first_records, first_errors, first_meta, first_successes = self._call_prepared(initial)
            observations.update(parsed)
            records.extend(first_records)
            errors.extend(first_errors)
            metadata.update(first_meta)
            successful_responses += first_successes
            request_count += len(initial)
        except Exception as error:  # noqa: BLE001 - visual failure must not erase OCR evidence
            errors.append({
                "batch": 0,
                "attempt": 1,
                "stage": "mcp_connect",
                "error_type": type(error).__name__,
                "http_status": None,
                "provider_code": None,
                "response_type": "exception",
                "request_id": None,
                "message": _safe_message(error),
            })

        missing_refs = [ref for ref in refs if ref[0] not in observations]
        throttled = any(
            error.get("http_status") == 429
            or error.get("provider_code") == 429
            or any(
                marker in str(error.get("message") or "").casefold()
                for marker in ("rate limit", "too many requests", "限流")
            )
            for error in errors
        )
        if missing_refs and (successful_responses > 0 or throttled):
            retry_frame_count = len(missing_refs)
            retry_groups = [
                missing_refs[index:index + self.batch_size]
                for index in range(0, len(missing_refs), self.batch_size)
            ]
            retry = self._prepare(retry_groups, attempt=2)
            try:
                before = len(observations)
                parsed, retry_records, retry_errors, retry_meta, _ = self._call_prepared(retry)
                observations.update(parsed)
                recovered_frame_count = len(observations) - before
                records.extend(retry_records)
                errors.extend(retry_errors)
                metadata.update(retry_meta)
                request_count += len(retry)
            except Exception as error:  # noqa: BLE001 - partial observations remain usable
                errors.append({
                    "batch": 0,
                    "attempt": 2,
                    "stage": "mcp_retry_connect",
                    "error_type": type(error).__name__,
                    "http_status": None,
                    "provider_code": None,
                    "response_type": "exception",
                    "request_id": None,
                    "message": _safe_message(error),
                })

        unresolved = [ref for ref in refs if ref[0] not in observations]
        coverage = round(len(observations) / len(refs) * 100, 1)
        threshold = round(self.coverage_threshold * 100, 1)
        if coverage >= threshold:
            status = "completed"
        elif observations:
            status = "partial"
        else:
            status = "failed"
        completed_batches = sum(
            all(global_index in observations for global_index, _ in group)
            for group in initial_groups
        )
        if unresolved:
            errors.append({
                "batch": 0,
                "attempt": 2 if retry_frame_count else 1,
                "stage": "coverage_validation",
                "error_type": "FrameCoverageIncomplete",
                "http_status": None,
                "provider_code": None,
                "response_type": "validation",
                "request_id": None,
                "message": f"仍有 {len(unresolved)} / {len(refs)} 帧没有可用视觉观察。",
            })
        reason = ""
        if status != "completed":
            reason = (
                errors[0]["message"]
                if errors
                else f"真实图片理解覆盖率 {coverage}% 低于 {threshold}% 门槛。"
            )
        ordered = [observations[index] for index in sorted(observations)]
        self.last_stats = {
            "status": status,
            "reason": reason,
            "provider": "MiniMax Token Plan",
            "model": "understand_image",
            "adapter": "minimax_token_plan_mcp",
            "transport": "stdio",
            "prompt_version": self.prompt_version,
            "mcp_package": "minimax-coding-plan-mcp==0.0.5",
            "api_host": self.api_host,
            "tool_connected": bool(metadata.get("tool_connected")),
            "available_tools": metadata.get("available_tools", []),
            "mcp_server_name": metadata.get("server_name"),
            "mcp_server_version": metadata.get("server_version"),
            "batch_size": self.batch_size,
            "concurrency": self.concurrency,
            "batch_count": len(initial_groups),
            "completed_batches": completed_batches,
            "failed_batches": len(initial_groups) - completed_batches,
            "contact_sheet_count": request_count,
            "request_count": request_count,
            "retry_frame_count": retry_frame_count,
            "serial_retry": bool(retry_frame_count),
            "recovered_frame_count": recovered_frame_count,
            "frames_requested": len(refs),
            "frames_understood": len(ordered),
            "missing_frame_count": len(unresolved),
            "frame_coverage_percent": coverage,
            "coverage_threshold_percent": threshold,
            "observation_count": len(ordered),
            "batches": records,
            "errors": errors[:20],
        }
        return tuple(ordered)
