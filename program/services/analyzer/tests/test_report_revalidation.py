"""Saved-report revalidation has no path to a new model or media request."""
import copy
from dataclasses import replace

import pytest

from liming_analyzer.api_client import ClaimedJob
from liming_analyzer.pipeline import AnalysisPipeline
from liming_analyzer.providers import InstructorStructureAnalyzer
from test_content_provider_integration import LegacyResponse, inputs
from test_reviewed_analysis import ReviewedSdk, review_inputs, run_reviewed
from test_unified_analysis import Ledger, OfflineSdk, run_unified


def fixture(reviewed):
    initial = run_reviewed() if reviewed else run_unified()
    progress = copy.deepcopy(initial[3][-1])
    sdk = ReviewedSdk() if reviewed else OfflineSdk()
    ledger = Ledger()
    analyzer = InstructorStructureAnalyzer(api_key="", base_url="https://synthetic.invalid",
        model="synthetic" if reviewed else "MiniMax-M3.1-Flash", provider="minimax",
        client=sdk, report_model=LegacyResponse, generate_content_features=True,
        generate_unified_report=True, generate_reviewed_report=reviewed, call_recorder=ledger)
    job = ClaimedJob("revalidation-fixture", "org", "project", "video", "upload", "analyzing", 84, 1, {},
        analysis_profile="max", checkpoint_stage="evidence_ready",
        checkpoint={"unified_progress": progress, "report_revalidation_only": True, "retry_module_keys": []})
    supplied = review_inputs() if reviewed else inputs()
    return analyzer, job, supplied, sdk, ledger


@pytest.mark.parametrize("reviewed", [False, True])
def test_complete_saved_report_revalidates_without_a_model_call(reviewed):
    analyzer, job, supplied, sdk, ledger = fixture(reviewed)
    result = analyzer.analyze(job, *supplied)
    assert result.report["unified_report"]["status"] == "complete"
    assert result.report["unified_report"]["validation"]["passed"]
    assert sdk.calls == [] and ledger.events == []


@pytest.mark.parametrize("reviewed", [False, True])
@pytest.mark.parametrize("variant", ["source", "missing_module", "bad_module", "bad_canonical"])
def test_invalid_revalidation_cache_fails_without_paid_fallback(reviewed, variant):
    analyzer, job, supplied, sdk, ledger = fixture(reviewed)
    progress = job.checkpoint["unified_progress"]
    if variant == "source":
        supplied = (replace(supplied[0], info=replace(supplied[0].info, duration_ms=999_999)), *supplied[1:])
    elif variant == "missing_module":
        del progress["modules"]["visual"]
    elif variant == "bad_module":
        progress["modules"]["visual"]["signature"] = "not-the-input-signature"
    else:
        progress["canonical"] = {"status": "completed", "validation": {"passed": True, "issues": []}}
    with pytest.raises(RuntimeError):
        analyzer.analyze(job, *supplied)
    assert sdk.calls == [] and ledger.events == []


def test_missing_evidence_checkpoint_cannot_download_or_transcribe_again():
    job = ClaimedJob("revalidation-no-evidence", "org", "project", "video", "upload", "analyzing", 84, 1, {},
                     checkpoint={"report_revalidation_only": True})
    with pytest.raises(RuntimeError, match="原始证据检查点无效"):
        AnalysisPipeline(None, None, None, None, None).process(job, lambda *_: job)
