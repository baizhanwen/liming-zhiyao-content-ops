"""Per-job visual evidence policy; missing historical values retain hybrid behavior."""
from __future__ import annotations

from typing import Any


def normalize_visual_analysis_mode(value: Any = None) -> str:
    if value is None:
        return "hybrid"
    if value not in ("hybrid", "vision_only"):
        raise ValueError("visual_analysis_mode must be hybrid or vision_only")
    return value


def job_visual_analysis_mode(job: Any) -> str:
    return normalize_visual_analysis_mode(job.source.get("visual_analysis_mode"))
