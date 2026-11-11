"""Reproducible content measurements. No acoustic or model-inferred measurements."""
from __future__ import annotations

import math
import unicodedata
from collections.abc import Mapping
from fractions import Fraction
from itertools import pairwise
from typing import Any

from .adapters import NormalizedMedia, TranscriptOutput, VisualOutput

VERSION = "content-metrics.v1"
CHARACTER_METHOD = "unicode_letters_numbers.v1"


def _ratio(value: str | None) -> Fraction | None:
    if not value or value in {"N/A", "0:1", "0/1"}:
        return None
    try:
        result = Fraction(value.replace(":", "/"))
        return result if result > 0 else None
    except (ValueError, ZeroDivisionError):
        return None


def _duration_bucket(milliseconds: int) -> str:
    for boundary, label in ((15_000, "under_15s"), (30_000, "15_to_under_30s"),
                            (60_000, "30_to_under_60s"), (180_000, "60_to_under_180s")):
        if milliseconds < boundary:
            return label
    return "180s_and_above"


def _characters(text: str) -> int:
    # Counts characters, not semantic information points or language-independent words.
    return sum(unicodedata.category(character)[0] in {"L", "N"} for character in text)


def build_content_metrics(
    media: NormalizedMedia, transcript: TranscriptOutput, visuals: VisualOutput,
) -> dict[str, Any]:
    info = media.info
    duration_ms = max(0, info.duration_ms)
    duration_seconds = duration_ms / 1000
    has_video = bool(info.video_codec)
    width, height = info.width, info.height
    rotation = info.rotation_degrees if math.isfinite(info.rotation_degrees) else 0.0
    sar = _ratio(info.sample_aspect_ratio)
    aspect = None
    aspect_reason = None
    if has_video and width and height and width > 0 and height > 0:
        # Missing SAR means square pixels; an explicitly invalid SAR is not silently trusted.
        if info.sample_aspect_ratio and sar is None and info.sample_aspect_ratio not in {"N/A", "0:1", "0/1"}:
            aspect_reason = "像素宽高比无效，未分类画幅。"
        else:
            aspect = Fraction(width, height) * (sar or Fraction(1))
            quarter_turns = round(rotation / 90)
            if abs(rotation - quarter_turns * 90) > 0.1:
                aspect = None
                aspect_reason = "非直角旋转，未将编码宽高冒充显示画幅。"
            elif quarter_turns % 2:
                aspect = 1 / aspect
    else:
        aspect_reason = "没有可用视频宽高。"
    aspect_category = None
    if aspect is not None:
        aspect_category = "other"
        for label, target in (("9:16", Fraction(9, 16)), ("16:9", Fraction(16, 9)),
                              ("1:1", Fraction(1)), ("3:4", Fraction(3, 4))):
            if abs(float(aspect / target) - 1) <= 0.01:
                aspect_category = label
                break

    stats = visuals.stats
    detection = stats.get("shot_detection")
    detection = detection if isinstance(detection, Mapping) else {}
    raw_boundaries = detection.get("boundaries_ms")
    boundaries: list[int] = []
    if isinstance(raw_boundaries, (list, tuple)) and duration_ms > 0:
        boundaries = sorted({0, duration_ms, *(
            round(value) for value in raw_boundaries
            if isinstance(value, (int, float)) and not isinstance(value, bool)
            and math.isfinite(value) and 0 <= value <= duration_ms
        )})
    detection_available = has_video and duration_ms > 0 and detection.get("status") == "measured" and bool(boundaries)
    shots = [
        {"start_ms": start, "end_ms": end, "duration_ms": end - start}
        for start, end in pairwise(boundaries) if end > start
    ] if detection_available else []
    cut_count = max(0, len(shots) - 1) if detection_available else None

    segment_metrics = []
    for index, segment in enumerate(transcript.segments, 1):
        count = _characters(segment.text)
        valid = 0 <= segment.start_ms < segment.end_ms <= duration_ms
        segment_metrics.append({
            "source_segment_id": f"transcript:{index:04d}",
            "start_ms": segment.start_ms, "end_ms": segment.end_ms,
            "character_count": count,
            "characters_per_second": round(count * 1000 / (segment.end_ms - segment.start_ms), 3) if valid else None,
            "status": "estimated" if valid else "unknown",
        })
    character_count = sum(row["character_count"] for row in segment_metrics)
    return {
        "version": VERSION,
        "media": {
            "status": "measured" if duration_ms > 0 else "unknown",
            "duration_ms": duration_ms, "duration_seconds": duration_seconds,
            "duration_bucket": _duration_bucket(duration_ms) if duration_ms > 0 else None,
            "encoded_width": width, "encoded_height": height,
            "rotation_degrees": rotation, "sample_aspect_ratio": info.sample_aspect_ratio,
            "display_aspect_ratio": f"{aspect.numerator}:{aspect.denominator}" if aspect is not None else None,
            "aspect_category": aspect_category, "aspect_status": "measured" if aspect is not None else "not_applicable" if not has_video else "unknown",
            "aspect_reason": aspect_reason,
        },
        "shot_detection": {
            "status": "measured" if detection_available else "not_applicable" if not has_video else "unknown",
            "method": detection.get("method", "ffmpeg_scene_score.v1"),
            "threshold": detection.get("threshold"),
            "boundaries_ms": boundaries if detection_available else [], "segments": shots,
            "detected_cut_count": cut_count, "detected_shot_count": len(shots) if detection_available else None,
            "mean_shot_seconds": round(duration_seconds / len(shots), 3) if shots else None,
            "cuts_per_minute": round(cut_count * 60 / duration_seconds, 3) if detection_available else None,
            "limitations": ["场景分数是检测代理指标，闪光、主体运动、渐变可能误检，低反差剪辑可能漏检；不等于人工确认的剪辑数。"],
        },
        "transcript_statistics": {
            "status": "estimated" if segment_metrics else "unavailable",
            "source": "uncorrected_transcript_after_overlap_dedup",
            "character_count": character_count if segment_metrics else None,
            "character_count_method": CHARACTER_METHOD,
            "characters_per_video_second": round(character_count / duration_seconds, 3) if segment_metrics and duration_ms > 0 else None,
            "segments": segment_metrics,
            "limitations": [
                "只计Unicode字母和数字，排除标点空白；不是语义信息点或跨语言统一词数。",
                "使用AI纠错前转写；识别错误和重叠识别去重会影响计数。",
                "全片值包含无口播时段，片段值依赖ASR时间戳，均不是声学发声速度；未计算静音或人声时长占比。",
            ],
        },
        "methodology": {
            "version": VERSION, "time_unit": "milliseconds",
            "aspect_category_relative_tolerance": 0.01,
            "character_count_method": CHARACTER_METHOD,
            "audio_analysis": "out_of_scope",
            "profile_invariant": True,
        },
    }
