"""Storage bounds shared with the web reader, measured in UTF-16 code units."""

from __future__ import annotations

import json
from importlib.resources import files
from typing import Any

_contract = json.loads(files("liming_analyzer").joinpath(
    "resources/content-report-contract.v1.json",
).read_text(encoding="utf-8"))
REPORT_MAX_UTF16_UNITS = _contract["report_max_utf16_units"]
EVIDENCE_REGISTRY_MAX_ENTRIES = _contract["evidence_registry_max_entries"]
RETIRED_DIMENSION_IDS = frozenset(_contract.get("retired_dimension_ids", ()))


def utf16_units(text: str) -> int:
    return len(text.encode("utf-16-le", errors="surrogatepass")) // 2


def validate_evidence_storage(registry: list[dict[str, Any]]) -> None:
    """Preserve raw sources while rejecting evidence that cannot fit a report."""
    if len(registry) > EVIDENCE_REGISTRY_MAX_ENTRIES:
        raise ValueError("content_evidence_registry_exceeds_entry_limit")
    if any(utf16_units(row["text"]) > REPORT_MAX_UTF16_UNITS for row in registry):
        raise ValueError("content_evidence_text_exceeds_report_budget")
    encoded = json.dumps(registry, ensure_ascii=False, separators=(",", ":"), allow_nan=False)
    if utf16_units(encoded) > REPORT_MAX_UTF16_UNITS:
        raise ValueError("content_evidence_registry_exceeds_report_budget")
