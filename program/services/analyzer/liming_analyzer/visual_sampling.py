"""Bound total sampled images independently of report budgets and vision adapters."""
from __future__ import annotations

from typing import Any


def normalize_visual_sampling_level(value: Any = None) -> str | None:
    # None denotes the pre-level sampling policy for historical jobs/checkpoints.
    if value is None:
        return None
    if value not in ("quick", "balanced", "detailed"):
        raise ValueError("visual_sampling_level must be quick, balanced or detailed")
    return value


def job_visual_sampling_level(job: Any) -> str | None:
    return normalize_visual_sampling_level(job.source.get("visual_sampling_level"))


def visual_sampling_budget(duration_seconds: float, level: str) -> dict[str, int]:
    level = normalize_visual_sampling_level(level)
    if level is None:
        raise ValueError("historical sampling has no new level budget")
    duration = max(0, duration_seconds)
    short_min, short_max, long_max = {
        "quick": (20, 44, 64), "balanced": (32, 80, 120), "detailed": (48, 144, 180),
    }[level]
    if duration <= 600:
        total = round(short_min + (short_max - short_min) * duration / 600)
    else:
        total = round(short_max + (long_max - short_max) * min(1, (duration - 600) / 1200))
    windows = 1 if level == "quick" else 2
    # Opening/first/ending and dense cut frames count *inside* the total cap.
    representative = total - 7 - windows * 6
    return {"total_frame_limit": total, "temporal_window_limit": windows,
            "representative_frame_limit": representative,
            "target_count": max(3, round(representative * .65))}
