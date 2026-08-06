from __future__ import annotations

from pathlib import Path
from typing import Protocol

from .adapters import Keyframe, NormalizedMedia, VisualObservation, VisualOutput
from .evidence import deduplicate_timed_rows, is_useful_ocr
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
        keyframes: list[Keyframe] = []; observations: list[dict[str, object]] = []; hashes: list[int] = []
        for frame in self.extractor.extract(media, output_dir / "keyframes"):
            signature = self._image_signature(frame.path)
            if signature is not None:
                image_hash, contrast = signature
                if contrast < 4.0 or any((image_hash ^ previous).bit_count() <= 5 for previous in hashes):
                    continue
                hashes.append(image_hash)
            text, confidence = self.ocr.recognize(frame.path); clean_text = text.strip()
            useful_text = clean_text if is_useful_ocr(clean_text, confidence) else ""
            keyframes.append(Keyframe(frame.timestamp_ms, frame.path, useful_text or None, confidence if useful_text else None))
            if useful_text:
                observations.append({"kind": "ocr", "start_ms": frame.timestamp_ms, "end_ms": frame.timestamp_ms, "text": useful_text, "confidence": confidence})
        unique_observations = deduplicate_timed_rows(observations, max_gap_ms=120_000, threshold=0.9)
        return VisualOutput(
            tuple(keyframes),
            tuple(VisualObservation(str(row["kind"]), int(row["start_ms"]), int(row["end_ms"]), str(row["text"]), int(row["confidence"]) if row.get("confidence") is not None else None) for row in unique_observations),
        )

    @staticmethod
    def _image_signature(path: Path) -> tuple[int, float] | None:
        try:
            from PIL import Image, ImageStat

            with Image.open(path) as image:
                source_grayscale = image.convert("L")
                grayscale = source_grayscale.resize((8, 8))
                pixels = list(grayscale.getdata())
                average = sum(pixels) / len(pixels)
                image_hash = sum(1 << index for index, value in enumerate(pixels) if value >= average)
                contrast = float(ImageStat.Stat(source_grayscale).stddev[0])
                return image_hash, contrast
        except (OSError, ValueError):
            return None
