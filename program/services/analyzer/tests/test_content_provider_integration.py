"""Offline provider-boundary checks using real Pydantic content response schemas."""
import ast
import copy
import json
from collections import Counter
from dataclasses import replace
from pathlib import Path
from types import SimpleNamespace

import pytest
from openai import LengthFinishReasonError
from test_content_analysis import synthetic_inputs, synthetic_response
from test_correction_token_retry import length_error
from test_providers import FakeReport

from liming_analyzer.adapters import (
    Keyframe,
    MediaInfo,
    NormalizedMedia,
    TranscriptOutput,
    TranscriptSegment,
    VisualObservation,
    VisualOutput,
)
from liming_analyzer.api_client import ClaimedJob
from liming_analyzer.content_analysis import MODULES
from liming_analyzer.evidence import normalize_evidence_text
from liming_analyzer.providers import InstructorStructureAnalyzer


class LegacyResponse:
    """Marker distinguishing the legacy schema from real content module schemas."""


def inputs():
    raw_media, raw_transcript, raw_visuals = synthetic_inputs()
    info = raw_media.info
    media = NormalizedMedia(Path("synthetic.mp4"), None, MediaInfo(
        info.duration_ms, info.width, info.height, info.video_codec, info.audio_codec,
        info.rotation_degrees, info.sample_aspect_ratio,
    ))
    transcript = TranscriptOutput("zh-CN", tuple(
        TranscriptSegment(row.start_ms, row.end_ms, row.text, 94)
        for row in raw_transcript.segments
    ), 94)
    visuals = VisualOutput(tuple(
        Keyframe(row.timestamp_ms, Path(f"synthetic-{index}.jpg"), row.ocr_text, 90, row.asset_id, row.roles)
        for index, row in enumerate(raw_visuals.keyframes)
    ), tuple(
        VisualObservation(row.kind, row.start_ms, row.end_ms, row.text, 90)
        for row in raw_visuals.observations
    ), {
        **raw_visuals.stats,
        "vision_observation_count": len(raw_visuals.observations),
        "visual_understanding": {"status": "completed", "frames_requested": 3, "frames_understood": 3},
    })
    return media, transcript, visuals


def payload_of(request):
    content = request["messages"][1]["content"]
    try:
        return json.loads(content)
    except json.JSONDecodeError:
        return ast.literal_eval(content)


class Sdk:
    def __init__(self, transcript, visuals, failures=None):
        self.calls = []
        self.failures = failures or {}
        self.attempts = Counter()
        self.transcript = transcript
        self.visuals = visuals
        self.chat = SimpleNamespace(completions=self)

    def create_with_completion(self, **kwargs):
        self.calls.append(kwargs)
        payload = payload_of(kwargs)
        model = kwargs["response_model"]
        if model.__name__.startswith("ContentModuleResponse_"):
            module = payload["module"]
            assert model.__name__ == "ContentModuleResponse_" + module
            self.attempts[module] += 1
            plan = self.failures.get(module, ())
            attempt = self.attempts[module] - 1
            if attempt < len(plan):
                if plan[attempt] == "length":
                    raise length_error(output_tokens=kwargs.get("max_tokens", kwargs.get("max_completion_tokens")))
                raise plan[attempt]
            response = model.model_validate(synthetic_response(module, payload, kwargs.get("max_tokens")))
            usage = SimpleNamespace(prompt_tokens=300, completion_tokens=30, total_tokens=330)
        elif "paragraphs" in payload:
            value = {"paragraphs": [
                {"paragraph_id": row["paragraph_id"], "text": row["text"] + "。"}
                for row in payload["paragraphs"]
            ]}
            response = SimpleNamespace(model_dump=lambda **_kwargs: value)
            usage = SimpleNamespace(prompt_tokens=200, completion_tokens=20, total_tokens=220)
        else:
            value = FakeReport().model_dump()
            source = self.transcript.segments[0]
            value["hook"] = "提出会后行动不清的问题"
            value["evidence"] = [
                {"start_ms": row.start_ms, "text": row.text, "source": "asr", "confidence": 94}
                for row in self.transcript.segments
            ] + [
                {"start_ms": row.start_ms, "text": row.text, "source": "vision", "confidence": 90}
                for row in self.visuals.observations[:3]
            ]
            value["insight_evidence"] = [{"section": "hook_analysis", "item_index": 0, "evidence_text": source.text}]
            response = SimpleNamespace(model_dump=lambda **_kwargs: copy.deepcopy(value))
            usage = SimpleNamespace(prompt_tokens=100, completion_tokens=10, total_tokens=110)
        return response, SimpleNamespace(usage=usage)


def run_analysis(*, profile="standard", cap=6000, failures=None, custom_inputs=None, provider="fixture", model="fixture"):
    media, transcript, visuals = custom_inputs or inputs()
    sdk = Sdk(transcript, visuals, failures)
    ledger = []

    def record(_job, event):
        ledger.append(dict(event))
        return {"records": len(ledger)}

    analyzer = InstructorStructureAnalyzer(
        api_key="", base_url="https://synthetic.invalid", provider=provider, model=model,
        client=sdk, report_model=LegacyResponse, generate_content_features=True,
        generate_script_variants=True, max_output_tokens=cap, call_recorder=record,
    )
    job = ClaimedJob("synthetic", "org", "project", "video", "upload", "analyzing", 84, 1, {}, analysis_profile=profile)
    result = analyzer.analyze(job, media, transcript, visuals)
    return result, sdk, ledger


def content_calls(sdk, module=None):
    return [row for row in sdk.calls if row["response_model"].__name__.startswith("ContentModuleResponse_")
            and (module is None or payload_of(row)["module"] == module)]


def assert_accounting(result, sdk, ledger):
    starts = [row for row in ledger if row["status"] == "started"]
    finishes = [row for row in ledger if row["status"] in {"completed", "failed"}]
    assert len(starts) == len(finishes) == len(sdk.calls)
    assert {row["id"] for row in starts} == {row["id"] for row in finishes}
    meta = result.report["analysis_meta"]
    assert meta["actual_input_tokens"] == sum(row.get("inputTokens", 0) for row in finishes)
    assert meta["actual_output_tokens"] == sum(row.get("outputTokens", 0) for row in finishes)
    assert meta["actual_total_tokens"] == sum(row.get("totalTokens", 0) for row in finishes)
    calls = content_calls(sdk)
    assert meta["content_classification_requests"] == len(calls)
    assert meta["content_classification_output_budget"] == sum(row.get("max_tokens", row.get("max_completion_tokens")) for row in calls)
    assert meta["maximum_output_tokens"] == sum(row.get("max_tokens", row.get("max_completion_tokens")) for row in sdk.calls)
    assert meta["maximum_total_tokens"] == meta["maximum_model_input_tokens"] + meta["maximum_output_tokens"]
    assert all(row["max_retries"] == 1 for row in calls)


@pytest.mark.parametrize("profile", ["standard", "max"])
def test_v10_calls_four_typed_modules_records_usage_and_keeps_complete_script(profile):
    result, sdk, ledger = run_analysis(profile=profile)
    assert result.schema_version == "analysis.v10"
    assert result.report["analysis_meta"]["contract_version"] == "analysis.v10"
    assert [payload_of(row)["module"] for row in content_calls(sdk)] == list(MODULES)
    content = result.report["content_analysis"]
    assert content["status"] == "complete", content["validation"]
    assert content["validation"]["passed"] is True
    assert content["metrics"]["media"]["duration_ms"] == 6000
    assert content["evidence_registry"][0]["text"] == inputs()[1].segments[0].text
    assert result.report["summary"] == FakeReport().model_dump()["summary"]
    corrected = result.report["spoken_script_set"]["corrected_original"]
    assert corrected["status"] == "completed", corrected
    assert corrected["validation"]["passed"] is True
    assert corrected["source_segment_ids"] == ["t-0001", "t-0002"]
    assert normalize_evidence_text(corrected["text"]) == normalize_evidence_text(inputs()[1].full_text)
    check = next(row for row in result.report["analysis_meta"]["quality_audit"]["checks"] if row["key"] == "content_analysis")
    assert check["passed"] is True
    assert {row["task"] for row in ledger if row["status"] == "started"} >= {"report", "corrected_original", *("content_classification:" + module for module in MODULES)}
    assert_accounting(result, sdk, ledger)


@pytest.mark.parametrize(("profile", "module", "expected"), [
    ("standard", MODULES[0], [2048, 3500]),
    ("standard", MODULES[1], [2048, 4096]),
    ("max", MODULES[0], [4096, 4500]),
    ("max", MODULES[1], [4096, 6000]),
])
def test_length_only_retry_increases_within_module_and_configuration_caps(profile, module, expected):
    result, sdk, ledger = run_analysis(profile=profile, failures={module: ["length"]})
    assert [row["max_tokens"] for row in content_calls(sdk, module)] == expected
    assert result.report["content_analysis"]["status"] == "complete"
    assert_accounting(result, sdk, ledger)


def test_flash_classification_uses_real_completion_parameter_and_clips_increased_budget():
    result, sdk, ledger = run_analysis(cap=3000, failures={MODULES[0]: ["length"]}, provider="minimax", model="MiniMax-M3.1-Flash")
    calls = content_calls(sdk, MODULES[0])
    assert [row["max_completion_tokens"] for row in calls] == [2048, 3000]
    assert all("max_tokens" not in row for row in sdk.calls)
    assert all(row["max_completion_tokens"] <= 3000 for row in sdk.calls)
    assert_accounting(result, sdk, ledger)


@pytest.mark.parametrize(("cap", "module", "failures", "expected"), [
    (1000, MODULES[0], ["length"], [1000]),
    (6000, MODULES[3], ["length"], [1800]),
    (6000, MODULES[1], ["length", "length", "length"], [2048, 4096]),
    (6000, MODULES[1], [TimeoutError("synthetic request timed out")], [2048]),
    (6000, MODULES[1], [ValueError("synthetic validation error")], [2048]),
])
def test_exhausted_or_nonlength_module_failure_stays_partial_and_other_modules_continue(cap, module, failures, expected):
    result, sdk, ledger = run_analysis(cap=cap, failures={module: failures})
    assert [row["max_tokens"] for row in content_calls(sdk, module)] == expected
    content = result.report["content_analysis"]
    assert content["status"] == "partial"
    assert content["module_status"][module]["status"] == "failed"
    assert {payload_of(row)["module"] for row in content_calls(sdk)} == set(MODULES)
    audit = result.report["analysis_meta"]["quality_audit"]
    assert audit["acceptance_passed"] is False
    assert audit["completion_status"] == "partial"
    assert result.report["spoken_script_set"]["corrected_original"]["status"] == "completed"
    assert result.report["summary"] == "问题式开场"
    assert_accounting(result, sdk, ledger)


def test_native_openai_length_exception_usage_is_preserved_from_completion_attribute():
    completion = SimpleNamespace(
        choices=[SimpleNamespace(finish_reason="length")],
        usage=SimpleNamespace(prompt_tokens=77, completion_tokens=2048, total_tokens=2125),
    )
    result, sdk, ledger = run_analysis(failures={MODULES[0]: [LengthFinishReasonError(completion=completion)]})
    failed = [row for row in ledger if row["status"] == "failed"]
    assert len(failed) == 1
    assert failed[0].get("inputTokens") == 77
    assert failed[0].get("outputTokens") == 2048
    assert failed[0].get("totalTokens") == 2125
    assert result.report["analysis_meta"]["actual_input_tokens"] == 1577
    assert result.report["analysis_meta"]["actual_output_tokens"] == 2198
    assert result.report["analysis_meta"]["actual_total_tokens"] == 3775
    assert_accounting(result, sdk, ledger)


def test_legacy_report_budget_keeps_all_required_opening_evidence():
    media, transcript, original = inputs()
    media = replace(media, info=replace(media.info, duration_ms=60_000))
    times = [0, 500, 1000, 1500, 2000, 2500] + list(range(6000, 60_000, 1000))
    frames = tuple(Keyframe(timestamp, Path(f"frame-{index}.jpg"), roles=("first_frame", "opening") if index == 0 else ("opening",) if index < 6 else ("representative",)) for index, timestamp in enumerate(times))
    observations = tuple(VisualObservation("vision", timestamp, timestamp, f"帧{index}可见内容：" + "构图人物场景细节" * 25, 90) for index, timestamp in enumerate(times))
    visuals = VisualOutput(frames, observations, original.stats)
    _result, sdk, _ledger = run_analysis(custom_inputs=(media, transcript, visuals))
    report_payload = next(payload_of(row) for row in sdk.calls if row["response_model"] is LegacyResponse and "visual_evidence" in payload_of(row))
    included = {row["start_ms"] for row in report_payload["visual_evidence"] if row["source"] == "vision"}
    assert set(times[:6]).issubset(included)
