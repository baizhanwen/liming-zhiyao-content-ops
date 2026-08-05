from __future__ import annotations

from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Callable, Mapping, Protocol, Sequence

from .api_client import AnalysisResult, ClaimedJob


@dataclass(frozen=True)
class MediaInfo:
    duration_ms: int
    width: int | None
    height: int | None
    video_codec: str | None
    audio_codec: str | None


@dataclass(frozen=True)
class NormalizedMedia:
    source_path: Path
    audio_path: Path | None
    info: MediaInfo


@dataclass(frozen=True)
class TranscriptSegment:
    start_ms: int
    end_ms: int
    text: str
    confidence: int | None = None

    def __post_init__(self) -> None:
        if self.start_ms < 0 or self.end_ms < self.start_ms or not self.text.strip():
            raise ValueError("invalid transcript segment")


@dataclass(frozen=True)
class TranscriptOutput:
    language: str
    segments: Sequence[TranscriptSegment]
    confidence: int | None = None

    @property
    def full_text(self) -> str:
        return "\n".join(segment.text.strip() for segment in self.segments)


@dataclass(frozen=True)
class Keyframe:
    timestamp_ms: int
    path: Path
    ocr_text: str | None = None
    confidence: int | None = None


@dataclass(frozen=True)
class VisualObservation:
    kind: str
    start_ms: int
    end_ms: int
    text: str
    confidence: int | None = None


@dataclass(frozen=True)
class VisualOutput:
    keyframes: Sequence[Keyframe] = field(default_factory=tuple)
    observations: Sequence[VisualObservation] = field(default_factory=tuple)


@dataclass(frozen=True)
class StructureOutput:
    schema_version: str
    report: Mapping[str, Any]
    confidence: int | None = None
    model_provider: str | None = None
    model_name: str | None = None
    prompt_version: str | None = None


class SourceProvider(Protocol):
    def acquire(self, job: ClaimedJob, destination: Path) -> Path: ...


class MediaProcessor(Protocol):
    def prepare(self, source: Path, output_dir: Path) -> NormalizedMedia: ...


class SpeechRecognizer(Protocol):
    def transcribe(self, audio: Path) -> TranscriptOutput: ...


class VisualAnalyzer(Protocol):
    def analyze(self, media: NormalizedMedia, output_dir: Path) -> VisualOutput: ...


class StructureAnalyzer(Protocol):
    def analyze(self, job: ClaimedJob, media: NormalizedMedia, transcript: TranscriptOutput, visuals: VisualOutput) -> StructureOutput: ...


Heartbeat = Callable[[str, int, str], ClaimedJob]


def build_analysis_result(transcript: TranscriptOutput, structure: StructureOutput) -> AnalysisResult:
    from .api_client import TranscriptResult

    segments = [
        {"start_ms": item.start_ms, "end_ms": item.end_ms, "text": item.text, "confidence": item.confidence}
        for item in transcript.segments
    ]
    return AnalysisResult(
        schema_version=structure.schema_version,
        report=structure.report,
        confidence=structure.confidence,
        transcript=TranscriptResult(transcript.language, transcript.full_text, segments, transcript.confidence),
        model_provider=structure.model_provider,
        model_name=structure.model_name,
        prompt_version=structure.prompt_version,
    )
