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
        keyframes: list[Keyframe] = []; observations: list[dict[str, object]] = []; accepted_signatures: list[tuple[int, int]] = []
        candidates = self.extractor.extract(media, output_dir / "keyframes")
        low_contrast_removed = 0; similar_removed = 0
        duration_ms = max(0, media.info.duration_ms)
        # Compare near-identical images only inside a genuinely local window.
        # A global comparison used to collapse long, steady videos to a few frames.
        local_similarity_window_ms = max(30_000, min(60_000, duration_ms // 20 if duration_ms else 45_000))
        for candidate_index, frame in enumerate(candidates):
            signature = self._image_signature(frame.path)
            if signature is not None:
                image_hash, contrast = signature
                is_boundary = candidate_index in {0, len(candidates) - 1}
                if contrast < 4.0 and not is_boundary:
                    low_contrast_removed += 1
                    continue
                if any(
                    abs(frame.timestamp_ms - previous_timestamp) <= local_similarity_window_ms
                    and (image_hash ^ previous_hash).bit_count() <= 5
                    for previous_timestamp, previous_hash in accepted_signatures
                ):
                    similar_removed += 1
                    continue
                accepted_signatures.append((frame.timestamp_ms, image_hash))
            text, confidence = self.ocr.recognize(frame.path); clean_text = text.strip()
            useful_text = clean_text if is_useful_ocr(clean_text, confidence) else ""
            keyframes.append(Keyframe(frame.timestamp_ms, frame.path, useful_text or None, confidence if useful_text else None))
            if useful_text:
                observations.append({"kind": "ocr", "start_ms": frame.timestamp_ms, "end_ms": frame.timestamp_ms, "text": useful_text, "confidence": confidence})
        unique_observations = deduplicate_timed_rows(observations, max_gap_ms=120_000, threshold=0.9)
        extractor_stats = getattr(self.extractor, "last_stats", {})
        stats = {
            **(dict(extractor_stats) if isinstance(extractor_stats, dict) else {}),
            "candidate_count": len(candidates),
            "low_contrast_removed": low_contrast_removed,
            "similar_removed": similar_removed,
            "kept_count": len(keyframes),
            "ocr_observation_count": len(unique_observations),
            "local_similarity_window_seconds": round(local_similarity_window_ms / 1000),
        }
        return VisualOutput(
            tuple(keyframes),
            tuple(VisualObservation(str(row["kind"]), int(row["start_ms"]), int(row["end_ms"]), str(row["text"]), int(row["confidence"]) if row.get("confidence") is not None else None) for row in unique_observations),
            stats,
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
