from __future__ import annotations

import re
from collections.abc import Callable, Mapping, Sequence
from itertools import pairwise
from pathlib import Path
from typing import Annotated, Any

from .adapters import (
    Keyframe,
    NormalizedMedia,
    StructureOutput,
    TranscriptOutput,
    TranscriptSegment,
    VisualOutput,
)
from .api_client import ClaimedJob
from .evidence import deduplicate_timed_rows, is_near_duplicate, normalize_evidence_text
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


def _deduplicate_rows(rows: list[dict[str, Any]], *, max_gap_ms: int = 15_000) -> list[dict[str, Any]]:
    return deduplicate_timed_rows(rows, max_gap_ms=max_gap_ms)


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


def _time_token_chunks(
    rows: list[dict[str, Any]],
    budget: int,
    *,
    segment_ms: int = 600_000,
) -> list[list[dict[str, Any]]]:
    chunks: list[list[dict[str, Any]]] = []; current: list[dict[str, Any]] = []; used = 0; bucket = -1
    for row in rows:
        row_bucket = max(0, int(row.get("start_ms") or 0)) // segment_ms
        cost = _row_tokens(row)
        if current and (row_bucket != bucket or used + cost > budget):
            chunks.append(current); current = []; used = 0
        current.append(row); used += cost; bucket = row_bucket
    if current:
        chunks.append(current)
    return chunks


def _merge_chunks(chunks: list[list[dict[str, Any]]], limit: int) -> list[list[dict[str, Any]]]:
    if len(chunks) <= limit:
        return chunks
    merged: list[list[dict[str, Any]]] = [[] for _ in range(limit)]
    for index, chunk in enumerate(chunks):
        target = min(limit - 1, index * limit // len(chunks))
        merged[target].extend(chunk)
    return [chunk for chunk in merged if chunk]


def _script_paragraphs(value: Any) -> list[str]:
    if isinstance(value, str):
        return [value.strip()] if value.strip() else []
    if isinstance(value, Sequence) and not isinstance(value, (str, bytes)):
        return [str(item).strip() for item in value if str(item).strip()]
    if isinstance(value, Mapping):
        paragraphs = value.get("paragraphs")
        if isinstance(paragraphs, Sequence) and not isinstance(paragraphs, (str, bytes)):
            return [str(item).strip() for item in paragraphs if str(item).strip()]
        text = value.get("text")
        return [str(text).strip()] if isinstance(text, str) and text.strip() else []
    return []


def _script_source_ids(paragraphs: list[str], source_rows: list[dict[str, Any]], explicit: Any) -> list[str]:
    valid_ids = {str(row.get("segment_id") or "").strip() for row in source_rows if row.get("segment_id")}
    if isinstance(explicit, Sequence) and not isinstance(explicit, (str, bytes)):
        ids = [str(item).strip() for item in explicit if str(item).strip() in valid_ids]
        if ids:
            return list(dict.fromkeys(ids))
    matched: list[str] = []
    for paragraph in paragraphs:
        for row in source_rows:
            source_text = str(row.get("text") or "")
            if source_text and (source_text in paragraph or paragraph in source_text):
                segment_id = str(row.get("segment_id") or "").strip()
                if segment_id:
                    matched.append(segment_id)
    if matched:
        return list(dict.fromkeys(matched))
    return [str(row.get("segment_id")) for row in source_rows if row.get("segment_id")]


def _build_spoken_script_set(report: dict[str, Any], source_rows: list[dict[str, Any]]) -> dict[str, dict[str, Any]]:
    fallback = _script_paragraphs(report.get("spoken_script")) or [str(row.get("text") or "").strip() for row in source_rows if row.get("text")]
    fallback = [item for item in fallback if item]
    if not fallback:
        raise RuntimeError("model report did not preserve a usable spoken script")
    raw_set = report.get("spoken_script_set") if isinstance(report.get("spoken_script_set"), Mapping) else {}
    result: dict[str, dict[str, Any]] = {}
    for key in ("faithful_full", "light_rewrite", "restructured"):
        raw = raw_set.get(key) if isinstance(raw_set, Mapping) else None
        paragraphs = _script_paragraphs(raw) or fallback
        explicit = raw.get("source_segment_ids") if isinstance(raw, Mapping) else None
        result[key] = {
            "text": "\n\n".join(paragraphs),
            "paragraphs": paragraphs,
            "source_segment_ids": _script_source_ids(paragraphs, source_rows, explicit),
        }
    report["spoken_script"] = result["faithful_full"]["paragraphs"]
    report["spoken_script_set"] = result
    return result


def _evidence_row(value: Mapping[str, Any]) -> dict[str, Any] | None:
    text = str(value.get("text") or "").strip()
    if not text:
        return None
    source = str(value.get("source") or "source").strip()[:80] or "source"
    confidence = _confidence(value.get("confidence"))
    return {
        "start_ms": max(0, int(value.get("start_ms") or 0)),
        "text": text,
        "source": source,
        "confidence": confidence,
    }


def _match_source_evidence(
    requested: Mapping[str, Any],
    sources: Sequence[Mapping[str, Any]],
) -> tuple[dict[str, Any] | None, str]:
    requested_text = str(requested.get("text") or "").strip()
    requested_key = normalize_evidence_text(requested_text)
    canonical = [row for value in sources if (row := _evidence_row(value)) is not None]
    if requested_text:
        for row in canonical:
            if row["text"] == requested_text:
                return row, "exact"
        for row in canonical:
            if requested_key and normalize_evidence_text(row["text"]) == requested_key:
                return row, "normalized"
        for row in canonical:
            if is_near_duplicate(requested_text, row["text"], threshold=0.88):
                return row, "similar"
    requested_start = requested.get("start_ms")
    if isinstance(requested_start, (int, float)) and canonical:
        nearest = min(canonical, key=lambda row: abs(row["start_ms"] - int(requested_start)))
        if abs(nearest["start_ms"] - int(requested_start)) <= 5_000:
            return nearest, "timestamp"
    return None, "unmatched"


def _fallback_source_evidence(
    sources: Sequence[Mapping[str, Any]],
    *,
    limit: int = 8,
) -> list[dict[str, Any]]:
    canonical = [row for value in sources if (row := _evidence_row(value)) is not None]
    if len(canonical) <= limit:
        return canonical
    indices = sorted({round(index * (len(canonical) - 1) / (limit - 1)) for index in range(limit)})
    return [canonical[index] for index in indices]


def _repair_report_evidence(
    requested_rows: Any,
    sources: Sequence[Mapping[str, Any]],
) -> tuple[list[dict[str, Any]], dict[str, str], dict[str, int | bool]]:
    aliases: dict[str, str] = {}
    repaired: list[dict[str, Any]] = []
    seen: set[tuple[int, str]] = set()
    counts = {"exact": 0, "normalized": 0, "similar": 0, "timestamp": 0, "unmatched": 0}
    values = requested_rows if isinstance(requested_rows, Sequence) and not isinstance(requested_rows, (str, bytes)) else []
    for value in values:
        if not isinstance(value, Mapping):
            continue
        matched, mode = _match_source_evidence(value, sources)
        counts[mode] += 1
        if matched is None:
            continue
        requested_text = str(value.get("text") or "").strip()
        if requested_text:
            aliases[requested_text] = matched["text"]
            requested_key = normalize_evidence_text(requested_text)
            if requested_key:
                aliases[requested_key] = matched["text"]
        key = (matched["start_ms"], matched["text"])
        if key not in seen:
            repaired.append(matched)
            seen.add(key)
    used_fallback = not repaired
    if used_fallback:
        repaired = _fallback_source_evidence(sources)
    return repaired, aliases, {
        "repaired_count": counts["normalized"] + counts["similar"] + counts["timestamp"],
        "unmatched_count": counts["unmatched"],
        "used_fallback": used_fallback,
    }


def _repair_insight_evidence(
    links: Any,
    report: Mapping[str, Any],
    evidence: Sequence[Mapping[str, Any]],
    aliases: Mapping[str, str],
) -> list[dict[str, Any]]:
    linkable_sections = {
        "hook_analysis", "viral_points", "rhythm_analysis", "emotion_curve",
        "conversion_design", "highlights", "risks", "recommendations",
    }
    source_rows = [row for value in evidence if (row := _evidence_row(value)) is not None]
    repaired: list[dict[str, Any]] = []
    values = links if isinstance(links, Sequence) and not isinstance(links, (str, bytes)) else []
    for value in values:
        if not isinstance(value, Mapping):
            continue
        section = value.get("section")
        item_index = value.get("item_index")
        section_items = report.get(str(section), [])
        if (
            section not in linkable_sections
            or not isinstance(item_index, int)
            or not isinstance(section_items, Sequence)
            or isinstance(section_items, (str, bytes))
            or not 0 <= item_index < len(section_items)
        ):
            continue
        requested_text = str(value.get("evidence_text") or "").strip()
        exact_text = aliases.get(requested_text) or aliases.get(normalize_evidence_text(requested_text))
        if not exact_text:
            matched, _mode = _match_source_evidence({"text": requested_text}, source_rows)
            exact_text = matched["text"] if matched else ""
        if exact_text:
            repaired.append({"section": section, "item_index": item_index, "evidence_text": exact_text})
    return repaired


def _completion_json_text(completion: Any) -> str:
    choices = getattr(completion, "choices", None)
    if not isinstance(choices, Sequence) or not choices:
        return ""
    message = getattr(choices[0], "message", None)
    content = getattr(message, "content", None)
    if isinstance(content, str) and content.strip():
        return content.strip()
    tool_calls = getattr(message, "tool_calls", None)
    if isinstance(tool_calls, Sequence) and tool_calls:
        function = getattr(tool_calls[0], "function", None)
        arguments = getattr(function, "arguments", None)
        if isinstance(arguments, str):
            return arguments.strip()
    return ""


def _payload_evidence_rows(payload: Any) -> list[dict[str, Any]]:
    rows: list[dict[str, Any]] = []

    def visit(value: Any) -> None:
        if isinstance(value, Mapping):
            if isinstance(value.get("text"), str) and value.get("text", "").strip():
                row = _evidence_row(value)
                if row is not None:
                    rows.append(row)
            for child in value.values():
                visit(child)
        elif isinstance(value, Sequence) and not isinstance(value, (str, bytes)):
            for child in value:
                visit(child)

    visit(payload)
    return rows


def _recover_partial_json_report(
    error: Exception,
    payload: Mapping[str, Any],
    *,
    compact: bool,
    section: str = "full",
) -> dict[str, Any] | None:
    raw = _completion_json_text(getattr(error, "last_completion", None))
    if not raw:
        return None
    try:
        from pydantic_core import from_json

        partial = from_json(raw, allow_partial=True)
    except (ImportError, ValueError, TypeError):
        return None
    if not isinstance(partial, Mapping):
        return None

    def text_value(key: str, fallback: str, maximum: int) -> str:
        value = partial.get(key)
        clean = str(value).strip() if isinstance(value, str) else ""
        return (clean or fallback)[:maximum]

    def text_list(key: str, maximum_items: int, maximum_length: int) -> list[str]:
        value = partial.get(key)
        if not isinstance(value, Sequence) or isinstance(value, (str, bytes)):
            return []
        return [str(item).strip()[:maximum_length] for item in value if str(item).strip()][:maximum_items]

    sources = _payload_evidence_rows(payload)
    fallback_evidence = _fallback_source_evidence(sources, limit=4)
    requested_evidence = partial.get("evidence")
    evidence = (
        [dict(item) for item in requested_evidence if isinstance(item, Mapping)][:8]
        if isinstance(requested_evidence, Sequence) and not isinstance(requested_evidence, (str, bytes))
        else []
    ) or fallback_evidence
    if not evidence:
        return None
    fallback_text = "。".join(row["text"] for row in fallback_evidence[:4])[:600] or "已保留可追溯的原始内容。"
    confidence = _confidence(partial.get("confidence")) or 60

    if compact:
        return {
            "summary": text_value("summary", fallback_text, 320),
            "hook": text_value("hook", fallback_evidence[0]["text"] if fallback_evidence else fallback_text, 240),
            "structure": text_list("structure", 6, 120),
            "spoken_script": text_list("spoken_script", 2, 800) or [fallback_text],
            "highlights": text_list("highlights", 5, 240),
            "risks": text_list("risks", 4, 240),
            "evidence": evidence[:6],
            "confidence": confidence,
        }

    if section == "core":
        return {
            "summary": text_value("summary", fallback_text, 1200),
            "hook": text_value("hook", fallback_evidence[0]["text"] if fallback_evidence else fallback_text, 320),
            "structure": text_list("structure", 12, 120) or ["核心内容"],
            "audience": text_value("audience", "未明确说明", 320),
            "spoken_script": text_list("spoken_script", 8, 1200) or [fallback_text],
            "visual": text_list("visual", 12, 320),
            "language": text_list("language", 12, 320),
            "highlights": text_list("highlights", 12, 320),
            "evidence": evidence[:20],
            "confidence": confidence,
        }

    if section == "insights":
        insight_links = partial.get("insight_evidence")
        return {
            "hook_analysis": text_list("hook_analysis", 8, 320),
            "viral_points": text_list("viral_points", 8, 320),
            "rhythm_analysis": text_list("rhythm_analysis", 8, 320),
            "emotion_curve": text_list("emotion_curve", 8, 320),
            "conversion_design": text_list("conversion_design", 8, 320),
            "insight_evidence": (
                [dict(item) for item in insight_links if isinstance(item, Mapping)][:50]
                if isinstance(insight_links, Sequence) and not isinstance(insight_links, (str, bytes))
                else []
            ),
            "risks": text_list("risks", 12, 320),
            "recommendations": text_list("recommendations", 12, 320),
            "evidence": evidence[:20],
            "confidence": confidence,
        }

    insight_links = partial.get("insight_evidence")
    return {
        "summary": text_value("summary", fallback_text, 600),
        "hook": text_value("hook", fallback_evidence[0]["text"] if fallback_evidence else fallback_text, 160),
        "structure": text_list("structure", 8, 80) or ["核心内容"],
        "audience": text_value("audience", "未明确说明", 160),
        "spoken_script": text_list("spoken_script", 6, 600) or [fallback_text],
        "hook_analysis": text_list("hook_analysis", 4, 160),
        "viral_points": text_list("viral_points", 4, 160),
        "rhythm_analysis": text_list("rhythm_analysis", 4, 160),
        "emotion_curve": text_list("emotion_curve", 4, 160),
        "conversion_design": text_list("conversion_design", 4, 160),
        "insight_evidence": (
            [dict(item) for item in insight_links if isinstance(item, Mapping)][:20]
            if isinstance(insight_links, Sequence) and not isinstance(insight_links, (str, bytes))
            else []
        ),
        "visual": text_list("visual", 6, 160),
        "language": text_list("language", 6, 160),
        "highlights": text_list("highlights", 6, 160),
        "risks": text_list("risks", 6, 160),
        "recommendations": text_list("recommendations", 6, 160),
        "evidence": evidence,
        "confidence": confidence,
    }


def _assess_report_quality(
    report: Mapping[str, Any],
    *,
    profile: str,
    available_evidence_count: int,
    source_characters: int,
    coverage_percent: int,
    recovered_json_outputs: int,
    evidence_repair: Mapping[str, Any],
    visual_stats: Mapping[str, Any],
    has_video: bool,
) -> dict[str, Any]:
    """Apply a deterministic acceptance gate without inventing missing findings."""
    score = 100
    issues: list[str] = []
    checks: list[dict[str, Any]] = []

    def values(key: str) -> list[str]:
        value = report.get(key)
        if not isinstance(value, Sequence) or isinstance(value, (str, bytes)):
            return []
        return [str(item).strip() for item in value if str(item).strip()]

    core_fields = ("summary", "hook", "structure", "audience", "spoken_script")
    missing_core = [key for key in core_fields if not report.get(key)]
    core_passed = not missing_core
    if missing_core:
        score -= min(35, 12 + len(missing_core) * 6)
        issues.append(f"主体报告缺少：{', '.join(missing_core)}。")
    checks.append({"key": "core", "label": "主体完整度", "passed": core_passed, "value": f"{len(core_fields) - len(missing_core)}/{len(core_fields)}"})

    summary_characters = len(str(report.get("summary") or "").strip())
    spoken_characters = sum(len(item) for item in values("spoken_script"))
    full_profile = profile in {"max", "deep"}
    summary_target = min(180 if full_profile else 90, max(1, round(source_characters * 0.12)))
    spoken_target = min(1_200 if full_profile else 600, max(1, round(source_characters * 0.55)))
    depth_passed = summary_characters >= summary_target and spoken_characters >= spoken_target
    if not depth_passed:
        score -= 12
        issues.append(
            f"报告展开不足：摘要 {summary_characters}/{summary_target} 字，整理口播稿 {spoken_characters}/{spoken_target} 字。"
        )
    checks.append({
        "key": "depth", "label": "内容展开度", "passed": depth_passed,
        "value": f"摘要 {summary_characters} · 口播 {spoken_characters} 字",
    })

    specialist_sections = (
        "hook_analysis", "viral_points", "rhythm_analysis", "emotion_curve",
        "conversion_design", "risks", "recommendations",
    )
    specialist_minimum = 3 if full_profile else 1
    thin_sections = [key for key in specialist_sections if len(values(key)) < specialist_minimum]
    specialist_passed = not thin_sections
    if thin_sections:
        score -= min(28, len(thin_sections) * 4)
        issues.append(f"专项诊断偏薄：{', '.join(thin_sections)}。")
    specialist_items = sum(len(values(key)) for key in specialist_sections)
    checks.append({"key": "specialists", "label": "专项诊断", "passed": specialist_passed, "value": f"{specialist_items} 条"})

    evidence = [item for item in report.get("evidence", []) if isinstance(item, Mapping)] if isinstance(report.get("evidence"), Sequence) else []
    evidence_target = min(12 if full_profile else 4, max(1, available_evidence_count))
    evidence_passed = len(evidence) >= evidence_target
    if not evidence_passed:
        score -= min(18, (evidence_target - len(evidence)) * 2)
        issues.append(f"代表性逐字证据不足：当前 {len(evidence)} 条，建议至少 {evidence_target} 条。")
    checks.append({"key": "evidence", "label": "逐字证据", "passed": evidence_passed, "value": f"{len(evidence)}/{evidence_target}"})

    linkable_items = sum(len(values(key)) for key in specialist_sections)
    links = [item for item in report.get("insight_evidence", []) if isinstance(item, Mapping)] if isinstance(report.get("insight_evidence"), Sequence) else []
    link_target = min(linkable_items, 12 if full_profile else 4)
    links_passed = link_target == 0 or len(links) >= max(1, round(link_target * 0.6))
    if not links_passed:
        score -= min(16, max(6, link_target - len(links)))
        issues.append(f"专项结论的证据链接覆盖不足：当前 {len(links)} 条，验收目标 {link_target} 条。")
    checks.append({"key": "links", "label": "结论可追溯", "passed": links_passed, "value": f"{len(links)}/{link_target}"})

    coverage_passed = coverage_percent >= (85 if full_profile else 70)
    if not coverage_passed:
        score -= 12
        issues.append(f"本次只覆盖约 {coverage_percent}% 的可用来源，部分内容未进入模型上下文。")
    checks.append({"key": "coverage", "label": "来源覆盖", "passed": coverage_passed, "value": f"{coverage_percent}%"})

    all_findings = [item for key in specialist_sections for item in values(key)]
    normalized_findings = [normalize_evidence_text(item) for item in all_findings]
    unique_ratio = len(set(normalized_findings)) / len(normalized_findings) if normalized_findings else 0.0
    diversity_passed = not all_findings or unique_ratio >= 0.75
    if not diversity_passed:
        score -= 10
        issues.append("多个专项存在明显重复结论，需要人工合并或重新分析。")
    checks.append({"key": "diversity", "label": "结论区分度", "passed": diversity_passed, "value": f"{round(unique_ratio * 100)}%" if all_findings else "—"})

    kept_frames = visual_stats.get("kept_count")
    target_frames = visual_stats.get("target_count")
    visual_evaluated = has_video and isinstance(kept_frames, int)
    visual_passed = not visual_evaluated or kept_frames >= min(3, target_frames if isinstance(target_frames, int) else 3)
    if not visual_passed:
        score -= 8
        issues.append(f"视频画面覆盖不足：仅保留 {kept_frames} 个关键帧。")
    checks.append({"key": "visual", "label": "画面覆盖", "passed": visual_passed, "value": str(kept_frames) if visual_evaluated else "未记录"})

    if recovered_json_outputs > 0:
        score -= min(20, recovered_json_outputs * 10)
        issues.append(f"有 {recovered_json_outputs} 次模型输出因截断或 JSON 不完整而使用恢复结果。")
    if bool(evidence_repair.get("used_fallback")):
        score -= 12
        issues.append("模型证据不可用，系统已改用来源中的保底证据。")

    score = max(0, min(100, score))
    critical_passed = all((core_passed, depth_passed, specialist_passed, evidence_passed, links_passed, coverage_passed))
    if score >= 85 and critical_passed:
        status, label = "passed", "验收通过"
    elif score >= 65 and core_passed:
        status, label = "review", "建议复核"
    else:
        status, label = "degraded", "降级输出"
    return {
        "score": score,
        "status": status,
        "label": label,
        "acceptance_passed": status == "passed",
        "requires_review": status != "passed",
        "checks": checks,
        "issues": issues,
        "missing_sections": [*missing_core, *thin_sections],
    }


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
        if maximum_frames < 3:
            raise ValueError("maximum_frames must be at least 3")
        self.processor = processor
        self.minimum_scene_seconds = minimum_scene_seconds
        self.maximum_frames = maximum_frames
        self.detector = detector or self._detect
        self.fallback = FfmpegFrameExtractor(processor, interval_seconds=5)
        self.last_stats: dict[str, Any] = {}

    def _detect(self, source: Path) -> Sequence[tuple[float, float]]:
        result = self.processor._execute(
            [
                self.processor.ffmpeg,
                "-hide_banner",
                "-nostdin",
                "-v",
                "info",
                "-i",
                str(source),
                "-vf",
                r"select=gt(scene\,0.32),showinfo",
                "-an",
                "-f",
                "null",
                "-",
            ]
        )
        duration_seconds = max(0.0, self.processor.probe(source).duration_ms / 1000)
        cuts = sorted(
            {
                max(0.0, float(value))
                for value in re.findall(r"pts_time:\s*(-?\d+(?:\.\d+)?)", result.stderr or "")
            }
        )
        boundaries = [0.0]
        for timestamp in cuts:
            if timestamp >= boundaries[-1] + self.minimum_scene_seconds:
                boundaries.append(timestamp)
        if duration_seconds > boundaries[-1]:
            boundaries.append(duration_seconds)
        return [
            (start, end)
            for start, end in pairwise(boundaries)
            if end > start
        ]

    def extract(self, media: NormalizedMedia, output_dir: Path) -> list[Keyframe]:
        if not media.info.video_codec:
            self.last_stats = {"strategy": "audio_only", "scene_count": 0, "anchor_count": 0, "candidate_count": 0}
            return []
        scenes = list(self.detector(media.source_path))
        duration_seconds = max(0.0, media.info.duration_ms / 1000)
        if not scenes and duration_seconds <= 0:
            frames = self.fallback.extract(media, output_dir)
            self.last_stats = {
                "strategy": "interval_fallback", "scene_count": 0, "anchor_count": len(frames),
                "candidate_count": len(frames), "target_count": len(frames),
            }
            return frames
        target_count = min(
            self.maximum_frames,
            max(3, round(duration_seconds / 75) + 2),
        )
        scene_timestamps = [max(0.0, start + max(0.0, end - start) / 2) for start, end in scenes]
        if len(scene_timestamps) > self.maximum_frames:
            step = len(scene_timestamps) / self.maximum_frames
            scene_timestamps = [
                scene_timestamps[min(len(scene_timestamps) - 1, round(index * step))]
                for index in range(self.maximum_frames)
            ]
        anchor_timestamps = (
            [duration_seconds * index / max(1, target_count - 1) for index in range(target_count)]
            if duration_seconds > 0
            else []
        )
        timestamps: list[float] = []
        minimum_gap = max(2.0, min(15.0, duration_seconds / max(1, target_count * 5)))
        for timestamp in sorted([*scene_timestamps, *anchor_timestamps]):
            bounded = min(max(0.0, timestamp), max(0.0, duration_seconds - 0.25)) if duration_seconds else max(0.0, timestamp)
            if not timestamps or all(abs(bounded - existing) >= minimum_gap for existing in timestamps):
                timestamps.append(bounded)
        if len(timestamps) > self.maximum_frames:
            indices = sorted({round(index * (len(timestamps) - 1) / (self.maximum_frames - 1)) for index in range(self.maximum_frames)})
            timestamps = [timestamps[index] for index in indices]
        output_dir.mkdir(parents=True, exist_ok=True)
        frames: list[Keyframe] = []
        for index, timestamp in enumerate(timestamps):
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
        self.last_stats = {
            "strategy": "scene_plus_timeline",
            "scene_count": len(scenes),
            "anchor_count": len(anchor_timestamps),
            "candidate_count": len(frames),
            "target_count": target_count,
            "maximum_frames": self.maximum_frames,
            "anchor_interval_seconds": round(duration_seconds / max(1, target_count - 1), 1) if target_count > 1 else None,
        }
        return frames


class InstructorStructureAnalyzer:
    def __init__(
        self,
        *,
        api_key: str,
        base_url: str,
        model: str,
        provider: str,
        prompt_version: str = "video-analysis.v6",
        max_source_tokens: int = 64_000,
        max_output_tokens: int = 6_000,
        window_tokens: int = 8_000,
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

            LabelText = Annotated[str, Field(min_length=1, max_length=80)]
            ShortText = Annotated[str, Field(min_length=1, max_length=160)]
            ParagraphText = Annotated[str, Field(min_length=1, max_length=600)]
            FullLabelText = Annotated[str, Field(min_length=1, max_length=120)]
            FullShortText = Annotated[str, Field(min_length=1, max_length=320)]
            FullParagraphText = Annotated[str, Field(min_length=1, max_length=1200)]

            class Evidence(BaseModel):
                model_config = ConfigDict(extra="forbid")
                start_ms: int | None = Field(default=None, ge=0)
                text: str = Field(min_length=1, max_length=1000)
                source: str = Field(min_length=1, max_length=80)
                confidence: int | None = Field(default=None, ge=0, le=100)

            class InsightEvidenceLink(BaseModel):
                model_config = ConfigDict(extra="forbid")
                section: str = Field(min_length=1, max_length=40)
                item_index: int = Field(ge=0, le=29)
                evidence_text: str = Field(min_length=1, max_length=1000)

            class SpokenScriptVersion(BaseModel):
                model_config = ConfigDict(extra="forbid")
                text: str = Field(min_length=1, max_length=12_000)
                paragraphs: list[str] = Field(min_length=1, max_length=16)
                source_segment_ids: list[str] = Field(default_factory=list, max_length=200)

            class SpokenScriptSet(BaseModel):
                model_config = ConfigDict(extra="forbid")
                faithful_full: SpokenScriptVersion | None = None
                light_rewrite: SpokenScriptVersion | None = None
                restructured: SpokenScriptVersion | None = None

            class Report(BaseModel):
                model_config = ConfigDict(extra="forbid")
                summary: ParagraphText
                hook: ShortText
                structure: list[LabelText] = Field(min_length=1, max_length=8)
                audience: ShortText
                spoken_script: list[ParagraphText] = Field(min_length=1, max_length=6)
                spoken_script_set: SpokenScriptSet | None = None
                hook_analysis: list[ShortText] = Field(default_factory=list, max_length=4)
                viral_points: list[ShortText] = Field(default_factory=list, max_length=4)
                rhythm_analysis: list[ShortText] = Field(default_factory=list, max_length=4)
                emotion_curve: list[ShortText] = Field(default_factory=list, max_length=4)
                conversion_design: list[ShortText] = Field(default_factory=list, max_length=4)
                insight_evidence: list[InsightEvidenceLink] = Field(default_factory=list, max_length=20)
                visual: list[ShortText] = Field(default_factory=list, max_length=6)
                language: list[ShortText] = Field(default_factory=list, max_length=6)
                highlights: list[ShortText] = Field(default_factory=list, max_length=6)
                risks: list[ShortText] = Field(default_factory=list, max_length=6)
                recommendations: list[ShortText] = Field(default_factory=list, max_length=6)
                evidence: list[Evidence] = Field(min_length=1, max_length=12)
                confidence: int = Field(ge=0, le=100)

            class SegmentReport(BaseModel):
                model_config = ConfigDict(extra="forbid")
                summary: FullShortText
                hook: FullShortText | None = None
                structure: list[FullLabelText] = Field(default_factory=list, max_length=6)
                spoken_script: list[FullParagraphText] = Field(min_length=1, max_length=2)
                highlights: list[FullShortText] = Field(default_factory=list, max_length=5)
                risks: list[FullShortText] = Field(default_factory=list, max_length=4)
                evidence: list[Evidence] = Field(min_length=1, max_length=6)
                confidence: int = Field(ge=0, le=100)

            class DeepCoreReport(BaseModel):
                model_config = ConfigDict(extra="forbid")
                summary: FullParagraphText
                hook: FullShortText
                structure: list[FullLabelText] = Field(min_length=1, max_length=12)
                audience: FullShortText
                spoken_script: list[FullParagraphText] = Field(min_length=1, max_length=8)
                spoken_script_set: SpokenScriptSet | None = None
                visual: list[FullShortText] = Field(default_factory=list, max_length=12)
                language: list[FullShortText] = Field(default_factory=list, max_length=12)
                highlights: list[FullShortText] = Field(default_factory=list, max_length=12)
                evidence: list[Evidence] = Field(min_length=1, max_length=20)
                confidence: int = Field(ge=0, le=100)

            class DeepInsightReport(BaseModel):
                model_config = ConfigDict(extra="forbid")
                hook_analysis: list[FullShortText] = Field(min_length=3, max_length=8)
                viral_points: list[FullShortText] = Field(min_length=3, max_length=8)
                rhythm_analysis: list[FullShortText] = Field(min_length=3, max_length=8)
                emotion_curve: list[FullShortText] = Field(min_length=3, max_length=8)
                conversion_design: list[FullShortText] = Field(min_length=3, max_length=8)
                insight_evidence: list[InsightEvidenceLink] = Field(default_factory=list, max_length=50)
                risks: list[FullShortText] = Field(min_length=3, max_length=12)
                recommendations: list[FullShortText] = Field(min_length=3, max_length=12)
                evidence: list[Evidence] = Field(min_length=1, max_length=20)
                confidence: int = Field(ge=0, le=100)

            report_model = Report
            self.segment_report_model = SegmentReport
            self.deep_core_report_model = DeepCoreReport
            self.deep_insight_report_model = DeepInsightReport
            mode = instructor.Mode.JSON if provider.strip().lower() == "deepseek" else instructor.Mode.TOOLS
            client = instructor.from_openai(OpenAI(api_key=api_key, base_url=base_url), mode=mode)
        else:
            self.segment_report_model = report_model
            self.deep_core_report_model = report_model
            self.deep_insight_report_model = report_model
        self.client = client
        self.report_model = report_model
        self.model = model
        self.provider = provider
        self.prompt_version = prompt_version
        self.max_source_tokens = max_source_tokens
        self.max_output_tokens = max_output_tokens
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
                "segment_id": f"t-{index + 1:04d}",
                "start_ms": row.start_ms,
                "end_ms": row.end_ms,
                "text": row.text,
                "source": "asr",
                "confidence": row.confidence,
            }
            for index, row in enumerate(transcript.segments)
        ]
        raw_visual_rows = [
            {
                "start_ms": row.start_ms,
                "end_ms": row.end_ms,
                "text": row.text,
                "source": "ocr",
                "confidence": row.confidence,
            }
            for row in visuals.observations
        ]
        transcript_rows = _deduplicate_rows(raw_transcript_rows)
        visual_rows = _deduplicate_rows(raw_visual_rows, max_gap_ms=120_000)
        original_tokens = sum(_row_tokens(row) for row in transcript_rows + visual_rows)
        profile = "max"
        profile_budget = 64_000
        profile_output_budget = 12_000
        effective_source_tokens = min(self.max_source_tokens, profile_budget)
        request_output_cap = self.max_output_tokens
        effective_output_tokens = min(
            profile_output_budget,
            request_output_cap * 2,
        )
        visual_budget = min(3_000, max(1_000, effective_source_tokens // 5))
        selected_visuals = _select_evenly(visual_rows, visual_budget)
        transcript_budget = max(1_000, effective_source_tokens - sum(_row_tokens(row) for row in selected_visuals))
        selected_transcript = _select_evenly(transcript_rows, transcript_budget)
        selected_tokens = sum(_row_tokens(row) for row in selected_transcript + selected_visuals)
        provider_options: dict[str, Any] = {}
        if self.provider.strip().lower() == "deepseek":
            provider_options["extra_body"] = {"thinking": {"type": "disabled"}}
        completions = self.client.chat.completions
        create_with_completion = getattr(completions, "create_with_completion", None)
        actual_input_tokens = 0; actual_output_tokens = 0; actual_total_tokens = 0; recovered_json_outputs = 0
        detail_contract = (
            "这是最高能力分析：摘要要充分解释核心机制；专项数组通常 5 至 8 项；"
            "画面、语言、亮点、风险和建议保留有区分度的细节；证据充足时选择 12 至 20 条代表性原文。"
            if profile == "max"
            else "总结、分析和建议只保留最关键结论；专项数组每项一句话且通常 2 至 4 项；证据只选 4 至 8 条最有代表性的短原文。"
        )
        script_contract = (
            "整理成不超过 8 个可以直接朗读的自然段，保留关键事实、案例与论证链，禁止补写来源中没有的事实。"
            if profile == "max"
            else "整理成不超过 6 个可以直接朗读的自然段，禁止补写来源中没有的事实。"
        )
        system_prompt = (
            "你是短视频内容分析员。当前分析方法已获授权并参考利明智耀授权方法库。统计数字只能使用输入值，不能猜测。"
            "必须优先保证 JSON 完整闭合，禁止为了写得更长而触发输出截断。严格遵守输入中的 length_contract："
            + detail_contract
            + "每条 evidence.text 必须逐字引用转写或 OCR，start_ms 必须来自同一证据。"
            "最终报告必须包含按语义整理的 spoken_script，以及 spoken_script_set 三版口播："
            "faithful_full 完整口播版、light_rewrite 微调同构版、restructured 内容等价重构版。"
            "三版都必须保留原意与事实，删除口头重复、语气词和无效停顿，分别写出 paragraphs、text 和 source_segment_ids；"
            "微调同构版必须与完整口播版保持段落数量和论点顺序一致，重构版允许调整顺序但不得新增事实。"
            + script_contract
            + "先识别视频唯一的核心机制，判断其他观点是否都在解释、证明、举例或提供方案；并列主张过多时要指出核心被稀释。"
            "hook_analysis 必须分别判断开头是否脱离标题独立成立、是否在前 5 秒交代话题和继续观看的理由、"
            "是否有来源中真实存在的可信依据、是否保留悬念以及正文能否兑现承诺。"
            "传播与共鸣分析要检查受众未说出口的处境、满足动机、内容立场、首批传播者和信念到行动的变化，"
            "这些维度只用于解释结构，禁止预测播放量或平台推荐。"
            "rhythm_analysis 必须检查段落间逻辑断裂、信息密度下降、重复表达、过长句、书面语和术语未解释等口播风险。"
            "hook_analysis、viral_points、rhythm_analysis、emotion_curve、conversion_design "
            "分别分析开场钩子、传播爆点、节奏、情绪推进和转化设计，结论要简洁、具体、可执行。"
            "为这些专项结论以及 highlights、risks、recommendations 生成 insight_evidence：section 是字段名，"
            "item_index 是该数组从 0 开始的序号，evidence_text 必须逐字等于 evidence 中的一条原文。"
            "同时输出结构、受众、画面、语言、亮点、风险和复用建议。"
        )

        def request_report(
            payload: Mapping[str, Any],
            output_tokens: int,
            *,
            synthesis: bool = False,
            compact: bool = False,
            section: str = "full",
        ) -> tuple[dict[str, Any], Any]:
            nonlocal actual_input_tokens, actual_output_tokens, actual_total_tokens, recovered_json_outputs
            if compact:
                response_model = self.segment_report_model
                section_prompt = ""
            elif section == "core":
                response_model = self.deep_core_report_model
                section_prompt = (
                    "这是最高能力的主体报告。只生成摘要、开场钩子、内容结构、目标受众、整理后的完整口播稿和 spoken_script_set 三版口播、"
                    "画面分析、语言分析、内容亮点和逐字证据。摘要应充分解释核心机制；口播稿保留关键事实与论证链，"
                    "不要为缩短篇幅删掉重要例子。证据充足时选择 12 至 20 条。"
                )
            elif section == "insights":
                response_model = self.deep_insight_report_model
                section_prompt = (
                    "这是最高能力的专项诊断。只生成钩子、传播爆点、节奏、情绪曲线、转化设计、风险和改进建议，"
                    "每个专项通常给出 5 至 8 条不同层次的结论，并用逐字证据建立 insight_evidence。"
                    "结论必须具体说明哪里有效、为什么有效、哪里不足以及如何修改，禁止空泛套话。"
                )
            else:
                response_model = self.report_model
                section_prompt = ""
            target_characters = (
                max(300, round(output_tokens * 0.72))
                if section in {"core", "insights"}
                else max(180, round(output_tokens * 0.5))
            )
            request_kwargs = {
                "model": self.model,
                "response_model": response_model,
                "max_retries": 1,
                "max_tokens": output_tokens,
                "temperature": 0.2,
                "messages": [
                    {
                        "role": "system",
                        "content": (
                            "你正在分析长视频的一个时间段。输出本段摘要、开场、结构、亮点、风险、按原意整理的口播段落和逐字证据；保留关键案例与论证。"
                            if compact
                            else system_prompt
                            + ("请汇总分段报告，消除重复结论，生成完整口播稿并保持证据原文。" if synthesis else "")
                            + section_prompt
                        ),
                    },
                    {"role": "user", "content": str({
                        **payload,
                            "length_contract": {
                                "maximum_output_tokens": output_tokens,
                                "target_maximum_chinese_characters": target_characters,
                                "priority": "完整合法 JSON > 可追溯证据 > 核心结论 > 补充细节",
                        },
                    })},
                ],
                **provider_options,
            }
            raw_response = None
            try:
                if callable(create_with_completion):
                    response, raw_response = create_with_completion(**request_kwargs)
                else:
                    response = completions.create(**request_kwargs)
                value = response.model_dump(mode="json") if hasattr(response, "model_dump") else dict(response)
            except Exception as error:
                value = _recover_partial_json_report(error, payload, compact=compact, section=section)
                if value is None:
                    raise
                recovered_json_outputs += 1
                total_usage = getattr(error, "total_usage", 0)
                if isinstance(total_usage, (int, float)):
                    actual_total_tokens += int(total_usage)
            confidence_value = value.pop("confidence", None)
            usage = getattr(raw_response, "usage", None)
            if usage is not None:
                input_value = int(getattr(usage, "prompt_tokens", 0) or 0)
                output_value = int(getattr(usage, "completion_tokens", 0) or 0)
                total_value = int(getattr(usage, "total_tokens", input_value + output_value) or input_value + output_value)
                actual_input_tokens += input_value; actual_output_tokens += output_value; actual_total_tokens += total_value
            return value, confidence_value

        duration_is_long = media.info.duration_ms >= 1_800_000
        candidate_windows = _time_token_chunks(selected_transcript, self.window_tokens) if duration_is_long else _chunk_rows(selected_transcript, self.window_tokens)
        segment_limit = 12
        windows = _merge_chunks(candidate_windows, segment_limit) if duration_is_long else candidate_windows
        segmented = duration_is_long and len(windows) > 1 and effective_output_tokens >= 1_600
        partial_output_tokens = (
            min(600, max(400, (effective_output_tokens - 4_800) // max(1, len(windows))))
            if segmented and profile == "max"
            else min(350, max(220, (effective_output_tokens - 1_200) // max(1, len(windows))))
            if segmented
            else 0
        )
        final_output_tokens = effective_output_tokens - partial_output_tokens * len(windows) if segmented else effective_output_tokens
        partial_output_budget = partial_output_tokens * len(windows)
        final_passes = 2
        analysis_passes = (len(windows) if segmented else 0) + final_passes

        final_payload: dict[str, Any]
        if segmented:
            segment_reports: list[dict[str, Any]] = []
            for index, window in enumerate(windows):
                first_evidence_ms = int(window[0].get("start_ms") or 0)
                last_evidence_ms = max(int(row.get("start_ms") or 0) for row in window)
                start_ms = first_evidence_ms // 600_000 * 600_000
                end_ms = min(media.info.duration_ms, (last_evidence_ms // 600_000 + 1) * 600_000)
                window_visuals = [row for row in selected_visuals if start_ms <= int(row.get("start_ms") or 0) < end_ms]
                partial_report, _partial_confidence = request_report(
                    {
                        "task": "分析长视频的一个时间段，结论仅限本段",
                        "video_id": job.video_id,
                        "segment": {"index": index + 1, "count": len(windows), "start_ms": start_ms, "end_ms": end_ms},
                        "transcript_window": window,
                        "visual_evidence": window_visuals,
                    },
                    partial_output_tokens,
                    compact=True,
                )
                allowed_partial_evidence = {str(row.get("text") or "") for row in window + window_visuals}
                partial_report["evidence"] = [row for row in partial_report.get("evidence", []) if isinstance(row, dict) and row.get("text") in allowed_partial_evidence]
                segment_reports.append({"start_ms": start_ms, "end_ms": end_ms, "report": partial_report})
            final_payload = {
                "task": "将按时间顺序排列的分段报告汇总为一份完整视频报告",
                "video_id": job.video_id,
                "duration_ms": media.info.duration_ms,
                "segment_reports": segment_reports,
            }
        else:
            final_payload = {
                "video_id": job.video_id,
                "duration_ms": media.info.duration_ms,
                "transcript_windows": windows,
                "visual_evidence": selected_visuals,
                "input_budget": {
                    "estimated_source_tokens": original_tokens,
                    "maximum_source_tokens": effective_source_tokens,
                },
            }

        if profile == "max":
            core_output_tokens = min(request_output_cap, final_output_tokens // 2)
            insight_output_tokens = min(request_output_cap, final_output_tokens - core_output_tokens)
            core_report, core_confidence = request_report(
                final_payload,
                core_output_tokens,
                synthesis=segmented,
                section="core",
            )
            insight_report, insight_confidence = request_report(
                final_payload,
                insight_output_tokens,
                synthesis=segmented,
                section="insights",
            )
            combined_evidence = [
                *core_report.pop("evidence", []),
                *insight_report.pop("evidence", []),
            ]
            report = {**core_report, **insight_report, "evidence": combined_evidence}
            confidence_values = [
                value for value in (_confidence(core_confidence), _confidence(insight_confidence)) if value is not None
            ]
            confidence = round(sum(confidence_values) / len(confidence_values)) if confidence_values else None
        else:
            report, confidence = request_report(
                final_payload,
                final_output_tokens,
                synthesis=segmented,
            )
        _build_spoken_script_set(report, raw_transcript_rows)
        available_evidence = selected_transcript + selected_visuals
        report["evidence"], evidence_aliases, evidence_repair = _repair_report_evidence(
            report.get("evidence"),
            available_evidence,
        )
        if not report["evidence"]:
            raise RuntimeError("analysis source did not contain usable transcript or OCR evidence")
        report["insight_evidence"] = _repair_insight_evidence(
            report.get("insight_evidence"),
            report,
            report["evidence"],
            evidence_aliases,
        )
        repeated_source_passes = 1 if segmented else final_passes
        synthesis_payload_passes = final_passes if segmented else 0
        estimated_model_input_tokens = (
            selected_tokens * repeated_source_passes
            + analysis_passes * 1_200
            + partial_output_budget * synthesis_payload_passes
        )
        maximum_model_input_tokens = (
            effective_source_tokens * repeated_source_passes
            + analysis_passes * 1_200
            + partial_output_budget * synthesis_payload_passes
        )
        specialist_sections = (
            "hook_analysis", "viral_points", "rhythm_analysis", "emotion_curve", "conversion_design",
            "risks", "recommendations",
        )
        coverage_percent = 100 if original_tokens == 0 else min(100, round(selected_tokens / original_tokens * 100))
        report["analysis_meta"] = {
            "contract_version": "analysis.v6",
            "mode": "full" if selected_tokens >= original_tokens else "budgeted",
            "processing_mode": "segmented" if segmented else "single_pass",
            "estimated_source_tokens": original_tokens,
            "estimated_model_input_tokens": estimated_model_input_tokens,
            "maximum_source_tokens": effective_source_tokens,
            "maximum_output_tokens": effective_output_tokens,
            "maximum_model_input_tokens": maximum_model_input_tokens,
            "maximum_total_tokens": maximum_model_input_tokens + effective_output_tokens,
            "analysis_profile": profile,
            "source_segments": len(raw_transcript_rows),
            "analyzed_segments": len(selected_transcript),
            "deduplicated_segments": len(transcript_rows),
            "chunk_count": len(windows),
            "segment_analysis_count": len(windows) if segmented else 0,
            "analysis_passes": analysis_passes,
            "coverage_percent": coverage_percent,
            "duration_minutes": round(media.info.duration_ms / 60_000, 1),
            "generation_strategy": "dual_pass_full",
            "report_depth": {
                "summary_characters": len(str(report.get("summary") or "")),
                "spoken_script_paragraphs": len(report.get("spoken_script") or []),
                "specialist_items": sum(len(report.get(section) or []) for section in specialist_sections),
                "evidence_items": len(report.get("evidence") or []),
            },
            "evidence_repair": evidence_repair,
            "recovered_json_outputs": recovered_json_outputs,
            "visual_extraction": dict(visuals.stats),
        }
        quality_audit = _assess_report_quality(
            report,
            profile=profile,
            available_evidence_count=len(available_evidence),
            source_characters=sum(len(str(row.get("text") or "")) for row in available_evidence),
            coverage_percent=coverage_percent,
            recovered_json_outputs=recovered_json_outputs,
            evidence_repair=evidence_repair,
            visual_stats=visuals.stats,
            has_video=bool(media.info.video_codec),
        )
        report["analysis_meta"]["quality_audit"] = quality_audit
        if actual_total_tokens > 0:
            report["analysis_meta"].update({
                "actual_input_tokens": actual_input_tokens,
                "actual_output_tokens": actual_output_tokens,
                "actual_total_tokens": actual_total_tokens,
            })
        final_confidence = _confidence(confidence)
        if quality_audit["requires_review"]:
            final_confidence = min(final_confidence if final_confidence is not None else 100, int(quality_audit["score"]))
        return StructureOutput(
            "analysis.v6",
            report,
            final_confidence,
            self.provider,
            self.model,
            self.prompt_version,
        )
