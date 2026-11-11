import hashlib
import sys
import wave
from types import SimpleNamespace

import pytest

from liming_analyzer import qwen_speech as qwen
from liming_analyzer.adapters import TranscriptOutput, TranscriptSegment


def sample(root, duration_ms):
    path = root / "speech.wav"
    with wave.open(str(path), "wb") as wav:
        wav.setparams((1, 2, 16000, 0, "NONE", "not compressed"))
        wav.writeframes(b"\x00\x01" * (16 * duration_ms))
    return path


class Engine:
    def __init__(self, texts, *, tokens=10):
        self.texts = iter(texts)
        self.calls = []
        self.tokens = tokens

    def generate(self, samples, **kwargs):
        assert set(kwargs) == {"temperature", "language", "max_tokens"}
        self.calls.append((len(samples), kwargs))
        return SimpleNamespace(
            text=next(self.texts), generation_tokens=self.tokens, language=["Chinese"]
        )


def recognizer(tmp_path, rows, engine, intervals, language="zh"):
    pytest.importorskip("numpy")
    timings = TranscriptOutput(language, tuple(TranscriptSegment(*r) for r in rows))
    return qwen.QwenSpeechRecognizer(
        tmp_path,
        language,
        SimpleNamespace(transcribe=lambda _: timings),
        engine=engine,
        vad=lambda _: [{"start": a * 16, "end": b * 16} for a, b in intervals],
    )


def test_independent_audio_preserves_corrections_and_only_borrows_unambiguous_boundaries(tmp_path):
    rows = [
        (1000, 1900, "先听这段原声"),
        (1900, 2700, "接着需要抓起数据"),
        (2700, 3500, "最后打包袋子"),
    ]
    engine = Engine(["先听这段原声，接着需要抓取数据，最后打包带走。"])
    worker = recognizer(tmp_path, rows, engine, [(1000, 3500)])
    result = worker.transcribe(sample(tmp_path, 6000))
    assert [r.text for r in result.segments] == [
        "先听这段原声，",
        "接着需要抓取数据，",
        "最后打包带走。",
    ]
    assert [(r.start_ms, r.end_ms) for r in result.segments] == [
        (1000, 1900),
        (1900, 2700),
        (2700, 3500),
    ]
    assert engine.calls[0][0] == 2500 * 16
    assert engine.calls[0][1]["language"] == "Chinese"


def test_missing_anchors_keep_only_measured_speech_bounds_and_auto_detect_language(tmp_path):
    engine = Engine(["这段是独立说的。"])
    worker = recognizer(tmp_path, [], engine, [(750, 4000)], "auto")
    result = worker.transcribe(sample(tmp_path, 6000))
    assert result.language == "zh"
    assert [(s.start_ms, s.end_ms) for s in result.segments] == [(750, 4000)]
    assert engine.calls[0][1]["language"] is None


@pytest.mark.parametrize(
    ("text", "tokens"),
    [
        ("抓取", 2),
        ("这里有一段真实的口播接下来还有其他内容", 1000),
        ("<|user|> language Chinese <asr_text>", 10),
        ("欢迎观看" * 8, 20),
        ("我们先听这个内容再看最后的例子", 15),
    ],
)
def test_partial_capped_template_and_loop_results_keep_existing_words(tmp_path, text, tokens):
    rows = [
        (100, 1200, "我们先听这个内容"),
        (1200, 2600, "这里有一整句不可删除的原话"),
        (2600, 3900, "再看最后的例子"),
    ]
    worker = recognizer(tmp_path, rows, Engine([text], tokens=tokens), [(100, 3900)])
    assert [s.text for s in worker.transcribe(sample(tmp_path, 4000)).segments] == [
        r[2] for r in rows
    ]


def test_no_speech_window_skips_decoder_and_preserves_a_valid_timing_cue(tmp_path):
    rows = [(100, 2000, "我们重新核对时间"), (46000, 46900, "第二个窗口的原话")]
    engine = Engine(["我们重新核对时间"])
    worker = recognizer(tmp_path, rows, engine, [(100, 2000)])
    result = worker.transcribe(sample(tmp_path, 50000))
    assert len(engine.calls) == 1
    assert result.segments[-1] == TranscriptSegment(*rows[-1])


def test_long_input_has_independent_monotonic_windows(tmp_path):
    engine = Engine(["第一句话", "第二句话", "第三句话"])
    worker = recognizer(tmp_path, [], engine, [(0, 91000)])
    rows = worker.transcribe(sample(tmp_path, 91000)).segments
    assert [(r.start_ms, r.end_ms) for r in rows] == [(0, 45000), (45000, 90000), (90000, 91000)]
    assert all(length <= 45000 * 16 for length, _ in engine.calls)


def test_model_preparation_validates_pinned_files_and_does_not_network_on_cache_hit(
    tmp_path, monkeypatch
):
    files = {"config.json": b"{}", "model.safetensors": b"test-weight"}
    monkeypatch.setattr(
        qwen, "QWEN_FILES", {name: hashlib.sha256(data).hexdigest() for name, data in files.items()}
    )
    monkeypatch.setattr(qwen, "QWEN_BYTES", len(files["model.safetensors"]))
    calls = []

    def fetch(repo, *, revision, local_dir, allow_patterns, force_download):
        assert repo == qwen.QWEN_REPO and revision == qwen.QWEN_REVISION
        calls.append((list(allow_patterns), force_download))
        local_dir.mkdir(parents=True, exist_ok=True)
        for name in allow_patterns:
            (local_dir / name).write_bytes(files[name])

    monkeypatch.setitem(sys.modules, "huggingface_hub", SimpleNamespace(snapshot_download=fetch))
    assert qwen.verified_qwen_model(tmp_path) is None
    expected = qwen.prepare_qwen_model(tmp_path)
    assert qwen.verified_qwen_model(tmp_path) == qwen.prepare_qwen_model(tmp_path) == expected
    assert len(calls) == 1
    (expected / "config.json").write_bytes(b"[]")
    assert qwen.verified_qwen_model(tmp_path) is None
    assert qwen.prepare_qwen_model(tmp_path) == expected
    assert calls[-1] == (["config.json"], True)


def test_timing_reference_is_scoped_to_current_recording_and_cleared_on_error(tmp_path):
    worker = recognizer(tmp_path, [(100, 600, "原声证据")], Engine(["原声证据"]), [(100, 600)])
    source = sample(tmp_path, 1000)
    assert worker.last_timing_transcript is None
    worker.transcribe(source)
    original = worker.timing_transcript_for(source)
    assert original.full_text == "原声证据"
    other = source.with_name("other.wav")
    other.write_bytes(source.read_bytes())
    assert worker.timing_transcript_for(other) is None

    def failed(_):
        assert worker.last_timing_transcript is None
        raise RuntimeError("timings unavailable")

    worker.timing = SimpleNamespace(transcribe=failed)
    worker.engine = Engine(["另外一段语音"])
    assert worker.transcribe(other).full_text == "另外一段语音"
    assert worker.timing_transcript_for(source) is worker.last_timing_transcript is None


def test_older_overlapping_transcription_cannot_overwrite_new_input_reference(tmp_path):
    from concurrent.futures import ThreadPoolExecutor
    from threading import Event

    first = sample(tmp_path, 1000)
    second = first.with_name("second.wav")
    second.write_bytes(first.read_bytes())
    active, release = Event(), Event()
    original = TranscriptOutput("zh", (TranscriptSegment(0, 700, "第一段"),))
    later = TranscriptOutput("zh", (TranscriptSegment(0, 700, "第二段"),))

    def read(path):
        if path == first:
            active.set()
            assert release.wait(3)
            return original
        return later

    worker = recognizer(tmp_path, [], None, [])
    worker.timing = SimpleNamespace(transcribe=read)
    with ThreadPoolExecutor(max_workers=2) as pool:
        slow = pool.submit(worker.transcribe, first)
        assert active.wait(3)
        assert worker.transcribe(second) == later
        release.set()
        assert slow.result() == original
    assert worker.timing_transcript_for(first) is None
    assert worker.timing_transcript_for(second) == worker.last_timing_transcript == later
