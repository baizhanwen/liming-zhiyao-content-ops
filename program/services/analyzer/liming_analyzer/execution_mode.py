"""Per-job scheduling only; historical jobs retain serial execution."""
from __future__ import annotations

from typing import Any


def normalize_execution_mode(value: Any = None) -> str:
    if value is None:
        return "serial"
    if value not in ("serial", "controlled_parallel"):
        raise ValueError("execution_mode must be serial or controlled_parallel")
    return value


def job_execution_mode(job: Any) -> str:
    return normalize_execution_mode(job.source.get("execution_mode"))
