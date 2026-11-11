"""Manual canonical transcript batching uses no correction SDK requests."""
from dataclasses import replace

from test_content_provider_integration import LegacyResponse, inputs
from test_unified_analysis import OfflineSdk

from liming_analyzer.adapters import TranscriptOutput, TranscriptSegment
from liming_analyzer.api_client import ClaimedJob
from liming_analyzer.providers import InstructorStructureAnalyzer


def test_manual_transcript_over_96_segments_uses_each_requested_global_index():
    media, _transcript, visuals = inputs()
    source = TranscriptOutput("zh-CN", tuple(TranscriptSegment(index * 1000, index * 1000 + 900, f"这是第{index + 1}段人工校正后的内容。") for index in range(99)))
    media = replace(media, info=replace(media.info, duration_ms=100_000))
    sdk = OfflineSdk()
    analyzer = InstructorStructureAnalyzer(api_key="", base_url="https://synthetic.invalid", model="MiniMax-M3.1-Flash", provider="minimax", client=sdk,
        report_model=LegacyResponse, generate_content_features=True, generate_unified_report=True, max_output_tokens=6000)
    job = ClaimedJob("manual-batch-fixture", "org", "project", "video", "upload", "analyzing", 84, 1,
                     {"manual_transcript": {"segments": [{"text": row.text} for row in source.segments]}}, analysis_profile="max")
    result = analyzer.analyze(job, media, source, visuals)
    canonical = result.report["unified_report"]["canonical"]
    assert canonical["status"] == "completed", canonical["validation"]
    assert len(canonical["segments"]) == 99
    assert canonical["segments"][-1]["source_segment_id"] == "transcript:0099"
    assert canonical["segments"][-1]["text"] == source.segments[-1].text
    assert all(row["text"] == row["original_text"] for row in canonical["segments"])
    assert not any(call["task"] == "canonical_transcript" for call in sdk.calls)
