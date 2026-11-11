import hashlib
import sys
import wave
from pathlib import Path
from types import SimpleNamespace

import pytest

from liming_analyzer import quality_speech, qwen_windows
from liming_analyzer.adapters import TranscriptOutput, TranscriptSegment


@pytest.mark.parametrize("device", ["auto", "cpu"])
def test_windows_default_requires_qwen_and_passes_preparation_only_on_request(tmp_path, monkeypatch, device):
    monkeypatch.setattr(quality_speech.platform, "machine", lambda: "AMD64")
    monkeypatch.setattr(quality_speech.platform, "system", lambda: "Windows")
    monkeypatch.setattr(quality_speech, "FasterWhisperSpeechRecognizer", lambda *_a, **_kw: "timing")
    calls = []

    def weights(_cache, *, prepare):
        calls.append(prepare)
        if not prepare:
            raise RuntimeError("尚未就绪")
        return tmp_path

    monkeypatch.setattr(qwen_windows, "windows_model_path", weights)
    monkeypatch.setattr(qwen_windows, "SherpaQwenEngine", lambda _folder: "onnx")
    with pytest.raises(RuntimeError, match="尚未就绪"):
        quality_speech.build_quality_recognizer(model_cache=tmp_path, device=device)
    asr = quality_speech.build_quality_recognizer(model_cache=tmp_path, device=device, prepare=True)
    assert (asr.model, asr.backend, asr.engine, asr.timing) == ("Qwen3-ASR-1.7B", "sherpa-onnx", "onnx", "timing")
    assert calls == [False, True]
    assert quality_speech.build_quality_recognizer("small", model_cache=tmp_path) == "timing"
    assert quality_speech.build_quality_recognizer(model_cache=tmp_path, language="en") == "timing"


def test_cache_repairs_only_bad_files_and_falls_back_to_the_original_export(monkeypatch, tmp_path):
    data = {"decoder.int8.onnx": b"onnx", "tokenizer/vocab.json": b"vocab"}
    monkeypatch.setattr(qwen_windows, "FILES", {k: (len(v), hashlib.sha256(v).hexdigest()) for k, v in data.items()})
    target = tmp_path / qwen_windows.MODEL_DIR
    target.mkdir()
    (target / "decoder.int8.onnx").write_bytes(b"oops")  # same size, different checksum
    (target / "tokenizer").mkdir()
    (target / "tokenizer/vocab.json").write_bytes(b"vocab")
    calls = []
    def unavailable(repo, *, revision, local_dir, allow_patterns, force_download):
        assert (repo, revision) == (qwen_windows.HUB_REPO, qwen_windows.HUB_REVISION)
        assert list(allow_patterns) == ["decoder.int8.onnx"] and force_download
        calls.append("primary")
        raise OSError("offline mirror")
    def mirror(repo, remote, *, revision, local_dir):
        assert (repo, revision) == (qwen_windows.MODELSCOPE_REPO, qwen_windows.MODELSCOPE_REVISION)
        assert remote == "model_1.7B/decoder.int8.onnx"
        calls.append("mirror")
        path = Path(local_dir) / remote
        path.parent.mkdir(parents=True)
        path.write_bytes(b"onnx")
        return str(path)
    monkeypatch.setitem(sys.modules, "huggingface_hub", SimpleNamespace(snapshot_download=unavailable))
    monkeypatch.setitem(sys.modules, "modelscope.hub.file_download", SimpleNamespace(model_file_download=mirror))
    with pytest.raises(RuntimeError, match="一键配置"):
        qwen_windows.windows_model_path(tmp_path, prepare=False)
    assert qwen_windows.windows_model_path(tmp_path, prepare=True) == target
    assert qwen_windows.windows_model_path(tmp_path, prepare=False) == target
    assert qwen_windows.windows_model_path(tmp_path, prepare=True) == target
    assert calls == ["primary", "mirror"]


def test_self_test_cannot_report_fallback_as_success(tmp_path):
    pytest.importorskip("numpy")
    raw = TranscriptOutput("zh", (TranscriptSegment(0, 1000, "这是原始口播"),))
    timing = SimpleNamespace(transcribe=lambda _audio: raw)
    audio = tmp_path / "one.wav"
    with wave.open(str(audio), "wb") as wav:
        wav.setparams((1, 2, 16000, 0, "NONE", "not compressed"))
        wav.writeframes(b"\x00\x01" * 16000)
    worker = qwen_windows.WindowsQwenSpeechRecognizer(
        tmp_path, "zh", timing, engine=SimpleNamespace(generate=lambda *_a, **_kw:
            SimpleNamespace(text="", generation_tokens=0)), vad=lambda _: [{"start": 0, "end": 16000}])
    assert worker.transcribe(audio) == raw
    with pytest.raises(RuntimeError, match="complete transcription"):
        worker.transcribe_verified(audio)
