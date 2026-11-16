"""At-cap recovery retains complete evidence, bounded spend, and old module caches."""
from __future__ import annotations

import copy
from collections import Counter

import pytest
from test_content_provider_integration import LegacyResponse, inputs
from test_unified_analysis import Ledger, OfflineSdk, payload_of

from liming_analyzer.api_client import ClaimedJob
from liming_analyzer.content_analysis import MODULES
from liming_analyzer.providers import InstructorStructureAnalyzer


def run(*, reviewed=True, failures=None, cap=6_000, provider="minimax", checkpoint=None, targets=None, sdk=None):
    sdk = sdk or OfflineSdk(failures=failures)
    ledger, checkpoints = Ledger(), []
    analyzer = InstructorStructureAnalyzer(
        api_key="", base_url="https://synthetic.invalid", model="MiniMax-M3.1-Flash" if provider == "minimax" else "fixture",
        provider=provider, client=sdk, report_model=LegacyResponse, max_output_tokens=cap,
        generate_content_features=True, generate_unified_report=True, generate_reviewed_report=reviewed,
        call_recorder=ledger,
    )
    analyzer.set_unified_checkpoint(lambda value: checkpoints.append(copy.deepcopy(value)))
    payload = {"unified_progress": checkpoint} if checkpoint else {}
    if targets:
        payload["retry_module_keys"] = list(targets)
    job = ClaimedJob(
        "length-fixture", "org", "project", "video", "upload", "analyzing", 84, 1,
        {"transcript_review_enabled": False} if reviewed else {}, analysis_profile="max",
        checkpoint_stage="evidence_ready" if checkpoint else None, checkpoint=payload or None,
    )
    return analyzer.analyze(job, *inputs()), sdk, ledger, checkpoints


def section(result, module=MODULES[1]):
    return next(row for row in result.report["unified_report"]["sections"] if row["key"] == module)


@pytest.mark.parametrize("reviewed", [False, True])
@pytest.mark.parametrize("provider", ["minimax", "deepseek"])
@pytest.mark.parametrize("cap", [2_500, 6_000, 12_000])
def test_at_cap_length_regenerates_complete_json_once_without_raising_the_cap(reviewed, provider, cap):
    task = "content_classification:" + MODULES[1]
    result, sdk, ledger, _ = run(reviewed=reviewed, provider=provider, cap=cap, failures={task: ["length"]})
    calls = [row for row in sdk.calls if row["task"] == task]
    limit = min(cap, 6_000)
    assert [row.get("max_completion_tokens", row.get("max_tokens")) for row in calls] == [limit, limit]
    first = payload_of(calls[0])
    second = payload_of(calls[1])
    recovery = second.pop("output_length_recovery")
    assert second == first  # All sources, indices, coverage, and bounds stay intact.
    assert recovery["previous_finish_reason"] == "length"
    assert recovery["output_budget"] == limit
    assert "完整覆盖expected_d" in recovery["instruction"]
    assert "数字、专名、否定、事实方向和必要来源" in recovery["instruction"]
    assert "不要续写上次截断内容" in recovery["instruction"]
    assert section(result)["status"] == "completed"
    diag = section(result)["diagnostics"]
    assert diag["attempts"] == 2 and diag["output_tokens"] == limit + 20
    assert diag["input_tokens"] == 113 and diag["reasoning_tokens"] == 6
    requests = [row for row in result.report["analysis_meta"]["model_requests"] if row["task"] == task]
    assert [row["failure_kind"] for row in requests] == ["length", None]
    assert [row["finish_reason"] for row in requests] == ["length", "stop"]
    events = [row for row in ledger.events if row["task"] == task]
    assert Counter(row["status"] for row in events) == {"started": 2, "failed": 1, "completed": 1}
    assert len({row["id"] for row in events}) == 2
    # No extra call is made for the modules that completed on their first try.
    assert all(sum(row["task"] == "content_classification:" + key for row in sdk.calls) == 1
               for key in MODULES if key != MODULES[1])


@pytest.mark.parametrize("reviewed", [False, True])
@pytest.mark.parametrize("failures", [["length", "length"], ["length", "schema"], ["schema", "length"]])
def test_length_and_schema_repair_share_two_paid_calls_without_accepting_partial_json(reviewed, failures):
    task = "content_classification:" + MODULES[1]
    result, sdk, ledger, _ = run(reviewed=reviewed, failures={task: failures})
    calls = [row for row in sdk.calls if row["task"] == task]
    assert len(calls) == 2
    assert section(result)["status"] == "failed"
    assert section(result)["findings"] == []
    assert section(result)["diagnostics"]["attempts"] == 2
    assert sum(row["status"] == "started" and row["task"] == task for row in ledger.events) == 2


class PriorAwareSdk(OfflineSdk):
    """Expose synthesis's dependency on the actual new classification input."""

    def create_with_completion(self, **arguments):
        response, completion = super().create_with_completion(**arguments)
        payload = payload_of(arguments)
        if payload.get("m") == "synthesis":
            value = response.model_dump(mode="json")
            action_known = any(row[0] == "行动引导" for row in payload["prior"])
            value["f"][0]["x"] = "已识别结尾实践提示，可保留行动引导。" if action_known else "行动引导分类尚未取得，保留现有独立观察。"
            response = arguments["response_model"].model_validate(value)
        return response, completion


def test_old_evidence_ready_signature_keeps_independent_successes_and_refreshes_changed_synthesis():
    task = "content_classification:" + MODULES[1]
    first, _, _, checkpoints = run(sdk=PriorAwareSdk(failures={task: ["timeout"]}))
    assert section(first)["status"] == "failed"
    checkpoint = checkpoints[-1]
    assert set(checkpoint["modules"]) == set(MODULES) - {MODULES[1]}
    original_signature = checkpoint["source_signature"]
    successes = copy.deepcopy(checkpoint["modules"])
    assert "尚未取得" in section(first, "synthesis")["findings"][0]["text"]

    recovered, sdk, ledger, retry_checkpoints = run(
        checkpoint=checkpoint, targets=[MODULES[1]], sdk=PriorAwareSdk(failures={task: ["length"]}),
    )
    assert [row["task"] for row in sdk.calls] == [task, task, "content_classification:synthesis"]
    assert {row["task"] for row in ledger.events} == {task, "content_classification:synthesis"}
    assert recovered.report["unified_report"]["source_signature"] == original_signature
    assert all(row["source_signature"] == original_signature for row in retry_checkpoints)
    assert recovered.report["unified_report"]["status"] == "complete"
    for key in (MODULES[0], "visual"):
        assert section(recovered, key)["diagnostics"]["reused"] is True
        assert retry_checkpoints[-1]["modules"][key]["findings"] == successes[key]["findings"]
    assert section(recovered, "synthesis")["diagnostics"]["reused"] is False
    assert "已识别结尾实践提示" in section(recovered, "synthesis")["findings"][0]["text"]
    assert retry_checkpoints[-1]["modules"]["synthesis"]["signature"] != successes["synthesis"]["signature"]


def test_exactly_unchanged_synthesis_inputs_keep_the_verified_cached_result():
    task = "content_classification:" + MODULES[1]
    _, _, _, checkpoints = run(failures={task: ["timeout"]})
    checkpoint = checkpoints[-1]
    original_synthesis = copy.deepcopy(checkpoint["modules"]["synthesis"])
    recovered, sdk, _, retry_checkpoints = run(
        checkpoint=checkpoint, targets=[MODULES[1]], failures={task: ["length", "length"]},
    )
    assert [row["task"] for row in sdk.calls] == [task, task]
    assert section(recovered)["status"] == "failed"
    assert section(recovered, "synthesis")["diagnostics"]["reused"] is True
    assert retry_checkpoints[-1]["modules"]["synthesis"] == original_synthesis
    assert recovered.report["unified_report"]["source_signature"] == checkpoint["source_signature"]


@pytest.mark.parametrize("reviewed", [False, True])
def test_budget_growth_and_nonlength_errors_keep_their_existing_policies(reviewed):
    task = "content_classification:" + MODULES[0]
    result, sdk, _, _ = run(reviewed=reviewed, failures={task: ["length"]})
    calls = [row for row in sdk.calls if row["task"] == task]
    assert [row["max_completion_tokens"] for row in calls] == [4_500, 6_000]
    assert all("output_length_recovery" not in payload_of(row) for row in calls)
    assert section(result, MODULES[0])["status"] == "completed"

    result, sdk, _, _ = run(reviewed=reviewed, failures={task: ["timeout"]})
    assert sum(row["task"] == task for row in sdk.calls) == 1
    assert section(result, MODULES[0])["diagnostics"]["failure_kind"] == "timeout"
