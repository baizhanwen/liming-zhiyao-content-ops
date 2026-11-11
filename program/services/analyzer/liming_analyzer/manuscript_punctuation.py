"""Retain the recognizer's sentence punctuation after subtitle word corrections."""
from __future__ import annotations

import re
from dataclasses import replace
from difflib import SequenceMatcher

from .adapters import TranscriptOutput

# ASCII punctuation between ASCII word characters may be part of a version,
# URL, formatted number, or filename. It is not an independent sentence mark.
_MARK = re.compile(r"[，。！？；、：…]|(?<![a-zA-Z0-9])[!?,;:.]|[!?,;:.](?![a-zA-Z0-9])")
_TERMINAL = re.compile(r"[。！？!?…]|(?<![a-zA-Z0-9])\.(?![a-zA-Z0-9])")
_NEW_TOPIC = re.compile(r"^(?:总之|综上|接下来|首先|其次|最后(?:我们|再|来|还有)|换个角度|另一方面|来看|再来看|举个例子)")
_CONNECTOR = re.compile(r"^(?:但是|不过|所以|因此|而且|然后|比如|例如|也就是说|与此同时|那么|只要|如果|而是|不仅|还能|再到|就直接|以及)")
_NEW_CLAUSE = re.compile(r"^(?:(?:你们|大家|我们|我|你|它|他|她)(?:可以|会|只需|只要|能|要|就|还|都|来|相当于)|这(?:个|套|种|些|是)|之所以|只需要|平时|当(?:你|我|他|她|大家))")
_OPEN_END = re.compile(r"(?:如果|比如|因为|不仅|为了|关于|作为|以及|或者|和|把|将|在|是因为|的话题是)$")


def _key(text: str) -> str:
    return "".join(c.lower() if c.isascii() else c for c in text if c.isalnum())


def _restore_marks(original: str, edited: str) -> str:
    marks = list(_MARK.finditer(original))
    if not marks or [m.group() for m in marks] == _MARK.findall(edited):
        return edited
    old, new = _key(original), _key(edited)
    if not old or not new:
        return edited
    positions = [i for i, char in enumerate(edited) if char.isalnum()]
    boundaries: dict[int, int] = {0: 0, len(old): len(new)}
    for op, a, b, c, d in SequenceMatcher(None, old, new, autojunk=False).get_opcodes():
        boundaries[a], boundaries[b] = c, d
        if op == "equal" or (b-a == d-c):
            boundaries.update((a+i, c+i) for i in range(1, b-a))
    additions: dict[int, str] = {}
    for mark in marks:
        at = boundaries.get(len(_key(original[:mark.start()])))
        if at is None:
            continue
        pos = positions[at-1]+1 if at else 0
        following = positions[at] if at < len(positions) else len(edited)
        if not _MARK.search(edited[pos:following]):
            additions[pos] = additions.get(pos, "") + mark.group()
    for pos in sorted(additions, reverse=True):
        edited = edited[:pos] + additions[pos] + edited[pos:]
    return edited


def _cue_boundary(previous: str, following: str, gap: int, clause: str, sentence_length: int) -> str:
    left, right = _key(previous), _key(following)
    if not left or not right or _MARK.search(previous.rstrip()[-1:]) or _OPEN_END.search(left):
        return ""
    # Keep condition and consequence attached, including ASR clips splitting
    # "如果……那么……", "之所以……是因为……", or "当……的时候……".
    if len(left) <= 10 and re.fullmatch(r"(?:太|真|好).{1,5}(?:了|啊|啦)", left):
        return "！"
    if (right.startswith(("那么", "是因为")) or left.endswith(("的时候", "之后", "之前", "的话", "呢"))
            or clause.startswith(("当", "如果", "只要")) and _NEW_CLAUSE.match(right)):
        return "，" if len(clause) >= 3 else ""
    if sentence_length >= 8 and (gap >= 900 or _NEW_TOPIC.match(right)):
        return "。"
    if _CONNECTOR.match(right):
        if sentence_length >= 36 and right.startswith(("所以", "如果", "比如", "例如")):
            return "。"
        return "，" if len(clause) >= 4 else ""
    if len(clause) >= 5 and (gap >= 320 or _NEW_CLAUSE.match(right)):
        return "。" if sentence_length >= 28 and _NEW_CLAUSE.match(right) else "，"
    return ""


def punctuate_manuscript(asr: TranscriptOutput, corrected: TranscriptOutput) -> TranscriptOutput:
    """Add punctuation only. Cue timing, spoken words and manual versions stay separate."""
    if not corrected.segments or not corrected.language.lower().startswith(("zh", "cmn", "chinese")):
        return corrected
    rows = list(corrected.segments)
    if len(asr.segments) == len(rows):
        for i, (source, row) in enumerate(zip(asr.segments, rows, strict=True)):
            if (source.start_ms, source.end_ms) == (row.start_ms, row.end_ms):
                text = _restore_marks(source.text, row.text)
                if text != row.text:
                    rows[i] = replace(row, text=text)
    continuous = "".join(r.text for r in rows)
    # Preserve authored/model punctuation where genuine sentence structure
    # is already present. Do not punctuate every ASR window boundary.
    if not _TERMINAL.search(continuous) or len(_TERMINAL.findall(continuous)) * 130 < len(_key(continuous)):
        sentence_length = 0
        clause = ""
        for i, row in enumerate(rows):
            sentence_length += len(_key(row.text))
            clause += _key(row.text)
            if _TERMINAL.search(row.text):
                sentence_length = len(_key(_TERMINAL.split(row.text)[-1]))
            if _MARK.search(row.text):
                clause = _key(_MARK.split(row.text)[-1])
            if i + 1 < len(rows):
                nxt = rows[i+1]
                mark = _cue_boundary(row.text, nxt.text, nxt.start_ms-row.end_ms, clause, sentence_length)
            else:
                mark = "。" if not _MARK.search(row.text.rstrip()[-1:]) else ""
            if mark:
                rows[i] = replace(row, text=row.text+mark)
                clause = ""
                if mark == "。":
                    sentence_length = 0
    return corrected if all(old is new for old, new in zip(corrected.segments, rows, strict=True)) else replace(corrected, segments=tuple(rows))
