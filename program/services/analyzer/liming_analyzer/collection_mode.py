"""Per-job collection selection without loading media or network dependencies."""
from __future__ import annotations

from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from .api_client import ClaimedJob


def job_collection_mode(job: ClaimedJob) -> str:
    if job.source_type == "upload":
        return "anonymous"
    value = job.source.get("collection_mode", "anonymous")
    if value not in ("anonymous", "cookie"):
        raise ValueError("collection_mode must be anonymous or cookie")
    return value
