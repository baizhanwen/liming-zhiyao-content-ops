"""Build ASR cues from verified word timestamps, never punctuation-array indexes."""
from __future__ import annotations

import math
import re
from collections.abc import Mapping
from typing import Any

from .adapters import TranscriptSegment


def _surface_units(text: str, words: list[str]) -> list[str] | None:
    """Keep punctuation/casing only when every spoken token is accounted for."""
    units: list[str] = []
    cursor = 0
    for word in words:
        match = re.compile(re.escape(word), re.IGNORECASE).search(text, cursor)
        if match is None or any(char.isalnum() for char in text[cursor:match.start()]):
            return None
        if units:
            units[-1] += text[cursor:match.start()]
        units.append(text[match.start():match.end()])
        cursor = match.end()
    if any(char.isalnum() for char in text[cursor:]):
        return None
    if units:
        units[-1] += text[cursor:]
    return units


def aligned_asr_segments(payload: Mapping[str, Any]) -> list[TranscriptSegment] | None:
    """Require a one-to-one lexical/timestamp mapping before rebuilding cues.

    Paraformer returns space-delimited raw tokens, including whole English words.
    Its punctuation tokenizer can use a different token count (especially around
    English/numbers). Using sentence_info in that case gradually shifts the text
    and can produce punctuation-only cues. Raw token timestamps remain usable.
    """
    words = payload.get("words")
    if not isinstance(words, list) or not words or not all(isinstance(word, str) and word for word in words):
        raw = payload.get("raw_text")
        words = raw.split() if isinstance(raw, str) else []
    stamps = payload.get("timestamp")
    if not words or not isinstance(stamps, (list, tuple)) or len(words) != len(stamps):
        return None
    times: list[tuple[int, int]] = []
    for stamp in stamps:
        if not isinstance(stamp, (list, tuple)) or len(stamp) != 2:
            return None
        if any(isinstance(value, bool) or not isinstance(value, (float, int)) or not math.isfinite(value) for value in stamp):
            return None
        start, end = (round(value) for value in stamp)
        if start < 0 or end < start or (times and start < times[-1][0]):
            return None
        times.append((start, end))
    surface = payload.get("text")
    units = _surface_units(surface, words) if isinstance(surface, str) else None
    if units is None:
        # Punctuation may change or omit words. Keep the recognizer's actual
        # tokens, with their actual timestamps, instead of guessing alignment.
        units = [word + (" " if index + 1 < len(words) and word[-1].isascii() and words[index + 1][0].isascii() else "") for index, word in enumerate(words)]
    segments: list[TranscriptSegment] = []
    first = 0
    text = ""
    for index, (unit, (start, end)) in enumerate(zip(units, times)):
        if text and start - times[index - 1][1] >= 800:
            segments.append(TranscriptSegment(times[first][0], times[index - 1][1], text.strip()))
            first, text = index, ""
        text += unit
        if re.search(r"[，。！？；,!?;]\s*$", unit) or end - times[first][0] >= 12_000 or len(text) >= 80:
            if any(char.isalnum() for char in text):
                segments.append(TranscriptSegment(times[first][0], end, text.strip()))
            first, text = index + 1, ""
    if text.strip() and any(char.isalnum() for char in text):
        segments.append(TranscriptSegment(times[first][0], times[-1][1], text.strip()))
    return segments or None
