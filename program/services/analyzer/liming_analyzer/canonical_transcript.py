"""Time-preserving ASR correction with auditable OCR references and no SDK dependency."""
from __future__ import annotations

import hashlib
import json
import re
import time
import unicodedata
from collections.abc import Callable, Mapping
from dataclasses import dataclass, field
from decimal import Decimal, InvalidOperation
from difflib import SequenceMatcher
from functools import lru_cache
from typing import Any

from .adapters import TranscriptOutput, TranscriptSegment, VisualOutput
from .evidence import normalize_evidence_text

PROTOCOL_VERSION = "canonical-transcript.v1"
VALIDATION_VERSION = "canonical-fidelity.v2"
_DIGITS = dict(zip("零〇一二两三四五六七八九", "001223456789", strict=True))
_SMALL = {"十": 10, "百": 100, "千": 1000}
_CN = "零〇一二两三四五六七八九十百千万亿点"
_UNITS = "美元|美金|人民币|分钟|小时|毫秒|公斤|千克|公里|厘米|毫米|英寸|像素|赫兹|尼特|版本|GB|TB|MB|GHz|MHz|Hz|fps|PPI|年|月|天|日|号|秒|分|岁|个|人|名|次|块|元|米|克|倍|瓦|成"
_NUMBER = re.compile(r"(?:\d+|[零〇一二两三四五六七八九十百千万亿]+)(?:[.,点](?:\d+|[零〇一二两三四五六七八九十百千万亿]+))*(?:[万亿])?")
_IDENTIFIER = re.compile(r"[A-Za-z][A-Za-z0-9_.+/-]*")
_NEGATION = re.compile(r"不是|不能|不要|不得|没有|并非|从未|禁止|拒绝|不|没|未|无|非|别")
_NON_NEGATING_BIE = frozenset(("区别", "差别", "特别", "分别", "级别", "别的", "别人", "识别", "告别", "别致", "别墅", "别扭", "派别", "离别", "永别", "送别", "性别", "辨别", "鉴别", "类别", "个别"))
# A closed confusion set, rather than permission for arbitrary one-character
# rewrites. Tone-sensitive opposites (e.g. 买/卖) and number words are excluded.
_CONFUSIONS = tuple(frozenset(group) for group in (
    "他她它", "的地得", "在再", "做作", "坐座", "帐账", "像象", "带戴",
    "件建见健剑", "级及急极集机鸡积", "权全泉拳", "线限现县献",
    "饮隐引", "食石时识实", "新心欣芯", "形型", "成诚城程", "以已乙",
    "需须", "制治质置", "记纪计技", "申身伸深", "清轻青", "理里礼",
    "部步布", "分纷氛", "经精京", "利力立历例", "频平评", "模磨摩",
    "遇预裕", "又右佑", "予语宇雨", "量亮谅", "享响想", "换唤焕",
))
_NAME_SEQUENCE = re.compile(r"[A-Za-z][A-Za-z0-9_.+/-]*(?:[ \t]+[A-Za-z][A-Za-z0-9_.+/-]*)?")


def _negation_facts(text: str) -> list[str]:
    return [match.group() for match in _NEGATION.finditer(text)
            if match.group() != "别" or (text[max(0, match.start() - 1):match.end()] not in _NON_NEGATING_BIE
                                        and text[match.start():match.end() + 1] not in _NON_NEGATING_BIE)]


def _parse_number(raw: str) -> Decimal | None:
    """Like script-rewrite.ts: Chinese scales/decimals are semantic, not English words."""
    value = unicodedata.normalize("NFKC", raw).strip()
    for unit, scale in (("亿", 100_000_000), ("万", 10_000)):
        if unit in value:
            left, right = value.split(unit, 1)
            coefficient = _parse_number(left) if left else Decimal(1)
            remainder = _parse_number(right) if right else Decimal(0)
            return None if coefficient is None or remainder is None else coefficient * scale + remainder
    if re.fullmatch(r"\d{1,3}(?:,\d{3})+(?:\.\d+)?", value):
        return Decimal(value.replace(",", ""))
    if re.fullmatch(r"\d+(?:[.,]\d+)?", value):
        try:
            return Decimal(value.replace(",", "."))
        except InvalidOperation:
            return None
    if "点" in value:
        left, right = value.split("点", 1)
        integer = _parse_number(left) if left else Decimal(0)
        if integer is None or not right or any(character not in _DIGITS and not character.isdigit() for character in right):
            return None
        return Decimal(str(integer) + "." + "".join(_DIGITS.get(character, character) for character in right))
    if not value or any(character not in _DIGITS and character not in _SMALL for character in value):
        return None
    if not any(character in _SMALL for character in value):
        return Decimal("".join(_DIGITS[character] for character in value))
    total = current = 0
    for character in value:
        if character in _DIGITS:
            current = int(_DIGITS[character])
        else:
            total += (current or 1) * _SMALL[character]
            current = 0
    return Decimal(total + current)


def _number_spans(text: str) -> list[tuple[int, int, str]]:
    value = unicodedata.normalize("NFKC", text)
    spans = []
    for match in _NUMBER.finditer(value):
        raw = match.group()
        before, after = value[:match.start()], value[match.end():]
        if raw == "百" and after.startswith("分之"):
            continue
        # Modal 千万 and ordinary idioms containing 一 are not numeric facts.
        if raw == "千万" and re.match(r"不要|别|不能|不可|务必|记得|小心|要", after):
            continue
        is_version = bool(re.search(r"(?:[A-Za-z][A-Za-z_./-]*|版本|第|V|v)\s*$", before))
        quantified = re.match(r"\s*(?:" + _UNITS + r"|%)", after, re.IGNORECASE)
        percent = before.endswith("百分之") or after.lstrip().startswith("%")
        if not raw[0].isdigit() and not (is_version or quantified or percent or "点" in raw or (any(c in _SMALL for c in raw) and re.match(r"(?:哦|啊)?[，。！？!?]", after))):
            continue
        # Arabic dotted technical versions retain components: 5.50 is not 5.5.
        if is_version and ("." in raw or "点" in raw):
            components = [_parse_number(part) for part in re.split(r"[.点]", raw)]
            if any(part is None or part != part.to_integral_value() for part in components):
                continue
            canonical = ".".join(str(int(part)) for part in components)
        else:
            number = _parse_number(raw)
            if number is None:
                if re.fullmatch(r"\d+(?:\.\d+)+", raw):
                    canonical = raw
                else:
                    continue
            else:
                canonical = format(number.normalize(), "f")
        if percent:
            canonical += "%"
        start = match.start() - 3 if before.endswith("百分之") else match.start()
        spans.append((start, match.end(), canonical))
    return spans


def protected_numeric_facts(text: str) -> list[str]:
    """Ordered values preserve repetition and prevent swapping model versions."""
    return [canonical for _, _, canonical in _number_spans(text)]


def _comparison_text(text: str) -> str:
    value = unicodedata.normalize("NFKC", text)
    for start, end, canonical in reversed(_number_spans(value)):
        value = value[:start] + canonical + value[end:]
    return normalize_evidence_text(value)


def _ocr_rows(visuals: VisualOutput) -> list[dict[str, Any]]:
    return [
        {"id": f"ocr:{index:04d}", "timestamp_ms": frame.timestamp_ms,
         "text": frame.ocr_text.strip(), "confidence": frame.confidence}
        for index, frame in enumerate(visuals.keyframes, 1) if frame.ocr_text and frame.ocr_text.strip()
    ]


def canonical_source_hash(transcript: TranscriptOutput, visuals: VisualOutput) -> str:
    payload = {"protocol_version": PROTOCOL_VERSION, "validation_version": VALIDATION_VERSION, "language": transcript.language,
               "segments": [{"start_ms": row.start_ms, "end_ms": row.end_ms, "text": row.text} for row in transcript.segments],
               "ocr": _ocr_rows(visuals)}
    return hashlib.sha256(json.dumps(payload, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode()).hexdigest()


def _context(segment: TranscriptSegment, rows: list[dict[str, Any]]) -> list[dict[str, Any]]:
    return [row for row in rows if segment.start_ms - 2_000 <= row["timestamp_ms"] <= segment.end_ms + 2_000]


def _quorum(rows: list[dict[str, Any]]) -> bool:
    times = {row["timestamp_ms"] for row in rows}
    return len(times) >= 2 and max(times) - min(times) >= 200


def _name_anchors(rows: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Repeated on-screen spellings may be reused later in the same video."""
    grouped: dict[str, list[dict[str, Any]]] = {}
    forms: dict[str, str] = {}
    for row in rows:
        if row["confidence"] is None or row["confidence"] < 80:
            continue
        terms = {match.group().strip("./-+") for pattern in (_NAME_SEQUENCE, _IDENTIFIER) for match in pattern.finditer(row["text"])}
        for term in sorted(terms):
            key = normalize_evidence_text(term)
            if not 4 <= len(key) <= 40 or not any(c.isupper() for c in term):
                continue
            grouped.setdefault(key, []).append(row)
            forms.setdefault(key, term)
    anchors = [{"term": forms[key], "key": key, "evidence_ids": list(dict.fromkeys(row["id"] for row in hits))}
               for key, hits in grouped.items() if _quorum(hits)]
    return sorted(anchors, key=lambda row: (-len(row["evidence_ids"]), -len(row["key"]), row["key"]))[:64]


def _phrase_anchors(original: str, context: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Find near-matching repeated subtitle lines, never an unrelated UI panel."""
    left = _comparison_text(original)
    grouped: dict[str, list[dict[str, Any]]] = {}
    forms: dict[str, str] = {}
    for row in context:
        if row["confidence"] is None or row["confidence"] < 80:
            continue
        for line in row["text"].splitlines():
            right = _comparison_text(line)
            if not 8 <= len(right) <= 160 or not .75 <= len(right) / max(1, len(left)) <= 1.35:
                continue
            matcher = SequenceMatcher(None, left, right, autojunk=False)
            if matcher.ratio() < .72 or matcher.find_longest_match().size < 6:
                continue
            if protected_numeric_facts(original) != protected_numeric_facts(line) or _negation_facts(original) != _negation_facts(line):
                continue
            grouped.setdefault(right, []).append(row)
            forms.setdefault(right, line.strip())
    candidates = [{"text": forms[key], "evidence_ids": list(dict.fromkeys(row["id"] for row in hits)),
                   "similarity": round(SequenceMatcher(None, left, key, autojunk=False).ratio(), 3)}
                  for key, hits in grouped.items() if _quorum(hits)]
    return sorted(candidates, key=lambda row: (-row["similarity"], -len(row["evidence_ids"])))[:2]


def _global_name_support(identifier: str, corrected: str, anchors: list[dict[str, Any]], context: list[dict[str, Any]], original: str) -> tuple[str, list[str]] | None:
    key = normalize_evidence_text(identifier)
    right = _comparison_text(corrected)
    scores = sorted((SequenceMatcher(None, key, anchor["key"], autojunk=False).ratio() for anchor in anchors
                     if .65 <= len(anchor["key"]) / max(1, len(key)) <= 1.5), reverse=True)
    ambiguous = len(scores) >= 2 and scores[0] - scores[1] < .12
    for anchor in anchors:
        replacement = anchor["key"]
        if replacement not in right or not .65 <= len(replacement) / max(1, len(key)) <= 1.5:
            continue
        similarity = SequenceMatcher(None, key, replacement, autojunk=False).ratio()
        # Full-frame OCR confidence can be lowered by unrelated terminal/UI
        # text. The spelling itself already has a separate high-confidence
        # multi-frame quorum; this nearby row supplies sentence alignment only.
        nearby = [row for row in context if row["confidence"] is not None and row["confidence"] >= 50
                  and replacement in _comparison_text(row["text"])
                  and SequenceMatcher(None, _comparison_text(original), _comparison_text(row["text"]), autojunk=False).find_longest_match().size >= 6]
        if (similarity >= .6 and not ambiguous) or (similarity >= .4 and key[:1] == replacement[:1] and nearby):
            return replacement, list(dict.fromkeys([*anchor["evidence_ids"], *(row["id"] for row in nearby)]))
    return None


def _relevant_names(transcript: TranscriptOutput, rows: list[dict[str, Any]]) -> list[dict[str, Any]]:
    result = []
    for anchor in _name_anchors(rows):
        for segment in transcript.segments:
            identifiers = [normalize_evidence_text(match.group()) for match in _IDENTIFIER.finditer(segment.text)]
            matches = [SequenceMatcher(None, identifier, anchor["key"], autojunk=False).ratio() for identifier in identifiers
                       if .65 <= len(anchor["key"]) / max(1, len(identifier)) <= 1.5]
            if not matches or max(matches) < .4:
                continue
            if max(matches) >= .6 or any(row["confidence"] is not None and row["confidence"] >= 50
                    and anchor["key"] in _comparison_text(row["text"])
                    and SequenceMatcher(None, _comparison_text(segment.text), _comparison_text(row["text"]), autojunk=False).find_longest_match().size >= 4
                    for row in _context(segment, rows)):
                result.append(anchor)
                break
    return [anchor for anchor in result if not any(anchor["key"] != other["key"] and anchor["key"] in other["key"]
            and len(set(anchor["evidence_ids"]) & set(other["evidence_ids"])) >= 2 for other in result)]


def _support(fragment: str, context: list[dict[str, Any]]) -> list[str]:
    key = normalize_evidence_text(fragment)
    if len(key) < 2:
        return []
    hits = [row for row in context if (row["confidence"] is not None and row["confidence"] >= 70
            and key in normalize_evidence_text(row["text"]))]
    return [row["id"] for row in hits] if _quorum(hits) else []


def _validate_text(original: str, corrected: str, context: list[dict[str, Any]], names: list[dict[str, Any]] | None = None) -> tuple[list[str], list[str]]:
    issues: list[str] = []
    refs: set[str] = set()
    if protected_numeric_facts(original) != protected_numeric_facts(corrected):
        issues.append("numeric_or_version_changed")
    if _negation_facts(original) != _negation_facts(corrected):
        issues.append("negation_changed")
    left, right = _comparison_text(original), _comparison_text(corrected)
    if not right or not .65 <= len(right) / max(1, len(left)) <= 1.45:
        issues.append("length_changed")
    # Names confirmed in several actual frames stay available across the video.
    # A weak spelling match additionally requires matching nearby sentence text.
    identifiers = [m.group() for m in _IDENTIFIER.finditer(original)
                   if any(c.isupper() for c in m.group()) or any(c.isdigit() for c in m.group())]
    for identifier in identifiers:
        if normalize_evidence_text(identifier) in right:
            continue
        if any(anchor["key"] == normalize_evidence_text(identifier) for anchor in names or []):
            issues.append("confirmed_name_changed")
            continue
        global_support = _global_name_support(identifier, corrected, names or [], context, original)
        if global_support:
            replacement, supported = global_support
            refs.update(supported)
            left = left.replace(_comparison_text(identifier), replacement, 1)
            continue
        replacements = [m.group() for m in _IDENTIFIER.finditer(corrected)
                        if SequenceMatcher(None, identifier.casefold(), m.group().casefold()).ratio() >= .5]
        supported = [ref for replacement in replacements for ref in _support(replacement, context)]
        if supported:
            refs.update(supported)
            # Remove the already-supported identifier change from the remaining
            # typo budget; spaces within an on-screen name are surface spelling.
            replacement = max(replacements, key=lambda value: len(_support(value, context)))
            left = left.replace(_comparison_text(identifier), _comparison_text(replacement), 1)
        elif _comparison_text(identifier) not in right:
            issues.append("technical_identifier_changed_without_ocr")
    matcher = SequenceMatcher(None, left, right, autojunk=False)
    small_edits = 0
    small_budget = min(3, max(1, (len(left) + 4) // 5))
    for operation, i, j, k, l in matcher.get_opcodes():
        if operation == "equal":
            continue
        before, after = left[i:j], right[k:l]
        if len(before) == len(after) and 0 < len(before) <= 3 and all(a == b or any(a in group and b in group for group in _CONFUSIONS) for a, b in zip(before, after, strict=True)):
            small_edits += sum(a != b for a, b in zip(before, after, strict=True))
            continue
        if before == "的" and not after and left[j:j + 1] == "在" and refs:
            small_edits += 1
            continue
        # Expand partial Latin changes (GrowlBot -> GrokBot) to the full word;
        # a one-letter match elsewhere on screen is not correction evidence.
        start, end = k, l
        while start and right[start - 1].isascii() and right[start - 1].isalnum():
            start -= 1
        while end < len(right) and right[end].isascii() and right[end].isalnum():
            end += 1
        supported = _support(right[start:end], context)
        if not supported:
            supported = _support(right[max(0, k - 2):min(len(right), l + 2)], context)
        if supported:
            refs.update(supported)
        else:
            issues.append("text_changed_without_repeated_ocr")
    if small_edits > small_budget:
        issues.append("small_edit_budget_exceeded")
    # A repeated near-identical subtitle can expose an unchanged ASR mistake.
    # Require only bounded replacement spans; do not force subtitle omissions or
    # copy an entire screen into the spoken transcript.
    source = _comparison_text(original)
    for anchor in _phrase_anchors(original, context)[:1]:
        target = _comparison_text(anchor["text"])
        for operation, i, j, k, l in SequenceMatcher(None, source, target, autojunk=False).get_opcodes():
            before, after = source[i:j], target[k:l]
            if operation != "replace" or i > 2 or j > 4 or not 1 <= len(before) <= 3 or not 1 <= len(after) <= 3 or not all("\u4e00" <= char <= "\u9fff" and char not in _CN for char in before + after):
                continue
            suffix = source[j:j + 6]
            if len(suffix) >= 6 and before + suffix in right and after + suffix not in right:
                issues.append("repeated_subtitle_correction_unapplied")
    short_anchored = len(left) <= 12 and bool(refs) and matcher.ratio() >= .25
    if matcher.ratio() < .6 and not short_anchored:
        issues.append("meaning_or_sequence_changed")
    return list(dict.fromkeys(issues)), sorted(refs)


def _source_with_safe_ending(original: str, candidate: str) -> str:
    """Keep every source character; borrow at most one sentence/clause mark."""
    endings = "，。！？；：,.!?;:"
    if original.rstrip().endswith(tuple(endings)):
        return original
    candidate = candidate.rstrip()
    return original + candidate[-1] if candidate and candidate[-1] in endings else original


def _retain_source_for_unsupported_chinese_edit(original: str, candidate: str, issues: list[str]) -> str | None:
    # This discards an unsupported proposal. It never approves the proposal or
    # repairs a failed factual/structural gate by silently falling back.
    if set(issues) != {"text_changed_without_repeated_ocr"}:
        return None
    left, right = _comparison_text(original), _comparison_text(candidate)
    edits = [(left[i:j], right[k:l]) for operation, i, j, k, l in SequenceMatcher(None, left, right, autojunk=False).get_opcodes() if operation != "equal"]
    if not edits or sum(max(len(before), len(after)) for before, after in edits) > 4:
        return None
    if any(not all("\u4e00" <= character <= "\u9fff" for character in before + after) for before, after in edits):
        return None
    return _source_with_safe_ending(original, candidate)


def _join(left: str, right: str) -> str:
    separator = " " if left and right and left[-1].isascii() and left[-1].isalnum() and right[0].isascii() and right[0].isalnum() else ""
    return left + separator + right


def _readability(transcript: TranscriptOutput, texts: list[str]) -> dict[str, Any]:
    source = "".join(segment.text for segment in transcript.segments)
    count = len(normalize_evidence_text(source))
    chinese = len(re.findall(r"[\u4e00-\u9fff]", source))
    span_ms = max((segment.end_ms for segment in transcript.segments), default=0) - min((segment.start_ms for segment in transcript.segments), default=0)
    # Short clips and many short label-like fragments need not read as a long
    # prose script. Never infer word timestamps or invent sentence boundaries.
    applicable = count >= 200 and chinese >= 120 and span_ms >= 30_000 and count / max(1, len(transcript.segments)) >= 6
    result: dict[str, Any] = {"applicable": applicable, "passed": True, "issues": [], "source_character_count": count}
    if not applicable:
        return result
    text = "".join(texts).strip()
    endings = len(re.findall(r"[。！？!?]+", text))
    marks = len(re.findall(r"[，,。！？!?；;：:]", text))
    longest = max((len(normalize_evidence_text(part)) for part in re.split(r"[，,。！？!?；;：:]", text)), default=0)
    required_endings = max(2, (count + 139) // 140)
    required_marks = max(required_endings, (count + 99) // 100)
    issues = []
    if endings < required_endings or marks < required_marks or longest > 160:
        issues.append("long_spoken_script_punctuation_insufficient")
    if not re.search(r"[。！？!?…][\s\"'”’」』）)\]】]*$", text):
        issues.append("long_spoken_script_sentence_end_missing")
    result.update(passed=not issues, issues=issues, sentence_endings=endings, punctuation_marks=marks,
                  longest_unpunctuated_characters=longest, required_sentence_endings=required_endings,
                  required_punctuation_marks=required_marks)
    return result


def _paragraphs(segments: list[dict[str, Any]]) -> list[dict[str, Any]]:
    result: list[dict[str, Any]] = []
    current: dict[str, Any] | None = None
    for row in segments:
        # Long ASR segments can form multiple reading paragraphs, but each keeps
        # the original segment interval rather than inventing word alignment.
        sentences = re.findall(r"[^。！？!?；;]+[。！？!?；;]?", row["text"]) or [row["text"]]
        pieces = []
        for sentence in sentences:
            while len(sentence) > 180:
                stops = [match.end() for match in re.finditer(r"[，,、\s]", sentence[:180]) if match.end() >= 60]
                end = stops[-1] if stops else 180
                while end < len(sentence) and sentence[end - 1].isascii() and sentence[end - 1].isalnum() and sentence[end].isascii() and sentence[end].isalnum():
                    end += 1
                pieces.append(sentence[:end]); sentence = sentence[end:]
            pieces.append(sentence)
        for piece in pieces:
            piece = piece.strip()
            if not piece:
                continue
            if current and (row["start_ms"] - current["end_ms"] >= 800 or len(current["text"]) + len(piece) > 180):
                result.append(current); current = None
            if current is None:
                current = {"source_segment_ids": [], "start_ms": row["start_ms"], "end_ms": row["end_ms"], "text": ""}
            current["text"] = _join(current["text"], piece)
            current["end_ms"] = max(current["end_ms"], row["end_ms"])
            if row["source_segment_id"] not in current["source_segment_ids"]:
                current["source_segment_ids"].append(row["source_segment_id"])
            if len(current["text"]) >= 80 and re.search(r"[。！？!?]$", piece):
                result.append(current); current = None
    if current:
        result.append(current)
    return [{"id": f"canonical:p{index:04d}", **row} for index, row in enumerate(result, 1)]


@dataclass
class CanonicalTranscriptResult:
    status: str
    source_hash: str
    segments: list[dict[str, Any]]
    paragraphs: list[dict[str, Any]]
    validation: dict[str, Any]
    error: str | None = None
    diagnostics: dict[str, Any] = field(default_factory=dict)
    transcript: TranscriptOutput | None = None

    @property
    def spoken_script_set(self) -> dict[str, Any]:
        paragraphs = [row["text"] for row in self.paragraphs]
        return {"corrected_original": {
            "status": self.status, "text": "\n\n".join(paragraphs), "paragraphs": paragraphs,
            "source_segment_ids": [row["source_segment_id"] for row in self.segments],
            "candidate_available": bool(paragraphs), "error": self.error,
            "validation": self.validation,
            "provenance": {"source": "canonical_asr_ocr_correction", "prompt_version": PROTOCOL_VERSION},
        }}

    def to_dict(self) -> dict[str, Any]:
        return {"protocol_version": PROTOCOL_VERSION, "source_hash": self.source_hash,
                "status": self.status, "segments": self.segments, "paragraphs": self.paragraphs,
                "changes": [{"source_segment_id": row["source_segment_id"], "before": row["original_text"], "after": row["text"], "evidence_ids": row["evidence_ids"]}
                            for row in self.segments if row["original_text"] != row["text"]],
                "validation": self.validation, "error": self.error, "diagnostics": self.diagnostics}

    def to_checkpoint(self) -> dict[str, Any]:
        if self.status != "completed" or not self.validation.get("passed"):
            raise ValueError("Only a verified canonical transcript can be checkpointed")
        return json.loads(json.dumps(self.to_dict(), ensure_ascii=False))


def _result(transcript: TranscriptOutput, visuals: VisualOutput, texts: list[str], diagnostics: dict[str, Any]) -> CanonicalTranscriptResult:
    rows, issues = [], []
    ocr = _ocr_rows(visuals)
    names = _relevant_names(transcript, ocr)
    if len(texts) != len(transcript.segments):
        issues.append("source_segment_mapping_incomplete")
    for index, (source, text) in enumerate(zip(transcript.segments, texts, strict=False), 1):
        errors, refs = _validate_text(source.text, text, _context(source, ocr), names)
        issues.extend(f"transcript:{index:04d}:{error}" for error in errors)
        rows.append({"source_segment_id": f"transcript:{index:04d}", "start_ms": source.start_ms,
                     "end_ms": source.end_ms, "text": text, "original_text": source.text, "evidence_ids": refs})
    readability = _readability(transcript, texts)
    issues.extend(readability["issues"])
    passed = not issues and bool(rows)
    validation = {"passed": passed, "issues": issues, "source_segment_coverage_percent": 100 if len(texts) == len(transcript.segments) else 0,
                  "checks": [{"key": "source_order", "passed": len(texts) == len(transcript.segments)}, {"key": "numeric_fidelity", "passed": not any("numeric_or_version" in issue for issue in issues)},
                             {"key": "readability", "passed": readability["passed"]}],
                  "time_precision": "original_asr_segment", "validation_version": VALIDATION_VERSION, "readability": readability}
    return CanonicalTranscriptResult(
        "completed" if passed else "failed", canonical_source_hash(transcript, visuals), rows,
        _paragraphs(rows), validation, None if passed else "Canonical correction failed source/fact verification",
        diagnostics, TranscriptOutput(transcript.language, tuple(TranscriptSegment(row["start_ms"], row["end_ms"], row["text"], source.confidence) for row, source in zip(rows, transcript.segments, strict=False)), transcript.confidence) if passed else None,
    )


def build_canonical_transcript(
    transcript: TranscriptOutput, visuals: VisualOutput,
    request_correction: Callable[[str, Mapping[str, Any], int], Mapping[str, Any]],
    *, max_output_tokens: int = 6000,
) -> CanonicalTranscriptResult:
    if not transcript.segments:
        return CanonicalTranscriptResult("not_applicable", canonical_source_hash(transcript, visuals), [], [], {"passed": True, "issues": [], "reason": "transcript_empty"})
    if max_output_tokens < 1:
        raise ValueError("max_output_tokens must be positive")
    rows = _ocr_rows(visuals)
    names = _relevant_names(transcript, rows)
    diagnostics: dict[str, Any] = {"request_count": 0, "batches": [], "protocol_version": PROTOCOL_VERSION, "validation_version": VALIDATION_VERSION,
                                   "retained_source_segments": []}
    texts: list[str] = []
    # Bound long inputs without ever selecting away ASR segments. A typical
    # short video (including 64 ASR rows) remains one compact request.
    batches: list[list[tuple[int, TranscriptSegment]]] = []
    for index, segment in enumerate(transcript.segments, 1):
        if not batches or len(batches[-1]) >= 96 or sum(len(row.text) for _, row in batches[-1]) >= 4000:
            batches.append([])
        batches[-1].append((index, segment))
    for batch_index, batch in enumerate(batches, 1):
        expected = [index for index, _ in batch]
        used_ocr: dict[str, dict[str, Any]] = {}
        source_rows = []
        for index, segment in batch:
            nearby = _context(segment, rows)
            context = sorted(nearby, key=lambda row: abs(row["timestamp_ms"] - (segment.start_ms + segment.end_ms) / 2))[:6]
            for row in context:
                used_ocr[row["id"]] = {**row, "text": row["text"][:1200]}
            source_rows.append({"s": index, "start_ms": segment.start_ms, "end_ms": segment.end_ms,
                                "t": segment.text, "protected_numbers": protected_numeric_facts(segment.text), "ocr_refs": [row["id"] for row in context],
                                "repeated_subtitle_anchors": _phrase_anchors(segment.text, nearby)})
        payload = {"protocol_version": PROTOCOL_VERSION, "source_hash": canonical_source_hash(transcript, visuals),
                   "segments": source_rows, "ocr_context": list(used_ocr.values()),
                   "confirmed_name_anchors": [{"term": row["term"], "evidence_ids": row["evidence_ids"]} for row in names],
                   "instructions": [
                       "Return exactly one s/t row per input segment, in source order. Do not return times or explanations.",
                       "请把所有相邻ASR片段当成连续口播理解，在各段t中补齐中文逗号、句号、问号等必要标点。不要逐段照抄无标点ASR，不要把长稿串成一大段。跨段续句可以前段用逗号、后段在真正句末用句号；保留每段原有内容、顺序和s，不合并段、不造时间。长口播必须有合理的自然句末，最后一句补完整句末标点。",
                       "例如两段“今天介绍一个工具”“它能整理资料”，可分别输出“今天介绍一个工具，”“它能整理资料。”；逗号和句号应结合真实上下文，不能机械地在每个ASR片段后加句号。",
                       "Correct punctuation and conservative recognition errors. Common same-sound Chinese typos, 他/她/它 and 的/地/得 may be corrected in a small edit budget; do not replace other words by guesswork. Keep uncertain words; do not rewrite, summarize or merge segments.",
                       "OCR is a time-aligned reference, not audio truth. Repeated consistent OCR may anchor spelling of names; never copy unrelated screen content.",
                       "Preserve every protected number/version and negation. Chinese/Arabic equivalent spelling is allowed; a known version must not be downgraded even if another number appears on screen.",
                       "confirmed_name_anchors are spellings confirmed in multiple real frames of THIS video. Reuse those names consistently in later segments, including spaced/ASR spelling variants; they do not authorize adding a new name or fact.",
                       "repeated_subtitle_anchors are near-identical local lines seen in multiple frames. Inspect their differing short phrases carefully and fix an ASR misrecognition still left in the source, including the opening address. Do not leave a clearly contradicted word unchanged. Preserve extra spoken words when the subtitle merely omits them.",
                       "Other meaning-bearing edits need actual OCR support. Do not guess a replacement just because it reads better. Output complete compact JSON {segments:[{s:1,t:'...'}]}.",
                   ]}
        started = time.monotonic()
        diagnostics["request_count"] += 1
        event = {"batch": batch_index, "output_limit": max_output_tokens}
        try:
            # The caller owns SDK length retries and usage recording. Never
            # multiply those paid attempts with an inner retry loop here.
            response = request_correction("canonical_transcript", payload, max_output_tokens)
            if hasattr(response, "model_dump"):
                response = response.model_dump()
            candidates = response.get("segments") if isinstance(response, Mapping) and set(response) == {"segments"} else None
            if not isinstance(candidates, list) or [row.get("s") if isinstance(row, Mapping) else None for row in candidates] != expected or any(set(row) != {"s", "t"} or type(row["s"]) is not int or not isinstance(row["t"], str) or not row["t"].strip() for row in candidates):
                raise ValueError("canonical_source_segment_mapping_invalid")
            batch_texts = [row["t"].strip() for row in candidates]
            issues = []
            for offset, ((index, segment), text) in enumerate(zip(batch, batch_texts, strict=True)):
                context = _context(segment, rows)
                errors, _refs = _validate_text(segment.text, text, context, names)
                retained = _retain_source_for_unsupported_chinese_edit(segment.text, text, errors)
                if retained is not None:
                    batch_texts[offset] = retained
                    diagnostics["retained_source_segments"].append({"source_segment_id": f"transcript:{index:04d}",
                                                                  "reason": "text_changed_without_repeated_ocr"})
                    errors, _refs = _validate_text(segment.text, retained, context, names)
                issues.extend(f"transcript:{index:04d}:{issue}" for issue in errors)
            texts.extend(batch_texts)
            event["status"] = "failed" if issues else "completed"
            if issues:
                return _result(transcript, visuals, texts, diagnostics)
        except Exception as error:  # noqa: BLE001 - preserve failure without leaking provider secrets
            event.update(status="failed", error_type=type(error).__name__)
            result = _result(transcript, visuals, texts, diagnostics)
            result.status = "failed"; result.transcript = None
            result.validation.update(passed=False)
            result.validation["issues"].append("canonical_request_failed:" + type(error).__name__)
            result.error = "Canonical correction request did not return a verified complete result"
            return result
        finally:
            event["duration_ms"] = round((time.monotonic() - started) * 1000)
            diagnostics["batches"].append(event)
    return _result(transcript, visuals, texts, diagnostics)


def restore_canonical_transcript(checkpoint: Any, transcript: TranscriptOutput, visuals: VisualOutput) -> CanonicalTranscriptResult | None:
    if not isinstance(checkpoint, Mapping) or checkpoint.get("protocol_version") != PROTOCOL_VERSION or checkpoint.get("source_hash") != canonical_source_hash(transcript, visuals) or checkpoint.get("status") != "completed" or not isinstance(checkpoint.get("validation"), Mapping) or checkpoint["validation"].get("passed") is not True:
        return None
    rows = checkpoint.get("segments")
    if not isinstance(rows, list) or len(rows) != len(transcript.segments):
        return None
    for index, (row, original) in enumerate(zip(rows, transcript.segments, strict=True), 1):
        if not isinstance(row, Mapping) or row.get("source_segment_id") != f"transcript:{index:04d}" or (row.get("start_ms"), row.get("end_ms"), row.get("original_text")) != (original.start_ms, original.end_ms, original.text) or not isinstance(row.get("text"), str):
            return None
    retained = checkpoint.get("diagnostics", {}).get("retained_source_segments", []) if isinstance(checkpoint.get("diagnostics"), Mapping) else []
    by_id = {row["source_segment_id"]: row for row in rows}
    retained = [{"source_segment_id": item["source_segment_id"], "reason": "text_changed_without_repeated_ocr"}
                for item in retained if isinstance(item, Mapping) and isinstance(item.get("source_segment_id"), str)
                and item["source_segment_id"] in by_id and item.get("reason") == "text_changed_without_repeated_ocr"
                and by_id[item["source_segment_id"]]["text"] == _source_with_safe_ending(by_id[item["source_segment_id"]]["original_text"], by_id[item["source_segment_id"]]["text"])] if isinstance(retained, list) else []
    result = _result(transcript, visuals, [row["text"] for row in rows], {"restored": True, "request_count": 0, "protocol_version": PROTOCOL_VERSION,
                                                                     "retained_source_segments": retained})
    return result if result.status == "completed" else None


@lru_cache(maxsize=1)
def create_canonical_response_model() -> Any:
    from pydantic import ConfigDict, Field, create_model
    config = ConfigDict(extra="forbid")
    segment = create_model("CanonicalSegment", __config__=config,
                           s=(int, Field(ge=1, strict=True)), t=(str, Field(min_length=1, max_length=12000)))
    return create_model("CanonicalTranscriptResponse", __config__=config,
                        segments=(list[segment], Field(min_length=1, max_length=96)))
