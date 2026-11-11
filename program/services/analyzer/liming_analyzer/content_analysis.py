"""Evidence-bound content annotations; deliberately importable without any model SDK."""

from __future__ import annotations

import json
import re
from collections.abc import Callable, Mapping, Sequence
from functools import lru_cache
from importlib.resources import files
from itertools import pairwise
from typing import Any, Literal

MODULES = (
    "text_topic_structure_audience",
    "text_expression_value",
    "visual",
    "synthesis",
)
STATES = ("known", "unknown", "not_acquired", "not_applicable")
_CLASS_FIELDS = {"dimension_id", "state", "tags", "primary_tag", "reason", "evidence_ids"}
_SEGMENT_FIELDS = {
    "id", "kind", "dimension_id", "tags", "start_ms", "end_ms", "text", "evidence_ids",
}
_UNIT_FIELDS = {"id", "type_tag", "text", "evidence_ids", "duplicate_of"}


@lru_cache(maxsize=1)
def _taxonomy() -> dict[str, Any]:
    resource = files("liming_analyzer").joinpath("resources/video-taxonomy.v1.json")
    return json.loads(resource.read_text(encoding="utf-8"))


def load_taxonomy() -> dict[str, Any]:
    """Return an independent copy so callers cannot mutate the shared registry."""
    return json.loads(json.dumps(_taxonomy(), ensure_ascii=False))


def _profile_budget(profile: str) -> dict[str, Any]:
    return _taxonomy()["budgets"]["max" if profile in {"max", "deep"} else "standard"]


def _get(value: Any, key: str, default: Any = None) -> Any:
    return value.get(key, default) if isinstance(value, Mapping) else getattr(value, key, default)


def _rows(value: Any) -> list[Any]:
    return list(value) if isinstance(value, Sequence) and not isinstance(value, (str, bytes)) else []


def _integer(value: Any) -> bool:
    return isinstance(value, int) and not isinstance(value, bool)


def _duration(media: Any) -> int | None:
    duration = _get(_get(media, "info", media), "duration_ms")
    return duration if _integer(duration) and duration >= 0 else None


def _valid_time(start: Any, end: Any, duration: int | None) -> bool:
    return (
        _integer(start) and _integer(end) and 0 <= start <= end
        and (duration is None or end <= duration)
    )


def _text(value: Any, limit: int = 2_000) -> bool:
    return isinstance(value, str) and bool(value.strip()) and len(value) <= limit


def _safe_asset(value: Any) -> str | None:
    # Storage IDs are useful; local filenames/paths must never enter model payloads.
    if isinstance(value, str) and re.fullmatch(r"[A-Za-z0-9_-]{1,160}", value):
        return value
    return None


def build_evidence_registry(media: Any, transcript: Any, visuals: Any) -> list[dict[str, Any]]:
    """Retain original text and source intervals, without inventing word alignment."""
    registry: list[dict[str, Any]] = []
    duration = _duration(media)

    def append(identifier: str, source: str, text: str, start: int, end: int,
               asset: str | None = None, group: str | None = None) -> None:
        registry.append({
            "id": identifier, "source": source, "text": text,
            "start_ms": start, "end_ms": end,
            "asset_ref": asset, "frame_group_id": group,
        })

    for index, segment in enumerate(_rows(_get(transcript, "segments", [])), 1):
        start, end, text = (_get(segment, key) for key in ("start_ms", "end_ms", "text"))
        if _valid_time(start, end, duration) and isinstance(text, str) and text.strip():
            append(f"transcript:{index:04d}", "transcript", text, start, end)

    frames = _rows(_get(visuals, "keyframes", []))
    frame_times: set[int] = set()
    for index, frame in enumerate(frames, 1):
        timestamp = _get(frame, "timestamp_ms")
        if not _valid_time(timestamp, timestamp, duration):
            continue
        frame_times.add(timestamp)
        asset = _safe_asset(_get(frame, "asset_id"))
        roles = _rows(_get(frame, "roles", []))
        append(f"frame:{index:04d}", "frame", "", timestamp, timestamp, asset,
               "first_frame" if "first_frame" in roles else None)
        text = _get(frame, "ocr_text")
        if isinstance(text, str) and text.strip():
            append(f"ocr:{index:04d}", "ocr", text, timestamp, timestamp, asset)

    vision_times: set[int] = set()
    for index, observation in enumerate(_rows(_get(visuals, "observations", [])), 1):
        if _get(observation, "kind") != "vision":
            continue
        start, end, text = (_get(observation, key) for key in ("start_ms", "end_ms", "text"))
        if _valid_time(start, end, duration) and isinstance(text, str) and text.strip():
            append(f"vision:{index:04d}", "vision", text, start, end)
            if start == end:
                vision_times.add(start)

    stats = _get(visuals, "stats", {})
    seen_groups: set[str] = set()
    for group in _rows(_get(stats, "temporal_groups", [])):
        group_id = _get(group, "group_id")
        timestamps = _rows(_get(group, "timestamps_ms", []))
        if not isinstance(group_id, str) or not re.fullmatch(r"[A-Za-z0-9_-]{1,80}", group_id):
            continue
        # Requiring both real extracted frames and understood frames prevents empty
        # manifests, two-frame guesses and fabricated group metadata from passing.
        if (
            group_id in seen_groups or _get(group, "source") != "ordered_sampled_frames"
            or len(timestamps) < 3 or not all(_integer(t) for t in timestamps)
            or timestamps != sorted(set(timestamps))
            or any(right - left > _taxonomy()["rules"]["temporal_max_gap_ms"]
                   for left, right in pairwise(timestamps))
            or not set(timestamps).issubset(frame_times & vision_times)
        ):
            continue
        start, end = timestamps[0], timestamps[-1]
        if not _valid_time(start, end, duration):
            continue
        seen_groups.add(group_id)
        append(f"temporal:{group_id}", "temporal", json.dumps({
            "kind": _get(group, "kind", "ordered_frames"), "timestamps_ms": timestamps,
            "limitations": _get(group, "limitations", []),
        }, ensure_ascii=False), start, end, group=group_id)
    return registry


def _available(dimension: Mapping[str, Any], sources: set[str]) -> bool:
    if dimension.get("requires_text") and not sources & {"transcript", "ocr"}:
        return False
    requirement = dimension["requires"]
    if requirement == "text":
        return bool(sources & {"transcript", "ocr"})
    if requirement == "visual":
        return "vision" in sources
    if requirement == "temporal":
        return {"vision", "temporal"}.issubset(sources)
    return bool(sources & {"transcript", "ocr", "vision"})


def _tag_modalities(tags: list[str], dimension: Mapping[str, Any], sources: set[str]) -> bool:
    selected = set(tags)
    return all(
        not tag.get("requires") or _available({"requires": tag["requires"]}, sources)
        for tag in dimension["tags"] if tag["id"] in selected
    )


def _first_frame_time(evidence: Sequence[Mapping[str, Any]]) -> int | None:
    frames = [row["start_ms"] for row in evidence if row["source"] == "frame" and (
        row["frame_group_id"] == "first_frame" or row["start_ms"] == 0
    )]
    return min(frames) if frames else None


def _dimension_acquired(dimension: Mapping[str, Any], evidence: Sequence[Mapping[str, Any]]) -> bool:
    if not _available(dimension, {row["source"] for row in evidence}):
        return False
    if dimension["id"].startswith("visual.first_frame"):
        first = _first_frame_time(evidence)
        return first is not None and any(
            row["source"] == "vision" and row["start_ms"] == first for row in evidence
        )
    if dimension["id"] == "visual.opening":
        return any(row["source"] == "vision" and row["start_ms"] < 3_000 for row in evidence)
    return True


def text_analysis_not_applicable(media: Any, transcript: Any, visuals: Any) -> bool:
    """Only declare text absent with explicit no-audio and successful empty OCR."""
    info = _get(media, "info", media)
    missing = object()
    if not _get(info, "video_codec") or _get(info, "audio_codec", missing) is not None:
        return False
    if any(isinstance(_get(row, "text"), str) and _get(row, "text").strip()
           for row in _rows(_get(transcript, "segments", []))):
        return False
    frames = _rows(_get(visuals, "keyframes", []))
    if not frames or any(isinstance(_get(row, "ocr_text"), str) and _get(row, "ocr_text").strip()
                         for row in frames):
        return False
    stats = _get(visuals, "stats", {})
    return (
        _get(stats, "ocr_error_count") == 0 and _integer(_get(stats, "ocr_error_count"))
        and _get(stats, "ocr_observation_count") == 0
        and _integer(_get(stats, "ocr_observation_count"))
        and any(_get(row, "kind") == "vision" and _text(_get(row, "text"), 10_000)
                for row in _rows(_get(visuals, "observations", [])))
    )


def _empty_classification(dimension: Mapping[str, Any], available: bool) -> dict[str, Any]:
    return {
        "dimension_id": dimension["id"],
        "state": "unknown" if available else "not_acquired",
        "tags": None, "primary_tag": None,
        "reason": "classification_not_returned" if available else f"{dimension['requires']}_evidence_not_acquired",
        "evidence_ids": [],
    }


def _evidence_ids(value: Any, evidence: Mapping[str, Any]) -> list[str] | None:
    if (
        not isinstance(value, list) or len(value) > 24
        or any(not isinstance(item, str) or item not in evidence for item in value)
        or len(set(value)) != len(value)
    ):
        return None
    return value


def _tags(value: Any, dimension: Mapping[str, Any]) -> bool:
    if not isinstance(value, list) or any(not isinstance(item, str) for item in value):
        return False
    allowed = {tag["id"] for tag in dimension["tags"] if not tag.get("disabled")}
    none = dimension["none_tag_id"]
    return (
        len(set(value)) == len(value) and set(value).issubset(allowed)
        and (dimension["cardinality"] != "single" or len(value) <= 1)
        and (none is None or (bool(value) and (none not in value or value == [none])))
    )


def _validate_classification(
    row: Any, dimension: Mapping[str, Any], evidence: Mapping[str, Any], *, complete: bool,
) -> tuple[dict[str, Any] | None, str | None]:
    if not isinstance(row, Mapping) or set(row) != _CLASS_FIELDS:
        return None, "classification_shape"
    if row.get("dimension_id") != dimension["id"] or row.get("state") not in STATES:
        return None, "classification_identity_or_state"
    refs = _evidence_ids(row.get("evidence_ids"), evidence)
    if refs is None:
        return None, "invalid_evidence_reference"
    state, tags, primary, reason = (row.get(key) for key in ("state", "tags", "primary_tag", "reason"))
    if state != "known":
        if tags is not None or primary is not None or not _text(reason, 600):
            return None, "nonknown_requires_null_and_reason"
    else:
        if not _tags(tags, dimension):
            return None, "invalid_tag_selection"
        if (primary is not None and primary not in tags) or (
            dimension["primary_required"] and tags and primary is None
        ):
            return None, "invalid_primary_tag"
        if reason is not None and not _text(reason, 600):
            return None, "invalid_reason"
        if not refs:
            return None, "known_requires_evidence"
        sources = {evidence[ref]["source"] for ref in refs}
        if not _available(dimension, sources) or not _tag_modalities(tags, dimension, sources):
            return None, "insufficient_evidence_modality"
        if dimension["requires"] == "temporal" and "temporal" not in sources:
            return None, "ordered_frame_group_required"
        if not complete and (not tags or tags == [dimension["none_tag_id"]]):
            # A declared representative sample is valid input, but cannot establish
            # whole-source absence. Normalize epistemic uncertainty, do not invent
            # absence or mark an otherwise valid sampled report malformed.
            return {
                "dimension_id": dimension["id"], "state": "unknown", "tags": None,
                "primary_tag": None, "reason": "absence_not_verifiable_from_representative_sample",
                "evidence_ids": refs,
            }, None
        if any(tag.endswith(".other") for tag in tags) and not _text(reason, 600):
            return None, "other_requires_reason"
        if dimension["id"].startswith("visual.first_frame"):
            first = _first_frame_time(list(evidence.values()))
            if first is None or not any(
                evidence[ref]["source"] == "vision" and evidence[ref]["start_ms"] == first
                for ref in refs
            ):
                return None, "first_frame_evidence_required"
        if dimension["id"] == "visual.opening" and not any(
            evidence[ref]["source"] == "vision" and evidence[ref]["start_ms"] < 3_000
            for ref in refs
        ):
            return None, "opening_evidence_required"
    return {key: row[key] for key in _CLASS_FIELDS}, None


def _time_within_evidence(row: Mapping[str, Any], refs: list[str], evidence: Mapping[str, Any],
                          duration: int | None) -> bool:
    start, end = row.get("start_ms"), row.get("end_ms")
    if start is None and end is None:
        return True
    if not _valid_time(start, end, duration):
        return False
    lower = min(evidence[ref]["start_ms"] for ref in refs)
    upper = max(evidence[ref]["end_ms"] for ref in refs)
    # Cited ASR intervals do not provide word-level alignment. Keeping the source
    # envelope avoids manufacturing more precise start/end times from prose.
    return lower == start and end == upper


def _validate_segments(rows: Any, module: str, dimensions: Mapping[str, Any],
                       evidence: Mapping[str, Any], duration: int | None,
                       issues: list[str]) -> list[dict[str, Any]]:
    result: list[dict[str, Any]] = []
    kinds = set(_taxonomy()["rules"]["open_text_segment_kinds"])
    if not isinstance(rows, list) or len(rows) > 80:
        issues.append("segment_array_invalid")
        return result
    for index, row in enumerate(rows, 1):
        if not isinstance(row, Mapping) or set(row) != _SEGMENT_FIELDS:
            issues.append(f"segment_shape:{index}")
            continue
        refs = _evidence_ids(row.get("evidence_ids"), evidence)
        dimension_id = row.get("dimension_id")
        dimension = dimensions.get(dimension_id) if isinstance(dimension_id, str) else None
        valid_tags = (
            isinstance(row.get("tags"), list)
            and (row["tags"] == [] if dimension is None else _tags(row["tags"], dimension))
        )
        if (
            not _text(row.get("id"), 100) or not isinstance(row.get("kind"), str)
            or row["kind"] not in kinds
            or (dimension_id is not None and dimension is None)
            or not valid_tags or not _text(row.get("text"), 2_000) or not refs
            or not _time_within_evidence(row, refs, evidence, duration)
        ):
            issues.append(f"segment_invalid:{index}")
            continue
        sources = {evidence[ref]["source"] for ref in refs}
        if dimension is not None and (
            not _available(dimension, sources) or not _tag_modalities(row["tags"], dimension, sources)
        ):
            issues.append(f"segment_modality:{index}")
            continue
        if row["kind"] == "cta" and (
            dimension_id != "cta.action" or not row["tags"] or "cta.action.none" in row["tags"]
            or not any(evidence[ref]["source"] in {"transcript", "ocr"} for ref in refs)
        ):
            issues.append(f"cta_segment_requires_action:{index}")
            continue
        if row["kind"] == "structure" and (dimension_id != "structure.role" or not row["tags"]):
            issues.append(f"structure_segment_requires_role:{index}")
            continue
        if row["kind"] in {"hook_first_sentence", "hook_first_3s"}:
            text_refs = sorted((evidence[ref] for ref in refs if evidence[ref]["source"] in {
                "transcript", "ocr",
            }), key=lambda item: (item["start_ms"], item["end_ms"]))
            quoted = re.sub(r"\s+", "", row["text"])
            original = re.sub(r"\s+", "", "".join(item["text"] for item in text_refs))
            if not text_refs or quoted not in original:
                issues.append(f"opening_quote_not_in_source:{index}")
                continue
        # First-three-second quotes cannot be word-trimmed from a segment that
        # overlaps 3s. Exact evidence must itself fit in that real interval.
        if row["kind"] == "hook_first_3s" and any(
            evidence[ref]["end_ms"] > 3_000 for ref in refs
        ):
            issues.append(f"first_3s_alignment_unavailable:{index}")
            continue
        result.append({**row, "id": f"segment:{module}:{index:04d}"})
    return result


def _validate_units(rows: Any, module: str, evidence: Mapping[str, Any],
                    issues: list[str]) -> list[dict[str, Any]]:
    result: list[dict[str, Any]] = []
    if not isinstance(rows, list) or len(rows) > 80:
        issues.append("information_unit_array_invalid")
        return result
    allowed = {
        tag["id"] for dimension in _taxonomy()["dimensions"]
        if dimension["id"] == "value.information_type" for tag in dimension["tags"]
    }
    aliases: dict[str, str] = {}
    exact: dict[tuple[str, str], str] = {}
    for index, row in enumerate(rows, 1):
        if not isinstance(row, Mapping) or set(row) != _UNIT_FIELDS:
            issues.append(f"information_unit_shape:{index}")
            continue
        refs = _evidence_ids(row.get("evidence_ids"), evidence)
        source_id, duplicate = row.get("id"), row.get("duplicate_of")
        if (
            not _text(source_id, 100) or source_id in aliases
            or not isinstance(row.get("type_tag"), str) or row["type_tag"] not in allowed
            or not _text(row.get("text"), 1_200)
            or not refs or (duplicate is not None and (
                not isinstance(duplicate, str) or duplicate not in aliases
            ))
            or not any(evidence[ref]["source"] in {"transcript", "ocr", "vision"} for ref in refs)
        ):
            issues.append(f"information_unit_invalid:{index}")
            continue
        identifier = f"unit:{module}:{index:04d}"
        key = (row["type_tag"], re.sub(r"[\W_]+", "", row["text"]).casefold())
        duplicate_id = aliases.get(duplicate) if duplicate is not None else exact.get(key)
        result.append({**row, "id": identifier, "duplicate_of": duplicate_id})
        aliases[source_id] = identifier
        exact.setdefault(key, identifier)
    return result


def _deterministic_opening(registry: list[dict[str, Any]]) -> list[dict[str, Any]]:
    transcript = sorted((row for row in registry if row["source"] == "transcript"),
                        key=lambda row: (row["start_ms"], row["end_ms"], row["id"]))
    if not transcript:
        return []
    source = transcript[0]
    original = source["text"].strip()
    match = re.search(r"[。！？!?][”’\"']*|\.(?=\s|$)|\n", original)
    sentence = original[:match.end()].strip() if match else original
    result = []
    for kind, text in (("hook_first_sentence", sentence), ("hook_first_3s", original)):
        if not _text(text, 2_000) or (kind == "hook_first_3s" and source["end_ms"] > 3_000):
            continue
        result.append({
            "id": f"segment:deterministic:{kind}", "kind": kind, "dimension_id": None,
            "tags": [], "start_ms": source["start_ms"], "end_ms": source["end_ms"],
            "text": text, "evidence_ids": [source["id"]],
        })
    return result


def _enforce_annotation_consistency(classifications: dict[str, dict[str, Any]],
                                     segments: list[dict[str, Any]],
                                     units: list[dict[str, Any]]) -> None:
    """Do not let positive video labels imply events/units that were never identified."""
    def positive(identifier: str) -> dict[str, Any] | None:
        row = classifications[identifier]
        if row["state"] != "known" or not row["tags"]:
            return None
        dimension = next(item for item in _taxonomy()["dimensions"] if item["id"] == identifier)
        return None if row["tags"] == [dimension["none_tag_id"]] else row

    def unknown(identifier: str, reason: str) -> None:
        classifications[identifier] = {
            **classifications[identifier], "state": "unknown", "tags": None,
            "primary_tag": None, "reason": reason,
        }

    def same_source(row: Mapping[str, Any], annotation: Mapping[str, Any]) -> bool:
        return bool(set(row["evidence_ids"]) & set(annotation["evidence_ids"]))

    relationships = (
        ("cta.action", "cta", "cta_events_not_identified"),
        ("structure.role", "structure", "structure_roles_not_segmented"),
    )
    for identifier, kind, reason in relationships:
        row = positive(identifier)
        if row is not None and any(not any(
            segment["kind"] == kind and segment["dimension_id"] == identifier
            and tag in segment["tags"] and same_source(row, segment)
            for segment in segments
        ) for tag in row["tags"]):
            unknown(identifier, reason)
    row = positive("value.information_type")
    if row is not None and any(not any(
        unit["type_tag"] == tag and same_source(row, unit) for unit in units
    ) for tag in row["tags"]):
        unknown("value.information_type", "information_units_not_identified")
    row = positive("cta.position")
    if row is not None and not any(segment["kind"] == "cta" and same_source(row, segment)
                                   for segment in segments):
        unknown("cta.position", "cta_events_not_identified")
    row = positive("structure.type")
    if row is not None and row["tags"] != ["structure.type.weak"] and not any(
        segment["kind"] == "structure" and same_source(row, segment) for segment in segments
    ):
        unknown("structure.type", "structure_roles_not_segmented")
    row = positive("topic.problem")
    if row is not None and not any(segment["kind"] == "topic_problem" and same_source(row, segment)
                                   for segment in segments):
        unknown("topic.problem", "specific_topic_problem_not_identified")
    row = positive("topic.granularity")
    if row is not None and row["tags"] != ["topic.granularity.broad"] and not any(
        segment["kind"] == "topic_subject" and same_source(row, segment) for segment in segments
    ):
        # The coarse category can still be valid; do not erase it merely because
        # the model did not identify the concrete subject promised by this axis.
        unknown("topic.granularity", "specific_topic_subject_not_identified")


def estimate_content_tokens(value: Any) -> int:
    """Declared estimate, not tokenizer truth: one CJK char/token, other chars/4."""
    encoded = json.dumps(value, ensure_ascii=False, separators=(",", ":"))
    cjk = sum(1 for char in encoded if "\u3400" <= char <= "\u9fff")
    return cjk + max(1, (len(encoded) - cjk + 3) // 4)


def _module_candidates(registry: list[dict[str, Any]], module: str) -> list[dict[str, Any]]:
    if module == MODULES[0]:
        return [row for row in registry if row["source"] in {"transcript", "ocr"}]
    if module == "visual":
        return [row for row in registry if row["source"] != "transcript"]
    return [row for row in registry if row["source"] != "frame"]


def _bounded_evidence(registry: list[dict[str, Any]], module: str,
                      max_tokens: int) -> tuple[list[dict[str, Any]], bool]:
    candidates = _module_candidates(registry, module)
    if estimate_content_tokens(candidates) <= max_tokens and len(candidates) <= 200:
        return candidates, True
    # Stratify the bounded sample rather than silently retaining only the beginning.
    order: list[int] = []
    count = len(candidates)
    for slot in range(min(count, 200)):
        index = round(slot * (count - 1) / max(1, min(count, 200) - 1))
        if index not in order:
            order.append(index)
    selected_ids: set[str] = set()
    used = 0
    def add_bundle(bundle: list[dict[str, Any]]) -> None:
        nonlocal used
        fresh = [row for row in bundle if row["id"] not in selected_ids]
        size = sum(estimate_content_tokens(row) + 2 for row in fresh)
        if used + size <= max_tokens:
            selected_ids.update(row["id"] for row in fresh)
            used += size

    # Preserve first/opening evidence and complete temporal bundles before the
    # representative sample. A group can never survive with only one seen frame.
    words = sorted((row for row in candidates if row["source"] == "transcript"),
                   key=lambda row: (row["start_ms"], row["end_ms"]))
    opening_words = words[:1]
    if module != "visual":
        # Text modules must see actual opening/body/ending words before auxiliary
        # vision context consumes their budget (in particular real CTA evidence).
        for anchor in [*words[:2], *words[-1:]]:
            add_bundle([anchor])
    add_bundle([row for row in candidates if row["start_ms"] == 0
                and row["source"] in {"frame", "vision", "ocr"}])
    groups = [row for row in candidates if row["source"] == "temporal"]
    groups.sort(key=lambda row: (row["frame_group_id"] != "opening", row["start_ms"]))
    for group in groups:
        timestamps = set(json.loads(group["text"])["timestamps_ms"])
        add_bundle([group, *[
            row for row in candidates if row["source"] in {"frame", "vision", "ocr"}
            and row["start_ms"] == row["end_ms"] and row["start_ms"] in timestamps
        ]])
    opening = [row for row in candidates if row["source"] in {"frame", "vision", "ocr"}
               and row["start_ms"] < 3_000]
    add_bundle(opening)
    for timestamp in sorted({row["start_ms"] for row in opening}):
        add_bundle([row for row in opening if row["start_ms"] == timestamp])
    # Retain the actual opening words separately: a very large ASR segment must
    # not prevent the first frame or a whole temporal bundle from being included.
    add_bundle(opening_words)
    for index in order:
        row = candidates[index]
        if row["source"] != "temporal":
            add_bundle([row])
    selected = [row for row in candidates if row["id"] in selected_ids]
    return selected, len(selected) == len(candidates)


def _module_payload(module: str, dimensions: list[dict[str, Any]], registry: list[dict[str, Any]],
                    prior: list[dict[str, Any]], profile: str, metrics: Mapping[str, Any],
                    transcript_source: str) -> tuple[dict[str, Any], dict[str, Any], bool]:
    budget = _profile_budget(profile)
    limit = budget["input_token_limit"]
    compact_dimensions = [{
        **{key: dimension[key] for key in (
            "id", "label", "cardinality", "primary_required", "requires", "none_tag_id",
        )},
        "tags": {tag["id"]: tag["label"] for tag in dimension["tags"] if not tag.get("disabled")},
        **({"tag_requirements": {tag["id"]: tag["requires"] for tag in dimension["tags"]
                                 if tag.get("requires")}} if any(
            tag.get("requires") for tag in dimension["tags"]
        ) else {}),
        **({"requires_text": True} if dimension.get("requires_text") else {}),
        **({"definition": dimension["definition"]} if dimension.get("definition") else {}),
        **({"inferred": True} if dimension.get("inferred") else {}),
    } for dimension in dimensions]
    payload = {
        "schema_version": "content-analysis.v1", "taxonomy_version": _taxonomy()["version"],
        "module": module, "profile": profile, "dimensions": compact_dimensions,
        "evidence_registry": [], "transcript_source": transcript_source,
        "source_coverage": {"complete": False, "included_evidence_count": 0},
        "prior_classifications": {
            row["dimension_id"]: {"tags": row["tags"], "evidence_ids": row["evidence_ids"]}
            for row in prior if row["state"] == "known" and module == "synthesis"
        },
        "measured_media": metrics.get("media", {}),
        "instructions": [
            "仅按给定分类表输出本模块维度；不得新增ID、证据、指标或比例。",
            "每个维度恰好一行；known必须引用确实支持判断的原始证据。",
            "材料不足用unknown；材料缺失用not_acquired；不适用用not_applicable并说明。",
            "known空数组表示确认没有；有none标签时必须使用none且不得与其他标签并存。",
            "主标签从已选标签中选；其他为辅助标签。其他标签必须解释原因。",
            "仅解释文案与可见画面，不分析声音情绪、配乐、音效、音量或静音。",
            "人群暗示与意图情绪属于推断，不是真实受众反馈。",
            "运动/稳定性/转场需引用temporal证据及对应vision描述，不可由单帧推断。",
            "segments保存原文之外的描述及证据；时间必须来自证据，不伪造词级对齐。",
            "topic_subject/topic_problem/audience_use_case/content_template用于具体开放文本。",
            "有文本依据时首模块必须给出具体topic_subject、实际topic_problem和至少一段structure角色；",
            "没有适用问题或结构不得编造：将相应分类设unknown/not_applicable并说明。",
            "每次实际CTA单独一条cta segment；无CTA不需要制造CTA段落。",
            "正向CTA动作必须有同标签同来源的cta事件；正向段落角色必须有structure分段。",
            "只有text_expression_value输出information_units；独立信息点计一次，同义复述标duplicate_of。",
            "已知非空information_type每个标签必须对应同类型且同源的information_unit。",
            "例子通常是信息点支撑；不可用信息点数量断言内容价值高低。",
            "原句来自转写或OCR，不将视觉模型描述冒充口播原句。",
        ],
    }
    prior_limit = 1_800 if profile in {"max", "deep"} else 900
    retained_prior: dict[str, Any] = {}
    for key, row in payload["prior_classifications"].items():
        proposed = {**retained_prior, key: row}
        if estimate_content_tokens(proposed) <= prior_limit:
            retained_prior = proposed
    payload["prior_classifications"] = retained_prior
    if module != "text_topic_structure_audience":
        payload["instructions"] = [instruction for instruction in payload["instructions"]
                                   if not instruction.startswith((
                                       "有文本依据时首模块", "没有适用问题或结构",
                                   ))]
    # The budget includes taxonomy/instructions/metadata, with a fixed SDK-schema
    # reserve. Exact provider usage remains in ModelCalls; this is a declared estimate.
    reserve = budget["sdk_schema_reserve_tokens"]
    available = max(0, limit - reserve - estimate_content_tokens(payload) - 80)
    selected, complete = _bounded_evidence(registry, module, available)
    payload["source_coverage"] = {
        "complete": complete, "included_evidence_count": len(selected),
        "input_token_limit": limit, "sdk_schema_reserve_tokens": reserve,
        "token_estimate_method": budget["token_estimate_method"],
    }
    opening_ids = {row["id"] for row in registry if row["source"] in {"frame", "ocr", "vision"}
                   and row["start_ms"] < 3_000}
    opening_groups = {row["id"] for row in registry if row["source"] == "temporal"
                      and row["frame_group_id"] == "opening"}
    first_frame_time = _first_frame_time(registry)
    first_frame_understood = first_frame_time is not None and any(
        row["source"] == "vision" and row["start_ms"] == first_frame_time for row in registry
    )
    opening_words = sorted((row for row in registry if row["source"] == "transcript"),
                           key=lambda row: (row["start_ms"], row["end_ms"]))[:1]

    def refresh_coverage() -> None:
        payload["evidence_registry"] = selected
        selected_ids = {row["id"] for row in selected}
        required_opening_complete = None
        if module == "visual":
            required_opening_complete = first_frame_understood and (
                opening_ids | opening_groups
            ).issubset(selected_ids)
        elif module == "text_expression_value" and opening_words:
            required_opening_complete = opening_words[0]["id"] in selected_ids
        payload["source_coverage"].update(
            complete=complete, included_evidence_count=len(selected),
            available_evidence_count=len(_module_candidates(registry, module)),
            opening_complete=opening_ids.issubset(selected_ids) if module != MODULES[0] else None,
            required_opening_complete=required_opening_complete,
            temporal_groups_available=[row["id"] for row in registry if row["source"] == "temporal"],
            temporal_groups_included=[row["id"] for row in selected if row["source"] == "temporal"],
            estimated_payload_tokens=0,
        )
        payload["source_coverage"]["estimated_payload_tokens"] = estimate_content_tokens(payload)

    refresh_coverage()
    while selected and estimate_content_tokens(payload) + reserve > limit:
        available = max(0, available - 100)
        selected, complete = _bounded_evidence(registry, module, available)
        refresh_coverage()
    evidence = {row["id"]: row for row in selected}
    return payload, evidence, complete


def build_content_analysis(
    media: Any,
    transcript: Any,
    visuals: Any,
    request_classification: Callable[[str, dict[str, Any], int], dict[str, Any]],
    profile: str = "standard",
    metrics: Mapping[str, Any] | None = None,
    transcript_source: str = "asr",
) -> dict[str, Any]:
    """Make at most four bounded calls and validate every stored semantic label."""
    if transcript_source not in {"asr", "manual"}:
        raise ValueError("transcript_source must be asr or manual")
    if metrics is None:
        from .content_metrics import build_content_metrics
        metrics = build_content_metrics(media, transcript, visuals)
    if not isinstance(metrics, Mapping):
        raise TypeError("metrics must be a mapping")
    taxonomy = _taxonomy()
    dimensions = {row["id"]: row for row in taxonomy["dimensions"]}
    registry = build_evidence_registry(media, transcript, visuals)
    text_not_applicable = text_analysis_not_applicable(media, transcript, visuals)
    classifications = {
        key: _empty_classification(row, _dimension_acquired(row, registry)) for key, row in dimensions.items()
    }
    if text_not_applicable:
        for key, dimension in dimensions.items():
            if dimension["requires"] == "text" or dimension.get("requires_text"):
                classifications[key].update(
                    state="not_applicable", reason="no_audio_or_usable_sampled_text",
                )
    segments: list[dict[str, Any]] = []
    units: list[dict[str, Any]] = []
    module_status: dict[str, Any] = {}
    all_issues: list[str] = []
    missing_required_opening: set[str] = set()
    budget = _profile_budget(profile)
    for module in MODULES:
        requested = [row for row in dimensions.values() if row["module"] == module
                     and classifications[row["id"]]["state"] != "not_applicable"
                     and _dimension_acquired(row, registry)]
        if not requested:
            not_applicable = all(classifications[row["id"]]["state"] == "not_applicable"
                                 for row in dimensions.values() if row["module"] == module)
            module_status[module] = {
                "status": "not_applicable" if not_applicable else "not_acquired",
                "reason": "no_audio_or_usable_sampled_text" if not_applicable else "required_evidence_not_acquired",
                "validation": {"passed": True, "issues": []}, "source_coverage": None,
            }
            continue
        payload, evidence, complete = _module_payload(
            module, requested, registry, list(classifications.values()), profile, metrics,
            transcript_source,
        )
        issues: list[str] = []
        source_coverage = {key: payload["source_coverage"][key] for key in (
            "complete", "included_evidence_count", "available_evidence_count",
            "required_opening_complete", "temporal_groups_available", "temporal_groups_included",
            "input_token_limit", "estimated_payload_tokens",
        )}
        if source_coverage["required_opening_complete"] is False:
            missing_required_opening.add(module)
        locally_acquired = []
        for dimension in requested:
            if _dimension_acquired(dimension, list(evidence.values())):
                locally_acquired.append(dimension)
            else:
                classifications[dimension["id"]] = {
                    **_empty_classification(dimension, False),
                    "reason": "required_evidence_omitted_by_input_budget",
                }
        requested = locally_acquired
        local_ids = {row["id"] for row in requested}
        payload["dimensions"] = [row for row in payload["dimensions"] if row["id"] in local_ids]
        if estimate_content_tokens(payload) + budget["sdk_schema_reserve_tokens"] > budget["input_token_limit"]:
            module_status[module] = {
                "status": "failed", "reason": "input_budget_exceeded",
                "validation": {"passed": False, "issues": ["input_budget_exceeded"]},
                "source_coverage": source_coverage,
            }
            all_issues.append(f"{module}:input_budget_exceeded")
            continue
        if not evidence or not requested:
            module_status[module] = {
                "status": "not_acquired", "reason": "no_evidence_within_input_budget",
                "validation": {"passed": True, "issues": []},
                "source_coverage": source_coverage,
            }
            continue
        try:
            response = request_classification(module, payload, budget["modules"][module])
            if hasattr(response, "model_dump"):
                response = response.model_dump()
        except Exception:  # noqa: BLE001 - preserve independently completed modules, no raw errors
            module_status[module] = {
                "status": "failed", "reason": "classification_request_failed",
                "validation": {"passed": False, "issues": ["classification_request_failed"]},
                "source_coverage": source_coverage,
            }
            all_issues.append(f"{module}:classification_request_failed")
            continue
        if not isinstance(response, Mapping) or set(response) != {
            "classifications", "segments", "information_units",
        }:
            issues.append("response_shape")
            response = {"classifications": [], "segments": [], "information_units": []}
        requested_by_id = {row["id"]: row for row in requested}
        returned: set[str] = set()
        raw = response.get("classifications")
        if not isinstance(raw, list) or len(raw) > len(requested) + 10:
            issues.append("classification_array_invalid")
            raw = []
        for row in raw:
            identifier = row.get("dimension_id") if isinstance(row, Mapping) else None
            if not isinstance(identifier, str) or identifier not in requested_by_id:
                issues.append("unexpected_dimension")
                continue
            if identifier in returned:
                issues.append(f"duplicate_dimension:{identifier}")
                classifications[identifier] = _empty_classification(dimensions[identifier], True)
                continue
            returned.add(identifier)
            valid, error = _validate_classification(
                row, requested_by_id[identifier], evidence, complete=complete,
            )
            if valid is None:
                issues.append(f"{error}:{identifier}")
            else:
                classifications[identifier] = valid
        for identifier in requested_by_id.keys() - returned:
            issues.append(f"missing_dimension:{identifier}")
        segments.extend(_validate_segments(
            response.get("segments"), module, requested_by_id, evidence, _duration(media), issues,
        ))
        if module == "text_expression_value":
            units.extend(_validate_units(response.get("information_units"), module, evidence, issues))
        elif response.get("information_units") != []:
            issues.append("information_units_wrong_module")
        module_status[module] = {
            "status": "completed",
            "reason": "required_opening_evidence_incomplete" if module in missing_required_opening else (
                None if complete else "representative_evidence_sample"
            ),
            "validation": {"passed": not issues, "issues": issues[:120]},
            "source_coverage": source_coverage,
        }
        all_issues.extend(f"{module}:{issue}" for issue in issues)
    opening = _deterministic_opening(registry)
    for annotation in opening:
        kind = annotation["kind"]
        if kind == "hook_first_sentence":
            segments = [segment for segment in segments if segment["kind"] != kind]
            segments.append(annotation)
        elif not any(segment["kind"] == kind for segment in segments):
            segments.append(annotation)
    _enforce_annotation_consistency(classifications, segments, units)
    stats = _get(visuals, "stats", {})
    result = {
        "schema_version": "content-analysis.v1", "taxonomy_version": taxonomy["version"],
        "profile": profile,
        "status": "complete" if not all_issues and not missing_required_opening and all(
            row["status"] in {"completed", "not_applicable"} for row in module_status.values()
        ) else "partial",
        "evidence_registry": registry, "classifications": list(classifications.values()),
        "segments": segments, "information_units": units, "metrics": dict(metrics),
        "methodology": {
            "transcript_source": transcript_source,
            "sampling_strategy_id": _get(stats, "sampling_strategy_id", "legacy-sampling"),
            "sampling_config": _get(stats, "sampling_config", {}),
            "evidence_version": _get(stats, "evidence_version", "legacy-visual-evidence"),
            "temporal_min_frames": 3,
        },
        "module_status": module_status,
        "validation": {"passed": not all_issues, "issues": all_issues[:300]},
    }
    return result


@lru_cache(maxsize=5)
def create_content_response_model(module_key: str | None = None) -> Any:
    """Create SDK schema lazily; importing this module never imports Pydantic."""
    if module_key is not None and module_key not in MODULES:
        raise ValueError("unknown content module")
    from pydantic import ConfigDict, Field, create_model

    config = ConfigDict(extra="forbid")
    dimension_ids = tuple(
        row["id"] for row in _taxonomy()["dimensions"]
        if module_key is None or row["module"] == module_key
    )
    dimension_type = Literal[dimension_ids]  # type: ignore[valid-type]
    classification = create_model(
        "ContentClassification", __config__=config,
        dimension_id=(dimension_type, ...), state=(Literal[STATES], ...),
        tags=(list[str] | None, ...), primary_tag=(str | None, ...),
        reason=(str | None, Field(max_length=600)),
        evidence_ids=(list[str], Field(max_length=24)),
    )
    segment = create_model(
        "ContentSegment", __config__=config,
        id=(str, Field(min_length=1, max_length=100)),
        kind=(Literal[tuple(_taxonomy()["rules"]["open_text_segment_kinds"])], ...),
        dimension_id=(dimension_type | None, ...), tags=(list[str], ...),
        start_ms=(int | None, ...), end_ms=(int | None, ...),
        text=(str, Field(min_length=1, max_length=2_000)),
        evidence_ids=(list[str], Field(min_length=1, max_length=24)),
    )
    unit = create_model(
        "ContentInformationUnit", __config__=config,
        id=(str, Field(min_length=1, max_length=100)), type_tag=(str, ...),
        text=(str, Field(min_length=1, max_length=1_200)),
        evidence_ids=(list[str], Field(min_length=1, max_length=24)),
        duplicate_of=(str | None, ...),
    )
    return create_model(
        "ContentModuleResponse_" + (module_key or "all"), __config__=config,
        classifications=(list[classification], Field(max_length=len(dimension_ids))),
        segments=(list[segment], Field(max_length=80)),
        information_units=(list[unit], Field(max_length=80)),
    )
