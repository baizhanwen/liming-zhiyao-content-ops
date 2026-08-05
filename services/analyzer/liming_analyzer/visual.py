from __future__ import annotations

from pathlib import Path
from typing import Protocol

from .adapters import Keyframe, NormalizedMedia, VisualObservation, VisualOutput
from .ffmpeg import FfmpegFrameExtractor


class OcrEngine(Protocol):
    def recognize(self, image: Path) -> tuple[str, int | None]: ...


class FrameExtractor(Protocol):
    def extract(self, media: NormalizedMedia, output_dir: Path) -> list[Keyframe]: ...


class KeyframeVisualAnalyzer:
    def __init__(self, extractor: FrameExtractor | FfmpegFrameExtractor, ocr: OcrEngine) -> None:
        self.extractor = extractor
        self.ocr = ocr

    def analyze(self, media: NormalizedMedia, output_dir: Path) -> VisualOutput:
        keyframes: list[Keyframe] = []; observations: list[VisualObservation] = []
        for frame in self.extractor.extract(media, output_dir / "keyframes"):
            text, confidence = self.ocr.recognize(frame.path); clean_text = text.strip()
            keyframes.append(Keyframe(frame.timestamp_ms, frame.path, clean_text or None, confidence))
            if clean_text:
                observations.append(VisualObservation("ocr", frame.timestamp_ms, frame.timestamp_ms, clean_text, confidence))
        return VisualOutput(tuple(keyframes), tuple(observations))
