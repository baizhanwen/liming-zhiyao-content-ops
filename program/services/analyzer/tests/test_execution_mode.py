"""Scheduling barriers, single-writer leases, and durable speech recovery."""
import hashlib
import threading
import time
from dataclasses import replace

import pytest
from PIL import Image

from liming_analyzer.adapters import Keyframe, MediaInfo, NormalizedMedia, StructureOutput, TranscriptOutput, TranscriptSegment, VisualObservation, VisualOutput
from liming_analyzer.api_client import AnalyzerApiError, ClaimedJob
from liming_analyzer.execution_mode import normalize_execution_mode
from liming_analyzer.pipeline import AnalysisPipeline
from liming_analyzer.visual import KeyframeVisualAnalyzer

WORDS = TranscriptOutput("zh", (TranscriptSegment(0, 1000, "保留完整原声。", 90),), 90)


class Source:
    calls = 0

    def acquire(self, _job, destination):
        self.calls += 1
        destination.write_bytes(b"media")
        return destination


class Media:
    def prepare(self, source, _output):
        return NormalizedMedia(source, source, MediaInfo(1000, 32, 32, "h264", "aac"))


class Store:
    def __init__(self):
        self.saved = []
        self.manuscripts = []
        self.restores = 0

    def persist_source(self, _job, _media):
        return {"id": "original", "sha256": hashlib.sha256(b"media").hexdigest(),
                "size_bytes": 5, "kind": "source_video"}

    def restore_source(self, _job, _asset, destination):
        self.restores += 1
        destination.write_bytes(b"media")
        return destination

    def save(self, current, stage, value):
        self.saved.append((stage, value, current.attempt_count))

    def persist_manuscript(self, _job, transcript, *_args, **_kwargs):
        self.manuscripts.append(transcript.full_text)

    def persist(self, _job, _transcript, visuals, _workspace):
        return visuals


class Structure:
    calls = 0

    def analyze(self, _job, _media, transcript, visuals):
        self.calls += 1
        self.visuals = visuals
        return StructureOutput("analysis.v1", {"words": transcript.full_text})


def job(mode=None, **kwargs):
    source = {"transcript_review_enabled": False}
    if mode is not None:
        source["execution_mode"] = mode
    return ClaimedJob("scheduling", "org", "project", "video", "upload", "queued", 0, 1,
                      source, attempt_count=1, **kwargs)


def heartbeat(initial, threads=None):
    current = [initial]
    def write(status, progress, _stage):
        if threads is not None:
            threads.append(threading.get_ident())
        current[0] = replace(current[0], status=status, progress=progress, version=current[0].version + 1)
        return current[0]
    return write


def pipeline(speech, visual, store=None, source=None, structure=None):
    store = store or Store()
    result = AnalysisPipeline(source or Source(), Media(), speech, visual, structure or Structure(),
                              store, store, heartbeat_seconds=.005)
    result.asr_fingerprint = "a" * 64
    return result


@pytest.mark.parametrize("mode", [None, "serial"])
def test_historical_and_explicit_serial_finish_speech_before_visual(mode):
    speech_done = threading.Event()
    class Speech:
        def transcribe(self, _audio):
            speech_done.set()
            return WORDS
    class Visual:
        def analyze(self, *_args):
            assert speech_done.is_set()
            return VisualOutput()
    current = job(mode)
    result = pipeline(Speech(), Visual()).process(current, heartbeat(current))
    assert result.report["analysis_meta"]["execution_mode"] == "serial"


def test_controlled_parallel_waits_for_local_ocr_then_overlaps_remote_vision(tmp_path):
    ocr_finished = threading.Event()
    speech_started = threading.Event()
    cloud_started = threading.Event()
    ocr_active = threading.Event()
    image = tmp_path / "frame.jpg"
    Image.new("RGB", (32, 32), "white").save(image)
    class Extractor:
        def extract(self, *_args):
            assert not speech_started.is_set()
            return [Keyframe(0, image, roles=("opening",)), Keyframe(500, image, roles=("opening",))]
    class Ocr:
        calls = 0
        def recognize(self, _path):
            ocr_active.set()
            assert not speech_started.is_set()
            time.sleep(.01)
            self.calls += 1
            ocr_active.clear()
            if self.calls == 2:
                ocr_finished.set()
            return "屏幕文字", 90
    class Vision:
        supports_ocr_overlap = True
        supports_speech_overlap = True
        def analyze(self, frames):
            cloud_started.set()
            assert speech_started.wait(1), "cloud and speech never overlapped"
            time.sleep(.03)
            return [VisualObservation("vision", frame.timestamp_ms, frame.timestamp_ms, "画面证据", 90) for frame in frames]
    class Speech:
        def transcribe(self, _audio):
            assert ocr_finished.is_set()
            assert not ocr_active.is_set()
            assert cloud_started.wait(1)
            speech_started.set()
            time.sleep(.03)
            return WORDS
    current = job("controlled_parallel")
    writers = []
    structure = Structure()
    visual = KeyframeVisualAnalyzer(Extractor(), Ocr(), Vision())
    worker = pipeline(Speech(), visual, structure=structure)
    events = []
    worker.runtime_monitor = lambda kind, value: events.append((kind, value))
    result = worker.process(current, heartbeat(current, writers))
    assert set(writers) == {threading.get_ident()}
    assert result.report["analysis_meta"]["execution_mode"] == "controlled_parallel"
    timing = structure.visuals.stats["branch_timing"]
    assert timing["speech_visual_overlap_ms"] >= 20
    assert timing["evidence_wall_elapsed_ms"] < timing["visual_elapsed_ms"] + timing["transcription_elapsed_ms"] - 10
    assert events.count(("branch_start", "visual")) == events.count(("branch_end", "visual")) == 1


def test_visual_failure_after_gate_keeps_raw_asr_checkpoint_for_serial_resume():
    speech_started = threading.Event()
    class Speech:
        calls = 0
        def transcribe(self, _audio):
            self.calls += 1
            speech_started.set()
            time.sleep(.02)
            return WORDS
    class FailingVisual:
        supports_speech_overlap = True
        def analyze_for_speech_overlap(self, _media, _output, ready):
            ready()
            assert speech_started.wait(1)
            raise RuntimeError("cloud failed")
    store, source, speech = Store(), Source(), Speech()
    current = job("controlled_parallel")
    with pytest.raises(RuntimeError, match="cloud failed"):
        pipeline(speech, FailingVisual(), store, source).process(current, heartbeat(current))
    stage, value, _ = store.saved[-1]
    assert stage == "transcript_ready"
    assert value["execution_mode"] == "controlled_parallel"
    class CompletedVisual:
        supports_speech_overlap = True
        def analyze_for_speech_overlap(self, *_args):
            raise AssertionError("restored raw speech needs no overlap")
        def analyze(self, *_args):
            return VisualOutput()
    resumed = replace(current, attempt_count=2, checkpoint_stage=stage, checkpoint=value)
    result = pipeline(speech, CompletedVisual(), store, source).process(resumed, heartbeat(resumed))
    assert speech.calls == source.calls == 1
    assert store.restores == 1
    assert result.report["words"] == WORDS.full_text
    assert result.report["analysis_meta"] == {"execution_mode": "serial", "requested_execution_mode": "controlled_parallel",
                                             "execution_fallback_reason": "transcript_reused", "collection_mode": "anonymous"}


def test_preparation_failure_does_not_start_speech_and_unknown_adapter_is_serial():
    class ForbiddenSpeech:
        def transcribe(self, _audio):
            raise AssertionError("speech must not start before local visual preparation")
    class BrokenPreparation:
        supports_speech_overlap = True
        def analyze_for_speech_overlap(self, *_args):
            raise RuntimeError("local preparation failed")
    current = job("controlled_parallel")
    with pytest.raises(RuntimeError, match="local preparation failed"):
        pipeline(ForbiddenSpeech(), BrokenPreparation()).process(current, heartbeat(current))
    sequence = []
    class Speech:
        def transcribe(self, _audio):
            sequence.append("speech")
            return WORDS
    class UnknownVisual:
        def analyze(self, *_args):
            sequence.append("visual")
            return VisualOutput()
    result = pipeline(Speech(), UnknownVisual()).process(current, heartbeat(current))
    assert sequence == ["speech", "visual"]
    assert result.report["analysis_meta"]["execution_mode"] == "serial"
    assert result.report["analysis_meta"]["execution_fallback_reason"] == "visual_adapter_without_preparation_gate"


def test_cancel_during_overlap_does_not_generate_report_and_joins_visual():
    speech_started, release_visual, visual_finished = (threading.Event() for _ in range(3))
    class Speech:
        def transcribe(self, _audio):
            speech_started.set()
            time.sleep(.025)
            return WORDS
    class Visual:
        supports_speech_overlap = True
        def analyze_for_speech_overlap(self, _media, _output, ready):
            ready()
            assert release_visual.wait(1)
            visual_finished.set()
            return VisualOutput()
    current = job("controlled_parallel")
    write = heartbeat(current)
    def cancelled(status, progress, stage):
        if speech_started.is_set():
            release_visual.set()
            raise AnalyzerApiError(409, "JOB_CANCELLED", "cancelled")
        return write(status, progress, stage)
    structure = Structure()
    with pytest.raises(AnalyzerApiError, match="JOB_CANCELLED"):
        pipeline(Speech(), Visual(), structure=structure).process(current, cancelled)
    assert visual_finished.is_set()
    assert structure.calls == 0


def test_only_manuscript_ignores_parallel_visual_work():
    class Speech:
        def transcribe(self, _audio):
            return WORDS
    current = job("controlled_parallel")
    current = replace(current, source={**current.source, "transcript_only": True})
    # Existing processor still configures harmless visual options before this
    # branch; use a real empty adapter to verify no analysis is launched.
    class Visual:
        def analyze(self, *_args):
            raise AssertionError("transcript-only must not analyze images")
    result = pipeline(Speech(), Visual()).process(current, heartbeat(current))
    assert result.report == {}


@pytest.mark.parametrize("bad", ["parallel", "", False, 2])
def test_invalid_execution_mode_rejected_before_work(bad):
    with pytest.raises(ValueError, match="execution_mode"):
        normalize_execution_mode(bad)
