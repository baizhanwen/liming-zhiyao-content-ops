import json
from dataclasses import replace
from unittest.mock import patch

from liming_analyzer.__main__ import build_lazy_processor
from liming_analyzer.api_client import AnalyzerApiClient, ClaimedJob
from liming_analyzer.bootstrap import AnalyzerSettings
from liming_analyzer.vision_capabilities import resolve_vision_capability


def job():
    return ClaimedJob("job-1", "org-1", "project-1", "video-1", "url", "downloading", 2, 3, {})


def test_worker_requests_model_snapshot_with_current_lease():
    calls = []

    def transport(method, url, headers, body):
        calls.append((method, url, json.loads(body)))
        return 200, json.dumps({"configuration": {"llm_provider": "fixture", "llm_base_url": "https://models.example.invalid/v1", "llm_model": "model", "llm_api_key": "synthetic-key"}}).encode()

    client = AnalyzerApiClient("http://127.0.0.1:3000", "synthetic-token", "fixture-worker", transport)
    assert client.model_configuration(job())["llm_model"] == "model"
    assert calls[0][1].endswith("/job-1/model-settings")
    assert calls[0][2] == {"workerId": "fixture-worker", "version": 3}


def test_saved_model_change_is_used_by_the_next_job_without_worker_restart():
    settings = AnalyzerSettings("http://127.0.0.1:3000", "synthetic-token", "fixture-worker", "synthetic-key", "https://models.example.invalid/v1", "initial", "fixture")

    class Client:
        model = "first"

        def model_configuration(self, _job):
            return {"llm_model": self.model}

    class Pipeline:
        def __init__(self, config):
            self.config = config

        def process(self, _job, _heartbeat):
            return self.config.llm_model

    client = Client()
    with patch("liming_analyzer.__main__.build_pipeline", side_effect=lambda config, _: Pipeline(config)) as builder:
        process = build_lazy_processor(settings, client)
        heartbeat = lambda status, progress, stage: replace(job(), status=status, progress=progress)
        assert process(job(), heartbeat) == "first"
        assert process(job(), heartbeat) == "first"
        client.model = "second"
        assert process(job(), heartbeat) == "second"
        assert builder.call_count == 2


def test_explicit_minimax_flash_endpoint_precedes_historical_key_prefix():
    capability = resolve_vision_capability(provider="minimax", model="MiniMax-M3.1-Flash", api_key="sk-cp-synthetic-key", base_url="https://api.minimax.cn/v1")
    assert capability.adapter == "openai_compatible"
