from __future__ import annotations

import unicodedata
from collections.abc import Mapping, Sequence
from dataclasses import replace
from difflib import SequenceMatcher
from typing import Any

from .adapters import TranscriptOutput, TranscriptSegment


def normalize_evidence_text(value: str) -> str:
    normalized = unicodedata.normalize("NFKC", value).casefold()
    return "".join(character for character in normalized if character.isalnum())


def is_near_duplicate(left: str, right: str, *, threshold: float = 0.92) -> bool:
    left_key = normalize_evidence_text(left)
    right_key = normalize_evidence_text(right)
    if not left_key or not right_key:
        return False
    if left_key == right_key:
        return True
    if min(len(left_key), len(right_key)) < 6:
        return False
    if left_key in right_key or right_key in left_key:
        return abs(len(left_key) - len(right_key)) <= 12
    if max(len(left_key), len(right_key)) > 40:
        return False
    return SequenceMatcher(None, left_key, right_key, autojunk=False).ratio() >= threshold


def deduplicate_timed_rows(
    rows: Sequence[Mapping[str, Any]],
    *,
    max_gap_ms: int,
    threshold: float = 0.92,
) -> list[dict[str, Any]]:
    unique: list[dict[str, Any]] = []
    for value in rows:
        row = dict(value)
        text = str(row.get("text") or "").strip()
        if not text:
            continue
        start_ms = int(row.get("start_ms") or 0)
        duplicate = False
        for previous in reversed(unique[-8:]):
            previous_start = int(previous.get("start_ms") or 0)
            if start_ms - previous_start > max_gap_ms:
                break
            if is_near_duplicate(text, str(previous.get("text") or ""), threshold=threshold):
                duplicate = True
                break
        if not duplicate:
            row["text"] = text
            unique.append(row)
    return unique


def clean_transcript(transcript: TranscriptOutput, *, max_gap_ms: int = 15_000) -> TranscriptOutput:
    unique: list[TranscriptSegment] = []
    for segment in transcript.segments:
        text = segment.text.strip()
        if not text:
            continue
        if unique and segment.start_ms - unique[-1].start_ms <= max_gap_ms and is_near_duplicate(text, unique[-1].text):
            previous = unique[-1]
            confidences = [value for value in (previous.confidence, segment.confidence) if value is not None]
            unique[-1] = replace(
                previous,
                end_ms=max(previous.end_ms, segment.end_ms),
                text=text if len(normalize_evidence_text(text)) > len(normalize_evidence_text(previous.text)) else previous.text,
                confidence=round(sum(confidences) / len(confidences)) if confidences else None,
            )
            continue
        unique.append(replace(segment, text=text))
    return TranscriptOutput(transcript.language, tuple(unique), transcript.confidence)


def is_useful_ocr(value: str, confidence: int | None, *, minimum_confidence: int = 45) -> bool:
    key = normalize_evidence_text(value)
    if len(key) < 2 or (confidence is not None and confidence < minimum_confidence):
        return False
    return not (len(key) >= 4 and len(set(key)) == 1)
