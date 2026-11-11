"""Offline unified-provider regressions using real SDK schemas and typed media inputs."""

import copy
import json
import threading
from collections import Counter
from dataclasses import replace
from unittest.mock import patch

import httpx
import pytest
from instructor.core.exceptions import FailedAttempt, InstructorRetryException
from openai import APIStatusError, LengthFinishReasonError
from openai.types.chat import ChatCompletion
from openai.types.completion_usage import CompletionUsage
from pydantic import TypeAdapter, ValidationError
from test_content_module_protocol import compact_synthetic_response
from test_content_provider_integration import LegacyResponse, Sdk, inputs

from liming_analyzer.adapters import TranscriptOutput, VisualOutput
from liming_analyzer.api_client import ClaimedJob
from liming_analyzer.content_analysis import MODULES
from liming_analyzer.pipeline import AnalysisPipeline, _evidence_checkpoint
from liming_analyzer.providers import InstructorStructureAnalyzer
from liming_analyzer.unified_analysis import (
    UnifiedRequestError,
    _safe_schema_candidate,
    failure_details,
)


def payload_of(arguments):
    return json.loads(arguments["messages"][1]["content"])


def response_completion(*, input_tokens=100, output_tokens=20, finish_reason="stop", known=True):
    return ChatCompletion(
        id="synthetic-offline", object="chat.completion", created=0, model="synthetic",
        choices=[{"index": 0, "finish_reason": finish_reason,
                  "message": {"role": "assistant", "content": "{}"}}],
        usage=CompletionUsage(prompt_tokens=input_tokens, completion_tokens=output_tokens,
                              total_tokens=input_tokens + output_tokens,
                              completion_tokens_details={"reasoning_tokens": 3}) if known else None,
    )


class OfflineSdk:
    """No transport exists: every call returns or raises an explicitly synthetic value."""
    def __init__(self, *, failures=None, mutate_canonical=None):
        self.calls = []
        self.attempts = Counter()
        self.failures = failures or {}
        self.mutate_canonical = mutate_canonical
        self.chat = self
        self.completions = self
        self.lock = threading.Lock()

    def create_with_completion(self, **arguments):
        payload = payload_of(arguments)
        model = arguments["response_model"]
        if model.__name__ == "CanonicalTranscriptResponse":
            task = "canonical_transcript"
        else:
            assert model.__name__.startswith("CompactContentResponse_"), "legacy report must never be generated"
            task = "content_classification:" + payload["m"]
        with self.lock:
            self.calls.append({"task": task, **arguments})
            attempt = self.attempts[task]
            self.attempts[task] += 1
        plan = self.failures.get(task, ())
        action = plan[attempt] if attempt < len(plan) else None
        if action == "length":
            limit = arguments.get("max_completion_tokens", arguments.get("max_tokens"))
            raise LengthFinishReasonError(completion=response_completion(
                input_tokens=13, output_tokens=limit, finish_reason="length",
            ))
        if action == "overloaded":
            request = httpx.Request("POST", "https://synthetic.invalid/no-transport")
            raise APIStatusError("synthetic overloaded", response=httpx.Response(529, request=request), body={})
        if action == "timeout":
            raise TimeoutError("synthetic timeout")
        if action == "schema":
            model.model_validate({"invalid": "synthetic schema failure"})
            raise AssertionError("model schema must reject the synthetic invalid result")
        if isinstance(action, Exception):
            raise action
        if task == "canonical_transcript":
            value = {"segments": [{"s": row["s"], "t": row["t"]} for row in payload["segments"]]}
            if self.mutate_canonical:
                value = self.mutate_canonical(copy.deepcopy(value))
        else:
            value = compact_synthetic_response(payload["m"], payload, 6_000)
            if payload["m"] == MODULES[1] and not any(row["s"] in {"t", "o"} for row in payload["e"]):
                value["f"] = [row for row in value["f"] if row["k"] in {0, 1}]
        return model.model_validate(value), response_completion(known=action != "unknown_success")


class Ledger:
    def __init__(self):
        self.events = []
        self.lock = threading.Lock()

    def __call__(self, _job, event):
        with self.lock:
            self.events.append(dict(event))
            return {"records": len(self.events)}


def run_unified(*, sdk=None, profile="max", checkpoint=None, custom_inputs=None,
                provider="minimax", model="MiniMax-M3.1-Flash", cap=6_000,
                retry_module_keys=None):
    sdk = sdk or OfflineSdk()
    ledger, checkpoints = Ledger(), []
    analyzer = InstructorStructureAnalyzer(
        api_key="", base_url="https://synthetic.invalid", model=model, provider=provider,
        client=sdk, report_model=LegacyResponse, generate_content_features=True,
        generate_unified_report=True, max_output_tokens=cap, call_recorder=ledger,
    )
    analyzer.set_unified_checkpoint(lambda value: checkpoints.append(copy.deepcopy(value)))
    checkpoint_payload = {"unified_progress": checkpoint} if checkpoint else {}
    if retry_module_keys is not None:
        checkpoint_payload["retry_module_keys"] = list(retry_module_keys)
    job = ClaimedJob("unified-synthetic", "org", "project", "video", "upload", "analyzing",
                     84, 1, {}, analysis_profile=profile, checkpoint_stage="evidence_ready" if checkpoint else None,
                     checkpoint=checkpoint_payload or None)
    supplied = custom_inputs or inputs()
    result = analyzer.analyze(job, *supplied)
    return result, sdk, ledger, checkpoints, job, analyzer


def module_section(result, key):
    return next(row for row in result.report["unified_report"]["sections"] if row["key"] == key)


def test_production_flow_calls_only_canonical_and_four_compact_modules():
    result, sdk, ledger, checkpoints, _job, _analyzer = run_unified()
    assert result.schema_version == "analysis.v11"
    assert result.report["unified_report"]["status"] == "complete", result.report["unified_report"]["validation"]
    assert result.report["content_analysis"]["validation"]["passed"] is True
    assert result.report["analysis_meta"]["quality_audit"]["acceptance_passed"] is True
    assert Counter(row["task"] for row in sdk.calls) == Counter({
        "canonical_transcript": 1, **{"content_classification:" + module: 1 for module in MODULES},
    })
    assert sdk.calls[0]["task"] == "canonical_transcript"
    assert sdk.calls[-1]["task"] == "content_classification:synthesis"
    assert all(row["max_retries"] == 1 and "max_tokens" not in row for row in sdk.calls)
    started = [row for row in ledger.events if row["status"] == "started"]
    finished = [row for row in ledger.events if row["status"] == "completed"]
    assert {row["id"] for row in started} == {row["id"] for row in finished}
    assert len(started) == len(finished) == 5
    assert checkpoints[-1]["canonical"]["validation"]["passed"] is True
    assert set(checkpoints[-1]["modules"]) == set(MODULES)
    assert result.report["spoken_script_set"]["corrected_original"]["status"] == "completed"
    assert result.report["content_analysis"]["methodology"]["transcript_basis"] == "canonical"


def test_numeric_downgrade_fails_canonical_and_prevents_all_classification_sdk_calls():
    media, transcript, visuals = inputs()
    transcript = replace(transcript, segments=(replace(transcript.segments[0], text="现在使用Opus5.5版本。"),
                                               *transcript.segments[1:]))
    def downgrade(value):
        value["segments"][0]["t"] = "现在使用Opus4.5版本。"
        return value
    result, sdk, _ledger, checkpoints, *_rest = run_unified(
        sdk=OfflineSdk(mutate_canonical=downgrade), custom_inputs=(media, transcript, visuals),
    )
    canonical = result.report["unified_report"]["canonical"]
    assert canonical["status"] == "failed" and canonical["validation"]["passed"] is False
    assert any("numeric_or_version_changed" in issue for issue in canonical["validation"]["issues"])
    assert [row["task"] for row in sdk.calls] == ["canonical_transcript"]
    assert result.report["unified_report"]["status"] == "partial"
    assert result.report["analysis_meta"]["quality_audit"]["acceptance_passed"] is False
    assert checkpoints and len(checkpoints[0]["source_signature"]) == 64
    assert checkpoints[0]["canonical"] is None and checkpoints[0]["modules"] == {}
    assert not any(value.get("canonical") for value in checkpoints)


@pytest.mark.parametrize(("profile", "expected"), [("max", [4500, 6000]), ("standard", [3000, 6000])])
def test_real_sdk_length_exception_increases_budget_once_and_includes_failed_usage(profile, expected):
    task = "content_classification:" + MODULES[0]
    result, sdk, ledger, *_rest = run_unified(profile=profile, sdk=OfflineSdk(failures={task: ["length"]}))
    calls = [row for row in sdk.calls if row["task"] == task]
    assert [row["max_completion_tokens"] for row in calls] == expected
    assert result.report["unified_report"]["status"] == "complete"
    records = result.report["analysis_meta"]["model_requests"]
    assert len(records) == 6
    assert result.report["analysis_meta"]["actual_total_tokens"] == 5 * 120 + 13 + expected[0]
    failed = [row for row in ledger.events if row["status"] == "failed"]
    assert len(failed) == 1 and failed[0]["outputTokens"] == expected[0]
    diag = module_section(result, MODULES[0])["diagnostics"]
    assert diag["attempts"] == 2 and diag["reused"] is False
    assert diag["total_tokens"] == 120 + 13 + expected[0]


@pytest.mark.parametrize(("failure", "kind"), [("overloaded", "overloaded"), ("timeout", "timeout"),
                                              ("schema", "schema_invalid")])
def test_nonlength_failure_is_not_blindly_retried_and_blocks_paid_synthesis(failure, kind):
    task = "content_classification:" + MODULES[1]
    result, sdk, _ledger, checkpoints, *_rest = run_unified(sdk=OfflineSdk(failures={task: [failure]}))
    assert len([row for row in sdk.calls if row["task"] == task]) == 1
    assert not any(row["task"] == "content_classification:synthesis" for row in sdk.calls)
    assert module_section(result, MODULES[1])["diagnostics"]["failure_kind"] == kind
    synthesis = module_section(result, "synthesis")
    assert synthesis["reason"] == "upstream_module_failed"
    assert synthesis["diagnostics"]["failure_kind"] == "evidence_invalid"
    assert result.report["unified_report"]["status"] == "partial"
    assert set(checkpoints[-1]["modules"]) == {MODULES[0], "visual"}


def test_successful_checkpoint_restores_without_any_new_sdk_request():
    original, _sdk, _ledger, checkpoints, *_rest = run_unified()
    resumed, sdk, ledger, _snapshots, *_rest = run_unified(checkpoint=checkpoints[-1])
    assert sdk.calls == [] and ledger.events == []
    assert resumed.report["unified_report"]["status"] == "complete"
    assert resumed.report["unified_report"]["timing"]["cache_reused_count"] == 4
    assert resumed.report["unified_report"]["canonical"] == original.report["unified_report"]["canonical"]
    assert all(row["diagnostics"]["reused"] for row in resumed.report["unified_report"]["sections"])


def test_repeated_length_exhausts_two_attempts_without_spending_on_synthesis():
    task = "content_classification:" + MODULES[0]
    result, sdk, ledger, *_rest = run_unified(sdk=OfflineSdk(failures={task: ["length", "length", "length"]}))
    calls = [row for row in sdk.calls if row["task"] == task]
    assert [row["max_completion_tokens"] for row in calls] == [4500, 6000]
    assert not any(row["task"] == "content_classification:synthesis" for row in sdk.calls)
    assert module_section(result, MODULES[0])["diagnostics"]["failure_kind"] == "length"
    failures = [row for row in ledger.events if row["status"] == "failed"]
    assert len(failures) == 2 and sum(row["totalTokens"] for row in failures) == 10526
    assert result.report["analysis_meta"]["actual_total_tokens"] == 3 * 120 + 10526
    assert result.report["unified_report"]["status"] == "partial"


@pytest.mark.parametrize(("profile", "initial", "others"), [("standard", 4500, 3000), ("max", 6000, 4500)])
def test_expression_module_starts_at_its_observed_budget_without_an_extra_sdk_call(profile, initial, others):
    result, sdk, _ledger, *_rest = run_unified(profile=profile)
    task = "content_classification:" + MODULES[1]
    calls = [row for row in sdk.calls if row["task"] == task]
    assert len(calls) == 1 and calls[0]["max_completion_tokens"] == initial
    assert all(row["max_completion_tokens"] == others for row in sdk.calls if row["task"] != task)
    diag = module_section(result, MODULES[1])["diagnostics"]
    assert diag["attempts"] == 1 and diag["output_budget"] == initial
    assert len(result.report["analysis_meta"]["model_requests"]) == 5
    assert result.report["unified_report"]["status"] == "complete"


@pytest.mark.parametrize("configured_cap", [2500, 5000, 6000, 12000])
def test_expression_length_at_its_hard_cap_never_repeats_the_same_paid_budget(configured_cap):
    task = "content_classification:" + MODULES[1]
    result, sdk, ledger, *_rest = run_unified(
        cap=configured_cap, sdk=OfflineSdk(failures={task: ["length", "length"]}),
    )
    expected = min(configured_cap, 6000)
    assert [row["max_completion_tokens"] for row in sdk.calls if row["task"] == task] == [expected]
    assert not any(row["task"] == "content_classification:synthesis" for row in sdk.calls)
    diag = module_section(result, MODULES[1])["diagnostics"]
    assert diag["attempts"] == 1 and diag["output_budget"] == expected
    assert diag["failure_kind"] == "length"
    assert len([row for row in ledger.events if row["status"] == "failed"]) == 1


def test_standard_expression_length_can_increase_from_4500_to_6000_once():
    task = "content_classification:" + MODULES[1]
    result, sdk, *_rest = run_unified(profile="standard", sdk=OfflineSdk(failures={task: ["length"]}))
    assert [row["max_completion_tokens"] for row in sdk.calls if row["task"] == task] == [4500, 6000]
    assert module_section(result, MODULES[1])["diagnostics"]["attempts"] == 2
    assert result.report["unified_report"]["status"] == "complete"


def test_a_successful_sdk_response_without_usage_remains_unknown_not_zero():
    task = "content_classification:" + MODULES[1]
    result, _sdk, ledger, *_rest = run_unified(sdk=OfflineSdk(failures={task: ["unknown_success"]}))
    meta = result.report["analysis_meta"]
    assert result.report["unified_report"]["status"] == "complete"
    assert meta["actual_total_tokens"] is None and meta["unknown_usage_requests"] == 1
    assert meta["known_total_tokens"] == 4 * 120
    record = next(row for row in meta["model_requests"] if row["task"] == task)
    assert record["total_tokens"] is None and record["output_tokens"] is None
    finished = next(row for row in ledger.events if row["task"] == task and row["status"] == "completed")
    assert finished.get("totalTokens") is None


@pytest.mark.parametrize("track", ["audio_only", "silent_video"])
def test_explicit_inapplicable_track_does_not_block_unified_completion(track):
    media, transcript, visuals = inputs()
    if track == "audio_only":
        media = replace(media, info=replace(media.info, video_codec=None, width=None, height=None))
        visuals = VisualOutput()
    else:
        media = replace(media, info=replace(media.info, audio_codec=None))
        transcript = TranscriptOutput("zh-CN", (), None)
        visuals = replace(visuals, keyframes=tuple(replace(row, ocr_text=None) for row in visuals.keyframes),
                          stats={**visuals.stats, "ocr_error_count": 0, "ocr_observation_count": 0})
    result, sdk, _ledger, *_rest = run_unified(custom_inputs=(media, transcript, visuals))
    assert result.report["unified_report"]["status"] == "complete", result.report["unified_report"]["validation"]
    if track == "audio_only":
        assert module_section(result, "visual")["status"] == "not_applicable"
        assert len(sdk.calls) == 4
    else:
        assert result.report["unified_report"]["canonical"]["status"] == "not_applicable"
        assert module_section(result, MODULES[0])["status"] == "not_applicable"
        assert len(sdk.calls) == 3
    assert sdk.calls[-1]["task"] == "content_classification:synthesis"


def test_retry_only_requests_failed_module_and_the_deferred_synthesis():
    failed_task = "content_classification:" + MODULES[1]
    first, _sdk, _ledger, checkpoints, *_rest = run_unified(sdk=OfflineSdk(failures={failed_task: ["overloaded"]}))
    assert first.report["unified_report"]["status"] == "partial"
    repaired, sdk, _ledger, *_rest = run_unified(checkpoint=checkpoints[-1])
    assert [row["task"] for row in sdk.calls] == [failed_task, "content_classification:synthesis"]
    assert repaired.report["unified_report"]["status"] == "complete"
    assert module_section(repaired, MODULES[0])["diagnostics"]["reused"] is True
    assert module_section(repaired, "visual")["diagnostics"]["reused"] is True


def test_targeted_retry_defers_other_failed_module_then_only_completes_it_and_synthesis():
    first, sdk, _ledger, checkpoints, *_rest = run_unified(sdk=OfflineSdk(failures={
        "content_classification:" + MODULES[0]: ["overloaded"],
        "content_classification:visual": ["timeout"],
    }))
    assert first.report["unified_report"]["status"] == "partial"
    assert set(checkpoints[-1]["modules"]) == {MODULES[1]}
    assert not any(row["task"] == "content_classification:synthesis" for row in sdk.calls)

    partial, visual_sdk, visual_ledger, visual_checkpoints, *_rest = run_unified(
        checkpoint=checkpoints[-1], retry_module_keys=["visual"],
    )
    assert [row["task"] for row in visual_sdk.calls] == ["content_classification:visual"]
    assert {row["task"] for row in visual_ledger.events} == {"content_classification:visual"}
    deferred = module_section(partial, MODULES[0])
    assert deferred["status"] == "failed" and deferred["reason"] == "not_requested"
    assert deferred["diagnostics"]["attempts"] == 0
    assert deferred["diagnostics"]["failure_kind"] is None
    assert module_section(partial, MODULES[1])["diagnostics"]["reused"] is True
    assert module_section(partial, "synthesis")["reason"] == "upstream_module_failed"
    assert set(visual_checkpoints[-1]["modules"]) == {MODULES[1], "visual"}

    complete, final_sdk, _ledger, *_rest = run_unified(
        checkpoint=visual_checkpoints[-1], retry_module_keys=[MODULES[0]],
    )
    assert [row["task"] for row in final_sdk.calls] == [
        "content_classification:" + MODULES[0], "content_classification:synthesis",
    ]
    assert complete.report["unified_report"]["status"] == "complete"
    assert module_section(complete, MODULES[1])["diagnostics"]["reused"] is True
    assert module_section(complete, "visual")["diagnostics"]["reused"] is True


def test_target_visual_with_corrupt_canonical_cache_never_secretly_pays_for_correction():
    _first, _sdk, _ledger, checkpoints, *_rest = run_unified()
    damaged = copy.deepcopy(checkpoints[-1])
    # Keep the claimed passed flag/hash; actual source/fact validation must reject it.
    damaged["canonical"]["segments"][0]["text"] = "现在使用Opus4.5版本。"
    result, sdk, ledger, snapshots, *_rest = run_unified(
        checkpoint=damaged, retry_module_keys=["visual"],
    )
    assert sdk.calls == [] and ledger.events == []
    assert snapshots and snapshots[0]["source_signature"] == damaged["source_signature"]
    canonical = result.report["unified_report"]["canonical"]
    assert canonical["status"] == "failed" and canonical["validation"]["passed"] is False
    assert result.report["unified_report"]["status"] == "partial"
    assert result.report["analysis_meta"]["canonical_diagnostics"]["attempts"] == 0
    assert result.report["analysis_meta"]["canonical_diagnostics"]["failure_kind"] == "canonical_failed"


@pytest.mark.parametrize("change", ["model", "source", "profile"])
def test_model_source_and_profile_changes_invalidate_affected_cache(change):
    _first, _sdk, _ledger, checkpoints, *_rest = run_unified(profile="standard")
    arguments = {"checkpoint": checkpoints[-1], "profile": "standard"}
    if change == "model":
        arguments["model"] = "synthetic-changed-model"
    elif change == "source":
        media, transcript, visuals = inputs()
        transcript = replace(transcript, segments=(replace(transcript.segments[0], text=transcript.segments[0].text + "请保留这条原句。"),
                                                   *transcript.segments[1:]))
        arguments["custom_inputs"] = media, transcript, visuals
    else:
        arguments["profile"] = "max"
    result, sdk, _ledger, *_rest = run_unified(**arguments)
    assert result.report["unified_report"]["status"] == "complete"
    assert {row["task"] for row in sdk.calls if row["task"].startswith("content_classification:")} == {
        "content_classification:" + module for module in MODULES
    }
    assert len(sdk.calls) == (4 if change == "profile" else 5)


def test_vision_and_failed_classification_usage_are_merged_and_unknown_is_not_zero():
    media, transcript, visuals = inputs()
    batches = [{"index": 1, "attempt": 1, "status": "failed", "failure_kind": "overloaded",
                "http_status": 529, "finish_reason": None, "elapsed_ms": 7, "output_budget": 4800,
                "input_tokens": None, "output_tokens": None, "total_tokens": None, "reasoning_tokens": None},
               {"index": 1, "attempt": 2, "status": "completed", "failure_kind": None,
                "http_status": None, "finish_reason": "stop", "elapsed_ms": 8, "output_budget": 4800,
                "input_tokens": 50, "output_tokens": 10, "total_tokens": 60, "reasoning_tokens": 2}]
    visuals = replace(visuals, stats={**visuals.stats, "visual_understanding": {
        **visuals.stats["visual_understanding"], "batches": batches, "request_count": 2,
    }})
    task = "content_classification:" + MODULES[0]
    result, sdk, _ledger, *_rest = run_unified(custom_inputs=(media, transcript, visuals),
                                              sdk=OfflineSdk(failures={task: ["length"]}))
    meta = result.report["analysis_meta"]
    assert len(sdk.calls) == 6
    assert len(meta["model_requests"]) == 8
    assert meta["actual_total_tokens"] is None
    assert meta["known_total_tokens"] == 5 * 120 + 13 + 4500 + 60
    assert meta["unknown_usage_requests"] == 1
    vision = [row for row in meta["model_requests"] if row["task"] == "vision_batch"]
    assert len(vision) == 2 and vision[0]["total_tokens"] is None


def test_pipeline_persists_unified_progress_with_original_evidence_and_restores_it():
    media, transcript, visuals = inputs()
    evidence = _evidence_checkpoint(media, transcript, visuals, None)
    sdk, ledger = OfflineSdk(), Ledger()
    analyzer = InstructorStructureAnalyzer(
        api_key="", base_url="https://synthetic.invalid", model="fixture", provider="fixture",
        client=sdk, report_model=LegacyResponse, generate_content_features=True,
        generate_unified_report=True, call_recorder=ledger,
    )
    class NeverAcquire:
        def __getattr__(self, name):
            raise AssertionError("cached evidence must not reacquire media: " + name)
    class Store:
        def __init__(self):
            self.saved = []
        def save(self, job, stage, payload):
            self.saved.append((job, stage, copy.deepcopy(payload)))
    store = Store()
    unused = NeverAcquire()
    pipeline = AnalysisPipeline(unused, unused, unused, unused, analyzer,
                                checkpoints=store, heartbeat_seconds=0.001)
    job = ClaimedJob("pipeline-synthetic", "org", "project", "video", "upload", "queued", 1, 1,
                     {}, checkpoint_stage="evidence_ready", checkpoint=evidence)
    def heartbeat(status, progress, _stage):
        return replace(job, status=status, progress=progress, version=job.version + 1)
    result = pipeline.process(job, heartbeat)
    assert result.schema_version == "analysis.v11"
    assert store.saved and all(stage == "evidence_ready" for _job, stage, _payload in store.saved)
    restored = store.saved[-1][2]
    assert restored["transcript"]["language"] == transcript.language
    assert restored["transcript"]["confidence"] == transcript.confidence
    assert restored["visuals"]["keyframes"][0]["roles"] == list(visuals.keyframes[0].roles)
    assert set(restored["unified_progress"]["modules"]) == set(MODULES)
    assert analyzer._unified_checkpoint is None
    sdk.calls.clear()
    resumed_job = replace(job, checkpoint=restored)
    def resumed_heartbeat(status, progress, _stage):
        return replace(resumed_job, status=status, progress=progress, version=resumed_job.version + 1)
    again = pipeline.process(resumed_job, resumed_heartbeat)
    assert again.report["unified_report"]["status"] == "complete"
    assert sdk.calls == []


def test_real_sdk_constructor_defaults_to_v11_but_legacy_injection_keeps_v9():
    sdk, ledger = OfflineSdk(), Ledger()
    with patch("openai.OpenAI", return_value=object()), patch("instructor.from_openai", return_value=sdk):
        analyzer = InstructorStructureAnalyzer(
            api_key="synthetic-offline-key", base_url="https://synthetic.invalid", model="fixture",
            provider="fixture", call_recorder=ledger,
        )
    job = ClaimedJob("factory-synthetic", "org", "project", "video", "upload", "analyzing", 84, 1, {})
    result = analyzer.analyze(job, *inputs())
    assert analyzer.generate_unified_report is True and result.schema_version == "analysis.v11"
    assert not any(row["task"] in {"report", "corrected_original"} for row in ledger.events)
    _media, transcript, visuals = inputs()
    legacy_sdk = Sdk(transcript, visuals)
    legacy = InstructorStructureAnalyzer(api_key="", base_url="https://synthetic.invalid", model="fixture",
                                         provider="fixture", client=legacy_sdk, report_model=LegacyResponse)
    legacy_result = legacy.analyze(job, *inputs())
    assert legacy.generate_unified_report is False and legacy_result.schema_version == "analysis.v9"


def synthetic_validation_error():
    with pytest.raises(ValidationError) as caught:
        TypeAdapter(int).validate_python("synthetic-invalid-integer")
    return caught.value


def instructor_wrapper(cause, *, content="{}", finish_reason="stop", link="cause"):
    completion = response_completion(finish_reason=finish_reason)
    completion.choices[0].message.content = content
    error = InstructorRetryException(
        "private-exception-message", last_completion=completion, n_attempts=1,
        total_usage=completion.usage,
        create_kwargs={"messages": [{"content": "private-request-prompt"}], "api_key": "private-api-key"},
        failed_attempts=[FailedAttempt(1, cause, completion)],
    )
    if link is not None:
        setattr(error, "__" + link + "__", cause)
    return error


@pytest.mark.parametrize("link", ["cause", "context", None])
def test_instructor_wrapper_retains_real_validation_kind_without_exposing_its_message(link):
    error = instructor_wrapper(synthetic_validation_error(), link=link)
    assert failure_details(error) == {"failure_kind": "schema_invalid", "http_status": None,
                                      "finish_reason": "stop"}


@pytest.mark.parametrize("status", [429, 503, 529])
def test_instructor_wrapper_retains_actual_overload_status(status):
    request = httpx.Request("POST", "https://synthetic.invalid/no-transport")
    cause = APIStatusError("private-http-message", response=httpx.Response(status, request=request), body={})
    assert failure_details(instructor_wrapper(cause)) == {
        "failure_kind": "overloaded", "http_status": status, "finish_reason": "stop",
    }


def test_wrapped_timeout_and_inner_completion_are_read_without_scanning_exception_text():
    assert failure_details(instructor_wrapper(TimeoutError("private-timeout"))) == {
        "failure_kind": "timeout", "http_status": None, "finish_reason": "stop",
    }
    cause = synthetic_validation_error()
    cause.completion = {"choices": [{"finish_reason": "stop", "message": {"content": '{"c":[]}'}}]}
    outer = RuntimeError("private-outer-message")
    outer.__cause__ = cause
    assert _safe_schema_candidate(outer, failure_details(outer)) == {"c": []}
    outer.__context__ = outer
    assert failure_details(outer)["failure_kind"] == "schema_invalid"


@pytest.mark.parametrize("content", [
    "[]", '"a JSON string"', "null", "```json\n{}\n```", '{"c":', '{} trailing',
    '{"x":NaN}', '{"x":Infinity}', '{"x":-Infinity}', '{"c":[],"c":[1]}',
    '{"x":{"n":1,"n":2}}', '{"x":"\\ud800"}',
    json.dumps({"x": "a" * 65_536}), json.dumps({"x": "中" * 30_000}, ensure_ascii=False),
    '{"x":' + '[' * 1_200 + '0' + ']' * 1_200 + '}',
])
def test_schema_candidate_rejects_nonobject_nonjson_ambiguous_or_oversized_output(content):
    error = instructor_wrapper(synthetic_validation_error(), content=content)
    assert _safe_schema_candidate(error, failure_details(error)) is None


def test_schema_candidate_utf8_byte_boundary_and_length_exclusion():
    content = '{"x":"' + 'a' * (65_536 - 8) + '"}'
    assert len(content.encode("utf-8")) == 65_536
    error = instructor_wrapper(synthetic_validation_error(), content=content)
    assert _safe_schema_candidate(error, failure_details(error)) == json.loads(content)
    error.last_completion.choices[0].message.content = content + " "
    assert _safe_schema_candidate(error, failure_details(error)) is None
    error = instructor_wrapper(synthetic_validation_error(), content='{"c":[]}', finish_reason="length")
    assert failure_details(error)["failure_kind"] == "length"
    assert _safe_schema_candidate(error, failure_details(error)) is None
    assert _safe_schema_candidate(instructor_wrapper(TimeoutError(), content='{"c":[]}'),
                                  {"failure_kind": "timeout", "finish_reason": "stop"}) is None


def test_wrapped_schema_failure_keeps_candidate_internal_and_never_pays_for_a_retry(caplog):
    candidate = {"c": [{"d": 0, "s": 1, "r": "private-candidate-only"}], "g": [], "u": [], "f": []}
    wrapped = instructor_wrapper(synthetic_validation_error(), content=json.dumps(candidate))
    failures = []

    class CapturingRequestError(UnifiedRequestError):
        def __init__(self, *args, **kwargs):
            super().__init__(*args, **kwargs)
            failures.append(self)

    task = "content_classification:" + MODULES[1]
    with patch("liming_analyzer.unified_analysis.UnifiedRequestError", CapturingRequestError):
        result, sdk, ledger, *_rest = run_unified(sdk=OfflineSdk(failures={task: [wrapped]}))
    assert len([row for row in sdk.calls if row["task"] == task]) == 1
    assert not any(row["task"] == "content_classification:synthesis" for row in sdk.calls)
    assert len(failures) == 1 and failures[0].safe_candidate == candidate
    assert failures[0].diagnostics["failure_kind"] == "schema_invalid"
    assert module_section(result, MODULES[1])["diagnostics"]["failure_kind"] == "schema_invalid"
    assert len([row for row in ledger.events if row["status"] == "failed"]) == 1
    public = json.dumps(result.report) + json.dumps(ledger.events) + caplog.text
    for private in ("private-exception-message", "private-request-prompt", "private-api-key", "private-candidate-only"):
        assert private not in public


def test_instructor_wrapped_length_still_increases_the_budget_once():
    cause = LengthFinishReasonError(completion=response_completion(finish_reason="length"))
    wrapped = instructor_wrapper(cause, content='{"c":[]}', finish_reason="length")
    task = "content_classification:" + MODULES[0]
    result, sdk, *_rest = run_unified(sdk=OfflineSdk(failures={task: [wrapped]}))
    assert [row["max_completion_tokens"] for row in sdk.calls if row["task"] == task] == [4500, 6000]
    assert result.report["unified_report"]["status"] == "complete"
