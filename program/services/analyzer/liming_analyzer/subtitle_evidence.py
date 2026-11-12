"""Recover words from a time-aligned, independently verified burned-in caption track."""
from __future__ import annotations

import math
import re
import tempfile
import unicodedata
from bisect import bisect_left, bisect_right
from dataclasses import dataclass, replace
from difflib import SequenceMatcher
from functools import lru_cache
from importlib.util import find_spec
from pathlib import Path
from statistics import median

from .adapters import TranscriptOutput
from .visual import OcrEngine


@dataclass(frozen=True)
class SubtitleRecovery:
    transcript: TranscriptOutput
    evidence: dict[str, dict]


@dataclass(frozen=True)
class Caption:
    time: int
    text: str
    y: float
    confidence: int


def _key(text):
    return "".join(c.casefold() for c in unicodedata.normalize("NFKC", text) if c.isalnum())


def _ratio(left, right):
    return SequenceMatcher(None, left, right, autojunk=False).ratio()


def _samples(segment):
    duration = segment.end_ms - segment.start_ms
    count = min(80, max(2, math.ceil(duration / 360)))
    return sorted({segment.start_ms + int((i + 0.5) * duration / count) for i in range(count)})


def _read_lines(frame, timestamp, color, path, ocr):
    import cv2
    import numpy as np

    height, width = frame.shape[:2]
    top = int(height * .73)
    strip = frame[top:, :]
    scale = min(1, 1000 / width)
    if color:
        # Karaoke emphasis can split one caption into multiple coloured runs.
        # Map all saturated glyphs to one ink colour before line detection.
        hsv = cv2.cvtColor(strip, cv2.COLOR_BGR2HSV)
        strip = 255 - cv2.inRange(hsv, np.array([0, 115, 85]), np.array([180, 255, 255]))
    strip = cv2.resize(strip, None, fx=scale, fy=scale, interpolation=cv2.INTER_AREA)
    if not cv2.imwrite(str(path), strip):
        return []
    try:
        ocr.recognize(path)
    except (OSError, RuntimeError, ValueError):
        return []
    lines = []
    for row in getattr(ocr, "last_regions", None) or ():
        poly = row["polygon"]
        xs = [pt[0] / scale / width for pt in poly]
        ys = [(top + pt[1] / scale) / height for pt in poly]
        x = (min(xs) + max(xs)) / 2
        y = (min(ys) + max(ys)) / 2
        h = max(ys) - min(ys)
        text = row["text"].strip()
        confidence = row.get("confidence") or 0
        if (.425 <= x <= .575 and .76 <= y <= .985 and .025 <= h <= .14 and confidence >= 72
                and 2 <= len(_key(text)) <= 75 and re.search(r"[\u3400-\u9fff]", text)):
            lines.append(Caption(timestamp, text, y, confidence))
    return lines


def _choose_track(probes):
    # The pilot spans the entire timeline. A static label, intermittent cutaway,
    # or a second screen of unrelated captions must not nominate a caption lane.
    best = None
    for color, samples in probes.items():
        all_y = [line.y for _idx, _source, lines in samples for line in lines]
        for y in sorted({round(item, 2) for item in all_y}):
            anchors = []
            for idx, source, lines in samples:
                source = _key(source)
                matches = [r for r in lines if abs(r.y - y) < .027 and len(_key(r.text)) >= 4
                           and (_key(r.text) in source or _ratio(source, _key(r.text)) >= .73)]
                if matches:
                    anchors.append((idx, max(matches, key=lambda r: r.confidence)))
            ids = {idx for idx, _r in anchors}
            unique = {_key(r.text) for _idx, r in anchors}
            if len(ids) < max(3, math.ceil(len(samples) * .45)) or len(unique) < 3:
                continue
            if max(ids) - min(ids) < (len(samples) - 1) * .55:
                continue
            value = (len(ids), len(unique), color)
            if best is None or value > best[0]:
                best = (value, color, median(r.y for _idx, r in anchors))
    return best[1:] if best else None


@lru_cache(maxsize=1)
def _words():
    # The media extra already ships the jieba lexicon with FunASR. Keep the
    # strict homophone route available when running a smaller installation.
    spec = find_spec("jieba")
    if not spec or not spec.origin:
        return frozenset()
    path = Path(spec.origin).with_name("dict.txt")
    try:
        with path.open(encoding="utf-8") as stream:
            return frozenset(line.split(" ", 1)[0] for line in stream)
    except OSError:
        return frozenset()


@lru_cache(maxsize=4096)
def _pinyin(text):
    from pypinyin import lazy_pinyin
    return tuple(lazy_pinyin(text))


def _edits_supported(left, right, *, audio_confirmed=False):
    protected = r"[a-z0-9]+|[零一二三四五六七八九十百千万亿两]+"
    if re.findall(protected, left) != re.findall(protected, right):
        return False
    for op, a, b, c, d in SequenceMatcher(None, left, right, autojunk=False).get_opcodes():
        if op == "equal":
            continue
        # Captions may abbreviate, censor, or paraphrase real speech. Do not
        # adopt standalone insertions/deletions or novel nonhomophonic words.
        before, after = left[a:b], right[c:d]
        if not before or not after:
            return False
        if len(before) == len(after) == 1:
            # A misspelled burned-in idiom can recur across every frame.
            # Preserve the recognized expression when the subtitle swaps one
            # glyph to an unattested spelling and all its neighbours match.
            lexicon = _words()
            for length in range(4, 7):
                for first in range(max(0, b - length), min(a, len(left) - length) + 1):
                    word = left[first:first + length]
                    replacement = left[first:a] + after + left[b:first + length]
                    target_start = c - (a - first)
                    if (word in lexicon and replacement not in lexicon and target_start >= 0
                            and right[target_start:target_start + length] == replacement):
                        return False
            from .canonical_review import _near_syllables, _syllables
            # Preserve the vowel and final consonant while allowing retroflex
            # Mandarin initials and polyphonic readings (e.g. "chong" in 去重).
            def initial(sound):
                return re.sub(r"^([zcs])h", r"\1", sound)
            if {initial(s) for s in _syllables(before)} & {initial(s) for s in _syllables(after)}:
                continue
            if audio_confirmed and any(_near_syllables(a, b) for a in _syllables(before) for b in _syllables(after)):
                continue
        source_sounds, caption_sounds = _pinyin(before), _pinyin(after)
        matching_sounds = {pos for block in SequenceMatcher(None, source_sounds, caption_sounds, autojunk=False).get_matching_blocks()
                           for pos in range(block.b, block.b + block.size)}
        if len(matching_sounds) == len(after) or len(matching_sounds) >= max(3, len(after) - 1):
            continue
        lexicon = _words()
        if not lexicon:
            return False
        for index in range(c, d):
            if index - c in matching_sounds:
                continue
            if not any(right[start:end] in lexicon for start in range(max(0, index-3), index+1)
                       for end in range(max(index+1, start+2), min(len(right), start+4)+1)):
                return False
    return True


def _fit(source, text):
    """Score wording against the closest part of this same utterance."""
    if text in source or source in text:
        return 1.0
    if len(source) <= len(text):
        return _ratio(source, text)
    return max(_ratio(source[i:i+len(text)], text) for i in range(len(source)-len(text)+1))


def _stable_lines(source, lines, y):
    groups = []
    for row in sorted(lines, key=lambda r: r.time):
        key = _key(row.text)
        if (abs(row.y - y) > .027 or not key or _fit(source, key) < .30 or
                any(token not in source for token in re.findall(r"[a-z0-9]+", key))):
            continue
        matches = [group for group in reversed(groups)
                   if 0 <= row.time - group[-1].time < 850 and _ratio(_key(group[-1].text), key) >= .72]
        if matches:
            matches[0].append(row)
        else:
            groups.append([row])
    result = []
    for group in groups:
        times = {r.time for r in group}
        if not times or max(r.confidence for r in group) < 86:
            continue
        # A single OCR image may corroborate speech already present in ASR.
        # It cannot introduce a correction.
        if len(times) < 2 or max(times) - min(times) < 90:
            exact = next((r for r in group if len(_key(r.text)) >= 2 and _key(r.text) in source), None)
            if exact:
                result.append((_key(exact.text), [exact]))
            continue
        counts = {k: len({r.time for r in group if _key(r.text) == k}) for k in {_key(r.text) for r in group}}
        # Prefer the captured spelling closest to speech. Other captures must
        # corroborate any newly introduced glyph even when they miss other glyphs.
        choices = []
        for row in group:
            key = _key(row.text)
            if any(len(other) >= len(key) + 3 and count >= 2 and _fit(other, key) >= .88 for other, count in counts.items()):
                continue
            changes = [key[b:d] for op, _a, _c, b, d in
                       SequenceMatcher(None, source, key, autojunk=False).get_opcodes() if op != "equal" and b < d]
            if all(len({r.time for r in group if change in _key(r.text)}) >= 2 for change in changes):
                choices.append((_fit(source, key), counts[key], row.confidence, key))
        if choices:
            result.append((max(choices)[-1], group))
    return result


def _readable_edit(source, target):
    # Keep source punctuation and spacing away from the particular changes.
    positions = [i for i, char in enumerate(source) for _ in _key(char)]
    if len(positions) != len(_key(source)):
        return source
    chars = list(source)
    ops = SequenceMatcher(None, _key(source), target, autojunk=False).get_opcodes()
    for op, start, end, new_start, new_end in reversed(ops):
        if op == "insert" and start == len(positions):
            chars.append(target[new_start:new_end])
        elif op != "equal":
            chars[positions[start]:positions[end-1]+1] = target[new_start:new_end]
    return "".join(chars)


def _segment_caption(source, lines, y, provenance=None, *, clip_end_ms=None, timing_text=""):
    original = _key(source)
    stable = _stable_lines(original, lines, y)
    best = None
    for start in range(len(stable)):
        for stop in range(start + 1, min(start + 8, len(stable)) + 1):
            run = stable[start:stop]
            key = "".join(word for word, _rows in run)
            if not key:
                continue
            candidates = [key]
            # ASR and authored captions may break at different words. Only use
            # a substring when both its edges have same-utterance anchors.
            if len(original) == 4 and len(key) > 4:
                # Four-character clauses often straddle an ASR boundary. Keep
                # this narrow exception to the edge of a repeated caption and
                # require a single homophone plus three literal characters.
                for part in (key[:4], key[-4:]):
                    if sum(a == b for a, b in zip(part, original, strict=True)) == 3 and _pinyin(part) == _pinyin(original):
                        candidates.append(part)
            if len(key) > len(original) and len(original) >= 5:
                for offset in range(len(key) - len(original) + 1):
                    sub = key[offset:offset + len(original)]
                    if (sub[:2] == original[:2] and sub[-2:] == original[-2:]
                            or sub[:3] == original[:3] and sub[-1:] == original[-1:]
                            or sub[-3:] == original[-3:] and sub[:1] == original[:1]):
                        candidates.append(sub)
            if 6 <= len(key) < len(original) and len(key) >= .60 * len(original):
                for offset in range(len(original) - len(key) + 1):
                    sub = original[offset:offset + len(key)]
                    anchored = (sub[:2] == key[:2] and sub[-2:] == key[-2:]
                                or offset > 0 and sub[-5:] == key[-5:] and len(sub) >= 8
                                or offset + len(sub) < len(original) and sub[:5] == key[:5] and len(sub) >= 8)
                    if anchored and _ratio(sub, key) >= .70:
                        candidates.append(original[:offset] + key + original[offset+len(key):])
            for target in candidates:
                agreement = _ratio(original, target)
                if not .86 <= len(target) / max(1, len(original)) <= 1.14:
                    continue
                if agreement < .63:
                    # A short standalone ASR utterance has fewer lexical anchors
                    # than a merged ASR sentence. Require the whole caption to be
                    # seen three times and corroborated by its spoken syllables.
                    exact_times = {r.time for _, captures in run for r in captures
                                   if _key(r.text) == target and r.confidence >= 92}
                    if (target != key or len(exact_times) < 3 or max(exact_times) - min(exact_times) < 450
                            or len(original) < 7 or original[:3] != target[:3] or original[-1] != target[-1]
                            or _ratio(_pinyin(original), _pinyin(target)) < .68):
                        continue
                verified_tail = False
                audio_confirmed = False
                if (target != original and target == timing_text == key and len(run) == 1
                        and len(original) == len(target) >= 6
                        and sum(a != b for a, b in zip(original, target, strict=True)) == 1):
                    frames = {r.time for r in run[0][1] if _key(r.text) == target and r.confidence >= 90}
                    audio_confirmed = len(frames) >= 2 and max(frames) - min(frames) >= 120
                if target != original and not _edits_supported(original, target, audio_confirmed=audio_confirmed):
                    # A cut at the end of the original recording can truncate
                    # the last word of the ASR output. Require the same complete
                    # word in the final caption on distinct frames, its prefix
                    # in speech, and the rest of the utterance unchanged.
                    tail_times = {r.time for _, captures in run for r in captures
                                  if _key(r.text) == target and r.confidence >= 94}
                    verified_tail = (clip_end_ms is not None and len(original) >= 8 and len(target) == len(original)+1
                            and target.startswith(original) and target[-2:] in _words()
                            and len(tail_times) >= 2 and max(tail_times)-min(tail_times) >= 200
                            and 0 <= clip_end_ms-max(tail_times) < 500)
                    if not verified_tail:
                        continue
                score = (verified_tail, agreement, -abs(len(original)-len(target)), min(len(key), len(original)))
                if best is None or score > best[0]:
                    times = sorted({r.time for _word, rows in run for r in rows})
                    best = (score, _readable_edit(source, target) if original != target else source, times)
                    if provenance is not None:
                        provenance.update(
                            timing_asr_confirmed=audio_confirmed,
                            full_caption_match=(target == key),
                            captions=[{"text": word, "timestamps_ms": sorted({r.time for r in captures if _key(r.text) == word})}
                                      for word, captures in run],
                        )
    return best[1:] if best else None


def recover_burned_subtitles(video_path: Path, transcript: TranscriptOutput, *, ocr: OcrEngine,
                             timing_transcript: TranscriptOutput | None = None) -> SubtitleRecovery:
    """Keep ASR when the video has no consistent, speech-aligned caption track."""
    unchanged = SubtitleRecovery(transcript, {})
    try:
        import cv2
    except ImportError:
        return unchanged
    segments = transcript.segments
    if len(segments) < 3 or not transcript.language.lower().startswith(("zh", "chinese", "cmn")):
        return unchanged
    cap = cv2.VideoCapture(str(video_path))
    changes = list(segments)
    evidence = {}
    anchors = sorted(timing_transcript.segments, key=lambda r: r.start_ms) if timing_transcript else []
    anchor_starts = [r.start_ms for r in anchors]
    try:
        if not cap.isOpened():
            return unchanged
        with tempfile.TemporaryDirectory(prefix="liming-caption-") as temp:
            path = Path(temp) / "caption.png"
            # Probe the colour-normalized pass first. On UI-heavy screencasts
            # this avoids a full-page OCR pass on every video frame.
            count = min(12, len(segments))
            indexes = [round(i * (len(segments) - 1) / (count - 1)) for i in range(count)]
            track = None
            cache = {}
            for color in (True, False):
                probes = []
                for pos, idx in enumerate(indexes):
                    source = segments[idx]
                    times = _samples(source)
                    t = times[len(times) // 2]
                    cap.set(cv2.CAP_PROP_POS_MSEC, t)
                    ok, frame = cap.read()
                    lines = _read_lines(frame, t, color, path, ocr) if ok else []
                    cache[(t, color)] = lines
                    probes.append((pos, source.text, lines))
                track = _choose_track({color: probes})
                if track:
                    break
            if not track:
                return unchanged
            color, y = track
            fps = cap.get(cv2.CAP_PROP_FPS)
            clip_end = cap.get(cv2.CAP_PROP_FRAME_COUNT) * 1000 / fps if fps > 0 else None
            for idx, source in enumerate(segments):
                rows = []
                for t in _samples(source):
                    if (t, color) in cache:
                        rows.extend(cache[t, color])
                        continue
                    cap.set(cv2.CAP_PROP_POS_MSEC, t)
                    ok, frame = cap.read()
                    if ok:
                        rows.extend(_read_lines(frame, t, color, path, ocr))
                details = {}
                # Only an independently decoded cue at the same source interval can
                # support a near-sound correction; an adjacent speaker's words cannot.
                start = bisect_left(anchor_starts, source.start_ms - 200)
                stop = bisect_right(anchor_starts, source.start_ms + 200)
                matching = [r for r in anchors[start:stop] if abs(source.end_ms - r.end_ms) <= 200
                            and min(source.end_ms, r.end_ms) - max(source.start_ms, r.start_ms)
                            >= .8 * max(source.end_ms - source.start_ms, r.end_ms - r.start_ms)]
                match = _segment_caption(source.text, rows, y, details,
                                         clip_end_ms=clip_end if idx == len(segments)-1 else None,
                                         timing_text=_key(matching[0].text) if len(matching) == 1 else "")
                if not match:
                    continue
                candidate, times = match
                text = source.text if _key(candidate) == _key(source.text) else candidate
                changes[idx] = replace(source, text=text)
                evidence[f"transcript:{idx + 1:04d}"] = {"method": "burned_subtitle", "source_text": source.text,
                                                         "text": text, "timestamps_ms": times, **details}
    finally:
        cap.release()
    return SubtitleRecovery(replace(transcript, segments=tuple(changes)), evidence) if evidence else unchanged
