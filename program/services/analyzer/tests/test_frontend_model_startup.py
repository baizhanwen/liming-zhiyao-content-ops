"""A clean worker starts with service identity, then reads leased-job models."""
import json
import os
from dataclasses import replace
from unittest.mock import patch

import pytest

from liming_analyzer.__main__ import build_lazy_processor
from liming_analyzer.api_client import AnalyzerApiClient, AnalyzerApiError, ClaimedJob
from liming_analyzer.bootstrap import AnalyzerSettings

SERVICE_ENV = {
    "ANALYZER_BASE_URL": "http://127.0.0.1:3000",
    "ANALYZER_SERVICE_TOKEN": "synthetic-service-token",
    "ANALYZER_WORKER_ID": "fixture-worker",
}


def clean_settings():
    with patch.dict(os.environ, SERVICE_ENV, clear=True):
        return AnalyzerSettings.from_environment()


def claimed():
    return ClaimedJob("job-1", "org-1", "project-1", "video-1", "url", "downloading", 2, 3, {})


def test_clean_worker_settings_do_not_require_cloud_keys():
    settings = clean_settings()
    assert settings.base_url == SERVICE_ENV["ANALYZER_BASE_URL"]
    assert settings.worker_id == "fixture-worker"
    assert (settings.llm_api_key, settings.llm_base_url, settings.llm_model, settings.llm_provider) == ("", "", "", "")
    assert settings.vision_api_key == ""


def test_service_identity_is_still_required():
    with patch.dict(os.environ, {"ANALYZER_BASE_URL": SERVICE_ENV["ANALYZER_BASE_URL"]}, clear=True), pytest.raises(RuntimeError, match="ANALYZER_SERVICE_TOKEN"):
        AnalyzerSettings.from_environment()


def test_first_job_fetches_and_uses_frontend_saved_model_with_no_environment_cloud_key():
    requests = []
    saved = {"llm_provider": "fixture-provider", "llm_base_url": "https://models.example.invalid/v1", "llm_model": "frontend-saved-model", "llm_api_key": "synthetic-frontend-saved-key"}
    def transport(method, url, headers, body):
        requests.append((method, url, headers, json.loads(body)))
        return 200, json.dumps({"configuration": saved}).encode()
    settings = clean_settings()
    client = AnalyzerApiClient(settings.base_url, settings.service_token, settings.worker_id, transport)
    class Pipeline:
        def __init__(self, active):
            self.active = active
        def process(self, _job, _heartbeat):
            return self.active.llm_model
    with patch("liming_analyzer.__main__.build_pipeline", side_effect=lambda active, _: Pipeline(active)) as builder:
        process = build_lazy_processor(settings, client)
        heartbeat = lambda status, progress, stage: replace(claimed(), status=status, progress=progress)
        assert process(claimed(), heartbeat) == "frontend-saved-model"
    assert settings.llm_api_key == ""
    assert builder.call_args.args[0].llm_api_key == saved["llm_api_key"]
    assert requests[0][1].endswith("/job-1/model-settings")
    assert requests[0][3] == {"workerId": "fixture-worker", "version": 3}


def test_incomplete_job_models_still_fail_before_loading_pipeline():
    settings = clean_settings()
    client = AnalyzerApiClient(settings.base_url, settings.service_token, settings.worker_id,
                               lambda *_args: (200, json.dumps({"configuration": {"llm_model": "incomplete"}}).encode()))
    with patch("liming_analyzer.__main__.build_pipeline") as builder, pytest.raises(AnalyzerApiError) as failure:
        build_lazy_processor(settings, client)(claimed(), lambda *_args: claimed())
    assert failure.value.code == "ANALYZER_MODEL_REQUIRED"
    builder.assert_not_called()
