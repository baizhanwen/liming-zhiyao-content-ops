"""Source-preserving, segment-isolated review of ASR through verified patches.

The callback owns transport, accounting and the two-paid-call budget per batch.
This module never imports an SDK and never promotes an uncertain draft to fact.
"""
from __future__ import annotations

import copy
import hashlib
import json
import re
import unicodedata
from collections.abc import Callable, Mapping, Sequence
from dataclasses import dataclass, field
from difflib import SequenceMatcher
from functools import lru_cache
from typing import Any, Literal

from .adapters import TranscriptOutput, VisualOutput
from .canonical_transcript import (
    _comparison_text,
    _context,
    _negation_facts,
    _number_spans,
    _ocr_rows,
    _paragraphs,
    _phrase_anchors,
    _quorum,
    _relevant_names,
    _validate_text,
    protected_numeric_facts,
)

PROTOCOL_VERSION = "canonical-transcript.v2"
VALIDATION_VERSION = "canonical-patch-fidelity.v1"
MAX_BATCH_SEGMENTS = 48
MAX_BATCH_CHARACTERS = 4_000
_SURFACE_CONFUSIONS = (frozenset("他她它"), frozenset("的地得"))
_PATCH_FIELDS = {"s", "before", "after", "evidence_ids"}
_EDIT_TYPES = {"orthography", "common_word", "name", "fact", "unknown"}
_COMMON_TYPES = {"orthography", "common_word"}
_SOFT_REJECTIONS = {"patch_shape_invalid", "patch_before_invalid", "patch_after_invalid",
                    "patch_before_not_unique_in_source", "patch_evidence_reference_invalid",
                    "text_changed_without_repeated_ocr", "lexical_patch_without_repeated_evidence",
                    "punctuation_changes_source_characters", "length_changed", "small_edit_budget_exceeded", "patches_overlap"}
_SOFT_REJECTIONS |= {"common_phonetic_mismatch", "common_phonetic_unavailable"}
_REPAIRABLE_REJECTIONS = {"patch_shape_invalid", "patch_before_invalid", "patch_after_invalid",
                         "patch_before_not_unique_in_source", "patch_evidence_reference_invalid",
                         "patches_overlap", "punctuation_changes_source_characters"}
_ACTORS = ("客户", "商家", "用户", "平台", "作者", "系统", "买方", "卖方", "我们", "你们", "他们", "她们", "它们", "我", "你", "他", "她", "它")
_POLARITY = ("买", "卖", "上涨", "下跌", "增加", "减少", "提升", "降低", "上升", "下降", "成功", "失败", "正确", "错误", "安全", "危险", "支持", "反对", "好", "差", "高", "低", "盈利", "亏损", "优", "劣")


@dataclass(frozen=True)
class ReviewedSegment:
    """Same ordinal slot as ASR; empty text deliberately excludes pending speech."""
    start_ms: int
    end_ms: int
    text: str
    confidence: int | None = None


def _source_hash(transcript: TranscriptOutput, visuals: VisualOutput, manual: bool) -> str:
    payload = {"protocol": PROTOCOL_VERSION, "validation": VALIDATION_VERSION,
               "manual": manual, "language": transcript.language,
               "segments": [{"start_ms": row.start_ms, "end_ms": row.end_ms,
                             "text": row.text} for row in transcript.segments], "ocr": _ocr_rows(visuals)}
    return hashlib.sha256(json.dumps(payload, ensure_ascii=False, sort_keys=True,
                                    separators=(",", ":")).encode()).hexdigest()


def _time(milliseconds: int) -> str:
    seconds, fraction = divmod(milliseconds, 1000)
    return f"{seconds // 60:02d}:{seconds % 60:02d}.{fraction:03d}"


def _surface_only(before: str, after: str) -> bool:
    left, right = _comparison_text(before), _comparison_text(after)
    edits = [left[i:j] + right[k:l] for op, i, j, k, l in
             SequenceMatcher(None, left, right, autojunk=False).get_opcodes() if op != "equal"]
    return not edits or (len(left) == len(right) and sum(a != b for a, b in zip(left, right, strict=True)) <= 2
                         and all(a == b or any(a in group and b in group for group in _SURFACE_CONFUSIONS)
                                 for a, b in zip(left, right, strict=True)))


def _relevant_context(source: Any, rows: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Keep only related short lines, not surrounding full-screen documents."""
    original = _comparison_text(source.text)
    identifiers = {part.casefold() for part in re.findall(r"[A-Za-z][A-Za-z0-9_.+/-]{2,}", source.text)}
    result = []
    for row in _context(source, rows):
        lines = []
        for raw in row["text"].splitlines():
            line = raw.strip()
            if not line or len(line) > 220:
                continue
            normalized = _comparison_text(line)
            match = SequenceMatcher(None, original, normalized, autojunk=False)
            shared_name = any(name in line.casefold() for name in identifiers)
            longest = match.find_longest_match().size
            if longest >= 4 and (match.ratio() >= .42 or shared_name or (len(normalized) >= 7 and longest >= 5)):
                lines.append((match.ratio(), longest, line))
        if lines:
            result.append({**row, "text": "\n".join(value[2] for value in sorted(lines, reverse=True)[:4])})
    return sorted(result, key=lambda row: (abs(row["timestamp_ms"] - (source.start_ms + source.end_ms) / 2),
                                          row["timestamp_ms"]))[:8]


def _aligned_confirmation(text: str, context: list[dict[str, Any]]) -> bool:
    key = _comparison_text(text)
    hits = [row for row in context if row["confidence"] is not None and row["confidence"] >= 80
            and any(_comparison_text(line) == key for line in row["text"].splitlines())]
    return bool(key) and _quorum(hits)


def _chinese_substitutions(original: str, candidate: str) -> list[tuple[int, int]]:
    """Bound the new proof route to small substitutions, never inserted facts."""
    left, right = _comparison_text(original), _comparison_text(candidate)
    if len(left) != len(right):
        return []
    indices = [index for index, (before, after) in enumerate(zip(left, right, strict=True)) if before != after]
    if not 1 <= len(indices) <= 3 or any(not "\u4e00" <= text[index] <= "\u9fff" for index in indices for text in (left, right)):
        return []
    return [(index, index + 1) for index in indices]


def _hard_edit_issues(original: str, candidate: str, names: list[dict[str, Any]]) -> list[str]:
    issues = []
    if protected_numeric_facts(original) != protected_numeric_facts(candidate):
        issues.append("numeric_or_version_changed")
    def quantified_facts(text: str) -> list[tuple[str, str, str]]:
        text = unicodedata.normalize("NFKC", text)
        units = r"美元|欧元|英镑|人民币|美金|港元|日元|分钟|小时|毫秒|公斤|千克|公里|厘米|毫米|英寸|像素|赫兹|尼特|个月|GB|TB|MB|GHz|MHz|Hz|fps|PPI|年|月|天|日|号|秒|分|岁|个|人|名|次|块|元|米|克|倍|瓦|成|%"
        result = []
        for start, end, value in _number_spans(text):
            unit = re.match(r"\s*(" + units + ")", text[end:], re.IGNORECASE)
            currency = re.search(r"([$¥€£]|人民币|美元|欧元|英镑)\s*$", text[:start])
            result.append((value, currency.group(1) if currency else "", unit.group(1).casefold() if unit else ""))
        return result
    if quantified_facts(original) != quantified_facts(candidate):
        issues.append("numeric_unit_or_currency_changed")
    if _negation_facts(original) != _negation_facts(candidate):
        issues.append("negation_changed")
    actor_pattern = "|".join(sorted(_ACTORS, key=len, reverse=True))
    original_actors = [re.sub("[他她它]", "它", value) for value in re.findall(actor_pattern, original)]
    candidate_actors = [re.sub("[他她它]", "它", value) for value in re.findall(actor_pattern, candidate)]
    if original_actors != candidate_actors:
        issues.append("source_actor_changed")
    polarity_pattern = "|".join(sorted(_POLARITY, key=len, reverse=True))
    if re.findall(polarity_pattern, original) != re.findall(polarity_pattern, candidate):
        issues.append("source_polarity_changed")
    for name in names:
        term = name.get("term", "")
        if term and _comparison_text(term) in _comparison_text(original) and _comparison_text(term) not in _comparison_text(candidate):
            issues.append("confirmed_name_changed")
    # Source-identified Chinese names, never a customer/brand answer dictionary.
    entities = [match.group(1) for pattern in (r"([\u4e00-\u9fff]{2,8})(?:老师|先生|女士|教授|博士|公司|集团)",
                r"(?:我叫|姓名[：:]?|作者[：:]|品牌名[：:]?|产品名[：:]?)\s*([\u4e00-\u9fff]{2,8})")
                for match in re.finditer(pattern, original)]
    if any(term not in candidate for term in entities):
        issues.append("identified_entity_changed")
    # Protect source-stated measurement/financial concepts in their actual
    # domain; this is a fact guard, never a typo-to-answer replacement table.
    terms = ["速度", "数量", "时长", "频率", "延迟", "准确率", "成功率"]
    if re.search(r"公司|股票|行业|市场|股市|投资|财务|利润|资产|负债|价格|成本|转账|金额", original):
        terms += ["股价", "收入", "支出", "成本", "利润", "单价", "盈利", "亏损"]
    if any(original.count(term) != candidate.count(term) for term in terms):
        issues.append("source_fact_concept_changed")
    return list(dict.fromkeys(issues))


def _common_shape(original: str, candidate: str, patch: Mapping[str, Any]) -> bool:
    spans = _chinese_substitutions(original, candidate)
    left = _comparison_text(original)
    return bool(patch.get("edit_type") in _COMMON_TYPES and isinstance(patch.get("context_basis"), str)
                and patch["context_basis"].strip() and spans
                and 100 * (len(left) - len(spans)) >= 85 * len(left))


@lru_cache(maxsize=4096)
def _syllables(character: str) -> tuple[str, ...]:
    from pypinyin import Style, pinyin

    rows = pinyin(character, style=Style.NORMAL, heteronym=True, strict=False)
    return tuple(sorted({value.lower().replace("ü", "v").replace("u:", "v")
                         for value in rows[0] if re.fullmatch(r"[a-zü:]+", value.lower())}))


def _one_spelling_edit(left: str, right: str) -> bool:
    if len(left) == len(right):
        return sum(a != b for a, b in zip(left, right, strict=True)) <= 1
    shorter, longer = sorted((left, right), key=len)
    return len(longer) - len(shorter) == 1 and any(longer[:i] + longer[i + 1:] == shorter for i in range(len(longer)))


def _near_syllables(left: str, right: str) -> bool:
    if left == right or _one_spelling_edit(left, right):
        return True
    pattern = r"^(zh|ch|sh|[bpmfdtnlgkhjqxrzcsyw]?)(.*)$"
    before, after = re.fullmatch(pattern, left), re.fullmatch(pattern, right)
    if not before or not after:
        return False
    initial_groups = ({"z", "zh"}, {"c", "ch"}, {"s", "sh"}, {"n", "l", "r"}, {"f", "h"})
    # General Mandarin/ASR confusions, not a table of words or video answers.
    final_groups = ({"an", "ang"}, {"en", "eng", "un", "uen"}, {"in", "ing"},
                    {"ian", "iang"}, {"uan", "uang"}, {"i", "u", "v"})
    initial = before[1] == after[1] or any(before[1] in group and after[1] in group for group in initial_groups)
    final = before[2] == after[2] or any(before[2] in group and after[2] in group for group in final_groups)
    return initial and final


def _common_phonetic_issue(original: str, candidate: str) -> str | None:
    left, right = _comparison_text(original), _comparison_text(candidate)
    spans = _chinese_substitutions(original, candidate)
    try:
        for start, _end in spans:
            if not any(_near_syllables(before, after) for before in _syllables(left[start]) for after in _syllables(right[start])):
                return "common_phonetic_mismatch"
    except ImportError:
        return "common_phonetic_unavailable"
    return None


def _common_patch(original: str, candidate: str, patch: Mapping[str, Any]) -> bool:
    return _common_shape(original, candidate, patch) and _common_phonetic_issue(original, candidate) is None


def _local_subtitle_evidence(source: Any, candidate: str, rows: list[dict[str, Any]]) -> list[str]:
    """Prove bounded ordinary substitutions in one actual local subtitle line."""
    left, right = _comparison_text(source.text), _comparison_text(candidate)
    spans = _chinese_substitutions(source.text, candidate)
    if not spans:
        return []
    hits: dict[str, dict[str, Any]] = {}
    for start, end in spans:
        matches = []
        for row in rows:
            if not source.start_ms - 250 <= row["timestamp_ms"] <= source.end_ms + 250:
                continue
            for raw in row["text"].splitlines():
                line = _comparison_text(raw)
                # Pronoun spelling is a surface distinction, not a new actor.
                normalized_right = re.sub("[他她它]", "它", right)
                normalized_line = re.sub("[他她它]", "它", line)
                offset = normalized_right.find(normalized_line)
                if (not 7 <= len(line) <= 160 or offset < 0
                        or normalized_right.find(normalized_line, offset + 1) >= 0
                        or not offset <= start < end <= offset + len(line)):
                    continue
                within = [(a, b) for a, b in spans if offset <= a and b <= offset + len(line)]
                unchanged = len(line) - len(within)
                first, last = min(a for a, _b in within), max(b for _a, b in within)
                before, after = first - offset, offset + len(line) - last
                anchored = before >= 2 and after >= 2 or max(before, after) >= 5 and min(before, after) >= 0
                confidence = row["confidence"]
                if unchanged >= 6 and anchored and confidence is not None:
                    matches.append({**row, "line_key": normalized_line,
                                    "strong": confidence >= 85 or (confidence >= 60 and len(spans) == 1 and unchanged >= 7)})
                    break
        strong = [row for row in matches if row["strong"]]
        if not strong:
            groups: dict[str, list[dict[str, Any]]] = {}
            for row in matches:
                if row["confidence"] >= 40:
                    groups.setdefault(row["line_key"], []).append(row)
            strong = next((group for group in groups.values() if len({row["timestamp_ms"] for row in group}) >= 3 and _quorum(group)), [])
        if not strong:
            return []
        hits.update((row["id"], row) for row in strong)
    # A complete, strongly aligned competing caption is genuine uncertainty.
    for row in rows:
        if row["confidence"] is None or row["confidence"] < 85 or not source.start_ms <= row["timestamp_ms"] <= source.end_ms:
            continue
        for raw in row["text"].splitlines():
            line = _comparison_text(raw)
            if (len(line) == len(right) and line != right and SequenceMatcher(None, left, line, autojunk=False).ratio() >= .85
                    and re.sub("[他她它]", "它", line) != re.sub("[他她它]", "它", right)):
                return []
    return sorted(hits)


def _strong_subtitle_conflict(source: Any, candidate: str, rows: list[dict[str, Any]]) -> bool:
    left, right = _comparison_text(source.text), _comparison_text(candidate)
    spans = _chinese_substitutions(source.text, candidate)
    for row in rows:
        if row["confidence"] is None or row["confidence"] < 85 or not source.start_ms <= row["timestamp_ms"] <= source.end_ms:
            continue
        for raw in row["text"].splitlines():
            line = _comparison_text(raw)
            if (len(line) == len(left) and re.sub("[他她它]", "它", line) == re.sub("[他她它]", "它", left)
                    and re.sub("[他她它]", "它", line) != re.sub("[他她它]", "它", right)):
                return True
            offset = left.find(line)
            if (spans and len(line) >= 7 and offset >= 0 and left.find(line, offset + 1) < 0
                    and any(offset <= start < end <= offset + len(line) for start, end in spans)
                    and line != right[offset:offset + len(line)]):
                return True
    return False


def _aligned_repeated_evidence(original: str, candidate: str,
                               context: list[dict[str, Any]]) -> list[str]:
    """Prove each edit inside an actual line, including subtitle boundaries.

    Fixed +/-2-character fragments can extend beyond a subtitle boundary. An
    exact candidate substring with unchanged anchors on both sides avoids that
    false rejection without joining lines or borrowing an unrelated UI term.
    """
    spans = _chinese_substitutions(original, candidate)
    right = _comparison_text(candidate)
    if not spans:
        return []
    proven = set()
    for start, end in spans:
        hits = []
        for row in context:
            if row["confidence"] is None or row["confidence"] < 70:
                continue
            for raw in row["text"].splitlines():
                line = _comparison_text(raw)
                offset = right.find(line)
                if (not 7 <= len(line) <= 160 or offset < 0 or right.find(line, offset + 1) >= 0
                        or not offset < start < end < offset + len(line)
                        or len(line) - (end - start) < 6):
                    continue
                # All changes in this line must be bounded Chinese edits, and
                # each has real unchanged text on both sides in this same line.
                hits.append(row)
                break
        if not _quorum(hits):
            return []
        proven.update(row["id"] for row in hits)
    return sorted(proven)


def _aligned_single_evidence(source: Any, candidate: str,
                             context: list[dict[str, Any]]) -> list[str]:
    """One high-confidence complete subtitle may prove one Chinese character."""
    left, right = _comparison_text(source.text), _comparison_text(candidate)
    spans = _chinese_substitutions(source.text, candidate)
    if (len(spans) != 1 or spans[0][1] - spans[0][0] != 1 or not 10 <= len(right) <= 160
            or SequenceMatcher(None, left, right, autojunk=False).ratio() < .9):
        return []
    hits = []
    for row in context:
        if (row["confidence"] is None or row["confidence"] < 95
                or not source.start_ms <= row["timestamp_ms"] <= source.end_ms):
            continue
        for raw in row["text"].splitlines():
            line = _comparison_text(raw)
            if line == right:
                hits.append(row)
            elif (len(line) == len(left)
                  and SequenceMatcher(None, left, line, autojunk=False).ratio() >= .9):
                # Conflicting complete, equally strong subtitles cannot be
                # resolved by choosing whichever spelling the model preferred.
                return []
    return sorted({row["id"] for row in hits})


def _source_issues(source: Any, text: str, context: list[dict[str, Any]], names: list[dict[str, Any]]) -> list[str]:
    issues = []
    if "\ufffd" in text or re.search(r"(.)\1{5,}", text) or any(ord(char) < 32 and char not in "\n\t\r" for char in text):
        issues.append("source_contains_garbled_text")
    # A missing correction that conflicts with repeated aligned subtitles is
    # pending, even when the model simply echoes ASR without declaring doubt.
    errors, _refs = _validate_text(source.text, text, context, names)
    issues.extend(error for error in errors if error in {
        "numeric_or_version_changed", "negation_changed", "confirmed_name_changed",
        "technical_identifier_changed_without_ocr", "repeated_subtitle_correction_unapplied",
    })
    for anchor in _phrase_anchors(source.text, context):
        left, right = _comparison_text(text), _comparison_text(anchor["text"])
        # Subtitle omissions do not erase spoken material. Only conflicting
        # replacements in a strongly aligned repeated line require review.
        if any(op == "replace" and left[i:j] and right[k:l] for op, i, j, k, l in
               SequenceMatcher(None, left, right, autojunk=False).get_opcodes()):
            issues.append("repeated_subtitle_alignment_conflict")
            break
    return list(dict.fromkeys(issues))


def _patch_span(original: str, patch: Mapping[str, Any]) -> tuple[int, int] | None:
    before = patch.get("before")
    if not isinstance(before, str) or not before:
        return None
    start = original.find(before)
    if start < 0 or original.find(before, start + 1) >= 0:
        return None
    return start, start + len(before)


def _apply(original: str, patches: Sequence[Mapping[str, Any]]) -> str:
    spans = [(_patch_span(original, patch), patch["after"]) for patch in patches]
    text = original
    for span, after in sorted(spans, key=lambda row: row[0][0] if row[0] else -1, reverse=True):
        if span is not None:
            text = text[:span[0]] + after + text[span[1]:]
    return text


def _verify_patch(source: Any, patch: Any, context: list[dict[str, Any]],
                  names: list[dict[str, Any]], all_rows: list[dict[str, Any]]) -> tuple[list[str], list[str]]:
    if (not isinstance(patch, Mapping) or not _PATCH_FIELDS.issubset(patch)
            or set(patch) - _PATCH_FIELDS - {"edit_type", "context_basis"}):
        return ["patch_shape_invalid"], []
    if (patch.get("edit_type", "unknown") not in _EDIT_TYPES
            or patch.get("context_basis") is not None and not isinstance(patch.get("context_basis"), str)):
        return ["patch_shape_invalid"], []
    if type(patch["s"]) is not int or patch["s"] < 1:
        return ["patch_segment_identity_invalid"], []
    if not isinstance(patch["before"], str) or len(patch["before"]) > 2_000:
        return ["patch_before_invalid"], []
    if not isinstance(patch["after"], str) or len(patch["after"]) > 2_000:
        return ["patch_after_invalid"], []
    span = _patch_span(source.text, patch)
    if span is None:
        return ["patch_before_not_unique_in_source"], []
    refs = patch["evidence_ids"]
    allowed = {row["id"] for row in context} | {reference for name in names for reference in name["evidence_ids"]}
    actual = {row["id"]: row for row in all_rows}
    if not isinstance(refs, list) or len(refs) > 12 or any(not isinstance(ref, str) for ref in refs) or len(set(refs)) != len(refs) or any(ref not in actual for ref in refs):
        return ["patch_evidence_reference_invalid"], []
    candidate = _apply(source.text, [patch])
    errors, proven = _validate_text(source.text, candidate, context, names)
    errors = [error for error in errors if error != "repeated_subtitle_correction_unapplied"]
    errors.extend(_hard_edit_issues(source.text, candidate, names))
    if _strong_subtitle_conflict(source, candidate, all_rows):
        errors.append("strong_subtitle_conflict")
    # V2 adds a bounded alignment proof; legacy v1 helpers and hard factual
    # errors retain their original semantics. No proof waives those errors.
    aligned = (_local_subtitle_evidence(source, candidate, all_rows)
               or _aligned_repeated_evidence(source.text, candidate, context)
               or _aligned_single_evidence(source, candidate, context))
    common = _common_patch(source.text, candidate, patch)
    if (_common_shape(source.text, candidate, patch) and not aligned and not proven
            and (phonetic_issue := _common_phonetic_issue(source.text, candidate))):
        errors.append(phonetic_issue)
    if aligned or common:
        proven = sorted(set(proven) | set(aligned))
        errors = [error for error in errors if error != "text_changed_without_repeated_ocr"]
    if any(ref not in allowed for ref in refs) and not aligned:
        errors.append("patch_evidence_reference_invalid")
    if not _surface_only(patch["before"], patch["after"]) and not proven and not common:
        errors.append("lexical_patch_without_repeated_evidence")
    if any(ref not in actual for ref in proven):
        errors.append("derived_evidence_missing")
    return list(dict.fromkeys(errors)), sorted(set(proven) if aligned else set(proven) | set(refs))


def _punctuation(original: str, draft: str) -> bool:
    # Numeric normalization is NOT used here: punctuation is not permission to
    # turn 5.50 into 5.5, change digits, names, or add/remove spoken characters.
    def characters(text: str) -> str:
        result = []
        for index, char in enumerate(text):
            if char.isspace():
                continue
            lexical = (0 < index < len(text) - 1 and text[index - 1].isascii()
                       and text[index - 1].isalnum() and text[index + 1].isascii()
                       and text[index + 1].isalnum())
            if char in "，。！？、；：,.!?;:\"'“”‘’（）()[]【】…" and not lexical:
                continue
            result.append(char)
        return "".join(result)
    return isinstance(draft, str) and bool(draft.strip()) and characters(original) == characters(draft)


def _fresh_selection() -> dict[str, Any]:
    return {"reviewed": False, "patches": [], "punctuation": None,
            "rejected": [], "uncertain_reason": None, "candidate_text": None,
            "archived_rejections": [], "reference_rebindings": [], "confirmed_original": []}


@dataclass
class ReviewedTranscriptResult:
    status: str
    source_hash: str
    segments: list[dict[str, Any]]
    validation: dict[str, Any]
    analysis_transcript: TranscriptOutput
    diagnostics: dict[str, Any] = field(default_factory=dict)
    selections: dict[str, dict[str, Any]] = field(default_factory=dict, repr=False)
    trusted_manual: bool = False

    @property
    def paragraphs(self) -> list[str]:
        displayed = [{**row, "text": row["text"] if row["review_status"] == "accepted" else
                      f"【待核对 {_time(row['start_ms'])}】{row['original_text']}"} for row in self.segments]
        return [row["text"] for row in _paragraphs(displayed)]

    @property
    def review_context(self) -> dict[str, Any]:
        pending = [row for row in self.segments if row["review_status"] == "needs_review"]
        return {"total_segments": len(self.segments), "accepted_segments": len(self.segments) - len(pending),
                "uncertain_segment_ids": [row["source_segment_id"] for row in pending],
                "uncertain_ranges": [{key: row[key] for key in ("source_segment_id", "start_ms", "end_ms")} for row in pending],
                "first_source_segment_id": self.segments[0]["source_segment_id"] if self.segments else None}

    @property
    def invalidated_cached_segment_ids(self) -> list[str]:
        return list(self.diagnostics.get("invalidated_cached_segment_ids", []))

    def to_dict(self) -> dict[str, Any]:
        return {"version": PROTOCOL_VERSION, "status": self.status,
                "segments": copy.deepcopy(self.segments), "paragraphs": self.paragraphs,
                "validation": copy.deepcopy(self.validation)}

    def to_checkpoint(self) -> dict[str, Any]:
        return {"version": PROTOCOL_VERSION, "status": self.status, "validation_version": VALIDATION_VERSION,
                "source_hash": self.source_hash, "trusted_manual": self.trusted_manual,
                "segments": copy.deepcopy(self.segments),
                "selections": copy.deepcopy(self.selections), "diagnostics": copy.deepcopy(self.diagnostics)}


def _result(transcript: TranscriptOutput, visuals: VisualOutput, selections: Mapping[str, Any],
            diagnostics: dict[str, Any], manual: bool = False) -> ReviewedTranscriptResult:
    ocr = _ocr_rows(visuals)
    names = _relevant_names(transcript, ocr)
    rows, accepted, sanitized = [], [], {}
    for index, source in enumerate(transcript.segments, 1):
        sid = f"transcript:{index:04d}"
        state = copy.deepcopy(selections.get(sid, _fresh_selection()))
        if not isinstance(state, dict):
            state = _fresh_selection()
        state = {**_fresh_selection(), **state}
        issues, refs, verified = [], set(), []
        context = _relevant_context(source, ocr)
        for patch in state.get("patches", []):
            if not isinstance(patch, Mapping) or patch.get("s") != index:
                issues.append("patch_segment_identity_invalid")
                continue
            errors, evidence = _verify_patch(source, patch, context, names, ocr)
            if errors:
                issues.extend(errors)
                rejected = {"patch": dict(patch), "issues": errors,
                            "origin": "cached_patch_revalidation"}
                if rejected not in state["rejected"]:
                    state["rejected"].append(rejected)
                state["candidate_text"] = _apply(source.text, [patch])
                invalidated = diagnostics.setdefault("invalidated_cached_segment_ids", [])
                if sid not in invalidated:
                    invalidated.append(sid)
            else:
                span = _patch_span(source.text, patch)
                if any(span[0] < other[1] and other[0] < span[1] for other in
                       [_patch_span(source.text, item) for item in verified]):
                    issues.append("patches_overlap")
                    continue
                verified.append(dict(patch)); refs.update(evidence)
        draft = _apply(source.text, verified)
        common_patches = [patch for patch in verified if patch.get("edit_type") in _COMMON_TYPES
                          and not _local_subtitle_evidence(source, _apply(source.text, [patch]), ocr)
                          and not _validate_text(source.text, _apply(source.text, [patch]), context, names)[1]]
        if common_patches and not _common_shape(source.text, draft, {"edit_type": "common_word", "context_basis": "combined"}):
            issues.append("common_edit_cumulative_limit")
        issues.extend(_hard_edit_issues(source.text, draft, names))
        punctuation = state.get("punctuation")
        if punctuation is not None:
            if _punctuation(draft, punctuation):
                draft = punctuation.strip()
            else:
                issues.append("punctuation_changes_source_characters")
        if not state.get("reviewed"):
            issues.append("not_reviewed")
        if state.get("uncertain_reason"):
            issues.append("model_declared_uncertain")
        for rejected in state.get("rejected", []):
            if isinstance(rejected, Mapping):
                issues.extend(rejected.get("issues", ["rejected_patch_unresolved"]))
        if manual:
            draft, issues, refs = source.text, [], set()
            state = {**_fresh_selection(), "reviewed": True}
        else:
            source_issues = _source_issues(source, draft, context, names)
            if common_patches and not _strong_subtitle_conflict(source, draft, ocr):
                source_issues = [issue for issue in source_issues if issue not in {
                    "repeated_subtitle_correction_unapplied", "repeated_subtitle_alignment_conflict"}]
            issues.extend(source_issues)
        issues = list(dict.fromkeys(issues))
        pending = bool(issues)
        row = {"source_segment_id": sid, "start_ms": source.start_ms, "end_ms": source.end_ms,
               "text": source.text if pending else draft, "original_text": source.text,
               "candidate_text": state.get("candidate_text") if pending else None,
               "review_status": "needs_review" if pending else "accepted",
               "issues": issues, "evidence_ids": sorted(refs)}
        rows.append(row)
        accepted.append(ReviewedSegment(source.start_ms, source.end_ms, "" if pending else draft, source.confidence))
        state["patches"] = verified
        sanitized[sid] = state
        diagnostics.setdefault("correction_sources", {}).pop(sid, None)
        if not pending and source.text != draft:
            diagnostics.setdefault("correction_sources", {})[sid] = "subtitle" if refs else "context"
    all_issues = [f"{row['source_segment_id']}:{issue}" for row in rows for issue in row["issues"]]
    status = "not_applicable" if not rows else "needs_review" if all_issues else "completed"
    return ReviewedTranscriptResult(status, _source_hash(transcript, visuals, manual), rows,
        {"passed": not all_issues, "issues": all_issues},
        TranscriptOutput(transcript.language, tuple(accepted), transcript.confidence), diagnostics, sanitized, manual)


def _batch_payload(batch_id: str, ids: list[int], transcript: TranscriptOutput, visuals: VisualOutput,
                   selections: Mapping[str, Any], repair: bool, *, explicit_review: bool = False) -> dict[str, Any]:
    rows = _ocr_rows(visuals)
    names = _relevant_names(transcript, rows)
    used: dict[str, dict[str, Any]] = {}
    segments = []
    for index in ids:
        source = transcript.segments[index - 1]
        context = _relevant_context(source, rows)
        for row in context:
            used[row["id"]] = row
        state = selections[f"transcript:{index:04d}"]
        segments.append({"s": index, "text": source.text, "start_ms": source.start_ms, "end_ms": source.end_ms,
                         "protected_numbers": protected_numeric_facts(source.text),
                         "context_before": transcript.segments[index - 2].text[:160] if index > 1 else None,
                         "context_after": transcript.segments[index].text[:160] if index < len(transcript.segments) else None,
                         "ocr_refs": [row["id"] for row in context],
                         **({"previous_rejected": state.get("rejected", []),
                             "previous_uncertain": state.get("uncertain_reason"),
                             "history_note": "previous_*是旧轮历史定位信息，可能包含已过时的无OCR/无重复OCR门槛，不是本轮规则。verified_patches是服务器已验证选择，保留。",
                             "verified_patches": state.get("patches", [])} if repair else {})})
    relevant = [{"term": row["term"], "evidence_ids": row["evidence_ids"]} for row in names
                if any(_comparison_text(row["term"]) in _comparison_text(item["text"])
                       or any(ref in item["ocr_refs"] for ref in row["evidence_ids"]) for item in segments)]
    for name in relevant:
        for row in rows:
            if row["id"] in name["evidence_ids"]:
                used.setdefault(row["id"], {**row, "text": name["term"]})
    return {"protocol_version": PROTOCOL_VERSION, "batch_id": batch_id,
            "review_mode": "explicit_recheck" if explicit_review else "format_repair" if repair else "initial_review",
            "segments": segments, "ocr": list(used.values()), "confirmed_names": relevant,
            "instructions": [
                "Review ONLY supplied segments as continuous speech. Return patches, uncertain and optional punctuation. Do not rewrite whole sentences for style.",
                "patches:[{s,before,after,evidence_ids,edit_type,context_basis}]. s is the original GLOBAL segment number. before must occur exactly once; give the MINIMAL unique word span, never a rewritten whole row. Patches cannot overlap.",
                "普通中文听写小词可由同音/近音、语法搭配及给定上下文校正，不需要OCR；每个改字的实际读音必须相同或近似，不能只因原词不顺就换成读音无关的词。edit_type=orthography或common_word，context_basis简述依据；同一原句累计仅1–3汉字等长替换，保留率至少85%。无OCR时evidence_ids为空，不制造引用。不得为顺口改风格或删口头的/重复词。",
                "数字、版本、金额、否定、主体、极性、专名硬保护。name/fact/unknown不走普通词规则；不得把人名产品名、买卖/增减/好差评价变化伪装common_word。复杂乱码、概念猜换或不完整尾词仍uncertain，不补新事实。",
                "本段真实单条字幕可以局部佐证2–3汉字，必须覆盖实际改字并有充分未改锚点；不跨行拼句，不抄整屏文章。引用实际ocr_refs，遇到字幕相互冲突仍uncertain。",
                "For punctuation:[{s,text}], preserve EVERY source character after verified patches; only add punctuation/spacing, no wording changes. Contextually punctuate continuous Chinese speech; do not mechanically end every short ASR fragment.",
                "只有确实多解、乱码未解、实体/事实变化或字幕冲突才给uncertain:[{s,reason}]，reason用引号明确仍未解的原文词。单纯无OCR不是普通词的疑点。改完一个词但其他乱码仍在时，保留其uncertain；不要照抄乱码冒称完成。",
                "这是用户显式按句复审：按当前规则独立重新审核所有给定原句，即使previous_rejected为空也可首次提出typed最小补丁。不继承历史缺OCR理由。对历史仅因缺OCR而误疑、现在明确通顺无需改字的普通原词，可用confirmed_original:[{s,text,basis}]逐项确认精确原文子串；不能确认实体/事实/乱码/不完整尾词来绕过保护。每个未解疑点仍如实uncertain。" if explicit_review else
                "This is one directed format repair: fix the concrete previous proposal errors using original before strings and preserve verified patches. Ordinary word correction may use context; still report genuine unresolved uncertainty honestly." if repair else
                "Review all supplied segments. A rejected doubtful edit will affect only its own source segment, never the other speech.",
            ]}


def _hard_history_risk(reason: str) -> bool:
    return any(word in reason for word in ("乱码", "多处", "连续", "剩余", "还有", "另有", "尾词", "尾句", "句尾", "不完整", "人名", "品牌", "专名", "实体", "后半", "末段", "听不清", "名字", "名称", "概念", "数字", "数值", "版本", "金额", "币种", "单位", "否定", "主体", "极性"))


def _historical_suspects(reason: str, original: str) -> list[str]:
    suspects = []
    for match in re.finditer(r'[“「『"]([^”」』"]+)[”」』"]', reason):
        word = match.group(1)
        if word in original and not re.search(r"(?:仅能确认|只确认|仅确认|只覆盖|仅覆盖|已经确认|已确认).{0,3}$", reason[:match.start()]):
            suspects.append(word)
    return suspects


def _valid_original_confirmation(source: Any, draft: str, record: Mapping[str, Any],
                                 patches: Sequence[Mapping[str, Any]], names: list[dict[str, Any]], reason: Any) -> bool:
    text, basis = record.get("text"), record.get("basis")
    if (not isinstance(text, str) or not text or len(text) > 240 or not isinstance(basis, str)
            or not basis.strip() or len(basis) > 240 or _hard_history_risk(str(reason or ""))):
        return False
    span = _patch_span(source.text, {"before": text})
    if span is None or _patch_span(draft, {"before": text}) is None:
        return False
    if any((other := _patch_span(source.text, patch)) is not None and span[0] < other[1] and other[0] < span[1] for patch in patches):
        return False
    masked = source.text[:span[0]] + "□" * len(text) + source.text[span[1]:]
    return (not _hard_edit_issues(source.text, masked, names)
            and not re.search(r"[A-Za-z]|\ufffd|(.)\1{5,}", text))


def _uncertainty_resolved(reason: Any, source: Any, draft: str, rows: list[dict[str, Any]],
                          *, context_reviewed: bool = False, confirmed_original: Sequence[Mapping[str, Any]] = ()) -> bool:
    if not reason:
        return True
    context = _relevant_context(source, rows)
    if _aligned_confirmation(draft, context):
        return True
    suspects = _historical_suspects(str(reason), source.text)
    missing_ocr = bool(re.search(r"OCR|字幕|画面文字", str(reason), re.IGNORECASE)
                       and re.search(r"没有|缺|无|不能确认|无法确认|不足|只确认|仅|未重复", str(reason)))
    if (confirmed_original and missing_ocr and not _hard_history_risk(str(reason)) and suspects
            and all(word not in draft or any(word in record["text"] for record in confirmed_original) for word in suspects)):
        return True
    if _comparison_text(draft) == _comparison_text(source.text):
        return False
    # Full local subtitle coverage can resolve the whole source, including short
    # segments where a two-character correction exceeds the context-only limit.
    if _local_subtitle_evidence(source, draft, rows) and any(
        re.sub("[他她它]", "它", _comparison_text(line)) == re.sub("[他她它]", "它", _comparison_text(draft))
        for row in _context(source, rows) for line in row["text"].splitlines()
    ):
        return True
    if _hard_history_risk(str(reason)):
        return False
    if "指代" in reason and _surface_only(source.text, draft):
        return True
    bounded = _common_shape(source.text, draft, {"edit_type": "common_word", "context_basis": "resolved_scope"})
    return bool(bounded and (suspects and all(word not in draft for word in suspects)
                             or context_reviewed and str(reason).startswith("review_request_failed:")))


def _old_proposal_resolved(source: Any, candidate: str, old_proposal: str,
                           *, discard_particle_deletion: bool) -> bool:
    left, right, previous = _comparison_text(source.text), _comparison_text(candidate), _comparison_text(old_proposal)
    if len(left) != len(right):
        return False
    saw_change = False
    for operation, start, end, other_start, other_end in SequenceMatcher(None, left, previous, autojunk=False).get_opcodes():
        if operation == "equal":
            continue
        saw_change = True
        if (operation == "delete" and discard_particle_deletion
                and left[start:end] and set(left[start:end]) <= set("的地得")):
            continue
        if operation != "replace" or end - start != other_end - other_start or right[start:end] != previous[other_start:other_end]:
            return False
    return saw_change or _punctuation(candidate, old_proposal)


def _consume(response: Any, ids: list[int], transcript: TranscriptOutput, visuals: VisualOutput,
             selections: dict[str, dict[str, Any]], repair: bool, *, allow_original_confirmation: bool = False) -> None:
    if hasattr(response, "model_dump"):
        response = response.model_dump(mode="json")
    if not isinstance(response, Mapping) or set(response) - {"patches", "uncertain", "punctuation", "confirmed_original"} or not all(
        isinstance(response.get(key, []), list) for key in ("patches", "uncertain", "punctuation", "confirmed_original")
    ) or "patches" not in response or "uncertain" not in response:
        raise ValueError("review_response_shape_invalid")
    if any(len(response.get(key, [])) > limit for key, limit in (("patches", 144), ("uncertain", 48), ("punctuation", 48), ("confirmed_original", 96))):
        raise ValueError("review_response_limit_exceeded")
    allowed = set(ids)
    by_segment = {index: [] for index in ids}
    uncertainty, punctuation = {}, {}
    confirmations: dict[int, list[dict[str, Any]]] = {index: [] for index in ids}
    for row in response.get("confirmed_original", []):
        if (not isinstance(row, Mapping) or set(row) != {"s", "text", "basis"}
                or type(row["s"]) is not int or row["s"] not in allowed):
            raise ValueError("review_confirmation_invalid")
        confirmations[row["s"]].append(dict(row))
    for key in ("patches", "uncertain", "punctuation"):
        for row in response.get(key, []):
            if not isinstance(row, Mapping) or type(row.get("s")) is not int or row["s"] not in allowed:
                raise ValueError("review_segment_identity_invalid")
            if key == "patches":
                by_segment[row["s"]].append(dict(row))
            elif key == "uncertain":
                if row["s"] in uncertainty or set(row) != {"s", "reason"} or not isinstance(row["reason"], str) or not row["reason"].strip():
                    raise ValueError("review_uncertainty_invalid")
                uncertainty[row["s"]] = row["reason"][:240]
            else:
                if row["s"] in punctuation or set(row) != {"s", "text"} or not isinstance(row["text"], str):
                    raise ValueError("review_punctuation_invalid")
                punctuation[row["s"]] = row["text"]
    rows = _ocr_rows(visuals)
    names = _relevant_names(transcript, rows)
    for index in ids:
        source, sid = transcript.segments[index - 1], f"transcript:{index:04d}"
        old = selections[sid]
        state = {**_fresh_selection(), **copy.deepcopy(old)} if repair else _fresh_selection()
        state["reviewed"] = True
        safe, rejected = list(state["patches"]), []
        raw = by_segment[index]
        for patch in raw:
            errors, verified_refs = _verify_patch(source, patch, _relevant_context(source, rows), names, rows)
            span = _patch_span(source.text, patch)
            if not errors and any(all(patch.get(key) == other.get(key) for key in ("s", "before", "after")) for other in safe):
                continue
            if not errors and any(span[0] < previous[1] and previous[0] < span[1]
                                  for previous in [_patch_span(source.text, other) for other in safe]):
                errors = ["patches_overlap"]
            if errors:
                rejected.append({"patch": dict(patch), "issues": errors})
            else:
                selected = dict(patch)
                if verified_refs and set(patch["evidence_ids"]) != set(verified_refs):
                    state["reference_rebindings"].append({"before": patch["evidence_ids"], "after": verified_refs,
                                                          "reason": "actual_local_subtitle_alignment"})
                    selected["evidence_ids"] = verified_refs
                safe.append(selected)
        draft = _apply(source.text, safe)
        if (any(patch.get("edit_type") in _COMMON_TYPES for patch in safe)
                and not _common_shape(source.text, draft, {"edit_type": "common_word", "context_basis": "combined"})
                and any(patch.get("edit_type") in _COMMON_TYPES and not _local_subtitle_evidence(source, _apply(source.text, [patch]), rows)
                        and not _validate_text(source.text, _apply(source.text, [patch]), _relevant_context(source, rows), names)[1] for patch in safe)):
            additions = [patch for patch in safe if patch not in old.get("patches", [])]
            rejected.extend({"patch": patch, "issues": ["common_edit_cumulative_limit"]} for patch in additions)
            safe = [patch for patch in safe if patch not in additions]
            draft = _apply(source.text, safe)
        proposed = _apply(source.text, [patch for patch in raw if _patch_span(source.text, patch) is not None
                                       and isinstance(patch.get("after"), str)])
        if repair:
            for record in confirmations[index]:
                if (allow_original_confirmation and _valid_original_confirmation(source, draft, record, safe, names, old.get("uncertain_reason"))):
                    if record not in state["confirmed_original"]:
                        state["confirmed_original"].append(record)
                else:
                    rejected.append({"patch": {}, "issues": ["original_confirmation_protected_or_not_unchanged"]})
            faithful_common = (any(patch.get("edit_type") in _COMMON_TYPES for patch in raw)
                               and _common_shape(source.text, draft, {"edit_type": "common_word", "context_basis": "replacement"})
                               and not _hard_edit_issues(source.text, draft, names))
            for previous in old.get("rejected", []):
                previous_issues = set(previous.get("issues", []))
                old_patch = previous.get("patch", {})
                previous_span = _patch_span(source.text, old_patch)
                old_proposal = (_apply(source.text, [old_patch]) if previous_span is not None
                                and isinstance(old_patch.get("after"), str) else old.get("candidate_text"))
                resolved = isinstance(old_proposal, str) and _old_proposal_resolved(
                    source, draft, old_proposal, discard_particle_deletion=faithful_common)
                if (previous.get("origin") == "cached_patch_revalidation" and previous_span is not None
                        and previous_issues & {"common_phonetic_mismatch", "common_phonetic_unavailable"}
                        and previous_issues.issubset(_SOFT_REJECTIONS)
                        and any(len(patch["before"]) <= 3 and (span := _patch_span(source.text, patch)) is not None
                                and span[0] <= previous_span[0] and span[1] >= previous_span[1] for patch in safe)):
                    resolved = True
                if (previous_span is None and previous_issues <= {"patch_shape_invalid", "patch_before_invalid", "patch_after_invalid", "patch_before_not_unique_in_source"}
                        and isinstance(old_patch.get("before"), str) and isinstance(old_patch.get("after"), str)
                        and any(patch["before"] in old_patch["before"] and patch["after"] == old_patch["after"] for patch in safe)):
                    resolved = True
                if (previous.get("issues") == ["punctuation_changes_source_characters"]
                        and ((index in punctuation and _punctuation(draft, punctuation[index]))
                             or (isinstance(old.get("candidate_text"), str)
                                 and _punctuation(draft, old["candidate_text"])))):
                    resolved = True
                if resolved and previous_issues.issubset(_SOFT_REJECTIONS):
                    state["archived_rejections"].append({**previous, "resolution": "superseded_by_verified_minimal_patch"})
                    continue
                if (not previous_issues.issubset(_SOFT_REJECTIONS)
                        or not resolved and not _aligned_confirmation(draft, _relevant_context(source, rows))):
                    rejected.append(previous)
            sticky_uncertain = None if _uncertainty_resolved(old.get("uncertain_reason"), source, draft, rows,
                                                            context_reviewed=faithful_common,
                                                            confirmed_original=state["confirmed_original"] if allow_original_confirmation else ()) else old.get("uncertain_reason")
        else:
            sticky_uncertain = None
        state.update(patches=safe, rejected=rejected,
                     uncertain_reason=uncertainty.get(index) or sticky_uncertain,
                     candidate_text=proposed if raw else old.get("candidate_text"))
        if index in punctuation:
            if _punctuation(draft, punctuation[index]):
                state["punctuation"] = punctuation[index]
            else:
                state["rejected"].append({"patch": {}, "issues": ["punctuation_changes_source_characters"]})
                state["candidate_text"] = punctuation[index]
        elif raw:
            state["punctuation"] = None
        selections[sid] = state


def _batches(transcript: TranscriptOutput) -> list[list[int]]:
    batches: list[list[int]] = []
    for index, segment in enumerate(transcript.segments, 1):
        if not batches or len(batches[-1]) >= MAX_BATCH_SEGMENTS or sum(len(transcript.segments[item - 1].text) for item in batches[-1]) + len(segment.text) > MAX_BATCH_CHARACTERS:
            batches.append([])
        batches[-1].append(index)
    return batches


def _needs_automatic_repair(state: Mapping[str, Any]) -> bool:
    issues = {issue for row in state.get("rejected", []) if isinstance(row, Mapping)
              for issue in row.get("issues", [])}
    # A second identical question cannot resolve uncertain speech or a hard
    # factual conflict. Repair is only for concrete patch-format/localization
    # feedback; explicit user-selected review may still ask once afresh.
    return bool(issues & _REPAIRABLE_REJECTIONS and not issues - _SOFT_REJECTIONS)


def restore_reviewed_transcript(checkpoint: Any, transcript: TranscriptOutput, visuals: VisualOutput,
                                *, trusted_manual: bool = False) -> ReviewedTranscriptResult | None:
    if (not isinstance(checkpoint, Mapping) or checkpoint.get("version") != PROTOCOL_VERSION
            or checkpoint.get("validation_version") != VALIDATION_VERSION
            or checkpoint.get("trusted_manual") is not trusted_manual
            or checkpoint.get("source_hash") != _source_hash(transcript, visuals, trusted_manual)):
        return None
    states = checkpoint.get("selections")
    expected = {f"transcript:{index:04d}" for index in range(1, len(transcript.segments) + 1)}
    if not isinstance(states, Mapping) or set(states) != expected:
        return None
    recorded = checkpoint.get("segments")
    if not isinstance(recorded, list) or len(recorded) != len(expected):
        return None
    for index, (row, source) in enumerate(zip(recorded, transcript.segments, strict=True), 1):
        if (not isinstance(row, Mapping) or row.get("source_segment_id") != f"transcript:{index:04d}"
                or (row.get("start_ms"), row.get("end_ms"), row.get("original_text")) != (source.start_ms, source.end_ms, source.text)):
            return None
        state = states[f"transcript:{index:04d}"]
        legacy_fields = set(_fresh_selection()) - {"archived_rejections", "reference_rebindings", "confirmed_original"}
        if (not isinstance(state, Mapping) or not legacy_fields.issubset(state) or set(state) - set(_fresh_selection())
                or type(state.get("reviewed")) is not bool or not isinstance(state.get("patches"), list)
                or not isinstance(state.get("rejected"), list)
                or any(key in state and not isinstance(state[key], list) for key in ("archived_rejections", "reference_rebindings", "confirmed_original"))
                or any(state.get(key) is not None and not isinstance(state.get(key), str)
                       for key in ("punctuation", "uncertain_reason", "candidate_text"))):
            return None
    try:
        result = _result(transcript, visuals, states,
                         {**copy.deepcopy(checkpoint.get("diagnostics", {})), "restored": True}, trusted_manual)
    except (TypeError, ValueError, KeyError, IndexError):
        return None
    if any(old.get("review_status") == "needs_review" and new["review_status"] == "accepted"
           for old, new in zip(recorded, result.segments, strict=True)):
        return None
    return result


def _local_revalidation(ids: list[int], transcript: TranscriptOutput, visuals: VisualOutput,
                        selections: dict[str, dict[str, Any]], diagnostics: dict[str, Any]) -> list[int]:
    """Explicit repair only: retry saved proposals against existing real proof.

    A model-declared doubt with no newly proven rejected patch is not erased.
    Unresolved trials are discarded, so repeated local attempts never duplicate
    old rejection records or change the paid repair's original feedback.
    """
    ocr, recovered = _ocr_rows(visuals), []
    names = _relevant_names(transcript, ocr)

    def actually_proven(source: Any, patch: Any, context: list[dict[str, Any]]) -> bool:
        errors, _refs = _verify_patch(source, patch, context, names, ocr)
        if errors:
            return False
        candidate = _apply(source.text, [patch])
        return bool(_validate_text(source.text, candidate, context, names)[1]
                    or _common_patch(source.text, candidate, patch)
                    or _local_subtitle_evidence(source, candidate, ocr)
                    or _aligned_repeated_evidence(source.text, candidate, context)
                    or _aligned_single_evidence(source, candidate, context))

    for index in ids:
        sid, source = f"transcript:{index:04d}", transcript.segments[index - 1]
        old = selections[sid]
        rejected = old.get("rejected", [])
        proposals = [row["patch"] for row in rejected if isinstance(row, Mapping) and row.get("patch")]
        context = _relevant_context(source, ocr)

        try:
            newly_proven = any(actually_proven(source, patch, context) for patch in proposals)
            punctuation_only = (bool(rejected) and not old.get("uncertain_reason")
                                and all(isinstance(row, Mapping) and row.get("issues") == ["punctuation_changes_source_characters"] for row in rejected)
                                and isinstance(old.get("candidate_text"), str)
                                and _punctuation(_apply(source.text, old["patches"]), old["candidate_text"])
                                and any(actually_proven(source, patch, context) for patch in old["patches"]))
            if not newly_proven and not punctuation_only:
                continue
            trial = copy.deepcopy(selections)
            _consume({"patches": proposals, "uncertain": []}, [index], transcript, visuals, trial, True, allow_original_confirmation=True)
            checked = _result(transcript, visuals, trial, diagnostics)
            row = checked.segments[index - 1]
            if row["review_status"] == "accepted" and (row["evidence_ids"] or any(
                patch.get("edit_type") in _COMMON_TYPES for patch in checked.selections[sid]["patches"]
            )):
                selections[sid] = checked.selections[sid]
                recovered.append(index)
        except (TypeError, ValueError, KeyError, IndexError):
            # A malformed/incomplete saved proposal remains reviewable and goes
            # through the bounded directed callback; it is never silently used.
            continue
    return recovered


def build_reviewed_transcript(transcript: TranscriptOutput, visuals: VisualOutput, request: Callable,
                              *, max_output_tokens: int = 6000, resume: Any = None,
                              repair_segment_ids: Sequence[str] | None = None,
                              on_checkpoint: Callable[[dict[str, Any]], None] | None = None,
                              trusted_manual: bool = False) -> ReviewedTranscriptResult:
    if max_output_tokens < 1:
        raise ValueError("max_output_tokens must be positive")
    restored = restore_reviewed_transcript(resume, transcript, visuals, trusted_manual=trusted_manual)
    selections = copy.deepcopy(restored.selections) if restored else {
        f"transcript:{index:04d}": _fresh_selection() for index in range(1, len(transcript.segments) + 1)}
    diagnostics = {"request_count": 0, "batches": [], "restored": bool(restored)}
    targets = set(repair_segment_ids or [])
    if restored and restored.invalidated_cached_segment_ids:
        diagnostics["invalidated_cached_segment_ids"] = restored.invalidated_cached_segment_ids
        if targets:
            targets.update(restored.invalidated_cached_segment_ids)
    if targets - set(selections):
        raise ValueError("repair target does not exist in original source")

    def snapshot() -> ReviewedTranscriptResult:
        return _result(transcript, visuals, selections, diagnostics, trusted_manual)

    def checkpoint() -> None:
        if on_checkpoint:
            on_checkpoint(snapshot().to_checkpoint())

    if trusted_manual:
        for state in selections.values():
            state["reviewed"] = True
        result = snapshot()
        if on_checkpoint:
            on_checkpoint(result.to_checkpoint())
        return result
    checkpoint()
    for batch_index, batch in enumerate(_batches(transcript), 1):
        batch_id = f"canonical:{batch_index:04d}"
        ids = [index for index in batch if (f"transcript:{index:04d}" in targets if targets else
                                           not selections[f"transcript:{index:04d}"]["reviewed"])]
        ids = [index for index in ids if len(transcript.segments[index - 1].text) <= MAX_BATCH_CHARACTERS]
        if not ids:
            continue
        if targets and restored:
            recovered = _local_revalidation(ids, transcript, visuals, selections, diagnostics)
            if recovered:
                diagnostics.setdefault("local_revalidated_segment_ids", []).extend(
                    f"transcript:{index:04d}" for index in recovered)
                diagnostics["batches"].append({"batch_id": batch_id, "task": "canonical_local_revalidation",
                                              "segment_ids": [f"transcript:{index:04d}" for index in recovered],
                                              "status": "completed", "paid": False, "reused_evidence": True})
                checkpoint()
                ids = [index for index in ids if index not in recovered]
            if not ids:
                continue
        is_repair = bool(targets)
        tasks = ["canonical_repair"] if is_repair else ["canonical_review", "canonical_repair"]
        for task in tasks:
            current = snapshot()
            pending = {row["source_segment_id"] for row in current.segments if row["review_status"] == "needs_review"}
            task_ids = ids if task == "canonical_review" else [index for index in ids if f"transcript:{index:04d}" in pending]
            if task == "canonical_repair" and not targets:
                task_ids = [index for index in task_ids if _needs_automatic_repair(selections[f"transcript:{index:04d}"])]
            if not task_ids:
                break
            payload = _batch_payload(batch_id, task_ids, transcript, visuals, selections, task == "canonical_repair", explicit_review=bool(targets))
            event = {"batch_id": batch_id, "task": task, "segment_ids": [f"transcript:{index:04d}" for index in task_ids]}
            try:
                diagnostics["request_count"] += 1
                response = request(task, payload, max_output_tokens)
                _consume(response, task_ids, transcript, visuals, selections, task == "canonical_repair", allow_original_confirmation=bool(targets))
                event["status"] = "completed"
            except Exception as error:  # noqa: BLE001 - preserve all source and successful segments
                kind = getattr(error, "safe_failure_kind", None) or type(error).__name__
                event.update(status="failed", failure_kind=str(kind)[:100])
                if task == "canonical_review":
                    for index in task_ids:
                        state = selections[f"transcript:{index:04d}"]
                        state.update(reviewed=True, uncertain_reason="review_request_failed:" + str(kind)[:100])
                # Never turn budget exhaustion or a repair transport failure into
                # whole-manuscript failure or perform an additional blind call.
                diagnostics["batches"].append(event)
                checkpoint()
                break
            diagnostics["batches"].append(event)
            # Save one updated batch: every original ordinal selection is kept,
            # without writing the same full document once per source row.
            checkpoint()
    return snapshot()


@lru_cache(maxsize=1)
def create_review_response_model() -> Any:
    from pydantic import ConfigDict, Field, create_model
    config = ConfigDict(extra="forbid")
    patch = create_model("CanonicalReviewPatch", __config__=config,
                         s=(int, Field(ge=1, strict=True)), before=(str, Field(min_length=1, max_length=2000)),
                         after=(str, Field(max_length=2000)), evidence_ids=(list[str], Field(max_length=12)),
                         edit_type=(Literal["orthography", "common_word", "name", "fact", "unknown"], Field(default="unknown")),
                         context_basis=(str | None, Field(default=None, max_length=240)))
    uncertain = create_model("CanonicalReviewUncertain", __config__=config,
                             s=(int, Field(ge=1, strict=True)), reason=(str, Field(min_length=1, max_length=240)))
    punctuation = create_model("CanonicalReviewPunctuation", __config__=config,
                               s=(int, Field(ge=1, strict=True)), text=(str, Field(min_length=1, max_length=12000)))
    confirmed = create_model("CanonicalReviewOriginalConfirmation", __config__=config,
                             s=(int, Field(ge=1, strict=True)), text=(str, Field(min_length=1, max_length=240)),
                             basis=(str, Field(min_length=1, max_length=240)))
    return create_model("CanonicalReviewResponse", __config__=config,
                        patches=(list[patch], Field(max_length=144)),
                        uncertain=(list[uncertain], Field(max_length=48)),
                        punctuation=(list[punctuation], Field(default_factory=list, max_length=48)),
                        confirmed_original=(list[confirmed], Field(default_factory=list, max_length=96)))


def create_repair_response_model() -> Any:
    return create_review_response_model()
