"""Retired questions disappear without invalidating saved reports or paid-call caches."""
import copy
from dataclasses import replace
from unittest.mock import patch

import pytest

from liming_analyzer.content_analysis import (
    MODULES,
    build_content_analysis,
    build_content_analysis_bundle,
    create_content_response_model,
    load_taxonomy,
)
from test_content_analysis import synthetic_inputs, synthetic_response
from test_content_module_protocol import compact_synthetic_response, wire_label_index
from test_report_revalidation import fixture as saved_report_fixture


RETIRED = "visual.cut_pattern"
RETIRED_LABEL = "镜头切换模式"


def test_legacy_sdk_schema_does_not_ask_for_a_retired_dimension():
    assert RETIRED not in str(create_content_response_model("visual").model_json_schema())


def legacy_compact_response(module, wire, budget):
    result = compact_synthetic_response(module, wire, budget)
    for dimension in wire["d"]:
        if dimension["n"] != RETIRED_LABEL:
            continue
        sources = {row["s"]: [] for row in wire["e"]}
        for row in wire["e"]:
            sources[row["s"]].append(row["i"])
        tag = wire_label_index(dimension["t"], "长镜头为主")
        index = dimension["i"]
        result["c"][index] = {"d": index, "s": 0, "t": [tag], "p": tag,
                                "e": [*sources["v"][:3], *sources["g"][:1]]}
    return result


@pytest.mark.parametrize("compact", [False, True])
def test_new_requests_omit_retired_question_but_keep_storage_compatibility(compact):
    requested = []

    def request(module, payload, budget):
        requested.extend(row["n"] if compact else row["id"] for row in payload["d" if compact else "dimensions"])
        return compact_synthetic_response(module, payload, budget) if compact else synthetic_response(module, payload, budget)

    if compact:
        content = build_content_analysis_bundle(*synthetic_inputs(), request)["content_analysis"]
    else:
        content = build_content_analysis(*synthetic_inputs(), request)
    assert content["status"] == "complete", content["validation"]
    assert RETIRED not in requested and RETIRED_LABEL not in requested
    assert len(content["classifications"]) == len(load_taxonomy()["dimensions"]) == 65
    slot = next(row for row in content["classifications"] if row["dimension_id"] == RETIRED)
    assert slot["state"] == "not_applicable" and slot["reason"] == "analysis_dimension_retired"
    assert slot["evidence_ids"] == [] and slot["tags"] is None


def old_saved_report(reviewed):
    with patch("liming_analyzer.content_analysis.RETIRED_DIMENSION_IDS", frozenset()), patch(
        "test_unified_analysis.compact_synthetic_response", legacy_compact_response,
    ):
        result = saved_report_fixture(reviewed)
    visual = result[1].checkpoint["unified_progress"]["modules"]["visual"]
    assert next(row for row in visual["response"]["classifications"] if row["dimension_id"] == RETIRED)["state"] == "known"
    return result


@pytest.mark.parametrize("reviewed", [False, True])
def test_v11_v12_saved_reports_migrate_retired_caches_with_zero_model_calls(reviewed):
    analyzer, job, supplied, sdk, ledger = old_saved_report(reviewed)
    progress = copy.deepcopy(job.checkpoint["unified_progress"])
    saved = []
    analyzer.set_unified_checkpoint(lambda value: saved.append(copy.deepcopy(value)))
    result = analyzer.analyze(job, *supplied)
    assert result.report["unified_report"]["status"] == "complete", result.report["unified_report"]["validation"]
    assert sdk.calls == [] and ledger.events == []
    assert saved[-1]["source_signature"] == progress["source_signature"]
    for key in ("visual", "synthesis"):
        migrated = saved[-1]["modules"][key]
        assert migrated["signature"] != progress["modules"][key]["signature"]
        assert migrated["generation_signature"] == progress["modules"][key]["signature"]
        assert migrated["revalidated_from_signature"] == progress["modules"][key]["signature"]
    assert RETIRED not in {row["dimension_id"] for row in saved[-1]["modules"]["visual"]["response"]["classifications"]}


@pytest.mark.parametrize("reviewed", [False, True])
def test_retrying_one_sibling_reuses_retired_visual_and_synthesis_caches(reviewed):
    analyzer, job, supplied, sdk, ledger = old_saved_report(reviewed)
    job.checkpoint.pop("report_revalidation_only")
    job.checkpoint["retry_module_keys"] = [MODULES[1]]
    del job.checkpoint["unified_progress"]["modules"][MODULES[1]]
    result = analyzer.analyze(job, *supplied)
    assert result.report["unified_report"]["status"] == "complete", result.report["unified_report"]["validation"]
    assert [row["task"] for row in sdk.calls] == ["content_classification:" + MODULES[1]]
    assert [row["task"] for row in ledger.events if row["status"] == "started"] == ["content_classification:" + MODULES[1]]


@pytest.mark.parametrize("reviewed", [False, True])
def test_retirement_never_accepts_a_saved_report_with_different_source(reviewed):
    analyzer, job, supplied, sdk, ledger = old_saved_report(reviewed)
    changed = (replace(supplied[0], info=replace(supplied[0].info, duration_ms=999_999)), *supplied[1:])
    with pytest.raises(RuntimeError):
        analyzer.analyze(job, *changed)
    assert sdk.calls == [] and ledger.events == []


@pytest.mark.parametrize("variant", ["signature", "invalid_active_row", "changed_source"])
def test_retired_cache_migration_requires_old_wire_match_and_current_validation(variant):
    supplied = synthetic_inputs()
    with patch("liming_analyzer.content_analysis.RETIRED_DIMENSION_IDS", frozenset()):
        old = build_content_analysis_bundle(*supplied, legacy_compact_response)
    assert old["content_analysis"]["status"] == "complete", old["content_analysis"]["validation"]
    caches = copy.deepcopy(old["module_results"])
    if variant == "signature":
        caches["visual"]["signature"] = "unrelated-request"
    elif variant == "invalid_active_row":
        row = next(row for row in caches["visual"]["response"]["classifications"] if row["dimension_id"] == "content.form")
        row["evidence_ids"] = ["vision:9999"]
    else:
        supplied[2].observations[0].text += "来源已改变。"
    calls = []

    def request(module, wire, budget):
        calls.append(module)
        return compact_synthetic_response(module, wire, budget)

    result = build_content_analysis_bundle(*supplied, request, resume_modules=caches)
    assert "visual" in calls
    assert result["content_analysis"]["status"] == "complete", result["content_analysis"]["validation"]
