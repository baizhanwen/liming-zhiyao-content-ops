"""Evidence-bound content annotations; deliberately importable without any model SDK."""

from __future__ import annotations

import json
import logging
import re
from collections.abc import Callable, Mapping, Sequence
from concurrent.futures import FIRST_COMPLETED, ThreadPoolExecutor, wait
from functools import lru_cache
from importlib.resources import files
from itertools import pairwise
from typing import Any, Literal

from .content_report_contract import RETIRED_DIMENSION_IDS, utf16_units, validate_evidence_storage

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
_LOCAL_CLASSIFICATION_NORMALIZATIONS = {
    "classification_tag_index_not_in_taxonomy", "classification_reference_limit_exceeded",
}


def _log_local_normalizations(module: str, response: Mapping[str, Any], source: str) -> bool:
    rows = [f"{row['dimension_id']}:{row['reason']}" for row in response["classifications"]
            if row.get("reason") in _LOCAL_CLASSIFICATION_NORMALIZATIONS]
    if rows:
        logging.getLogger(__name__).info("local_normalization module=%s source=%s dimensions=%s",
                                         module, source, ",".join(rows))
    return bool(rows)


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
    return isinstance(value, str) and bool(value.strip()) and utf16_units(value) <= limit


def _safe_asset(value: Any) -> str | None:
    # Storage IDs are useful; local filenames/paths must never enter model payloads.
    if isinstance(value, str) and re.fullmatch(r"[A-Za-z0-9_-]{1,160}", value):
        return value
    return None


def _review_metadata(value: Any, transcript: Any) -> dict[str, Any] | None:
    """Validate the v12 safe-input contract before any model request is made."""
    if value is None:
        return None
    fields = {"total_segments", "accepted_segments", "uncertain_segment_ids", "uncertain_ranges",
              "first_source_segment_id"}
    segments = _rows(_get(transcript, "segments", ()))
    if not isinstance(value, Mapping) or set(value) != fields:
        raise ValueError("invalid_transcript_review_context")
    total, accepted = value["total_segments"], value["accepted_segments"]
    ids, ranges = value["uncertain_segment_ids"], value["uncertain_ranges"]
    expected = {f"transcript:{index:04d}": row for index, row in enumerate(segments, 1)}
    if (not _integer(total) or total != len(segments) or not _integer(accepted)
            or not 0 <= accepted <= total or not isinstance(ids, list)
            or any(not isinstance(key, str) or key not in expected for key in ids)
            or len(set(ids)) != len(ids) or accepted + len(ids) != total
            or not isinstance(ranges, list) or len(ranges) != len(ids)
            or value["first_source_segment_id"] != ("transcript:0001" if total else None)):
        raise ValueError("invalid_transcript_review_context")
    by_id = {}
    for row in ranges:
        if (not isinstance(row, Mapping) or set(row) != {"source_segment_id", "start_ms", "end_ms"}
                or row.get("source_segment_id") not in ids or row["source_segment_id"] in by_id):
            raise ValueError("invalid_transcript_review_context")
        source = expected[row["source_segment_id"]]
        if (row["start_ms"], row["end_ms"]) != (_get(source, "start_ms"), _get(source, "end_ms")):
            raise ValueError("invalid_transcript_review_context")
        if not _valid_time(row["start_ms"], row["end_ms"], None):
            raise ValueError("invalid_transcript_review_context")
        by_id[row["source_segment_id"]] = dict(row)
    return {"total_segments": total, "accepted_segments": accepted,
            "uncertain_segment_ids": list(ids), "uncertain_ranges": [by_id[key] for key in ids],
            "first_source_segment_id": value["first_source_segment_id"]}


def _review_text_unavailable(review: Mapping[str, Any] | None, module: str,
                             evidence: Sequence[Mapping[str, Any]]) -> bool:
    # Pending speech is not trusted transcript, but independently observed
    # screen text remains usable. A single long ASR slot must not disable every
    # text module when the real OCR can support its own bounded conclusions.
    return bool(review and review["total_segments"] and not review["accepted_segments"]
                and module in MODULES[:2] and not any(
                    row["source"] == "ocr" and isinstance(row["text"], str) and row["text"].strip()
                    for row in evidence
                ))


def _review_crosses_gap(refs: Sequence[Mapping[str, Any]], review: Mapping[str, Any]) -> bool:
    if not refs:
        return False
    start, end = min(row["start_ms"] for row in refs), max(row["end_ms"] for row in refs)
    return any(row["start_ms"] < end and row["end_ms"] > start
               for row in review["uncertain_ranges"])


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
    stats = _get(visuals, "stats", {})
    valid_frame_times = {
        _get(frame, "timestamp_ms") for frame in frames
        if _valid_time(_get(frame, "timestamp_ms"), _get(frame, "timestamp_ms"), duration)
    }
    marked_first = [_get(frame, "timestamp_ms") for frame in frames
                    if "first_frame" in _rows(_get(frame, "roles", []))
                    and _valid_time(_get(frame, "timestamp_ms"), _get(frame, "timestamp_ms"), duration)]
    reported_first = _get(stats, "first_frame_timestamp_ms")
    # A video stream can start after its audio track. Keep that real media
    # timestamp instead of inventing a zero-time picture, but only trust a
    # positive first-frame role when the extractor independently reports the
    # same earliest extracted frame. Legacy zero-time frames stay compatible.
    positive_first = (reported_first if _integer(reported_first) and 0 < reported_first < 3_000
                      and marked_first == [reported_first] and valid_frame_times
                      and min(valid_frame_times) == reported_first else None)
    frame_times: set[int] = set()
    for index, frame in enumerate(frames, 1):
        timestamp = _get(frame, "timestamp_ms")
        if not _valid_time(timestamp, timestamp, duration):
            continue
        frame_times.add(timestamp)
        asset = _safe_asset(_get(frame, "asset_id"))
        roles = _rows(_get(frame, "roles", []))
        append(f"frame:{index:04d}", "frame", "", timestamp, timestamp, asset,
               "first_frame" if "first_frame" in roles and timestamp in {0, positive_first} else None)
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
        opening_origin = {}
        if group_id == "opening" and start > 0:
            if (start != positive_first or not _integer(_get(group, "first_frame_timestamp_ms"))
                    or _get(group, "first_frame_timestamp_ms") != positive_first
                    or _get(group, "kind") != "opening" or end >= 3_000
                    or any(time < start for time in vision_times)):
                continue
            opening_origin = {"first_frame_timestamp_ms": positive_first}
        seen_groups.add(group_id)
        append(f"temporal:{group_id}", "temporal", json.dumps({
            "kind": _get(group, "kind", "ordered_frames"), "timestamps_ms": timestamps,
            "limitations": _get(group, "limitations", []),
            **opening_origin,
        }, ensure_ascii=False), start, end, group=group_id)
    validate_evidence_storage(registry)
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


def _is_explicit_audio_only(media: Any) -> bool:
    info = _get(media, "info", media)
    missing = object()
    audio_codec = _get(info, "audio_codec")
    return (
        _get(info, "video_codec", missing) is None
        and isinstance(audio_codec, str) and bool(audio_codec.strip())
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
    review_context: Mapping[str, Any] | None = None,
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
        if review_context and review_context["uncertain_segment_ids"]:
            text_refs = [evidence[ref] for ref in refs if evidence[ref]["source"] == "transcript"]
            opening_missing = review_context["first_source_segment_id"] in review_context["uncertain_segment_ids"]
            if opening_missing and not review_context["accepted_segments"] and dimension["id"].startswith("hook."):
                ocr_refs = [evidence[ref] for ref in refs if evidence[ref]["source"] == "ocr"]
                unavailable_opening = (
                    dimension["id"] == "hook.channel" and "hook.channel.spoken_text" in tags
                    or ocr_refs and not any(row["start_ms"] < 3_000 and row["end_ms"] <= 3_000
                                           for row in ocr_refs)
                )
                if unavailable_opening:
                    return {"dimension_id": dimension["id"], "state": "unknown", "tags": None,
                            "primary_tag": None, "reason": "original_opening_text_requires_review",
                            "evidence_ids": refs}, None
            if (dimension["id"].startswith("hook.") or dimension["id"] == "synthesis.opening_fulfillment") and (
                text_refs and (opening_missing or not any(item["id"] == review_context["first_source_segment_id"]
                                                         for item in text_refs)
                               or _review_crosses_gap(text_refs, review_context))
            ):
                return {"dimension_id": dimension["id"], "state": "unknown", "tags": None,
                        "primary_tag": None, "reason": "original_opening_text_requires_review",
                        "evidence_ids": refs}, None
            complete = False
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
                       issues: list[str], review_context: Mapping[str, Any] | None = None) -> list[dict[str, Any]]:
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
        if not valid_tags:
            safe_dimension = dimension["id"] if dimension is not None else "untyped"
            safe_kind = row["kind"] if isinstance(row.get("kind"), str) and row["kind"] in kinds else "unknown"
            issues.append(f"segment_invalid_tags:{index}:{safe_kind}:{safe_dimension}")
            continue
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
        if review_context and row["kind"] in {"cta", "hook_first_sentence", "hook_first_3s"}:
            # A literal event may use a safe uninterrupted ASR run or a single
            # visible OCR quote. Never join text over a pending source sentence.
            text_refs = sorted((evidence[ref] for ref in refs if evidence[ref]["source"] in {
                "transcript", "ocr",
            }), key=lambda item: (item["start_ms"], item["end_ms"], item["id"]))
            spoken = [item for item in text_refs if item["source"] == "transcript"]
            opening_missing = review_context["first_source_segment_id"] in review_context["uncertain_segment_ids"]
            if opening_missing and row["kind"] == "hook_first_sentence":
                # A visible line cannot certify the first spoken sentence.
                continue
            if row["kind"] == "hook_first_3s" and any(item["end_ms"] > 3_000 for item in text_refs):
                continue
            if ((spoken and _review_crosses_gap(spoken, review_context)) or (
                row["kind"].startswith("hook_first") and spoken and opening_missing
            )):
                continue
            quoted = re.sub(r"\s+", "", row["text"])
            alternatives = [item["text"] for item in text_refs]
            if spoken:
                alternatives.append("".join(item["text"] for item in spoken))
            if not any(quoted in re.sub(r"\s+", "", source) for source in alternatives):
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


def _deterministic_opening(registry: list[dict[str, Any]],
                           review_context: Mapping[str, Any] | None = None) -> list[dict[str, Any]]:
    transcript = sorted((row for row in registry if row["source"] == "transcript"),
                        key=lambda row: (row["start_ms"], row["end_ms"], row["id"]))
    if not transcript:
        return []
    source = transcript[0]
    if review_context and source["id"] != review_context["first_source_segment_id"]:
        return []
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
                      max_tokens: int, *, reviewed: bool = False) -> tuple[list[dict[str, Any]], bool]:
    if reviewed:
        return _bounded_review_evidence(registry, module, max_tokens)
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
    first = _first_frame_time(registry)
    add_bundle([row for row in candidates if row["start_ms"] == first
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


def _bounded_review_evidence(registry: list[dict[str, Any]], module: str,
                             max_tokens: int) -> tuple[list[dict[str, Any]], bool]:
    """Keep visual proof atomic without bundling dense full-page OCR with it."""
    candidates = _module_candidates(registry, module)
    selected_ids: set[str] = set()
    used = 0

    def add(rows: list[dict[str, Any]]) -> None:
        nonlocal used
        fresh = [row for row in rows if row["id"] not in selected_ids]
        size = sum(estimate_content_tokens({**row, "text": row["text"][:360]}) + 2
                   if row["source"] == "ocr" else estimate_content_tokens(row) + 2 for row in fresh)
        if len(selected_ids) + len(fresh) <= 200 and used + size <= max_tokens:
            selected_ids.update(row["id"] for row in fresh)
            used += size

    words = sorted((row for row in candidates if row["source"] == "transcript"),
                   key=lambda row: (row["start_ms"], row["end_ms"], row["id"]))
    if module != "visual":
        for row in [*words[:2], *words[-1:]]:
            add([row])
    first = _first_frame_time(registry)
    add([row for row in candidates if row["source"] in {"frame", "vision"} and row["start_ms"] == first])
    groups = sorted((row for row in candidates if row["source"] == "temporal"),
                    key=lambda row: (row["frame_group_id"] != "opening", row["start_ms"]))
    for group in groups:
        times = set(json.loads(group["text"])["timestamps_ms"])
        add([group, *[row for row in candidates if row["source"] in {"frame", "vision"}
                      and row["start_ms"] == row["end_ms"] and row["start_ms"] in times]])
    for row in candidates:
        if row["source"] in {"frame", "vision"} and row["start_ms"] < 3_000:
            add([row])
    # Short visible text is an auxiliary modality. Repeated screen chrome must
    # not consume the opening frame-group budget. Raw evidence is never edited.
    seen_ocr: set[str] = set()
    for row in sorted((row for row in candidates if row["source"] == "ocr"),
                      key=lambda row: (row["start_ms"] >= 3_000, len(row["text"]), row["start_ms"])):
        key = re.sub(r"\s+", "", row["text"])
        if key not in seen_ocr:
            add([row])
            seen_ocr.add(key)
    count = len(candidates)
    for slot in range(min(count, 200)):
        row = candidates[round(slot * (count - 1) / max(1, min(count, 200) - 1))]
        if row["source"] not in {"temporal", "ocr"}:
            add([row])
    selected = [row for row in candidates if row["id"] in selected_ids]
    return selected, len(selected) == len(candidates)


def _module_payload(module: str, dimensions: list[dict[str, Any]], registry: list[dict[str, Any]],
                    prior: list[dict[str, Any]], profile: str, metrics: Mapping[str, Any],
                    transcript_source: str, *, compact: bool = False,
                    review_context: Mapping[str, Any] | None = None,
                    upstream_context: Mapping[str, Any] | None = None,
                    ) -> tuple[dict[str, Any], dict[str, Any], bool]:
    budget = _profile_budget(profile)["compact"] if compact else _profile_budget(profile)
    def input_estimate(value: Mapping[str, Any]) -> int:
        if compact:
            from .content_module_protocol import prepare_compact_request
            wire = prepare_compact_request(module, value)[0]
            if module == "visual" and review_context is not None:
                # Manuscript repair must not change the selected visual sample.
                # The actual wire excludes manuscript IDs/ranges; estimate its
                # small coverage counters at a constant worst-case width.
                wire["coverage"].update(complete=False, review_limited=False,
                    uncertain_segment_count=review_context["total_segments"])
            return estimate_content_tokens(wire)
        return estimate_content_tokens(value)
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
    if review_context is not None:
        payload["transcript_review"] = dict(review_context)
        payload["model_evidence_excerpts"] = {row["id"]: row["text"][:360] for row in registry
                                             if row["source"] == "ocr" and len(row["text"]) > 360}
    if upstream_context is not None:
        payload["upstream_modules"] = dict(upstream_context)
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
    candidates = _module_candidates(registry, module)
    words = [row for row in candidates if row["source"] == "transcript"]
    word_ids = {row["id"] for row in words}
    text_opening = [row for row in candidates if compact and module == MODULES[1] and (
        (row["source"] in {"ocr", "vision"} and row["start_ms"] < 3_000)
        or (row["source"] == "temporal" and row["frame_group_id"] == "opening")
    )]
    if review_context is not None:
        text_opening = [row for row in text_opening if row["source"] != "ocr"]
    text_opening_ids = {row["id"] for row in text_opening}
    protected: list[dict[str, Any]] = []
    if compact and module != "visual" and words:
        # Whole canonical text takes priority over auxiliary sampled pictures.
        # Test the actual wire size, rather than the larger registry encoding.
        # B's opening visual proof remains atomic alongside the opening words.
        essential_ids = word_ids | text_opening_ids
        essential = [row for row in candidates if row["id"] in essential_ids]
        essential_payload = {**payload, "evidence_registry": essential, "source_coverage": {
            "complete": len(essential) == len(candidates),
            "required_opening_complete": True if module == MODULES[1] else None,
            "valid_transcript_complete": True,
        }}
        if input_estimate(essential_payload) + reserve <= limit:
            protected = essential
    available = max(0, limit - reserve - input_estimate(payload) - 80)
    if protected:
        protected_ids = {row["id"] for row in protected}
        auxiliary = [row for row in registry if row["id"] not in protected_ids]
        available = max(0, limit - reserve - input_estimate(essential_payload) - 80)

    def select_evidence(remaining: int) -> tuple[list[dict[str, Any]], bool]:
        if not protected:
            return _bounded_evidence(registry, module, remaining, reviewed=review_context is not None)
        extra, _complete = _bounded_evidence(auxiliary, module, remaining, reviewed=review_context is not None)
        selected_ids = protected_ids | {row["id"] for row in extra}
        result = [row for row in candidates if row["id"] in selected_ids]
        return result, len(result) == len(candidates)

    selected, complete = select_evidence(available)
    payload["source_coverage"] = {
        "complete": complete, "included_evidence_count": len(selected),
        "input_token_limit": limit, "sdk_schema_reserve_tokens": reserve,
        "token_estimate_method": budget["token_estimate_method"],
    }
    opening_ids = {row["id"] for row in registry if row["source"] in {"frame", "ocr", "vision"}
                   and row["start_ms"] < 3_000}
    if review_context is not None:
        opening_ids = {row["id"] for row in registry if row["source"] in {"frame", "vision"}
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
            required_opening_complete = (
                opening_words[0]["id"] in selected_ids and text_opening_ids.issubset(selected_ids)
            )
        excerpted = bool(set(payload.get("model_evidence_excerpts", {})) & selected_ids)
        review_limited = bool(review_context and review_context["uncertain_segment_ids"])
        payload["source_coverage"].update(
            complete=complete and not excerpted and not review_limited, included_evidence_count=len(selected),
            available_evidence_count=len(_module_candidates(registry, module)),
            opening_complete=opening_ids.issubset(selected_ids) if module != MODULES[0] else None,
            required_opening_complete=required_opening_complete,
            temporal_groups_available=[row["id"] for row in registry if row["source"] == "temporal"],
            temporal_groups_included=[row["id"] for row in selected if row["source"] == "temporal"],
            estimated_payload_tokens=0,
        )
        if review_context is not None:
            payload["source_coverage"].update(review_limited=review_limited,
                uncertain_segment_count=len(review_context["uncertain_segment_ids"]), evidence_excerpted=excerpted,
                evidence_complete=complete and not excerpted)
        if compact and module != "visual":
            payload["source_coverage"]["valid_transcript_complete"] = word_ids.issubset(selected_ids)
        payload["source_coverage"]["estimated_payload_tokens"] = input_estimate(payload)

    refresh_coverage()
    while selected and input_estimate(payload) + reserve > limit:
        available = max(0, available - 100)
        selected, complete = select_evidence(available)
        refresh_coverage()
    evidence = {row["id"]: row for row in selected}
    return payload, evidence, bool(payload["source_coverage"]["complete"])


def _initial_content_state(media: Any, transcript: Any, visuals: Any,
                           review_context: Mapping[str, Any] | None = None, *,
                           include_retired: bool = False) -> tuple[
    dict[str, Any], dict[str, Any], list[dict[str, Any]], dict[str, dict[str, Any]],
]:
    taxonomy = _taxonomy()
    dimensions = {row["id"]: row for row in taxonomy["dimensions"]}
    registry = build_evidence_registry(media, transcript, visuals)
    if review_context is not None:
        pending = set(review_context["uncertain_segment_ids"])
        registry = [row for row in registry if row["id"] not in pending]
    classifications = {
        key: _empty_classification(row, _dimension_acquired(row, registry))
        for key, row in dimensions.items()
    }
    if text_analysis_not_applicable(media, transcript, visuals):
        for key, dimension in dimensions.items():
            if dimension["requires"] == "text" or dimension.get("requires_text"):
                classifications[key].update(state="not_applicable", reason="no_audio_or_usable_sampled_text")
    if _is_explicit_audio_only(media):
        for key, dimension in dimensions.items():
            if dimension["requires"] in {"visual", "temporal"}:
                classifications[key].update(state="not_applicable", reason="no_video_track")
    if review_context is not None and _review_text_unavailable(review_context, MODULES[0], registry):
        for key, dimension in dimensions.items():
            if dimension["module"] in MODULES[:2]:
                classifications[key] = {**_empty_classification(dimension, False),
                                        "reason": "trusted_transcript_not_acquired"}
    # Keep stable storage IDs for old reports while omitting retired questions
    # from every new model request.
    if not include_retired:
        for key in RETIRED_DIMENSION_IDS & classifications.keys():
            classifications[key] = {**_empty_classification(dimensions[key], False),
                                    "state": "not_applicable", "reason": "analysis_dimension_retired"}
    return taxonomy, dimensions, registry, classifications


def build_content_analysis(
    media: Any,
    transcript: Any,
    visuals: Any,
    request_classification: Callable[[str, dict[str, Any], int], dict[str, Any]],
    profile: str = "standard",
    metrics: Mapping[str, Any] | None = None,
    transcript_source: str = "asr",
    *,
    _compact_payload: bool = False,
    review_context: Mapping[str, Any] | None = None,
    _include_retired: bool = False,
) -> dict[str, Any]:
    """Make at most four bounded calls and validate every stored semantic label."""
    if transcript_source not in {"asr", "manual"}:
        raise ValueError("transcript_source must be asr or manual")
    if metrics is None:
        from .content_metrics import build_content_metrics
        metrics = build_content_metrics(media, transcript, visuals)
    if not isinstance(metrics, Mapping):
        raise TypeError("metrics must be a mapping")
    review_context = _review_metadata(review_context, transcript)
    taxonomy, dimensions, registry, classifications = _initial_content_state(
        media, transcript, visuals, review_context, include_retired=_include_retired,
    )
    segments: list[dict[str, Any]] = []
    units: list[dict[str, Any]] = []
    module_status: dict[str, Any] = {}
    all_issues: list[str] = []
    missing_required_opening: set[str] = set()
    budget = _profile_budget(profile)["compact"] if _compact_payload else _profile_budget(profile)
    for module in MODULES:
        requested = [row for row in dimensions.values() if row["module"] == module
                     and classifications[row["id"]]["state"] != "not_applicable"
                     and _dimension_acquired(row, registry)
                     and not _review_text_unavailable(review_context, module, registry)]
        if not requested:
            not_applicable = all(classifications[row["id"]]["state"] == "not_applicable"
                                 for row in dimensions.values() if row["module"] == module)
            reasons = {classifications[row["id"]]["reason"] for row in dimensions.values()
                       if row["module"] == module
                       and classifications[row["id"]]["reason"] != "analysis_dimension_retired"}
            module_status[module] = {
                "status": "not_applicable" if not_applicable else "not_acquired",
                "reason": next(iter(reasons)) if not_applicable and len(reasons) == 1 else (
                    "module_not_applicable" if not_applicable else "required_evidence_not_acquired"
                ),
                "validation": {"passed": True, "issues": []}, "source_coverage": None,
            }
            continue
        module_registry = registry
        upstream_context = None
        if review_context is not None and module == "synthesis":
            available = [key for key in MODULES[:3] if module_status.get(key, {}).get("status") == "completed"
                         and module_status[key]["validation"]["passed"]]
            upstream_context = {
                "available": available,
                "missing": [key for key in MODULES[:3] if key not in available
                            and module_status.get(key, {}).get("status") != "not_applicable"],
                "limited": [key for key in available if not (module_status[key].get("source_coverage") or {}).get("complete")],
            }
            safe_refs = {ref for key, row in classifications.items() if dimensions[key]["module"] in available
                         and row["state"] == "known" for ref in row["evidence_ids"]}
            safe_refs.update(ref for row in [*segments, *units]
                             if any(row["id"].startswith((f"segment:{key}:", f"unit:{key}:")) for key in available)
                             for ref in row["evidence_ids"])
            module_registry = [row for row in registry if row["id"] in safe_refs]
        payload, evidence, complete = _module_payload(
            module, requested, module_registry, list(classifications.values()), profile, metrics,
            transcript_source, compact=_compact_payload, review_context=review_context,
            upstream_context=upstream_context,
        )
        issues: list[str] = []
        source_coverage = {key: payload["source_coverage"][key] for key in (
            "complete", "included_evidence_count", "available_evidence_count",
            "required_opening_complete", "temporal_groups_available", "temporal_groups_included",
            "input_token_limit", "estimated_payload_tokens",
        )}
        if review_context is not None:
            source_coverage.update(review_limited=payload["source_coverage"]["review_limited"],
                                   uncertain_segment_count=len(review_context["uncertain_segment_ids"]))
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
        if source_coverage["estimated_payload_tokens"] + budget["sdk_schema_reserve_tokens"] > budget["input_token_limit"]:
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
        except Exception as error:  # noqa: BLE001 - preserve independently completed modules, no raw errors
            kind = getattr(error, "safe_failure_kind", None) if _compact_payload else None
            candidate = getattr(error, "safe_failure_reason", kind) if _compact_payload else None
            reason = candidate if isinstance(candidate, str) and re.fullmatch(r"[a-z_]{1,80}", candidate) else "classification_request_failed"
            safe_issues = getattr(error, "safe_validation_issues", None)
            issues = safe_issues if isinstance(safe_issues, list) and all(
                isinstance(issue, str) and re.fullmatch(r"[a-zA-Z0-9_.:-]{1,180}", issue)
                for issue in safe_issues
            ) else [reason]
            module_status[module] = {
                "status": "failed", "reason": reason,
                "validation": {"passed": False, "issues": issues[:120]},
                "source_coverage": source_coverage,
            }
            all_issues.extend(f"{module}:{issue}" for issue in issues)
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
                review_context=review_context,
            )
            if valid is None:
                issues.append(f"{error}:{identifier}")
            else:
                classifications[identifier] = valid
        for identifier in requested_by_id.keys() - returned:
            issues.append(f"missing_dimension:{identifier}")
        segments.extend(_validate_segments(
            response.get("segments"), module, requested_by_id, evidence, _duration(media), issues, review_context,
        ))
        if module == "text_expression_value":
            units.extend(_validate_units(response.get("information_units"), module, evidence, issues))
        elif response.get("information_units") != []:
            issues.append("information_units_wrong_module")
        usable_text = not (review_context is not None and module in MODULES[:2] and not any(
            classifications[row["id"]]["state"] == "known" for row in requested
        ))
        module_status[module] = {
            "status": "completed" if usable_text else "not_acquired",
            "reason": "required_opening_evidence_incomplete" if module in missing_required_opening else (
                "trusted_text_insufficient" if not usable_text else None if complete else "representative_evidence_sample"
            ),
            "validation": {"passed": not issues, "issues": issues[:120]},
            "source_coverage": source_coverage,
        }
        all_issues.extend(f"{module}:{issue}" for issue in issues)
    opening = _deterministic_opening(registry, review_context)
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
    if review_context is not None:
        result["methodology"]["transcript_review"] = dict(review_context)
    return result


def _checked_bundle_module(
    module: str, response: Any, findings: Any, payload: Mapping[str, Any],
    base_classifications: Mapping[str, Any], duration: int | None,
) -> tuple[dict[str, Any], list[dict[str, Any]]]:
    """Revalidate decoded responses and restored caches against this exact input."""
    from .content_module_protocol import (
        SEGMENT_KINDS,
        CompactProtocolError,
        protocol_limits,
        validate_compact_findings,
        validate_temporal_evidence,
    )
    limits = protocol_limits(module, str(payload["profile"]))
    requested_ids = {row["id"] for row in payload["dimensions"]}
    definitions = {row["id"]: row for row in _taxonomy()["dimensions"] if row["id"] in requested_ids}
    evidence = {row["id"]: row for row in payload["evidence_registry"]}
    issues: list[str] = []
    rows: dict[str, Any] = {}
    if not isinstance(response, Mapping) or set(response) != {"classifications", "segments", "information_units"}:
        raise CompactProtocolError("module_response_shape")
    raw_classifications = response["classifications"]
    if not isinstance(raw_classifications, list) or len(raw_classifications) != len(definitions):
        raise CompactProtocolError("module_classification_count")
    for row in raw_classifications:
        key = row.get("dimension_id") if isinstance(row, Mapping) else None
        if not isinstance(key, str) or key not in definitions or key in rows:
            issues.append("unexpected_or_duplicate_dimension")
            continue
        valid, error = _validate_classification(
            row, definitions[key], evidence, complete=bool(payload["source_coverage"]["complete"]),
            review_context=payload.get("transcript_review"),
        )
        selected_tags = row.get("tags") if isinstance(row.get("tags"), list) else []
        temporal_required = definitions[key]["requires"] == "temporal" or any(
            tag.get("requires") == "temporal" and tag["id"] in selected_tags
            for tag in definitions[key]["tags"]
        )
        conservative_review_failure = payload.get("transcript_review") is not None and error in {
            "insufficient_evidence_modality", "first_frame_evidence_required", "opening_evidence_required",
            "ordered_frame_group_required",
        }
        if (valid is None and (
            conservative_review_failure or (not temporal_required and error == "insufficient_evidence_modality"
                                            and not key.startswith("visual.first_frame"))
        )):
            # Legal references that do not prove the required modalities cannot
            # establish a known label. Retain uncertainty, never add evidence or
            # waive temporal/first-frame proof and other structural checks.
            uncertain = {**row, "state": "unknown", "tags": None, "primary_tag": None,
                         "reason": "temporal_sequence_not_proven_by_cited_evidence" if temporal_required
                         else "first_frame_not_proven_by_cited_evidence" if key.startswith("visual.first_frame")
                         else "opening_not_proven_by_cited_evidence" if error == "opening_evidence_required"
                         else "required_modalities_not_cited"}
            valid, error = _validate_classification(
                uncertain, definitions[key], evidence, complete=bool(payload["source_coverage"]["complete"]),
                review_context=payload.get("transcript_review"),
            )
        if valid is None:
            issues.append(f"{error}:{key}")
        else:
            if valid["state"] == "known" and temporal_required:
                try:
                    validate_temporal_evidence(valid["evidence_ids"], evidence,
                                               maximum=24 if payload.get("transcript_review") is not None else 8,
                                               dimension_id=key)
                except CompactProtocolError as temporal_error:
                    if payload.get("transcript_review") is None:
                        issues.extend(f"{issue}:{key}" for issue in temporal_error.safe_validation_issues)
                        continue
                    valid = {**valid, "state": "unknown", "tags": None, "primary_tag": None,
                             "reason": "temporal_sequence_not_proven_by_cited_evidence"}
            rows[key] = valid
    if set(rows) != set(definitions):
        issues.append("missing_valid_dimensions")
    raw_segments = response["segments"]
    if not isinstance(raw_segments, list) or len(raw_segments) > limits["segments"] or any(
        not isinstance(row, Mapping) or row.get("kind") not in SEGMENT_KINDS[module]
        for row in raw_segments
    ):
        issues.append("segment_module_scope_invalid")
        raw_segments = []
    segments = _validate_segments(raw_segments, module, definitions, evidence, duration, issues,
                                  payload.get("transcript_review"))
    raw_units = response["information_units"]
    if not isinstance(raw_units, list) or len(raw_units) > limits["information_units"]:
        issues.append("unit_module_scope_invalid")
        raw_units = []
    units = _validate_units(raw_units, module, evidence, issues) if module == MODULES[1] else []
    if issues:
        error = CompactProtocolError("module_semantic_validation_failed")
        error.safe_validation_issues = issues[:120]
        raise error
    checked_findings = validate_compact_findings(
        module, findings, set(evidence), str(payload["profile"]),
        evidence_sources={key: row["source"] for key, row in evidence.items()},
        evidence_reference_limit=24 if payload.get("transcript_review") is not None else 8,
    )
    local = {key: dict(row) for key, row in base_classifications.items()}
    local.update(rows)
    _enforce_annotation_consistency(local, segments, units)
    return {
        "classifications": [local[key] for key in definitions],
        "segments": segments, "information_units": units,
    }, checked_findings


def build_content_analysis_bundle(
    media: Any,
    transcript: Any,
    visuals: Any,
    request_classification: Callable[[str, dict[str, Any], int], dict[str, Any]],
    profile: str = "standard",
    metrics: Mapping[str, Any] | None = None,
    transcript_source: str = "asr",
    *,
    max_workers: int = 1,
    on_module_checkpoint: Callable[[str, dict[str, Any]], None] | None = None,
    on_module_failure: Callable[[str, dict[str, Any]], None] | None = None,
    resume_modules: Mapping[str, Any] | None = None,
    resume_failures: Mapping[str, Any] | None = None,
    retry_module_keys: Sequence[str] | None = None,
    allow_revalidated_synthesis_cache: bool = False,
    transcript_basis: str = "canonical",
    review_context: Mapping[str, Any] | None = None,
) -> dict[str, Any]:
    """Use compact model calls, bounded parallelism and independently verified caches.

    Only the first three modules run independently (at most two in flight).
    Synthesis sees their validated results. Checkpoints contain successful modules
    only and are acknowledged on the caller thread before more work is submitted.
    """
    from .content_module_protocol import (
        CompactProtocolError,
        compact_budget,
        compact_signature,
        decode_compact_response,
        prepare_compact_request,
    )
    if not isinstance(max_workers, int) or isinstance(max_workers, bool) or max_workers not in {1, 2}:
        raise ValueError("max_workers must be 1 or 2")
    if transcript_basis not in {"canonical", "original"}:
        raise ValueError("transcript_basis must be canonical or original")
    if transcript_source not in {"asr", "manual"}:
        raise ValueError("transcript_source must be asr or manual")
    if retry_module_keys is not None and (
        not isinstance(retry_module_keys, Sequence) or isinstance(retry_module_keys, (str, bytes))
        or any(not isinstance(key, str) or key not in {"canonical", *MODULES} for key in retry_module_keys)
    ):
        raise ValueError("retry_module_keys must be a sequence of known module keys")
    explicit_retry_modules = set(retry_module_keys or ()) & set(MODULES)
    if metrics is None:
        from .content_metrics import build_content_metrics
        metrics = build_content_metrics(media, transcript, visuals)
    if not isinstance(metrics, Mapping):
        raise TypeError("metrics must be a mapping")
    review_context = _review_metadata(review_context, transcript)
    _tax, definitions, registry, base = _initial_content_state(media, transcript, visuals, review_context)
    budget = compact_budget(profile)
    # Checkpoint callbacks replace entries in the caller's mapping. Preserve the
    # original generation inputs while migrating dependent cache signatures.
    restored = dict(resume_modules) if isinstance(resume_modules, Mapping) else {}
    failed_candidates = resume_failures if isinstance(resume_failures, Mapping) else {}
    findings_by_module: dict[str, list[dict[str, Any]]] = {module: [] for module in MODULES}
    module_results: dict[str, dict[str, Any]] = {}
    completed: dict[str, Any] = {}
    errors: dict[str, Exception] = {}

    def usable_result(module: str, result: Mapping[str, Any]) -> bool:
        return not (review_context is not None and module in MODULES[:2] and not any(
            row.get("state") == "known" for row in result.get("response", {}).get("classifications", ())
        ))

    def prepare(module: str, *, include_retired: bool = False) -> dict[str, Any] | None:
        requested = [row for row in definitions.values() if row["module"] == module
                     and (base[row["id"]]["state"] != "not_applicable" or (
                         include_retired and row["id"] in RETIRED_DIMENSION_IDS
                         and not _is_explicit_audio_only(media)))
                     and _dimension_acquired(row, registry)
                     and not _review_text_unavailable(review_context, module, registry)]
        if not requested:
            return None
        payload, evidence, _complete = _module_payload(
            module, requested, registry, list(base.values()), profile, metrics,
            transcript_source, compact=True, review_context=review_context,
        )
        available = {row["id"] for row in requested
                     if _dimension_acquired(row, list(evidence.values()))}
        payload["dimensions"] = [row for row in payload["dimensions"] if row["id"] in available]
        wire, _context = prepare_compact_request(module, payload)
        if not available or not evidence or estimate_content_tokens(wire) + budget["sdk_schema_reserve_tokens"] > budget["input_token_limit"]:
            return None
        return payload

    def failure_candidate(error: Exception, raw: Any, signature: str) -> dict[str, Any] | None:
        # Customer text belongs only in private checkpoints, never in the public
        # report or error strings. Keep complete JSON objects only, without
        # truncating a candidate into a misleading/incomplete diagnostic sample.
        if hasattr(raw, "model_dump"):
            raw = raw.model_dump(mode="json")
        if not isinstance(raw, Mapping):
            return None
        try:
            encoded = json.dumps(dict(raw), ensure_ascii=False, allow_nan=False, separators=(",", ":"))
            if len(encoded.encode("utf-8")) > 65_536:
                return None
            candidate = json.loads(encoded)
        except (TypeError, ValueError, OverflowError, RecursionError):
            return None
        issues = getattr(error, "safe_validation_issues", None)
        safe_issues = [issue for issue in issues if isinstance(issue, str)
                       and re.fullmatch(r"[a-zA-Z0-9_.:-]{1,180}", issue)] if isinstance(issues, list) else []
        return {"signature": signature, "status": "failed",
                "validation": {"passed": False, "issues": safe_issues[:120] or ["compact_response_validation_failed"]},
                "candidate": candidate}

    def retired_cache_matches(module: str, cache: Mapping[str, Any]) -> bool:
        # Reconstruct the exact earlier request before accepting a cache whose
        # only configuration change is a question that is no longer asked.
        if not RETIRED_DIMENSION_IDS:
            return False
        if module == "synthesis":
            previous_payload = None

            def previous_request(key: str, payload: dict[str, Any], _limit: int) -> dict[str, Any]:
                nonlocal previous_payload
                if key == "synthesis":
                    previous_payload = payload
                    return {}
                previous = restored.get(key)
                if (not isinstance(previous, Mapping) or previous.get("status") != "completed"
                        or not isinstance(previous.get("validation"), Mapping)
                        or previous["validation"].get("passed") is not True):
                    raise CompactProtocolError("retired_cache_upstream_unavailable")
                return previous["response"]

            # Replay only saved responses. This reproduces the reviewed-flow
            # source subset and upstream coverage as well as prior labels.
            build_content_analysis(
                media, transcript, visuals, previous_request, profile=profile, metrics=metrics,
                transcript_source=transcript_source, _compact_payload=True,
                review_context=review_context, _include_retired=True,
            )
        elif any(definitions[key]["module"] == module
                 for key in RETIRED_DIMENSION_IDS & definitions.keys()):
            previous_payload = prepare(module, include_retired=True)
        else:
            return False
        if previous_payload is None:
            return False
        previous_wire, _context = prepare_compact_request(module, previous_payload)
        return compact_signature(previous_wire) == cache.get("signature")

    def execute(module: str, payload: Mapping[str, Any]) -> tuple[dict[str, Any], bool]:
        wire, context = prepare_compact_request(module, payload)
        signature = compact_signature(wire)
        cache = restored.get(module)
        revalidate_synthesis = (allow_revalidated_synthesis_cache and module == "synthesis"
                                and module not in explicit_retry_modules and isinstance(cache, Mapping)
                                and cache.get("signature") != signature)
        revalidate_retired = False
        if isinstance(cache, Mapping) and cache.get("signature") != signature:
            try:
                revalidate_retired = retired_cache_matches(module, cache)
            except (CompactProtocolError, TypeError, ValueError, KeyError, AttributeError):
                pass
        if isinstance(cache, Mapping) and (cache.get("signature") == signature or revalidate_synthesis or revalidate_retired) and cache.get("status") == "completed" and (
            isinstance(cache.get("validation"), Mapping) and cache["validation"].get("passed") is True
        ):
            try:
                cached_response = cache.get("response")
                if revalidate_retired:
                    cached_response = {**cached_response, "classifications": [
                        row for row in cached_response["classifications"]
                        if row["dimension_id"] not in RETIRED_DIMENSION_IDS
                    ]}
                response, findings = _checked_bundle_module(
                    module, cached_response, cache.get("findings"), payload, base, _duration(media),
                )
                restored_result = {"signature": signature, "status": "completed",
                                   "validation": {"passed": True, "issues": []},
                                   "response": response, "findings": findings}
                if revalidate_synthesis or revalidate_retired:
                    restored_result["generation_signature"] = cache.get("generation_signature", cache["signature"])
                    restored_result["revalidated_from_signature"] = cache["signature"]
                if revalidate_retired:
                    logging.getLogger(__name__).info("retired_dimension_cache_migrated module=%s", module)
                if usable_result(module, restored_result):
                    return restored_result, not (revalidate_synthesis or revalidate_retired)
            except (CompactProtocolError, TypeError, ValueError, KeyError):
                # A source match still requires all current semantic checks.
                pass
        def checked(raw: Any, source: str) -> tuple[dict[str, Any], bool]:
            decoded, findings = decode_compact_response(raw, context)
            response, findings = _checked_bundle_module(
                module, decoded, findings, payload, base, _duration(media),
            )
            _log_local_normalizations(module, response, source)
            return {"signature": signature, "status": "completed",
                    "validation": {"passed": True, "issues": []},
                    "response": response, "findings": findings}, False

        def remember(error: Exception, candidate: Any) -> None:
            stored = failure_candidate(error, candidate, signature)
            if stored is not None:
                error._compact_failure_candidate = stored

        failed = failed_candidates.get(module)
        error_to_repair = None
        raw = None
        if isinstance(failed, Mapping) and failed.get("signature") == signature and failed.get("status") == "failed":
            # A matching saved response is revalidated before spending anything.
            # Only an explicit retry authorizes another call after failed recovery.
            raw = failed.get("candidate")
            bounded = failure_candidate(CompactProtocolError("failed_candidate_invalid"), raw, signature)
            try:
                if bounded is None or set(bounded["candidate"]) != {"c", "g", "u", "f"}:
                    raise CompactProtocolError("failed_candidate_invalid")
                return checked(bounded["candidate"], "failed_candidate")
            except (CompactProtocolError, TypeError, ValueError, KeyError) as error:
                remember(error, raw)
                if module not in explicit_retry_modules:
                    raise
                error_to_repair = error
        else:
            try:
                raw = request_classification(module, wire, budget["modules"][module])
            except Exception as error:
                raw = getattr(error, "safe_candidate", None)
                remember(error, raw)
                if raw is not None:
                    try:
                        return checked(raw, "sdk_candidate")
                    except (CompactProtocolError, TypeError, ValueError, KeyError) as validation_error:
                        remember(validation_error, raw)
                        error_to_repair = validation_error
                if error_to_repair is None:
                    error_to_repair = error
            else:
                try:
                    return checked(raw, "model_response")
                except (CompactProtocolError, TypeError, ValueError, KeyError) as error:
                    remember(error, raw)
                    error_to_repair = error

        kind = getattr(error_to_repair, "safe_failure_kind", None)
        if kind not in {"schema_invalid", "evidence_invalid"}:
            raise error_to_repair
        issues = getattr(error_to_repair, "safe_validation_issues", None)
        issues = [issue for issue in issues if isinstance(issue, str)
                  and re.fullmatch(r"[a-zA-Z0-9_.:-]{1,180}", issue)][:24] if isinstance(issues, list) else []
        repair_wire = {**wire, "response_repair": {
            "issues": issues or [kind],
            "instruction": "修复本模块上次返回的字段或引用错误，重新返回完整c/g/u/f。"
                           "c恰好覆盖expected_d一次；c.t为标签数组，u.t为单个数字。"
                           "已判断分类必须引用支持该标签的输入证据。不能编造引用或将不确定内容标成已确认。",
        }}
        if estimate_content_tokens(repair_wire) + budget["sdk_schema_reserve_tokens"] > budget["input_token_limit"]:
            raise error_to_repair
        def repair() -> tuple[dict[str, Any], bool]:
            # The caller acknowledges a complete failure candidate before this
            # additional request. All paid calls share the module's finite cap.
            try:
                repaired = request_classification(module, repair_wire, budget["modules"][module])
            except Exception as error:
                candidate = getattr(error, "safe_candidate", None)
                if candidate is not None:
                    try:
                        return checked(candidate, "repair_sdk_candidate")
                    except (CompactProtocolError, TypeError, ValueError, KeyError) as validation_error:
                        remember(validation_error, candidate)
                        raise validation_error from error
                remember(error, raw)
                raise
            try:
                return checked(repaired, "repair_response")
            except (CompactProtocolError, TypeError, ValueError, KeyError) as error:
                remember(error, repaired)
                raise

        error_to_repair._compact_repair = repair
        raise error_to_repair

    plans = [(module, payload) for module in MODULES[:3] if (payload := prepare(module)) is not None]
    plans_by_key = dict(plans)
    # Main-thread acknowledgements avoid checkpoint update races and do not
    # submit another paid request after a checkpoint/ownership acknowledgement fails.
    with ThreadPoolExecutor(max_workers=max_workers) as executor:
        pending: dict[Any, str] = {}
        todo = iter(plans)
        for _index in range(min(max_workers, len(plans))):
            module, payload = next(todo)
            pending[executor.submit(execute, module, payload)] = module
        while pending:
            done, _waiting = wait(pending, return_when=FIRST_COMPLETED)
            repairs = []
            for future in done:
                module = pending.pop(future)
                try:
                    result, reused = future.result()
                    completed[module] = result
                except Exception as error:  # noqa: BLE001 - isolate module failures
                    candidate = getattr(error, "_compact_failure_candidate", None)
                    if candidate is not None and on_module_failure is not None:
                        try:
                            on_module_failure(module, candidate)
                        except BaseException:
                            for other in pending:
                                other.cancel()
                            raise
                    repair = getattr(error, "_compact_repair", None)
                    if callable(repair):
                        repairs.append((module, repair))
                    else:
                        errors[module] = error
                else:
                    if on_module_checkpoint is not None and not reused and (
                        plans_by_key[module]["source_coverage"]["required_opening_complete"] is not False
                    ) and usable_result(module, result):
                        try:
                            on_module_checkpoint(module, result)
                        except BaseException:
                            for other in pending:
                                other.cancel()
                            raise
            # Acknowledge all results already returned by this wait before any
            # new request. Set iteration order must not schedule work ahead of
            # another returned result whose checkpoint acknowledgement fails.
            for module, repair in repairs:
                pending[executor.submit(repair)] = module
            for _slot in range(len(done) - len(repairs)):
                next_plan = next(todo, None)
                if next_plan is not None:
                    key, payload = next_plan
                    pending[executor.submit(execute, key, payload)] = key

    synthesis_checkpoint: dict[str, Any] | None = None
    synthesis_failure: dict[str, Any] | None = None
    checkpoint_error: BaseException | None = None
    def canonical_request(module: str, payload: dict[str, Any], _output_tokens: int) -> dict[str, Any]:
        nonlocal synthesis_checkpoint, synthesis_failure, checkpoint_error
        if module == "synthesis":
            def upstream_inapplicable(key: str) -> bool:
                return all(base[row["id"]]["state"] == "not_applicable"
                           for row in definitions.values() if row["module"] == key)
            blocked = any(
                key in errors or (key not in completed and not upstream_inapplicable(key))
                or (key in plans_by_key and
                    plans_by_key[key]["source_coverage"]["required_opening_complete"] is False)
                for key in MODULES[:3]
            )
            if blocked and review_context is None:
                error = CompactProtocolError("upstream_module_failed")
                error.safe_failure_kind = "evidence_invalid"
                error.safe_failure_reason = "upstream_module_failed"
                error.safe_validation_issues = ["upstream_module_failed"]
                raise error
        if module in errors:
            raise errors[module]
        if module in completed:
            result = completed[module]
            wire, _context = prepare_compact_request(module, payload)
            if result["signature"] != compact_signature(wire):
                raise CompactProtocolError("prepared_input_signature_changed")
        else:
            try:
                result, reused = execute(module, payload)
            except Exception as error:
                candidate = getattr(error, "_compact_failure_candidate", None)
                repair = getattr(error, "_compact_repair", None)
                if not callable(repair):
                    synthesis_failure = candidate
                    raise
                if candidate is not None and on_module_failure is not None:
                    try:
                        on_module_failure(module, candidate)
                    except BaseException as acknowledgement_error:
                        checkpoint_error = acknowledgement_error
                        raise
                try:
                    result, reused = repair()
                except Exception as repair_error:
                    synthesis_failure = getattr(repair_error, "_compact_failure_candidate", None)
                    raise
            completed[module] = result
            if module == "synthesis" and not reused:
                synthesis_checkpoint = result
        findings_by_module[module] = result["findings"]
        # A structurally valid response with incomplete required opening inputs is
        # still displayed as partial and is never checkpointed for paid-call reuse.
        if payload["source_coverage"]["required_opening_complete"] is not False and usable_result(module, result):
            module_results[module] = result
        return result["response"]

    content = build_content_analysis(
        media, transcript, visuals, canonical_request, profile=profile,
        metrics=metrics, transcript_source=transcript_source, _compact_payload=True,
        review_context=review_context,
    )
    content["methodology"]["transcript_basis"] = transcript_basis
    if checkpoint_error is not None:
        raise checkpoint_error
    if synthesis_failure is not None and on_module_failure is not None:
        on_module_failure("synthesis", synthesis_failure)
    if synthesis_checkpoint is not None and "synthesis" in module_results and on_module_checkpoint is not None:
        on_module_checkpoint("synthesis", synthesis_checkpoint)
    return {"content_analysis": content, "findings_by_module": findings_by_module,
            "module_results": module_results}


@lru_cache(maxsize=5)
def create_content_response_model(module_key: str | None = None) -> Any:
    """Create SDK schema lazily; importing this module never imports Pydantic."""
    if module_key is not None and module_key not in MODULES:
        raise ValueError("unknown content module")
    from pydantic import ConfigDict, Field, create_model

    config = ConfigDict(extra="forbid")
    dimension_ids = tuple(
        row["id"] for row in _taxonomy()["dimensions"]
        if row["id"] not in RETIRED_DIMENSION_IDS and (module_key is None or row["module"] == module_key)
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
