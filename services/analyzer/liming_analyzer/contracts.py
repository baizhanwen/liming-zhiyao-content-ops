from __future__ import annotations

from dataclasses import dataclass
from enum import StrEnum


class AnalysisJobStatus(StrEnum):
    PENDING = "pending"
    QUEUED = "queued"
    DOWNLOADING = "downloading"
    PROCESSING = "processing"
    TRANSCRIBING = "transcribing"
    EXTRACTING = "extracting"
    ANALYZING = "analyzing"
    COMPLETED = "completed"
    FAILED = "failed"
    CANCELLED = "cancelled"


_TRANSITIONS: dict[AnalysisJobStatus, frozenset[AnalysisJobStatus]] = {
    AnalysisJobStatus.PENDING: frozenset({AnalysisJobStatus.QUEUED, AnalysisJobStatus.CANCELLED}),
    AnalysisJobStatus.QUEUED: frozenset({AnalysisJobStatus.DOWNLOADING, AnalysisJobStatus.PROCESSING, AnalysisJobStatus.FAILED, AnalysisJobStatus.CANCELLED}),
    AnalysisJobStatus.DOWNLOADING: frozenset({AnalysisJobStatus.PROCESSING, AnalysisJobStatus.FAILED, AnalysisJobStatus.CANCELLED}),
    AnalysisJobStatus.PROCESSING: frozenset({AnalysisJobStatus.TRANSCRIBING, AnalysisJobStatus.EXTRACTING, AnalysisJobStatus.FAILED, AnalysisJobStatus.CANCELLED}),
    AnalysisJobStatus.TRANSCRIBING: frozenset({AnalysisJobStatus.EXTRACTING, AnalysisJobStatus.ANALYZING, AnalysisJobStatus.FAILED, AnalysisJobStatus.CANCELLED}),
    AnalysisJobStatus.EXTRACTING: frozenset({AnalysisJobStatus.ANALYZING, AnalysisJobStatus.FAILED, AnalysisJobStatus.CANCELLED}),
    AnalysisJobStatus.ANALYZING: frozenset({AnalysisJobStatus.COMPLETED, AnalysisJobStatus.FAILED, AnalysisJobStatus.CANCELLED}),
    AnalysisJobStatus.COMPLETED: frozenset(),
    AnalysisJobStatus.FAILED: frozenset({AnalysisJobStatus.PENDING}),
    AnalysisJobStatus.CANCELLED: frozenset({AnalysisJobStatus.PENDING}),
}


def can_transition(current: AnalysisJobStatus, target: AnalysisJobStatus) -> bool:
    return target in _TRANSITIONS[current]


@dataclass(frozen=True)
class AnalysisJobUpdate:
    status: AnalysisJobStatus
    progress: int
    stage: str
    error_code: str | None = None
    error_message: str | None = None

    def __post_init__(self) -> None:
        if not 0 <= self.progress <= 100:
            raise ValueError("progress must be between 0 and 100")
        if not self.stage.strip():
            raise ValueError("stage is required")
        if self.status is AnalysisJobStatus.FAILED and not self.error_code:
            raise ValueError("failed jobs require an error_code")
        if self.status is not AnalysisJobStatus.FAILED and (self.error_code or self.error_message):
            raise ValueError("only failed jobs may carry errors")
