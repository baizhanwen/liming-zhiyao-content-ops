"""Real thread overlap with identical retained evidence and offline payloads."""
import copy
import hashlib
import json
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from types import SimpleNamespace

import pytest
from PIL import Image

from liming_analyzer.adapters import Keyframe, MediaInfo, NormalizedMedia, VisualObservation
from liming_analyzer.minimax_vision import McpVisionCallResult, MiniMaxTokenPlanMcpVisionEngine
from liming_analyzer.pipeline import _visual_heartbeat_progress
from liming_analyzer.visual import KeyframeVisualAnalyzer, OpenAiCompatibleVisionEngine


def media():
    return NormalizedMedia(Path("unused.mp4"), None, MediaInfo(10000, 32, 32, "h264", None))


def fixture_frames(tmp_path):
    specs = [(stamp, ("first_frame", "opening", "temporal:opening") if stamp == 0 else ("opening", "temporal:opening"), "black") for stamp in range(0, 3000, 500)]
    specs += [(4000, ("representative",), "checker"), (4100, ("representative",), "checker"), (4500, ("representative",), "black")]
    specs += [(stamp, ("temporal:cut-001",), "black") for stamp in range(6000, 6750, 125)]
    specs += [(8000, ("representative",), "checker")]
    frames = []
    for index, (stamp, roles, kind) in enumerate(specs):
        path = tmp_path / f"frame-{index}.jpg"
        picture = Image.new("RGB", (32, 32), "black")
        if kind == "checker":
            for x in range(32):
                for y in range(32):
                    picture.putpixel((x, y), (255, 255, 255) if (x + y) % 2 else (0, 0, 0))
        picture.save(path)
        frames.append(Keyframe(stamp, path, roles=roles))
    return frames


class Extractor:
    def __init__(self, frames):
        self.frames = frames
        self.last_stats = {"sampling_strategy_id": "content-frames.v2"}

    def extract(self, *_args):
        return self.frames


class Ocr:
    def __init__(self, *, errors=()):
        self.calls = []
        self.errors = errors

    def recognize(self, path):
        self.calls.append(path)
        if path.stem in self.errors:
            raise ValueError("synthetic OCR failure")
        self.last_regions = [{"polygon": [[0, 0], [16, 0], [16, 4], [0, 4]], "confidence": 92}]
        return f"真实标题{path.stem}", 92


def rows_for(manifest):
    return [{"frame_index": row["frame_index"], "composition": f"帧{row['timestamp_ms']}", "confidence": 90, "temporal": "抽样切换"} for row in manifest]


class Sdk:
    def __init__(self):
        self.calls = []
        self.active = self.maximum = 0
        self.lock = threading.Lock()
        self.chat = self
        self.completions = self

    def create(self, **kwargs):
        manifest = json.loads(kwargs["messages"][1]["content"][0]["text"].split("frame_manifest=", 1)[1])
        with self.lock:
            self.calls.append(kwargs)
            self.active += 1
            self.maximum = max(self.maximum, self.active)
        time.sleep(.01)
        with self.lock:
            self.active -= 1
        return SimpleNamespace(choices=[SimpleNamespace(message=SimpleNamespace(content=json.dumps({"observations": rows_for(manifest)})))],
                               usage=SimpleNamespace(prompt_tokens=10, completion_tokens=5, total_tokens=15))


def comparable_stats(stats):
    value = copy.deepcopy(stats)
    value.pop("stage_timing", None)
    understanding = value.get("visual_understanding", {})
    understanding.pop("elapsed_ms", None)
    for row in understanding.get("batches", []):
        for name in ("elapsed_ms", "started_at", "completed_at"):
            row.pop(name, None)
    return value


def test_builtin_openai_serial_and_overlapped_evidence_payloads_and_receipts_are_equal(tmp_path):
    frames = fixture_frames(tmp_path)
    original_hashes = [hashlib.sha256(frame.path.read_bytes()).hexdigest() for frame in frames]
    outputs, payloads, receipts = [], [], []
    for overlap in (False, True):
        sdk, ledger = Sdk(), []
        vision = OpenAiCompatibleVisionEngine(api_key="", base_url="https://fixture.invalid", model="fixture", provider="fixture", client=sdk)
        vision.supports_ocr_overlap = overlap
        analyzer = KeyframeVisualAnalyzer(Extractor(frames), Ocr(errors=("frame-10",)), vision)
        analyzer.set_call_context(SimpleNamespace(id="fixture"), lambda _job, row, ledger=ledger: ledger.append(row))
        outputs.append(analyzer.analyze(media(), tmp_path))
        payloads.append(sorted(json.dumps(row, sort_keys=True) for row in sdk.calls))
        receipts.append(ledger)
        assert sdk.maximum <= 2
        assert len(sdk.calls) == 3  # Opening group, full cut group, remaining reps.
    assert outputs[0].keyframes == outputs[1].keyframes
    assert outputs[0].observations == outputs[1].observations
    assert comparable_stats(outputs[0].stats) == comparable_stats(outputs[1].stats)
    assert payloads[0] == payloads[1]
    assert outputs[1].stats["kept_count"] == 14
    assert outputs[1].stats["low_contrast_removed"] == 1
    assert outputs[1].stats["similar_removed"] == 1
    assert outputs[1].stats["ocr_error_count"] == 1
    assert [hashlib.sha256(frame.path.read_bytes()).hexdigest() for frame in frames] == original_hashes
    for ledger in receipts:
        assert len(ledger) == 6
        assert sum(row.get("totalTokens", 0) or 0 for row in ledger) == 45
        assert all(row["task"] == "vision_batch" and row["outputBudget"] == 4800 for row in ledger)


def test_builtin_mcp_contact_sheet_payload_and_evidence_are_ocr_independent(tmp_path):
    frames = fixture_frames(tmp_path)
    outputs, payloads, sheets = [], [], []

    class Runner:
        def call_many(self, requests, on_progress=None, concurrency=None):
            self.requests = list(requests)
            assert concurrency == 2
            results = []
            for index, request in enumerate(requests, 1):
                manifest = json.loads(request["prompt"].split("manifest=", 1)[1])
                results.append(McpVisionCallResult(json.dumps({"observations": rows_for(manifest)})))
                if on_progress:
                    on_progress(index, len(requests))
            return results, {"tool_connected": True}

    for overlap in (False, True):
        runner = Runner()
        vision = MiniMaxTokenPlanMcpVisionEngine(api_key="", api_host="https://api.minimax.io", runner=runner)
        vision.supports_ocr_overlap = overlap
        outputs.append(KeyframeVisualAnalyzer(Extractor(frames), Ocr(), vision).analyze(media(), tmp_path))
        payloads.append(runner.requests)
        sheets.append([hashlib.sha256(Path(row["image_source"]).read_bytes()).hexdigest() for row in runner.requests])
    assert outputs[0].keyframes == outputs[1].keyframes
    assert outputs[0].observations == outputs[1].observations
    assert comparable_stats(outputs[0].stats) == comparable_stats(outputs[1].stats)
    assert payloads[0] == payloads[1] and sheets[0] == sheets[1]


def test_event_handshake_proves_overlap_after_first_healthy_ocr_and_truthful_progress(tmp_path):
    frames = fixture_frames(tmp_path)[:3]
    first_healthy, second_ocr, vision_started, vision_progress = (threading.Event() for _ in range(4))

    class ConcurrentOcr(Ocr):
        def recognize(self, path):
            if not self.calls:
                result = super().recognize(path)
                first_healthy.set()
                return result
            if len(self.calls) == 1:
                second_ocr.set()
                assert vision_started.wait(2) and vision_progress.wait(2), "vision must start while OCR is in progress"
                snapshot = analyzer.progress_snapshot()
                assert snapshot["ocr_completed"] == 1 and snapshot["ocr_total"] == 3
                assert snapshot["batch_completed"] == 1 and snapshot["phase"] == "ocr"
                time.sleep(.02)
            return super().recognize(path)

    class Vision:
        supports_ocr_overlap = True

        def set_progress_callback(self, callback):
            self.callback = callback

        def analyze(self, received):
            assert first_healthy.is_set()
            assert all(frame.ocr_text is None for frame in received)
            vision_started.set()
            assert second_ocr.wait(2), "OCR and VLM must actually run concurrently"
            self.callback({"phase": "vision", "batch_completed": 1, "batch_total": 2})
            vision_progress.set()
            time.sleep(.01)
            return [VisualObservation("vision", frame.timestamp_ms, frame.timestamp_ms, "真实画面") for frame in received]

    vision = Vision()
    analyzer = KeyframeVisualAnalyzer(Extractor(frames), ConcurrentOcr(), vision)
    output = analyzer.analyze(media(), tmp_path)
    assert len(output.keyframes) == 3 and output.stats["vision_observation_count"] == 3
    assert output.stats["stage_timing"]["ocr_vision_overlap_ms"] > 0
    assert analyzer.progress_snapshot()["phase"] == "completed"
    assert vision.callback is None


def test_unknown_adapter_stays_serial_and_receives_all_ocr_fields(tmp_path):
    frames, ocr = fixture_frames(tmp_path)[:3], Ocr()

    class NeedsOcr:
        def analyze(self, received):
            assert len(ocr.calls) == len(frames)
            assert all(frame.ocr_text and frame.confidence == 92 for frame in received)
            return []

    result = KeyframeVisualAnalyzer(Extractor(frames), ocr, NeedsOcr()).analyze(media(), tmp_path)
    assert result.stats["stage_timing"]["mode"] == "serial"
    assert result.stats["stage_timing"]["ocr_vision_overlap_ms"] == 0


@pytest.mark.parametrize("failure", ["first_ocr", "all_ocr", "vision"])
def test_independent_failures_preserve_frames_and_the_other_evidence_branch(tmp_path, failure):
    frames = fixture_frames(tmp_path)[:3]
    ocr = Ocr(errors=("frame-0",) if failure == "first_ocr" else tuple(frame.path.stem for frame in frames) if failure == "all_ocr" else ())

    class Vision:
        supports_ocr_overlap = True

        def set_progress_callback(self, callback):
            self.callback = callback

        def analyze(self, received):
            if failure == "first_ocr":
                assert len(ocr.calls) >= 2
            if failure == "all_ocr":
                assert len(ocr.calls) == len(frames)
            if failure == "vision":
                raise ValueError("synthetic VLM failure")
            return [VisualObservation("vision", frame.timestamp_ms, frame.timestamp_ms, "画面观察") for frame in received]

    vision = Vision()
    result = KeyframeVisualAnalyzer(Extractor(frames), ocr, vision).analyze(media(), tmp_path)
    assert len(result.keyframes) == 3 and len(ocr.calls) == 3
    assert result.stats["ocr_error_count"] == (1 if failure == "first_ocr" else 3 if failure == "all_ocr" else 0)
    assert result.stats["vision_observation_count"] == (0 if failure == "vision" else 3)
    assert result.stats["ocr_observation_count"] == (3 if failure == "vision" else 0 if failure == "all_ocr" else 2)
    assert vision.callback is None


def test_unexpected_ocr_exception_joins_started_vision_and_detaches_callback(tmp_path):
    frames = fixture_frames(tmp_path)[:3]
    started, ocr_failed, release, finished = (threading.Event() for _ in range(4))

    class BadOcr(Ocr):
        def recognize(self, path):
            if self.calls:
                assert started.wait(2)
                ocr_failed.set()
                return None, None  # Unexpected contract error, outside per-frame catch.
            return super().recognize(path)

    class Vision:
        supports_ocr_overlap = True

        def set_progress_callback(self, callback):
            self.callback = callback

        def analyze(self, _frames):
            started.set()
            assert release.wait(2)
            finished.set()
            return []

    vision = Vision()
    analyzer = KeyframeVisualAnalyzer(Extractor(frames), BadOcr(), vision)
    with ThreadPoolExecutor(max_workers=1) as executor:
        future = executor.submit(analyzer.analyze, media(), tmp_path)
        assert ocr_failed.wait(2)
        assert not future.done()  # The OCR failure cannot orphan the running VLM.
        release.set()
        with pytest.raises(AttributeError):
            future.result(timeout=2)
    assert finished.is_set() and vision.callback is None


def test_parallel_progress_never_uses_candidate_completion_as_ocr_completion():
    progress, detail = _visual_heartbeat_progress({"phase": "ocr", "keyframes_completed": 82, "keyframes_total": 82,
        "ocr_completed": 13, "ocr_total": 82, "batch_completed": 14, "batch_total": 14})
    assert 54 <= progress < 66
    assert "OCR 13/82" in detail and "视觉批次 14/14" in detail


def test_full_82_frame_plan_stays_14_paid_calls_with_at_most_two_in_flight(tmp_path):
    samples = fixture_frames(tmp_path)
    checker = next(frame.path for frame in samples if frame.timestamp_ms == 4000)
    frames = [Keyframe(stamp, samples[0].path, roles=("opening", "temporal:opening")) for stamp in range(0, 3000, 500)]
    frames += [Keyframe(group * 10000 + offset, checker, roles=(f"temporal:cut-{group}",)) for group in range(1, 9) for offset in range(0, 750, 125)]
    frames += [Keyframe(90000 + index * 3000, checker, roles=("representative",)) for index in range(28)]

    class SlowOcr(Ocr):
        def recognize(self, path):
            time.sleep(.002)
            return super().recognize(path)

    sdk, ledger = Sdk(), []
    engine = OpenAiCompatibleVisionEngine(api_key="", base_url="https://fixture.invalid", model="fixture", provider="fixture", client=sdk)
    analyzer = KeyframeVisualAnalyzer(Extractor(frames), SlowOcr(), engine)
    analyzer.set_call_context(SimpleNamespace(id="fixture"), lambda _job, row: ledger.append(row))
    long_media = NormalizedMedia(Path("unused.mp4"), None, MediaInfo(180000, 32, 32, "h264", None))
    result = analyzer.analyze(long_media, tmp_path)
    assert len(result.keyframes) == 82 and result.stats["vision_observation_count"] == 82
    assert len(sdk.calls) == 14 and sdk.maximum == 2
    assert len(ledger) == 28 and sum(row.get("totalTokens", 0) or 0 for row in ledger) == 210
    assert result.stats["stage_timing"]["ocr_vision_overlap_ms"] > 0


def test_ocr_finishing_first_keeps_its_real_counters_while_waiting_for_vision(tmp_path):
    frames = fixture_frames(tmp_path)[:3]
    vision_started, last_ocr, release = (threading.Event() for _ in range(3))

    class OcrFirst(Ocr):
        def recognize(self, path):
            if self.calls:
                assert vision_started.wait(2)
            result = super().recognize(path)
            if len(self.calls) == 3:
                last_ocr.set()
            return result

    class Vision:
        supports_ocr_overlap = True

        def set_progress_callback(self, callback):
            self.callback = callback

        def analyze(self, _frames):
            vision_started.set()
            self.callback({"phase": "vision", "batch_completed": 0, "batch_total": 1})
            assert release.wait(2)
            return []

    analyzer = KeyframeVisualAnalyzer(Extractor(frames), OcrFirst(), Vision())
    with ThreadPoolExecutor(max_workers=1) as executor:
        future = executor.submit(analyzer.analyze, media(), tmp_path)
        assert last_ocr.wait(2)
        deadline = time.monotonic() + 2
        while analyzer.progress_snapshot().get("phase") != "vision" and time.monotonic() < deadline:
            time.sleep(.002)
        snapshot = analyzer.progress_snapshot()
        assert snapshot["ocr_completed"] == snapshot["ocr_total"] == 3
        assert snapshot["phase"] == "vision" and snapshot["batch_completed"] == 0
        assert not future.done()
        release.set()
        assert len(future.result(timeout=2).keyframes) == 3


def test_extraction_failure_cannot_start_ocr_or_a_paid_vision_future(tmp_path):
    ocr = Ocr()

    class ExtractorFailure:
        def extract(self, *_args):
            raise ValueError("synthetic extraction failure")

    class NeverVision:
        supports_ocr_overlap = True

        def analyze(self, _frames):
            pytest.fail("a failed extraction must not invoke a model")

    with pytest.raises(ValueError, match="synthetic extraction failure"):
        KeyframeVisualAnalyzer(ExtractorFailure(), ocr, NeverVision()).analyze(media(), tmp_path)
    assert ocr.calls == []
