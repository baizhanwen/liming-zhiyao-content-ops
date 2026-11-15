"""The per-job review switch changes processing, provenance and resumable inputs."""
from dataclasses import replace
from unittest.mock import patch

import pytest

from liming_analyzer.adapters import TranscriptOutput, TranscriptSegment
from liming_analyzer.api_client import ClaimedJob
from liming_analyzer.pipeline import AnalysisPipeline, _evidence_checkpoint, _restore_evidence_checkpoint
from test_content_provider_integration import inputs
from test_pipeline import Source, Media, Visual, Structure
from test_reviewed_analysis import review_inputs, run_reviewed


def test_disabled_review_uses_original_source_without_canonical_calls_and_labels_it_honestly():
    result, sdk, _ledger, checkpoints = run_reviewed(source={"transcript_review_enabled": False})
    document = result.report["unified_report"]
    original = review_inputs()[1]
    assert document["status"] == "complete", document["validation"]
    assert document["outcome"]["manuscript"] == "original"
    assert document["outcome"]["review_segment_count"] == 0
    assert document["canonical"]["status"] == "original"
    assert [row["text"] for row in document["canonical"]["segments"]] == [row.text for row in original.segments]
    assert all(row["review_status"] == "original" and row["candidate_text"] is None
               for row in document["canonical"]["segments"])
    assert result.report["analysis_meta"]["transcript_review_enabled"] is False
    assert result.report["analysis_meta"]["transcript_source_kind"] == "asr"
    assert result.report["spoken_script_set"]["corrected_original"]["status"] == "original"
    assert document["methodology"]["transcript_basis"] == "original"
    assert result.report["content_analysis"]["methodology"]["transcript_basis"] == "original"
    assert len(sdk.calls) == 4 and all(row["task"].startswith("content_classification:") for row in sdk.calls)
    assert all('"transcript_review_enabled":false' in row["messages"][1]["content"] for row in sdk.calls)
    assert checkpoints[-1]["canonical"]["trusted_manual"] is False
    registry = result.report["content_analysis"]["evidence_registry"]
    assert [row["text"] for row in registry if row["source"] == "transcript"] == [row.text for row in original.segments]


def test_original_mode_cannot_reuse_reviewed_module_cache_and_resumes_its_own_cache():
    _reviewed, _sdk, _ledger, reviewed_cp = run_reviewed()
    raw, sdk, _ledger, raw_cp = run_reviewed(checkpoint=reviewed_cp[-1], source={"transcript_review_enabled": False})
    assert len(sdk.calls) == 4
    assert raw_cp[-1]["source_signature"] != reviewed_cp[-1]["source_signature"]
    assert all(raw_cp[-1]["modules"][key]["signature"] != old["signature"]
               for key, old in reviewed_cp[-1]["modules"].items())
    resumed, reused_sdk, _ledger, _cp = run_reviewed(checkpoint=raw_cp[-1], source={"transcript_review_enabled": False})
    assert reused_sdk.calls == []
    assert resumed.report["unified_report"]["canonical"] == raw.report["unified_report"]["canonical"]
    enabled, enabled_sdk, _ledger, _cp = run_reviewed(checkpoint=raw_cp[-1])
    assert enabled.report["unified_report"]["outcome"]["manuscript"] == "verified"
    assert len(enabled_sdk.calls) == 5


def test_disabled_review_with_real_manual_input_preserves_manual_provenance():
    result, sdk, _ledger, _cp = run_reviewed(source={
        "transcript_review_enabled": False, "manual_transcript": {"confirmed": True},
    })
    document = result.report["unified_report"]
    assert not any(row["task"].startswith("canonical_") for row in sdk.calls)
    assert result.report["analysis_meta"]["transcript_source_kind"] == "manual"
    assert document["canonical"]["status"] == "completed"
    assert document["outcome"]["manuscript"] == "verified"
    assert [row["text"] for row in document["canonical"]["segments"]] == [row.text for row in review_inputs()[1].segments]


def test_original_report_revalidation_checks_source_without_any_model_fallback():
    from test_report_revalidation import fixture

    _result, _sdk, _ledger, checkpoints = run_reviewed(source={"transcript_review_enabled": False})
    analyzer, job, supplied, sdk, ledger = fixture(True)
    job = replace(job, source={"transcript_review_enabled": False}, checkpoint={
        "unified_progress": checkpoints[-1], "report_revalidation_only": True, "retry_module_keys": [],
    })
    result = analyzer.analyze(job, *supplied)
    assert result.report["unified_report"]["outcome"]["manuscript"] == "original"
    assert sdk.calls == [] and ledger.events == []
    job.checkpoint["unified_progress"]["canonical"]["segments"][0]["text"] = "篡改原稿"
    with pytest.raises(RuntimeError, match="原始转写检查点未通过复验"):
        analyzer.analyze(job, *supplied)
    assert sdk.calls == [] and ledger.events == []


def test_disabled_pipeline_never_recovers_subtitles_punctuates_or_deduplicates_asr():
    raw = TranscriptOutput("zh-CN", (
        TranscriptSegment(0, 1500, " 先提出问题 ", 94),
        TranscriptSegment(1000, 2200, "先提出问题", 93),
    ), 94)
    class RawSpeech:
        def transcribe(self, _audio):
            return raw
    structure = Structure()
    job = ClaimedJob("raw-pipeline", "org", "project", "video", "upload", "queued", 1, 2,
                     {"transcript_review_enabled": False})
    with patch("liming_analyzer.subtitle_evidence.recover_burned_subtitles", side_effect=AssertionError("no subtitle edits")), \
         patch("liming_analyzer.manuscript_punctuation.punctuate_manuscript", side_effect=AssertionError("no rewritten punctuation")):
        result = AnalysisPipeline(Source(), Media(), RawSpeech(), Visual(), structure,
                                  manuscript_ocr=object()).process(job, lambda *_: job)
    assert structure.inputs[2] is raw
    assert [row["text"] for row in result.transcript.segments] == [row.text for row in raw.segments]


def test_disabled_pipeline_preserves_explicit_manual_input_without_running_asr():
    class ForbiddenSpeech:
        def transcribe(self, _audio):
            raise AssertionError("manual input must win over ASR")
    job = ClaimedJob("raw-manual", "org", "project", "video", "upload", "queued", 1, 2, {
        "transcript_review_enabled": False,
        "manual_transcript": {"language": "zh-CN", "segments": [
            {"start_ms": 0, "end_ms": 1000, "text": "用户手动保留的完整文字。"},
        ]},
    })
    structure = Structure()
    result = AnalysisPipeline(Source(), Media(), ForbiddenSpeech(), Visual(), structure).process(job, lambda *_: job)
    assert result.transcript.full_text == "用户手动保留的完整文字。"


@pytest.mark.parametrize("saved,requested,expected", [(True, False, False), (False, True, False),
                                                      (False, False, True), (True, True, True)])
def test_evidence_checkpoint_is_bound_to_the_review_mode(tmp_path, saved, requested, expected):
    checkpoint = _evidence_checkpoint(*inputs(), None, transcript_review_enabled=saved)
    job = ClaimedJob("mode-checkpoint", "org", "project", "video", "upload", "analyzing", 84, 1,
        {"transcript_review_enabled": requested}, checkpoint_stage="evidence_ready", checkpoint=checkpoint)
    assert (_restore_evidence_checkpoint(job, tmp_path) is not None) is expected


def test_legacy_checkpoint_defaults_to_review_enabled_only(tmp_path):
    checkpoint = _evidence_checkpoint(*inputs(), None)
    del checkpoint["transcript_review_enabled"]
    job = ClaimedJob("legacy-mode", "org", "project", "video", "upload", "analyzing", 84, 1,
                     {}, checkpoint_stage="evidence_ready", checkpoint=checkpoint)
    assert _restore_evidence_checkpoint(job, tmp_path) is not None
    assert _restore_evidence_checkpoint(replace(job, source={"transcript_review_enabled": False}), tmp_path) is None
