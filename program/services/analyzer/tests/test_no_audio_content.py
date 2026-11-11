"""Explicit no-audio is inapplicable, while failed/missing ASR stays missing."""

from dataclasses import replace
from types import SimpleNamespace

import pytest
from test_content_provider_integration import (
    LegacyResponse,
    Sdk,
    content_calls,
    inputs,
    payload_of,
)
from test_providers import FakeReport

from liming_analyzer.adapters import TranscriptOutput
from liming_analyzer.api_client import ClaimedJob
from liming_analyzer.content_analysis import build_content_analysis
from liming_analyzer.providers import InstructorStructureAnalyzer


def visual_inputs(*, audio_codec=None, ocr_errors=0, keep_ocr=False):
    media, _transcript, visuals = inputs()
    media = replace(media, info=replace(media.info, audio_codec=audio_codec))
    transcript = TranscriptOutput("zh-CN", ())
    visuals = replace(visuals,
        keyframes=tuple(replace(row, ocr_text=row.ocr_text if keep_ocr else None)
                        for row in visuals.keyframes),
        stats={**visuals.stats, "ocr_error_count": ocr_errors,
               "ocr_observation_count": 1 if keep_ocr else 0},
    )
    return media, transcript, visuals


def unknown_response(_module, payload, _budget):
    return {"classifications": [{
        "dimension_id": row["id"], "state": "unknown", "tags": None,
        "primary_tag": None, "reason": "合成画面材料不足以确定该语义标签。", "evidence_ids": [],
    } for row in payload["dimensions"]], "segments": [], "information_units": []}


class VisualSdk(Sdk):
    def create_with_completion(self, **kwargs):
        self.calls.append(kwargs)
        payload = payload_of(kwargs)
        model = kwargs["response_model"]
        if model.__name__.startswith("ContentModuleResponse_"):
            response = model.model_validate(unknown_response(payload["module"], payload, 1_000))
        else:
            assert "paragraphs" not in payload, "no audio must not call transcript correction"
            value = FakeReport().model_dump()
            value["spoken_script"] = []
            value["language"] = []
            value["evidence"] = [{"start_ms": row.start_ms, "text": row.text,
                                  "source": "vision", "confidence": 90}
                                 for row in self.visuals.observations]
            value["insight_evidence"] = []
            response = SimpleNamespace(model_dump=lambda **_kwargs: value)
        return response, SimpleNamespace(usage=SimpleNamespace(
            prompt_tokens=100, completion_tokens=20, total_tokens=120,
        ))


def analyze_visual_only(*, audio_codec=None, ocr_errors=0, keep_ocr=False):
    media, transcript, visuals = visual_inputs(
        audio_codec=audio_codec, ocr_errors=ocr_errors, keep_ocr=keep_ocr,
    )
    sdk = VisualSdk(transcript, visuals)
    analyzer = InstructorStructureAnalyzer(
        api_key="", base_url="https://synthetic.invalid", model="fixture", provider="fixture",
        client=sdk, report_model=LegacyResponse, generate_content_features=True,
        generate_script_variants=True,
    )
    job = ClaimedJob("synthetic", "org", "project", "video", "upload", "analyzing", 84, 1, {})
    return analyzer.analyze(job, media, transcript, visuals), sdk


def test_no_audio_returns_visual_report_without_paying_for_correction_or_faking_script():
    result, sdk = analyze_visual_only()
    corrected = result.report["spoken_script_set"]["corrected_original"]
    assert corrected["status"] == "not_applicable"
    assert corrected["paragraphs"] == []
    assert corrected["validation"]["passed"] is True
    assert result.report["spoken_script"] == []
    assert result.report["language"] == []
    assert result.report["analysis_meta"]["transcript_correction"]["request_count"] == 0
    assert all("paragraphs" not in payload_of(row) for row in sdk.calls)
    content = result.report["content_analysis"]
    assert content["status"] == "complete", content["validation"]
    assert content["module_status"]["text_topic_structure_audience"]["status"] == "not_applicable"
    assert len(content_calls(sdk)) == 3
    checks = {row["key"]: row for row in result.report["analysis_meta"]["quality_audit"]["checks"]}
    assert checks["spoken_scripts"]["passed"] is True
    assert "不适用" in checks["spoken_scripts"]["value"]
    assert checks["language_applicability"]["passed"] is True
    # Other missing findings and evidence links still fail the real quality gate.
    assert result.report["analysis_meta"]["quality_audit"]["acceptance_passed"] is False


def test_no_audio_with_real_ocr_keeps_text_analysis_applicable():
    result, sdk = analyze_visual_only(keep_ocr=True)
    assert result.report["spoken_script_set"]["corrected_original"]["status"] == "not_applicable"
    content = result.report["content_analysis"]
    assert content["module_status"]["text_topic_structure_audience"]["status"] == "completed"
    assert len(content_calls(sdk)) == 4
    assert not any(row["key"] == "language_applicability"
                   for row in result.report["analysis_meta"]["quality_audit"]["checks"])


def test_audio_track_with_missing_asr_is_never_reclassified_as_no_audio():
    with pytest.raises(RuntimeError, match="transcript did not contain a usable spoken script"):
        analyze_visual_only(audio_codec="aac")


@pytest.mark.parametrize(("audio_codec", "errors"), [("aac", 0), (None, 1)])
def test_missing_asr_or_failed_ocr_remains_partial_not_applicable_is_not_invented(audio_codec, errors):
    media, transcript, visuals = visual_inputs(audio_codec=audio_codec, ocr_errors=errors)
    result = build_content_analysis(media, transcript, visuals, unknown_response)
    assert result["status"] == "partial"
    assert result["module_status"]["text_topic_structure_audience"]["status"] == "not_acquired"
    text_row = next(row for row in result["classifications"] if row["dimension_id"] == "topic.category")
    assert text_row["state"] == "not_acquired"
