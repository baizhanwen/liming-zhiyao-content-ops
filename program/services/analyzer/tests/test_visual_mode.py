"""Mode-isolated visual evidence, no OCR fallback and unchanged speech input."""
import json
from dataclasses import replace
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import Mock

import pytest
from PIL import Image
from test_reviewed_analysis import run_reviewed
from test_transcript_checkpoints import WORDS, heartbeat, job, pipeline

from liming_analyzer.__main__ import build_lazy_processor
from liming_analyzer.adapters import (
    Keyframe,
    MediaInfo,
    NormalizedMedia,
    VisualObservation,
    VisualOutput,
)
from liming_analyzer.bootstrap import AnalyzerSettings, build_pipeline
from liming_analyzer.content_analysis import build_evidence_registry
from liming_analyzer.pipeline import _evidence_checkpoint, _restore_evidence_checkpoint
from liming_analyzer.visual import KeyframeVisualAnalyzer
from liming_analyzer.visual_mode import normalize_visual_analysis_mode


def frames(tmp_path):
    result = []
    for index in range(3):
        path = tmp_path / f"mode-{index}.jpg"
        Image.new("RGB", (32, 32), "white").save(path)
        result.append(Keyframe(index * 500, path, roles=("opening",), asset_id=f"asset-{index}"))
    return result


def media():
    return NormalizedMedia(Path("unused.mp4"), None, MediaInfo(5000, 32, 32, "h264", "aac"))


class Vision:
    def __init__(self):
        self.last_stats = {"status": "completed"}

    def set_visual_analysis_mode(self, mode):
        self.mode = mode

    def analyze(self, images):
        return tuple(row for frame in images for row in (
            VisualObservation("vision", frame.timestamp_ms, frame.timestamp_ms, "主体在画面中央。"),
            VisualObservation("vision_text", frame.timestamp_ms, frame.timestamp_ms, "清晰可见的标题"),
        ))


def test_pure_visual_keeps_frame_provenance_and_reads_text_without_local_ocr(tmp_path):
    selected = frames(tmp_path)
    extractor = SimpleNamespace(extract=lambda *_args: selected)
    ocr = SimpleNamespace(recognize=Mock(side_effect=AssertionError("must not run local OCR")))
    vision = Vision()
    analyzer = KeyframeVisualAnalyzer(extractor, ocr, vision)
    analyzer.set_visual_analysis_mode("vision_only")
    result = analyzer.analyze(media(), tmp_path)
    assert vision.mode == "vision_only"
    ocr.recognize.assert_not_called()
    assert [frame.asset_id for frame in result.keyframes] == [frame.asset_id for frame in selected]
    assert all(frame.ocr_text == "清晰可见的标题" and frame.confidence is None for frame in result.keyframes)
    assert result.stats["ocr_engine_call_count"] == result.stats["ocr_observation_count"] == 0
    assert result.stats["ocr"]["status"] == "skipped"
    assert result.stats["screen_text_source"] == "vision_model"
    assert result.stats["vision_observation_count"] == result.stats["vision_text_observation_count"] == 3
    assert result.stats["stage_timing"]["ocr_elapsed_ms"] == 0
    assert result.stats["stage_timing"]["mode"] == "vision_only"
    assert result.stats["ocr_text_regions"]["status"] == "unknown"
    assert analyzer.progress_snapshot()["ocr_total"] == 0
    registry = build_evidence_registry(media(), WORDS, result)
    text_rows = [row for row in registry if row["source"] == "ocr"]
    assert [(row["start_ms"], row["asset_ref"]) for row in text_rows] == [(0, "asset-0"), (500, "asset-1"), (1000, "asset-2")]


def test_switch_back_to_hybrid_uses_ocr_and_does_not_retain_model_text(tmp_path):
    selected = frames(tmp_path)
    ocr = SimpleNamespace(recognize=Mock(return_value=("本地文字识别结果", 90)))
    vision = Vision()
    analyzer = KeyframeVisualAnalyzer(SimpleNamespace(extract=lambda *_args: selected), ocr, vision)
    analyzer.set_visual_analysis_mode("vision_only")
    analyzer.analyze(media(), tmp_path)
    analyzer.set_visual_analysis_mode("hybrid")
    result = analyzer.analyze(media(), tmp_path)
    assert ocr.recognize.call_count == 3 and vision.mode == "hybrid"
    assert all(frame.ocr_text == "本地文字识别结果" for frame in result.keyframes)
    assert result.stats["screen_text_source"] == "local_ocr"


def test_pure_visual_requires_vision_instead_of_falling_back_to_ocr(tmp_path):
    ocr = Mock()
    analyzer = KeyframeVisualAnalyzer(SimpleNamespace(extract=Mock()), ocr)
    analyzer.set_visual_analysis_mode("vision_only")
    with pytest.raises(RuntimeError, match="纯视觉模式需要"):
        analyzer.analyze(media(), tmp_path)
    ocr.recognize.assert_not_called()
    analyzer.extractor.extract.assert_not_called()


def test_pure_visual_provider_failure_is_explicit_and_never_runs_ocr(tmp_path):
    ocr = Mock()
    vision = SimpleNamespace(analyze=Mock(side_effect=RuntimeError("synthetic unavailable")))
    analyzer = KeyframeVisualAnalyzer(SimpleNamespace(extract=lambda *_args: frames(tmp_path)), ocr, vision)
    analyzer.set_visual_analysis_mode("vision_only")
    with pytest.raises(RuntimeError, match="未自动切回"):
        analyzer.analyze(media(), tmp_path)
    ocr.recognize.assert_not_called()


@pytest.mark.parametrize("mode", ["hybrid", "vision_only"])
def test_evidence_checkpoints_restore_only_their_mode_and_keep_legacy_hybrid(tmp_path, mode):
    checkpoint = _evidence_checkpoint(media(), WORDS, VisualOutput(), None, visual_analysis_mode=mode)
    current = job(tmp_path, source={"visual_analysis_mode": mode}, checkpoint_stage="evidence_ready", checkpoint=checkpoint)
    assert _restore_evidence_checkpoint(current, tmp_path)
    other = "vision_only" if mode == "hybrid" else "hybrid"
    assert _restore_evidence_checkpoint(replace(current, source={"visual_analysis_mode": other}), tmp_path) is None
    checkpoint.pop("visual_analysis_mode")
    assert bool(_restore_evidence_checkpoint(current, tmp_path)) is (mode == "hybrid")


def test_pure_visual_skips_optional_subtitle_ocr_and_keeps_original_asr(tmp_path, monkeypatch):
    current = job(tmp_path, source={"test_root": str(tmp_path), "visual_analysis_mode": "vision_only", "transcript_review_enabled": True})
    (tmp_path / "allow-visual").touch()
    worker = pipeline(tmp_path)
    worker.manuscript_ocr = Mock()
    captions = Mock(side_effect=AssertionError("subtitle OCR must not run"))
    monkeypatch.setattr("liming_analyzer.subtitle_evidence.recover_burned_subtitles", captions)
    result = worker.process(current, heartbeat(current))
    captions.assert_not_called()
    assert result.report["words"] == WORDS.full_text
    assert (tmp_path / "asr_calls").read_text(encoding="utf-8") == "1"
    saved = json.loads((tmp_path / "saved.json").read_text(encoding="utf-8"))
    assert saved["checkpoint"]["visual_analysis_mode"] == "vision_only"


def test_transcript_checkpoint_cannot_cross_visual_modes(tmp_path):
    current = job(tmp_path)
    worker = pipeline(tmp_path)
    with pytest.raises(RuntimeError, match="visual failure"):
        worker.process(current, heartbeat(current))
    saved = json.loads((tmp_path / "saved.json").read_text(encoding="utf-8"))
    current = replace(current, checkpoint_stage=saved["stage"], checkpoint=saved["checkpoint"])
    assert worker._restore_transcript(current)
    assert worker._restore_transcript(replace(current, source={**current.source, "visual_analysis_mode": "vision_only"})) is None


def test_report_mode_is_recorded_and_prevents_identical_evidence_cache_cross_use():
    first, _, _, checkpoints = run_reviewed(source={"transcript_review_enabled": False})
    second, sdk, _, pure_checkpoints = run_reviewed(checkpoint=checkpoints[-1], source={"transcript_review_enabled": False, "visual_analysis_mode": "vision_only"})
    assert first.report["analysis_meta"]["visual_analysis_mode"] == "hybrid"
    assert second.report["analysis_meta"]["visual_analysis_mode"] == "vision_only"
    assert first.report["unified_report"]["source_signature"] != second.report["unified_report"]["source_signature"]
    assert sdk.calls  # Matching images alone cannot reuse another mode's paid modules.
    third, cached_sdk, _, _ = run_reviewed(checkpoint=pure_checkpoints[-1], source={"transcript_review_enabled": False, "visual_analysis_mode": "vision_only"})
    assert not cached_sdk.calls
    assert third.report["unified_report"]["status"] == second.report["unified_report"]["status"]


def test_building_pure_pipeline_never_initializes_paddle(tmp_path, monkeypatch):
    from liming_analyzer import bootstrap
    settings = AnalyzerSettings("http://fixture.invalid", "fixture", "worker", "fixture", "https://fixture.invalid", "fixture", "fixture", model_cache=str(tmp_path))
    monkeypatch.setattr(bootstrap, "_resolve_media_executable", lambda value, _label: value)
    monkeypatch.setattr(bootstrap, "build_quality_recognizer", lambda *_args, **_kwargs: object())
    paddle = Mock(side_effect=AssertionError("Paddle must not initialize"))
    monkeypatch.setattr(bootstrap, "PaddleOcrEngine", paddle)
    with pytest.raises(RuntimeError, match="纯视觉模式需要"):
        build_pipeline(settings, SimpleNamespace(), visual_analysis_mode="vision_only")
    paddle.assert_not_called()


def test_worker_rebuilds_pipeline_when_visual_mode_changes(tmp_path, monkeypatch):
    built = []
    def builder(*_args, **kwargs):
        built.append(kwargs.get("visual_analysis_mode", "hybrid"))
        return SimpleNamespace(process=lambda *_args: None)
    monkeypatch.setattr("liming_analyzer.__main__.build_pipeline", builder)
    process = build_lazy_processor(object(), SimpleNamespace())
    current = job(tmp_path)
    process(current, heartbeat(current))
    pure = replace(current, source={**current.source, "visual_analysis_mode": "vision_only"})
    process(pure, heartbeat(pure))
    process(pure, heartbeat(pure))
    process(current, heartbeat(current))
    assert built == ["hybrid", "vision_only", "hybrid"]


@pytest.mark.parametrize("value", ["invalid", "", False, 1])
def test_invalid_explicit_modes_are_rejected(value):
    with pytest.raises(ValueError):
        normalize_visual_analysis_mode(value)
