"""Durable ASR recovery, stable attempt fencing and real process timeout recovery."""
import hashlib
import json
import os
import time
from dataclasses import fields, replace
from pathlib import Path
from types import SimpleNamespace
from typing import ClassVar
from unittest.mock import Mock, patch

import pytest
from PIL import Image

from liming_analyzer.adapters import (
    Keyframe,
    MediaInfo,
    NormalizedMedia,
    StructureOutput,
    TranscriptOutput,
    TranscriptSegment,
    VisualObservation,
    VisualOutput,
)
from liming_analyzer.api_client import AnalyzerApiClient, AnalyzerApiError, ClaimedJob
from liming_analyzer.artifacts import ApiArtifactStore
from liming_analyzer.pipeline import AnalysisPipeline, _evidence_checkpoint
from liming_analyzer.process_runtime import IsolatedProcessor, ProcessingLimits
from liming_analyzer.visual import KeyframeVisualAnalyzer, OpenAiCompatibleVisionEngine
from liming_analyzer.worker import ProcessingFailure

WORDS = TranscriptOutput("zh", (TranscriptSegment(0, 900, "完整原声，保留未改字的口播。", 91),), 91)


def job(root, **changes):
    initial = ClaimedJob("checkpoint-fixture", "org", "project", "video", "url", "queued", 0, 1,
        {"test_root": str(root), "transcript_review_enabled": False}, attempt_count=1)
    return replace(initial, **changes)


def count(root, name):
    path = root / name
    value = int(path.read_text(encoding="utf-8")) + 1 if path.exists() else 1
    path.write_text(str(value), encoding="utf-8")


class DurableClient:
    def __init__(self, root):
        self.root = root

    def upload_artifact(self, _job, *, path, kind, **_kwargs):
        data = path.read_bytes()
        digest = hashlib.sha256(data).hexdigest()
        folder = self.root / "assets"
        folder.mkdir(exist_ok=True)
        (folder / digest).write_bytes(data)
        return {"id": digest, "kind": kind, "sha256": digest, "sizeBytes": len(data)}

    def download_checkpoint_source(self, _job, destination, asset):
        count(self.root, "restores")
        data = (self.root / "assets" / asset["sha256"]).read_bytes()
        assert len(data) == asset["size_bytes"] and hashlib.sha256(data).hexdigest() == asset["sha256"]
        destination.write_bytes(data)
        return destination

    def save_checkpoint(self, _job, stage, checkpoint):
        # This store is outside the isolated child's temporary workspace.
        (self.root / "saved.json").write_text(
            json.dumps({"stage": stage, "checkpoint": checkpoint}, ensure_ascii=False), encoding="utf-8")


class HangingManuscriptClient(DurableClient):
    def upload_artifact(self, current, **payload):
        if payload["path"].name == "manuscript.json" and not (self.root / "allow-manuscript").exists():
            while True:
                time.sleep(.02)
        return super().upload_artifact(current, **payload)


class Source:
    def __init__(self, root):
        self.root = root

    def acquire(self, _job, destination):
        count(self.root, "acquires")
        destination.write_bytes(b"stable original source")
        return destination


class Media:
    def prepare(self, path, _directory):
        return NormalizedMedia(path, path, MediaInfo(1000, 800, 600, "h264", "aac"))


class Speech:
    backend = "synthetic-asr"
    model = "fixture.v1"

    def __init__(self, root):
        self.root = root

    def transcribe(self, _audio):
        count(self.root, "asr_calls")
        return WORDS


class Visual:
    supports_speech_overlap = True

    def __init__(self, root, *, hang=False):
        self.root, self.hang = root, hang

    def analyze(self, *_args):
        if not (self.root / "allow-visual").exists():
            if self.hang:
                while True:
                    time.sleep(.02)
            raise RuntimeError("synthetic visual failure after completed ASR")
        return VisualOutput()

    def analyze_for_speech_overlap(self, media, output, ready):
        ready()
        return self.analyze(media, output)


class Structure:
    def analyze(self, _job, _media, transcript, _visuals):
        return StructureOutput("analysis.v1", {"words": transcript.full_text})


def pipeline(root, *, hang=False):
    store = ApiArtifactStore(DurableClient(root))
    result = AnalysisPipeline(Source(root), Media(), Speech(root), Visual(root, hang=hang), Structure(),
                              store, store, heartbeat_seconds=.01)
    result.asr_fingerprint = "a" * 64
    return result


def heartbeat(current):
    latest = [current]
    def update(status, progress, _stage):
        latest[0] = replace(latest[0], status=status, progress=progress, version=latest[0].version + 1)
        return latest[0]
    return update


def test_asr_checkpoint_survives_later_failure_and_skips_collection_and_asr(tmp_path):
    first = job(tmp_path)
    with pytest.raises(RuntimeError, match="visual failure"):
        pipeline(tmp_path).process(first, heartbeat(first))
    saved = json.loads((tmp_path / "saved.json").read_text(encoding="utf-8"))
    assert saved["stage"] == "transcript_ready"
    value = saved["checkpoint"]
    assert value["checkpoint_version"] == 2 and value["transcript"]["segments"][0]["text"] == WORDS.full_text
    assert value["transcript_review_enabled"] is False and value["manual_source_hash"] is None
    assert value["asr_fingerprint"] == "a" * 64
    assert len(value["transcript_sha256"]) == 64 and len(value["source_asset"]["sha256"]) == 64
    (tmp_path / "allow-visual").touch()
    resumed = job(tmp_path, checkpoint_stage=saved["stage"], checkpoint=value, attempt_count=2)
    result = pipeline(tmp_path).process(resumed, heartbeat(resumed))
    assert result.report["words"] == WORDS.full_text
    assert (tmp_path / "acquires").read_text(encoding="utf-8") == (tmp_path / "asr_calls").read_text(encoding="utf-8") == "1"
    assert (tmp_path / "restores").read_text(encoding="utf-8") == "1"
    assert json.loads((tmp_path / "saved.json").read_text(encoding="utf-8"))["stage"] == "evidence_ready"


@pytest.mark.parametrize("level,expected_batches", [
    ("quick", [[0, 200, 400, 600], [800]]),
    ("balanced", [[0, 200], [400, 600], [800]]),
])
def test_pure_visual_transcript_resume_skips_asr_and_applies_current_tier_batches(tmp_path, level, expected_batches):
    first = job(tmp_path, source={"test_root": str(tmp_path), "transcript_review_enabled": False,
                                "visual_analysis_mode": "vision_only", "visual_sampling_level": level})
    with pytest.raises(RuntimeError, match="visual failure"):
        pipeline(tmp_path).process(first, heartbeat(first))
    saved = json.loads((tmp_path / "saved.json").read_text(encoding="utf-8"))
    assert saved["stage"] == "transcript_ready"
    assert saved["checkpoint"]["asr_fingerprint"] == "a" * 64
    assert saved["checkpoint"]["visual_analysis_mode"] == "vision_only"
    assert saved["checkpoint"]["visual_sampling_level"] == level

    selected = []
    for index in range(5):
        path = tmp_path / f"native-resume-{index}.jpg"
        Image.new("RGB", (32, 32), (index * 40, 100, 200)).save(path)
        selected.append(Keyframe(index * 200, path, roles=("opening",)))

    def complete(**kwargs):
        content = kwargs["messages"][-1]["content"]
        manifest = json.loads(content[0]["text"].split("frame_manifest=", 1)[1])
        assert len([part for part in content if part["type"] == "image_url"]) == len(manifest)
        rows = [{"frame_index": row["frame_index"], "composition": "合成图形居中。", "people_actions": "没有人物。",
                 "scene": "合成背景。", "camera_expression": "固定画面。", "visual_role": "隔离恢复测试。",
                 "confidence": 90, "visible_text": "合成文字"} for row in manifest]
        return SimpleNamespace(choices=[SimpleNamespace(message=SimpleNamespace(
            content=json.dumps({"observations": rows}, ensure_ascii=False)))])

    request = Mock(side_effect=complete)
    sdk = SimpleNamespace(chat=SimpleNamespace(completions=SimpleNamespace(create=request)))
    vision = OpenAiCompatibleVisionEngine(api_key="", base_url="https://fixture.invalid/v1", model="synthetic-vision",
                                         provider="openai", batch_size=6, client=sdk)
    extractor = SimpleNamespace(extract=Mock(return_value=selected))
    ocr = SimpleNamespace(recognize=Mock(side_effect=AssertionError("pure visual resume must not run OCR")))
    visual = KeyframeVisualAnalyzer(extractor, ocr, vision)
    worker = pipeline(tmp_path)
    worker.visual = visual
    worker.speech.transcribe = Mock(side_effect=AssertionError("restored transcript must not run ASR"))
    resumed = replace(first, checkpoint_stage="transcript_ready", checkpoint=saved["checkpoint"], attempt_count=2)
    result = worker.process(resumed, heartbeat(resumed))

    assert result.report["words"] == WORDS.full_text
    assert resumed.source == first.source
    assert worker.asr_fingerprint == saved["checkpoint"]["asr_fingerprint"] == "a" * 64
    worker.speech.transcribe.assert_not_called()
    ocr.recognize.assert_not_called()
    assert (tmp_path / "acquires").read_text(encoding="utf-8") == (tmp_path / "asr_calls").read_text(encoding="utf-8") == "1"
    assert (tmp_path / "restores").read_text(encoding="utf-8") == "1"
    assert visual.visual_sampling_level == vision.visual_sampling_level == level
    assert visual.visual_analysis_mode == vision.visual_analysis_mode == "vision_only"
    batches = [json.loads(call.kwargs["messages"][-1]["content"][0]["text"].split("frame_manifest=", 1)[1])
               for call in request.call_args_list]
    # Provider calls may finish concurrently; compare their source timestamps,
    # not invocation order or a simulated batch counter.
    batch_times = sorted([row["timestamp_ms"] for row in batch] for batch in batches)
    assert batch_times == expected_batches
    assert request.call_count == len(expected_batches)
    assert vision.last_stats["batch_size"] == (4 if level == "quick" else 2)
    assert vision.last_stats["frames_understood"] == 5


def test_old_quick_evidence_resume_keeps_single_frame_input_metadata_and_does_not_call_vision(tmp_path):
    first = job(tmp_path, source={"test_root": str(tmp_path), "transcript_review_enabled": False,
                                "visual_analysis_mode": "vision_only", "visual_sampling_level": "quick"})
    media = Media().prepare(tmp_path / "previous-source.mp4", tmp_path)
    old_stats = {"visual_analysis_mode": "vision_only", "visual_sampling_level": "quick",
                 "visual_understanding": {"visual_analysis_mode": "vision_only", "image_input_mode": "original_frame",
                                          "batch_size": 1, "frames_requested": 1, "frames_understood": 1}}
    old_visuals = VisualOutput((Keyframe(0, tmp_path / "previous-frame.jpg", asset_id="old-frame", roles=("opening",)),),
                              (VisualObservation("vision", 0, 0, "已取得的合成画面观察。"),), old_stats)
    checkpoint = _evidence_checkpoint(media, WORDS, old_visuals, None, transcript_review_enabled=False,
                                      visual_analysis_mode="vision_only", visual_sampling_level="quick")
    before = json.dumps(checkpoint, ensure_ascii=False)
    request = Mock(side_effect=AssertionError("complete visual evidence must not be acquired again"))
    sdk = SimpleNamespace(chat=SimpleNamespace(completions=SimpleNamespace(create=request)))
    vision = OpenAiCompatibleVisionEngine(api_key="", base_url="https://fixture.invalid/v1", model="synthetic-vision",
                                         provider="openai", client=sdk)
    extractor = SimpleNamespace(extract=Mock(side_effect=AssertionError("restored evidence must not extract frames")))
    ocr = SimpleNamespace(recognize=Mock(side_effect=AssertionError("restored evidence must not run OCR")))
    worker = pipeline(tmp_path)
    worker.visual = KeyframeVisualAnalyzer(extractor, ocr, vision)
    worker.source.acquire = Mock(side_effect=AssertionError("restored evidence must not collect source"))
    worker.speech.transcribe = Mock(side_effect=AssertionError("restored evidence must not run ASR"))
    captured = []

    def structure(_job, _media, transcript, visuals):
        captured.append(visuals)
        return StructureOutput("analysis.v1", {"words": transcript.full_text})

    worker.structure = SimpleNamespace(analyze=structure)
    resumed = replace(first, checkpoint_stage="evidence_ready", checkpoint=checkpoint, attempt_count=2)
    result = worker.process(resumed, heartbeat(resumed))
    assert result.report["words"] == WORDS.full_text
    worker.source.acquire.assert_not_called()
    worker.speech.transcribe.assert_not_called()
    extractor.extract.assert_not_called()
    ocr.recognize.assert_not_called()
    request.assert_not_called()
    assert len(captured) == 1 and captured[0].stats["evidence_reused"] is True
    assert captured[0].stats["visual_understanding"]["batch_size"] == 1
    assert captured[0].stats["visual_understanding"]["image_input_mode"] == "original_frame"
    assert json.dumps(checkpoint, ensure_ascii=False) == before
    assert resumed.source == first.source and worker.asr_fingerprint == "a" * 64


@pytest.mark.parametrize("changed", ["asr", "mode", "manual", "words", "source_hash"])
def test_checkpoint_reuse_is_bound_to_asr_mode_manual_source_and_verbatim_words(tmp_path, changed):
    first = job(tmp_path)
    with pytest.raises(RuntimeError):
        pipeline(tmp_path).process(first, heartbeat(first))
    saved = json.loads((tmp_path / "saved.json").read_text(encoding="utf-8"))["checkpoint"]
    resumed = job(tmp_path, checkpoint_stage="transcript_ready", checkpoint=saved)
    worker = pipeline(tmp_path)
    assert worker._restore_transcript(resumed) is not None
    if changed == "asr":
        worker.asr_fingerprint = "b" * 64
    elif changed == "mode":
        resumed = replace(resumed, source={**resumed.source, "transcript_review_enabled": True})
    elif changed == "manual":
        resumed = replace(resumed, source={**resumed.source, "manual_transcript": {
            "language": "zh", "segments": [{"start_ms": 0, "end_ms": 900, "text": "真实人工校正版"}],
        }})
    elif changed == "words":
        saved["transcript"]["segments"][0]["text"] = "被替换的原文"
    else:
        saved["source_asset"]["sha256"] = "invalid"
    assert worker._restore_transcript(resumed) is None


def test_raw_checkpoint_is_saved_before_optional_subtitle_recovery_starts(tmp_path):
    first = job(tmp_path, source={"test_root": str(tmp_path), "transcript_review_enabled": True})
    worker = pipeline(tmp_path)
    worker.manuscript_ocr = object()
    def captions(_path, transcript, **_kwargs):
        saved = json.loads((tmp_path / "saved.json").read_text(encoding="utf-8"))
        assert saved["stage"] == "transcript_ready"
        assert saved["checkpoint"]["transcript"]["segments"][0]["text"] == WORDS.full_text
        assert transcript.full_text == WORDS.full_text
        raise RuntimeError("synthetic subtitle failure")
    with patch("liming_analyzer.subtitle_evidence.recover_burned_subtitles", captions), pytest.raises(RuntimeError, match="visual failure"):
        worker.process(first, heartbeat(first))


def test_manual_checkpoint_preserves_the_manual_source_and_never_runs_asr(tmp_path):
    first = job(tmp_path, source={"test_root": str(tmp_path), "transcript_review_enabled": False,
        "manual_transcript": {"language": "zh", "segments": [
            {"start_ms": 0, "end_ms": 900, "text": "用户手动核对保留的口播。"},
        ]}})
    with pytest.raises(RuntimeError, match="visual failure"):
        pipeline(tmp_path).process(first, heartbeat(first))
    saved = json.loads((tmp_path / "saved.json").read_text(encoding="utf-8"))["checkpoint"]
    assert len(saved["manual_source_hash"]) == 64
    assert not (tmp_path / "asr_calls").exists()
    (tmp_path / "allow-visual").touch()
    resumed = replace(first, checkpoint_stage="transcript_ready", checkpoint=saved, attempt_count=2)
    assert pipeline(tmp_path).process(resumed, heartbeat(resumed)).report["words"] == "用户手动核对保留的口播。"
    assert not (tmp_path / "asr_calls").exists()
    assert pipeline(tmp_path)._restore_transcript(replace(resumed,
        source={"test_root": str(tmp_path), "transcript_review_enabled": False})) is None


def test_failed_source_persistence_cannot_start_asr_or_create_a_fake_checkpoint(tmp_path):
    class BrokenClient(DurableClient):
        def upload_artifact(self, current, **payload):
            if payload["kind"] == "source_video":
                raise AnalyzerApiError(503, "SOURCE_STORAGE_FAILED", "synthetic durable storage outage")
            return super().upload_artifact(current, **payload)
    worker = pipeline(tmp_path)
    worker.artifacts = worker.checkpoints = ApiArtifactStore(BrokenClient(tmp_path))
    first = job(tmp_path)
    with pytest.raises(AnalyzerApiError, match="SOURCE_STORAGE_FAILED"):
        worker.process(first, heartbeat(first))
    assert not (tmp_path / "asr_calls").exists() and not (tmp_path / "saved.json").exists()


def test_manuscript_upload_failure_keeps_completed_asr_checkpoint_for_retry(tmp_path):
    class BrokenManuscriptClient(DurableClient):
        def upload_artifact(self, current, **payload):
            if payload["path"].name == "manuscript.json":
                raise AnalyzerApiError(503, "MANUSCRIPT_UPLOAD_FAILED", "synthetic manuscript upload outage")
            return super().upload_artifact(current, **payload)
    worker, first = pipeline(tmp_path), job(tmp_path)
    worker.artifacts = worker.checkpoints = ApiArtifactStore(BrokenManuscriptClient(tmp_path))
    with pytest.raises(AnalyzerApiError, match="MANUSCRIPT_UPLOAD_FAILED"):
        worker.process(first, heartbeat(first))
    saved = json.loads((tmp_path / "saved.json").read_text(encoding="utf-8"))
    assert saved["stage"] == "transcript_ready"
    (tmp_path / "allow-visual").touch()
    resumed = replace(first, checkpoint_stage="transcript_ready", checkpoint=saved["checkpoint"], attempt_count=2)
    result = pipeline(tmp_path).process(resumed, heartbeat(resumed))
    assert result.report["words"] == WORDS.full_text and (tmp_path / "asr_calls").read_text(encoding="utf-8") == "1"


def test_completed_real_chunk_counters_are_not_replaced_by_a_one_chunk_placeholder(tmp_path):
    class CountedSpeech(Speech):
        def set_progress(self, callback):
            self.callback = callback
        def transcribe(self, audio):
            self.callback({"phase": "model_transcription", "transcribed_chunks": 29, "total_chunks": 29})
            return super().transcribe(audio)
    worker, first, events = pipeline(tmp_path), job(tmp_path), []
    worker.speech = CountedSpeech(tmp_path)
    (tmp_path / "allow-visual").touch()
    update = heartbeat(first)
    update.observe = events.append
    worker.process(first, update)
    completed = next(index for index, event in enumerate(events) if event.get("transcribed_chunks") == 29)
    assert not any(event.get("total_chunks") == 1 for event in events[completed + 1:])


@pytest.mark.parametrize("variant", ["valid", "truncated", "hash_mismatch", "asset_size_mismatch"])
def test_checkpoint_source_stream_is_verified_before_atomic_publish(tmp_path, variant):
    data = b"original media bytes"
    class Stream:
        headers: ClassVar[dict[str, str]] = {"Content-Length": str(len(data) + (2 if variant == "truncated" else 0))}
        def __enter__(self):
            self.chunk = data
            return self
        def __exit__(self, *_args):
            return False
        def read(self, _length):
            value, self.chunk = self.chunk, b""
            return value
    asset = {"id": "bound-asset", "size_bytes": len(data) + (1 if variant == "asset_size_mismatch" else 0),
             "sha256": "0" * 64 if variant == "hash_mismatch" else hashlib.sha256(data).hexdigest()}
    client = AnalyzerApiClient("https://synthetic.invalid", "token", "worker")
    destination = tmp_path / "source"
    destination.write_bytes(b"previous valid source")
    with patch("liming_analyzer.api_client.urllib.request.urlopen", return_value=Stream()) as opener:
        if variant == "valid":
            assert client.download_checkpoint_source(job(tmp_path), destination, asset).read_bytes() == data
        else:
            with pytest.raises(AnalyzerApiError, match="SOURCE_INCOMPLETE|SOURCE_INTEGRITY_MISMATCH"):
                client.download_checkpoint_source(job(tmp_path), destination, asset)
            assert destination.read_bytes() == b"previous valid source"
            assert not (tmp_path / "source.part").exists()
    request = opener.call_args.args[0]
    assert request.full_url.endswith("/source?assetId=bound-asset")
    assert request.get_header("X-worker-attempt") == "1"


def test_artifact_writes_keep_same_attempt_when_heartbeat_advances_version(tmp_path):
    current = job(tmp_path, status="extracting", progress=70, version=3, attempt_count=7)
    state = {"version": 3, "attempt": 7, "writes": 0}
    def transport(_method, _url, headers, data):
        time.sleep(.06)
        if int(headers.get("X-Worker-Attempt", "0")) != state["attempt"]:
            return 409, b'{"error":{"code":"ARTIFACT_LEASE_INVALID"}}'
        state["writes"] += 1
        digest, size = hashlib.sha256(), 0
        chunks = (data,) if isinstance(data, bytes) else iter(lambda: data.read(64 * 1024), b"")
        for chunk in chunks:
            digest.update(chunk)
            size += len(chunk)
        return 201, json.dumps({"asset": {"id": "saved", "sha256": digest.hexdigest(), "sizeBytes": size}}).encode()
    client = AnalyzerApiClient("https://synthetic.invalid", "token", "worker", transport)
    source = tmp_path / "source.bin"
    source.write_bytes(b"original")
    def advance(status, progress, _stage):
        state["version"] += 1
        return replace(current, version=state["version"], status=status, progress=progress)
    worker = AnalysisPipeline(None, None, None, None, None, heartbeat_seconds=.01)
    _, value = worker._run_monitored(
        lambda: client.upload_artifact(current, kind="source_video", path=source, content_type="video/mp4"),
        current, advance, "extracting", 72, "saving",
    )
    assert state["version"] > current.version and state["writes"] == 1 and value["id"] == "saved"
    state["attempt"] = 8
    with pytest.raises(AnalyzerApiError, match="ARTIFACT_LEASE_INVALID"):
        client.upload_artifact(current, kind="source_video", path=source, content_type="video/mp4")
    assert state["writes"] == 1


def isolated_factory(_settings, _client, monitor):
    def process(current, keepalive):
        worker = pipeline(Path(current.source["test_root"]), hang=True)
        if current.source.get("hang_manuscript"):
            worker.artifacts = worker.checkpoints = ApiArtifactStore(HangingManuscriptClient(Path(current.source["test_root"])))
        worker.runtime_monitor = monitor
        return worker.process(current, keepalive)
    return process


class Control:
    def check_control(self, _job):
        return {"version": 1}


@pytest.mark.skipif(os.name not in {"nt", "posix"}, reason="native process isolation")
@pytest.mark.parametrize("blocked", ["visual", "manuscript"])
@pytest.mark.parametrize("execution_mode", ["serial", "controlled_parallel"])
def test_real_isolated_timeout_reuses_finished_asr_in_a_new_child(tmp_path, blocked, execution_mode):
    settings = {"initialization": 5, "evidence": .35, "artifacts": .35, "poll": .02, "task": 15}
    if "visual" in {field.name for field in fields(ProcessingLimits)}:
        settings["visual"] = .35
    limits = ProcessingLimits(**settings)
    first = job(tmp_path)
    first = replace(first, source={**first.source, "execution_mode": execution_mode})
    if blocked == "manuscript":
        first = replace(first, source={**first.source, "hang_manuscript": True})
        (tmp_path / "allow-visual").touch()
    with IsolatedProcessor(None, Control(), root=tmp_path, limits=limits, factory=isolated_factory) as processor:
        with pytest.raises(ProcessingFailure) as caught:
            processor(first, heartbeat(first))
        assert caught.value.code == "ANALYZER_STAGE_TIMEOUT"
        saved = json.loads((tmp_path / "saved.json").read_text(encoding="utf-8"))
        assert saved["stage"] == "transcript_ready" and processor.resources_released
        (tmp_path / "allow-visual").touch()
        (tmp_path / "allow-manuscript").touch()
        resumed = replace(first, checkpoint_stage="transcript_ready", checkpoint=saved["checkpoint"], attempt_count=2)
        result = processor(resumed, heartbeat(resumed))
    assert result.report["words"] == WORDS.full_text
    assert (tmp_path / "asr_calls").read_text(encoding="utf-8") == (tmp_path / "acquires").read_text(encoding="utf-8") == "1"
    assert (tmp_path / "restores").read_text(encoding="utf-8") == "1"
