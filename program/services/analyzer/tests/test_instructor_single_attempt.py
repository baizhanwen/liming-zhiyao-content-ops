"""Real Instructor/OpenAI wrappers over an in-memory, never-network transport."""
from __future__ import annotations

import copy
import json
from collections import Counter
from contextlib import contextmanager
from dataclasses import replace
from pathlib import Path
from threading import Lock

import httpx
import instructor
import pytest
from openai import OpenAI
from test_content_module_protocol import compact_synthetic_response
from test_content_provider_integration import LegacyResponse, inputs
from test_unified_analysis import Ledger, response_completion

from liming_analyzer.adapters import Keyframe
from liming_analyzer.api_client import ClaimedJob
from liming_analyzer.canonical_review import create_review_response_model
from liming_analyzer.content_analysis import MODULES
from liming_analyzer.content_module_protocol import create_compact_response_model
from liming_analyzer.model_calls import ModelCalls, exception_usage, usage_counts
from liming_analyzer.model_compat import completion_options, single_attempt_retry
from liming_analyzer.providers import InstructorStructureAnalyzer
from liming_analyzer.unified_analysis import _safe_schema_candidate, failure_details


class SyntheticTransport:
    def __init__(self, plans=None, *, pending_after_length=False):
        self.plans = plans or {}
        self.pending_after_length = pending_after_length
        self.requests = []
        self.attempts = Counter()
        self.lock = Lock()

    def handle(self, request):
        body = json.loads(request.content)
        # MD_JSON appends its own output reminder after the user's JSON object.
        payload = next(json.JSONDecoder().raw_decode(message["content"])[0] for message in body["messages"]
                       if message["role"] == "user" and message["content"].startswith("{"))
        if "m" in payload:
            task = "content_classification:" + payload["m"]
        elif payload.get("protocol_version") == "canonical-transcript.v2":
            task = "canonical_repair" if any("previous_uncertain" in row for row in payload["segments"]) else "canonical_review"
        else:
            task = "canonical_transcript"
        with self.lock:
            position = self.attempts[task]
            self.attempts[task] += 1
            self.requests.append({"task": task, "body": body})
        plan = self.plans.get(task, ())
        action = plan[position] if position < len(plan) else None
        if action == "confirm_source":
            value = {"patches": [], "uncertain": [], "punctuation": [], "confirmed_original": [
                {"s": payload["segments"][0]["s"], "text": payload["segments"][0]["text"], "basis": "普通原文语法通顺，可由上下文确认原样保留"}]}
        elif action in {"schema", "schema_fence"}:
            # Complete, bounded JSON with a genuine schema violation. Keeping
            # its completion matters for the private safe-candidate checkpoint.
            value = {"c": "invalid", "g": [], "u": [], "f": []} if "m" in payload else {"patches": "invalid", "uncertain": []}
        elif "m" in payload:
            value = compact_synthetic_response(payload["m"], payload, 6_000)
            if action == "overrefs":
                assert len(payload["e"]) >= 30
                value["c"][0]["e"] = list(range(30))
        elif task == "canonical_transcript":
            value = {"segments": [{"s": row["s"], "t": row["t"]} for row in payload["segments"]]}
        else:
            value = {"patches": [], "uncertain": [{"s": 2, "reason": "仍需听原片核对"}]
                     if self.pending_after_length else [], "punctuation": []}
        output_tokens = body.get("max_completion_tokens", body.get("max_tokens")) if action == "length" else 17
        content = json.dumps(value, ensure_ascii=False)
        if action == "schema_fence":
            content = "```json\n" + content + "\n```"
        return httpx.Response(200, json={
            "id": f"synthetic-{task}-{position}", "object": "chat.completion", "created": 0,
            "model": body["model"], "choices": [{"index": 0, "finish_reason": "length" if action == "length" else "stop",
                "message": {"role": "assistant", "content": content}}],
            "usage": {"prompt_tokens": 13, "completion_tokens": output_tokens, "total_tokens": 13 + output_tokens,
                      "completion_tokens_details": {"reasoning_tokens": 2}},
        })


@contextmanager
def wrapped_client(transport):
    # MockTransport handles every request locally; no DNS/socket/API exists.
    with httpx.Client(transport=httpx.MockTransport(transport.handle)) as http:
        raw = OpenAI(api_key="synthetic", base_url="https://synthetic.invalid/v1", http_client=http, max_retries=0)
        yield instructor.from_openai(raw, mode=instructor.Mode.MD_JSON)


def run_pipeline(*, reviewed, plans=None, pending_after_length=False, custom_inputs=None):
    transport, ledger, checkpoints = SyntheticTransport(plans, pending_after_length=pending_after_length), Ledger(), []
    with wrapped_client(transport) as client:
        analyzer = InstructorStructureAnalyzer(api_key="", base_url="https://synthetic.invalid/v1",
            provider="minimax", model="MiniMax-M3.1-Flash", client=client, report_model=LegacyResponse,
            generate_content_features=True, generate_unified_report=True, generate_reviewed_report=reviewed,
            max_output_tokens=6_000, call_recorder=ledger)
        analyzer.set_unified_checkpoint(lambda value: checkpoints.append(copy.deepcopy(value)))
        job = ClaimedJob("synthetic-single-attempt", "org", "project", "video", "upload", "analyzing", 84, 1, {}, analysis_profile="max")
        result = analyzer.analyze(job, *(inputs() if custom_inputs is None else custom_inputs))
    started = [row for row in ledger.events if row["status"] == "started"]
    finished = [row for row in ledger.events if row["status"] in {"completed", "failed"}]
    assert len(started) == len(finished) == len(transport.requests)
    assert {row["id"] for row in started} == {row["id"] for row in finished}
    return result, transport, ledger, checkpoints


@pytest.mark.parametrize("task", ["canonical_review", "content_classification:" + MODULES[0]])
@pytest.mark.parametrize("fenced", [False, True])
def test_actual_instructor_schema_failure_is_one_transport_call_with_completion_usage_and_candidate(task, fenced):
    transport, ledger = SyntheticTransport({task: ["schema_fence" if fenced else "schema"]}), Ledger()
    canonical = task == "canonical_review"
    model = create_review_response_model() if canonical else create_compact_response_model(MODULES[0], dimension_count=1)
    payload = {"protocol_version": "canonical-transcript.v2", "segments": [{"s": 1, "text": "合成原句"}]} if canonical else {"m": MODULES[0]}
    with wrapped_client(transport) as client, pytest.raises(Exception) as caught:
        ModelCalls(object(), ledger).invoke(task, 4500, lambda: client.chat.completions.create_with_completion(
            model="MiniMax-M3.1-Flash", response_model=model, max_retries=single_attempt_retry(),
            **completion_options("minimax", "MiniMax-M3.1-Flash", 4500),
            messages=[{"role": "user", "content": json.dumps(payload)}]))
    assert len(transport.requests) == 1
    detail = failure_details(caught.value)
    assert detail == {"failure_kind": "schema_invalid", "http_status": None, "finish_reason": "stop"}
    assert usage_counts(exception_usage(caught.value)) == {"inputTokens": 13, "outputTokens": 17, "totalTokens": 30}
    expected = {"patches": "invalid", "uncertain": []} if canonical else {"c": "invalid", "g": [], "u": [], "f": []}
    assert _safe_schema_candidate(caught.value, detail) == (None if fenced else expected)
    assert _safe_schema_candidate(caught.value, detail, allow_markdown=True) == expected
    assert len(ledger.events) == 2 and ledger.events[-1]["status"] == "failed"
    assert ledger.events[-1]["totalTokens"] == 30


@pytest.mark.parametrize("reviewed", [False, True])
def test_actual_instructor_success_keeps_raw_completion_and_records_each_transport_once(reviewed):
    result, transport, ledger, _cp = run_pipeline(reviewed=reviewed)
    assert result.report["unified_report"]["status"] == "complete", result.report["unified_report"]["validation"]
    assert len(transport.requests) == 5
    assert result.report["analysis_meta"]["actual_total_tokens"] == 150
    assert all(row["totalTokens"] == 30 for row in ledger.events if row["status"] == "completed")


@pytest.mark.parametrize("reviewed", [False, True])
@pytest.mark.parametrize("fenced", [False, True])
def test_actual_instructor_content_schema_failure_has_one_explicit_repair_and_no_hidden_retry(reviewed, fenced):
    task = "content_classification:" + MODULES[1]
    violation = "schema_fence" if fenced else "schema"
    result, transport, ledger, cp = run_pipeline(reviewed=reviewed, plans={task: [violation, violation]})
    assert transport.attempts[task] == 2
    requests = [row["body"] for row in transport.requests if row["task"] == task]
    payloads = [next(json.JSONDecoder().raw_decode(message["content"])[0] for message in body["messages"]
                     if message["role"] == "user" and message["content"].startswith("{")) for body in requests]
    assert "response_repair" not in payloads[0]
    repair = payloads[1].pop("response_repair")
    assert repair["issues"] and all("private" not in issue and "https:" not in issue for issue in repair["issues"])
    assert "u.t" in repair["instruction"]
    assert payloads[0] == payloads[1]
    section = next(row for row in result.report["unified_report"]["sections"] if row["key"] == MODULES[1])
    assert section["diagnostics"]["failure_kind"] == "schema_invalid"
    assert section["diagnostics"]["attempts"] == 2 and section["diagnostics"]["total_tokens"] == 60
    assert len([row for row in ledger.events if row["task"] == task and row["status"] == "started"]) == 2
    assert len([row for row in ledger.events if row["task"] == task and row["status"] == "failed"]) == 2
    assert all(row["totalTokens"] == 30 for row in ledger.events if row["task"] == task and row["status"] == "failed")
    if reviewed:
        assert cp[-1]["failed_modules"][MODULES[1]]["candidate"] == {"c": "invalid", "g": [], "u": [], "f": []}


def test_reviewed_sdk_candidate_local_recovery_clears_final_module_failure_but_preserves_real_usage():
    media, transcript, visuals = inputs()
    # A receives at least 30 real, distinct evidence rows; no image inference is
    # involved. The actual SDK rejects its 30 refs before local normalization.
    extra = tuple(Keyframe(1_500 + index * 100, Path(f"synthetic-extra-{index}.jpg"),
        f"合成界面文字编号{index}", 94, f"synthetic_extra_{index}", ("representative",)) for index in range(33))
    visuals = replace(visuals, keyframes=(*visuals.keyframes, *extra))
    task = "content_classification:" + MODULES[0]
    result, transport, ledger, checkpoints = run_pipeline(reviewed=True,
        plans={task: ["overrefs"]}, custom_inputs=(media, transcript, visuals))

    section = next(row for row in result.report["unified_report"]["sections"] if row["key"] == MODULES[0])
    assert section["status"] == "completed"
    assert section["diagnostics"]["failure_kind"] is None
    assert section["diagnostics"]["attempts"] == 1
    assert section["diagnostics"]["total_tokens"] == 30
    assert result.report["unified_report"]["status"] == "complete"
    assert result.report["unified_report"]["validation"]["passed"] is True

    assert transport.attempts[task] == 1 and len(transport.requests) == 5
    records = [row for row in result.report["analysis_meta"]["model_requests"] if row["task"] == task]
    assert len(records) == 1 and records[0]["failure_kind"] == "schema_invalid"
    assert (records[0]["input_tokens"], records[0]["output_tokens"], records[0]["total_tokens"]) == (13, 17, 30)
    paid = [row for row in ledger.events if row["task"] == task and row["status"] in {"completed", "failed"}]
    assert len(paid) == 1 and paid[0]["status"] == "failed" and paid[0]["totalTokens"] == 30
    assert result.report["analysis_meta"]["actual_total_tokens"] == 150

    normalized = next(row for row in checkpoints[-1]["modules"][MODULES[0]]["response"]["classifications"]
                      if row["dimension_id"] == "topic.category")
    assert normalized["state"] == "unknown" and normalized["evidence_ids"] == []
    assert normalized["reason"] == "classification_reference_limit_exceeded"


@pytest.mark.parametrize("task", ["canonical_review", "content_classification:" + MODULES[0]])
def test_reviewed_actual_instructor_length_retry_is_outer_bounded_and_increases_output_cap(task):
    result, transport, ledger, _cp = run_pipeline(reviewed=True, plans={task: ["length"]}, pending_after_length=task == "canonical_review")
    requests = [row["body"] for row in transport.requests if row["task"] == task]
    budgets = [row["max_completion_tokens"] for row in requests]
    assert len(budgets) == 2 and budgets[0] < budgets[1] <= 6000
    assert all(row["task"] != "canonical_repair" for row in transport.requests)
    assert len([row for row in ledger.events if row["task"] == task and row["status"] == "started"]) == 2
    records = [row for row in result.report["analysis_meta"]["model_requests"] if row["task"] == task]
    assert [row["output_budget"] for row in records] == budgets
    assert [row["failure_kind"] for row in records] == ["length", None]
    assert sum(row["total_tokens"] for row in records) == 26 + budgets[0] + 17


def test_single_attempt_controllers_are_independent_for_parallel_modules():
    first, second = single_attempt_retry(), single_attempt_retry()
    assert first is not second and first.stop.max_attempt_number == second.stop.max_attempt_number == 1
    assert first.reraise and second.reraise


def test_actual_instructor_schema_accepts_explicit_original_confirmation_and_defaults_empty():
    model = create_review_response_model()
    assert model.model_validate({"patches": [], "uncertain": []}).confirmed_original == []
    transport = SyntheticTransport({"canonical_repair": ["confirm_source"]})
    payload = {"protocol_version": "canonical-transcript.v2", "review_mode": "explicit_recheck",
               "segments": [{"s": 1, "text": "这批文字和图片", "previous_uncertain": "没有OCR无法确认原词"}]}
    with wrapped_client(transport) as client:
        result, raw = client.chat.completions.create_with_completion(
            model="MiniMax-M3.1-Flash", response_model=model, max_retries=single_attempt_retry(),
            **completion_options("minimax", "MiniMax-M3.1-Flash", 4500),
            messages=[{"role": "user", "content": json.dumps(payload)}])
    assert len(transport.requests) == 1 and raw.usage.total_tokens == 30
    assert result.confirmed_original[0].text == "这批文字和图片"


@pytest.mark.parametrize("content", [
    '说明\n```json\n{"c":[]}\n```',
    '```json\n{"c":[]}\n```\n说明',
    '```json\n{"c":[]}\n```\n```json\n{"g":[]}\n```',
    '```json\nnot JSON\n```',
    '```json\n{"c":[],"c":[1]}\n```',
    '```json\n{"c":[NaN]}\n```',
    '```json\n{"c":[1e999]}\n```',
    '```json\n{"c":[]}\n',
    '```javascript\n{"c":[]}\n```',
])
def test_markdown_candidate_recovery_rejects_explanations_extra_fences_or_non_strict_json(content):
    error = RuntimeError("synthetic schema error")
    error.last_completion = response_completion()
    error.last_completion.choices[0].message.content = content
    assert _safe_schema_candidate(error, {"failure_kind": "schema_invalid"}, allow_markdown=True) is None


def test_markdown_candidate_recovery_keeps_utf8_size_object_and_finish_reason_limits():
    error = RuntimeError("synthetic schema error")
    error.last_completion = response_completion()
    for content in ['```json\n' + json.dumps({"c": "中" * 22_000}, ensure_ascii=False) + '\n```',
                    '```json\n[]\n```']:
        error.last_completion.choices[0].message.content = content
        assert _safe_schema_candidate(error, {"failure_kind": "schema_invalid"}, allow_markdown=True) is None
    error.last_completion.choices[0].message.content = ' \n```JSON\r\n{"c":[]}\r\n```\n '
    assert _safe_schema_candidate(error, {"failure_kind": "schema_invalid"}, allow_markdown=True) == {"c": []}
    assert _safe_schema_candidate(error, {"failure_kind": "schema_invalid"}) is None
    error.last_completion.choices[0].finish_reason = "length"
    assert _safe_schema_candidate(error, {"failure_kind": "schema_invalid"}, allow_markdown=True) is None
