"""Synthetic request acceptance; no external model or user media is used."""
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

import instructor
from PIL import Image
from test_providers import FakeClient, FakeCompletions, FakeReport

from liming_analyzer.adapters import (
    Keyframe,
    MediaInfo,
    NormalizedMedia,
    TranscriptOutput,
    TranscriptSegment,
    VisualOutput,
)
from liming_analyzer.api_client import ClaimedJob
from liming_analyzer.model_compat import completion_options
from liming_analyzer.providers import InstructorStructureAnalyzer
from liming_analyzer.visual import OpenAiCompatibleVisionEngine


def test_instructor_flash_uses_prompt_schema_mode_without_api_format_or_tools():
    with (
        patch("instructor.from_openai", return_value=FakeClient()) as factory,
        patch("openai.OpenAI", return_value=object()),
    ):
        analyzer = InstructorStructureAnalyzer(
            api_key="synthetic-key",
            base_url="https://api.example.invalid/v1",
            model="MiniMax-M3.1-Flash",
            provider="minimax",
            generate_script_variants=False,
        )
    assert factory.call_args.kwargs["mode"] == instructor.Mode.MD_JSON
    assert hasattr(analyzer.report_model, "model_validate")


def test_flash_structure_preserves_standard_budget_and_schema_validation():
    FakeCompletions.calls = []
    analyzer = InstructorStructureAnalyzer(
        api_key="", base_url="https://api.example.invalid/v1",
        model="MiniMax-M3.1-Flash", provider="minimax",
        client=FakeClient(), report_model=object,
    )
    evidence = FakeReport().model_dump()["evidence"][0]["text"]
    result = analyzer.analyze(
        ClaimedJob("synthetic-job", "synthetic-org", "synthetic-project", "synthetic-video", "upload", "analyzing", 84, 4, {}),
        NormalizedMedia(Path("synthetic.mp4"), None, MediaInfo(6000, 1080, 1920, "h264", "aac")),
        TranscriptOutput("zh-CN", (TranscriptSegment(100, 900, evidence, 94),), 94),
        VisualOutput(),
    )
    assert len(FakeCompletions.calls) == 1
    request = FakeCompletions.calls[0]
    assert request["max_completion_tokens"] == 6000
    assert request["extra_body"] == {"reasoning_effort": "low"}
    assert "max_tokens" not in request
    assert "response_format" not in request
    assert request["response_model"] is object
    assert request["max_retries"] == 1
    assert result.report["analysis_meta"]["maximum_output_tokens"] == 6000
    assert result.report["analysis_meta"]["maximum_total_tokens"] == 39200
    assert result.report["evidence"][0]["text"] == evidence


def test_flash_vision_sends_real_image_parts_without_response_format_and_keeps_budget(tmp_path):
    image = tmp_path / "synthetic.jpg"
    Image.new("RGB", (64, 64), "blue").save(image)
    requests = []

    def create(**kwargs):
        requests.append(kwargs)
        content = '{"observations":[{"frame_index":1,"composition":"蓝色方形测试图","confidence":95}]}'
        return SimpleNamespace(choices=[SimpleNamespace(message=SimpleNamespace(content=content, reasoning_content="synthetic reasoning"))])

    client = SimpleNamespace(chat=SimpleNamespace(completions=SimpleNamespace(create=create)))
    engine = OpenAiCompatibleVisionEngine(
        api_key="", base_url="https://api.example.invalid/v1",
        model="MiniMax-M3.1-Flash", provider="minimax", client=client,
        max_output_tokens=2400,
    )
    result = engine.analyze([Keyframe(1000, image)])
    assert len(result) == 1
    assert result[0].start_ms == 1000
    assert "蓝色" in result[0].text
    request = requests[0]
    assert request["max_completion_tokens"] == 2400
    assert request["extra_body"] == {"reasoning_effort": "low"}
    assert "max_tokens" not in request
    assert "response_format" not in request
    assert request["messages"][1]["content"][1]["type"] == "image_url"
    assert engine.last_stats["status"] == "completed"


def test_legacy_models_retain_existing_completion_parameters():
    assert completion_options("deepseek", "deepseek-chat", 6000) == {"max_tokens": 6000}
    assert completion_options("minimax", "MiniMax-M3", 900) == {"max_tokens": 900}
