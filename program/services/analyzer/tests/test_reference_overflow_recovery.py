"""Reference recovery through the real Instructor wrapper and an offline HTTP transport."""
from __future__ import annotations

import copy
import json
from dataclasses import replace
from pathlib import Path

import httpx
import pytest
from test_content_provider_integration import LegacyResponse, inputs
from test_instructor_single_attempt import SyntheticTransport, wrapped_client
from test_unified_analysis import Ledger

from liming_analyzer.adapters import Keyframe
from liming_analyzer.api_client import ClaimedJob
from liming_analyzer.content_analysis import MODULES
from liming_analyzer.providers import InstructorStructureAnalyzer

MODULE = "text_expression_value"
TASK = "content_classification:" + MODULE


def extended_inputs():
    media, transcript, visuals = inputs()
    extra = tuple(Keyframe(1_500 + index * 100, Path(f"/tmp/synthetic-unused-{index}.jpg"),
        f"合成界面文字编号{index}", 94, f"synthetic_extra_{index}", ("representative",))
        for index in range(33))
    return media, transcript, replace(visuals, keyframes=(*visuals.keyframes, *extra))


class ReferenceTransport(SyntheticTransport):
    def __init__(self, field, mode="overflow", *, repeat=False):
        super().__init__()
        self.field, self.mode, self.repeat = field, mode, repeat
        self.candidates = []

    def handle(self, request):
        body = json.loads(request.content)
        payload = next(json.JSONDecoder().raw_decode(row["content"])[0] for row in body["messages"]
                       if row["role"] == "user" and row["content"].startswith("{"))
        response = super().handle(request)
        result = response.json()
        position = int(result["id"].rsplit("-", 1)[1])
        if payload.get("m") != MODULE or position and not self.repeat:
            return response
        value = json.loads(result["choices"][0]["message"]["content"])
        assert len(payload["e"]) >= 25
        if self.field == "c":
            selected = next(row["i"] for row in payload["d"] if row["n"] == "行动引导")
            rows = [value["c"][selected]]
        else:
            rows = value[self.field] if self.mode == "all_findings" else [value[self.field][0]]
        for row in rows:
            if self.mode == "duplicates":
                row["e"] = row["e"] * 25
            else:
                row["e"] = list(range(25))
                if self.mode == "foreign":
                    row["e"][-1] = len(payload["e"])
                elif self.mode == "boolean":
                    row["e"][-1] = True
                elif self.mode == "float":
                    row["e"][-1] = 0.0
                elif self.mode == "bad_kind":
                    row["k"] = "fabricated_event"
                elif self.mode == "polluted_text":
                    row["x"] = "PRIVATE_UNPROVEN_FACT_9999"
        if self.mode == "dependent_units":
            prior = value["u"][0]
            value["u"].extend([
                {**prior, "e": [0], "q": 0},
                {**prior, "e": [0], "q": 1},
            ])
        self.candidates.append(copy.deepcopy(value))
        result["choices"][0]["message"]["content"] = json.dumps(value, ensure_ascii=False)
        return httpx.Response(200, json=result)


def run_transport(transport, *, original=False, checkpoint=None):
    ledger, checkpoints = Ledger(), []
    with wrapped_client(transport) as client:
        analyzer = InstructorStructureAnalyzer(api_key="", base_url="https://synthetic.invalid/v1",
            provider="minimax", model="MiniMax-M3.1-Flash", client=client, report_model=LegacyResponse,
            generate_content_features=True, generate_unified_report=True, generate_reviewed_report=True,
            max_output_tokens=6_000, call_recorder=ledger)
        analyzer.set_unified_checkpoint(lambda value: checkpoints.append(copy.deepcopy(value)))
        job = ClaimedJob("synthetic-overflow", "org", "project", "video", "upload", "analyzing", 84, 1,
                         {"transcript_review_enabled": False} if original else {}, analysis_profile="max",
                         checkpoint={"unified_progress": checkpoint} if checkpoint else None)
        result = analyzer.analyze(job, *extended_inputs())
    return result, ledger, checkpoints


def section(result, module=MODULE):
    return next(row for row in result.report["unified_report"]["sections"] if row["key"] == module)


@pytest.mark.parametrize("field", ["c", "g", "u", "f"])
def test_valid_repeated_references_are_deduplicated_with_no_extra_paid_request(field):
    transport = ReferenceTransport(field, "duplicates")
    result, ledger, checkpoints = run_transport(transport)
    assert transport.attempts[TASK] == 1
    assert result.report["unified_report"]["status"] == "complete"
    diagnostics = section(result)["diagnostics"]
    recovery = diagnostics["local_recovery"]
    assert any(row["path"].startswith(field + ".") and row["action"] == "deduplicated"
               and row["original_count"] == 25 and row["retained_count"] == 1 for row in recovery)
    assert checkpoints[-1]["modules"][MODULE]["local_recovery"] == recovery
    assert len([row for row in ledger.events if row["task"] == TASK and row["status"] == "started"]) == 1


@pytest.mark.parametrize("field", ["g", "u", "f"])
@pytest.mark.parametrize("original", [False, True])
def test_one_nonredundant_overflow_omits_the_whole_item_and_keeps_other_results(field, original):
    transport = ReferenceTransport(field)
    result, _ledger, checkpoints = run_transport(transport, original=original)
    assert transport.attempts[TASK] == 1
    assert result.report["unified_report"]["status"] == "complete"
    assert all(row["status"] == "completed" for row in result.report["unified_report"]["sections"])
    recovery = section(result)["diagnostics"]["local_recovery"]
    assert {"path": f"{field}.0.e", "action": "omitted", "original_count": 25,
            "retained_count": 0, "limit": 24} in recovery
    checked = checkpoints[-1]["modules"][MODULE]
    assert len(transport.candidates[0][field][0]["e"]) == 25
    if field == "g":
        assert not any(row["kind"] == "cta" for row in checked["response"]["segments"])
        assert not any(row["section"] == "cta" for row in checked["findings"])
        for identifier in ("cta.action", "cta.position"):
            row = next(row for row in checked["response"]["classifications"] if row["dimension_id"] == identifier)
            assert row["state"] == "unknown" and row["tags"] is None and row["evidence_ids"] == []
    elif field == "u":
        assert checked["response"]["information_units"] == []
        row = next(row for row in checked["response"]["classifications"] if row["dimension_id"] == "value.information_type")
        assert row["state"] == "unknown" and row["tags"] is None
        assert not any(row["section"] == "value" for row in checked["findings"])
    else:
        assert len(checked["findings"]) == 5
    if original:
        assert result.report["unified_report"]["outcome"]["manuscript"] == "original"
        assert not any(row["task"].startswith("canonical_") for row in transport.requests)


def test_recovered_module_cache_is_reused_and_keeps_its_local_diagnostics():
    transport = ReferenceTransport("g")
    result, _ledger, checkpoints = run_transport(transport)
    second_transport = ReferenceTransport("g")
    resumed, ledger, _cp = run_transport(second_transport, checkpoint=checkpoints[-1])
    assert second_transport.requests == [] and ledger.events == []
    assert section(resumed)["diagnostics"]["reused"] is True
    assert section(resumed)["diagnostics"]["local_recovery"] == section(result)["diagnostics"]["local_recovery"]


def test_units_pointing_to_an_omitted_predecessor_are_not_rebound_to_another_unit():
    transport = ReferenceTransport("u", "dependent_units")
    result, _ledger, checkpoints = run_transport(transport)
    assert transport.attempts[TASK] == 1
    assert checkpoints[-1]["modules"][MODULE]["response"]["information_units"] == []
    recovery = section(result)["diagnostics"]["local_recovery"]
    assert {row["path"] for row in recovery if row["action"] == "omitted"} >= {"u.0.e", "u.1", "u.2"}


def test_no_remaining_findings_gets_one_repair_with_exact_sdk_location_count_and_limit():
    transport = ReferenceTransport("f", "all_findings")
    result, ledger, checkpoints = run_transport(transport)
    assert transport.attempts[TASK] == 2
    calls = [row["body"] for row in transport.requests if row["task"] == TASK]
    payload = next(json.JSONDecoder().raw_decode(row["content"])[0] for row in calls[1]["messages"]
                   if row["role"] == "user" and row["content"].startswith("{"))
    repair = payload["response_repair"]
    assert "f.0.e:too_long" in repair["issues"]
    assert "f.0.e:too_long:actual_25:limit_24" in repair["issues"]
    assert "findings_count_invalid" in repair["issues"]
    assert "最多24" in repair["instruction"]
    assert result.report["unified_report"]["status"] == "complete"
    assert len([row for row in ledger.events if row["task"] == TASK and row["status"] == "started"]) == 2
    assert not checkpoints[-1].get("failed_modules", {}).get(MODULE)


@pytest.mark.parametrize("field", ["c", "g", "u", "f"])
@pytest.mark.parametrize("mode", ["foreign", "boolean", "float"])
def test_invalid_tail_reference_cannot_disappear_when_an_oversized_item_is_dropped(field, mode):
    transport = ReferenceTransport(field, mode, repeat=True)
    result, _ledger, checkpoints = run_transport(transport)
    assert transport.attempts[TASK] == 2
    assert section(result)["status"] == "failed"
    assert MODULE not in checkpoints[-1]["modules"]
    candidate = checkpoints[-1]["failed_modules"][MODULE]["candidate"]
    assert candidate == transport.candidates[-1]
    assert not section(result)["findings"]


def test_bad_event_shape_is_not_hidden_by_overflow_and_polluted_omitted_text_is_not_published():
    transport = ReferenceTransport("g", "bad_kind", repeat=True)
    result, _ledger, _cp = run_transport(transport)
    assert section(result)["status"] == "failed" and transport.attempts[TASK] == 2
    polluted = ReferenceTransport("g", "polluted_text")
    result, _ledger, _cp = run_transport(polluted)
    assert section(result)["status"] == "completed"
    assert "PRIVATE_UNPROVEN_FACT_9999" not in json.dumps(result.report)


def test_when_every_finding_overflows_it_stays_failed_after_two_calls_and_preserves_other_modules():
    transport = ReferenceTransport("f", "all_findings", repeat=True)
    result, _ledger, checkpoints = run_transport(transport)
    assert section(result)["status"] == "failed" and transport.attempts[TASK] == 2
    assert section(result, MODULES[0])["status"] == section(result, "visual")["status"] == "completed"
    assert section(result, "synthesis")["status"] == "completed"
    saved = checkpoints[-1]["failed_modules"][MODULE]
    assert saved["candidate"] == transport.candidates[-1]
    assert "f.0.e:too_long:actual_25:limit_24" in saved["validation"]["issues"]
