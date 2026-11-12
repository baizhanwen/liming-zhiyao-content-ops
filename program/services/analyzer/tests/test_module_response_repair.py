"""Structured module recovery keeps reusable work and a finite request budget."""
import copy

import pytest

from liming_analyzer.content_analysis import MODULES, build_content_analysis_bundle
from test_content_review import failed_visual_candidate, reviewed_inputs
from test_reviewed_analysis import ReviewedSdk, run_reviewed
from test_unified_analysis import module_section, payload_of, run_unified


@pytest.mark.parametrize("reviewed", [False, True])
def test_schema_failure_gets_one_field_specific_repair_and_keeps_other_modules_once(reviewed):
    task = "content_classification:" + MODULES[1]
    sdk = ReviewedSdk()
    sdk.failures = {task: ["schema"]}
    result, sdk, ledger, *_rest = run_reviewed(sdk) if reviewed else run_unified(sdk=sdk)
    calls = [row for row in sdk.calls if row["task"] == task]
    assert len(calls) == 2
    assert "response_repair" not in payload_of(calls[0])
    repair = payload_of(calls[1])["response_repair"]
    assert "c:missing" in repair["issues"]
    assert "u.t" in repair["instruction"]
    assert result.report["unified_report"]["status"] == "complete"
    assert module_section(result, MODULES[1])["diagnostics"]["attempts"] == 2
    assert sum(row["task"] == task and row["status"] == "started" for row in ledger.events) == 2
    assert sum(row["task"] == task and row["status"] == "failed" for row in ledger.events) == 1
    for module in (MODULES[0], "visual", "synthesis"):
        assert sum(row["task"] == "content_classification:" + module for row in sdk.calls) == 1


@pytest.mark.parametrize("reviewed", [False, True])
@pytest.mark.parametrize("failures", [["schema", "schema", "schema"], ["length", "schema", "schema"]])
def test_length_and_schema_repairs_share_the_same_two_paid_request_limit(reviewed, failures):
    task = "content_classification:" + MODULES[0]
    sdk = ReviewedSdk()
    sdk.failures = {task: failures}
    result, sdk, ledger, *_rest = run_reviewed(sdk) if reviewed else run_unified(sdk=sdk)
    assert sum(row["task"] == task for row in sdk.calls) == 2
    assert sum(row["task"] == task and row["status"] == "started" for row in ledger.events) == 2
    assert module_section(result, MODULES[0])["status"] == "failed"
    assert module_section(result, MODULES[0])["diagnostics"]["attempts"] == 2


@pytest.mark.parametrize("reviewed", [False, True])
def test_semantic_reference_error_is_repaired_using_the_same_input_and_exact_failure(reviewed):
    task = "content_classification:" + MODULES[0]

    class BadReferenceSdk(ReviewedSdk):
        def create_with_completion(self, **arguments):
            response, completion = super().create_with_completion(**arguments)
            payload = payload_of(arguments)
            if payload.get("m") == MODULES[0] and self.attempts[task] == 1:
                raw = response.model_dump()
                raw["c"][0]["e"] = [len(payload["e"]) + 10]
                response = arguments["response_model"].model_validate(raw)
            return response, completion

    result, sdk, _ledger, *_rest = run_reviewed(BadReferenceSdk()) if reviewed else run_unified(sdk=BadReferenceSdk())
    calls = [payload_of(row) for row in sdk.calls if row["task"] == task]
    assert len(calls) == 2
    assert calls[1]["response_repair"]["issues"] == ["compact_evidence_index"]
    original = copy.deepcopy(calls[1])
    original.pop("response_repair")
    assert original == calls[0]
    assert module_section(result, MODULES[0])["status"] == "completed"


def test_explicit_saved_candidate_repair_carries_error_and_requests_only_failed_module_once():
    from test_content_module_protocol import compact_synthetic_response

    inputs, review = reviewed_inputs()
    current, failed = failed_visual_candidate(inputs, review)
    failed["candidate"]["c"][0]["e"] = [999_999]
    calls = []

    def request(module, wire, cap):
        calls.append((module, copy.deepcopy(wire)))
        return compact_synthetic_response(module, wire, cap)

    result = build_content_analysis_bundle(*inputs, request, review_context=review,
        resume_modules=current["module_results"], resume_failures={"visual": failed}, retry_module_keys=("visual",))
    assert [module for module, _wire in calls] == ["visual"]
    assert calls[0][1]["response_repair"]["issues"] == ["compact_evidence_index"]
    assert result["content_analysis"]["status"] == "complete"


def test_targeted_repair_revalidates_existing_synthesis_without_a_new_summary_call():
    task = "content_classification:" + MODULES[0]
    first_sdk = ReviewedSdk()
    first_sdk.failures = {task: ["schema", "schema"]}
    first, _sdk, _ledger, checkpoints = run_reviewed(first_sdk)
    previous = checkpoints[-1]
    assert module_section(first, MODULES[0])["status"] == "failed"
    assert module_section(first, "synthesis")["status"] == "completed"
    original_signature = previous["modules"]["synthesis"]["signature"]

    result, sdk, ledger, resumed = run_reviewed(checkpoint=previous, targets=[MODULES[0]])
    assert [row["task"] for row in sdk.calls] == [task]
    assert sum(row["status"] == "started" for row in ledger.events) == 1
    assert result.report["unified_report"]["status"] == "complete"
    assert module_section(result, "synthesis")["diagnostics"]["reused"] is True
    saved = resumed[-1]["modules"]["synthesis"]
    assert saved["generation_signature"] == original_signature
    assert saved["revalidated_from_signature"] == original_signature
    assert saved["signature"] != original_signature


def test_changed_source_cannot_revalidate_a_previous_synthesis_on_targeted_retry():
    from dataclasses import replace
    from test_reviewed_analysis import review_inputs

    _first, _sdk, _ledger, checkpoints = run_reviewed()
    media, transcript, visuals = review_inputs()
    media = replace(media, info=replace(media.info, width=media.info.width + 1))
    result, sdk, _ledger, resumed = run_reviewed(checkpoint=checkpoints[-1], targets=[MODULES[0]],
        custom_inputs=(media, transcript, visuals))
    assert module_section(result, "synthesis")["status"] == "not_acquired"
    assert module_section(result, "synthesis")["diagnostics"]["reused"] is False
    assert not any(row["task"] == "content_classification:synthesis" for row in sdk.calls)
    assert "synthesis" not in resumed[-1]["modules"]
