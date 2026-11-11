import json
import sys
import wave
from pathlib import Path
from types import SimpleNamespace

import pytest

from liming_analyzer import quality_speech as quality
from liming_analyzer.faster_whisper_asr import TURBO_MODEL, FasterWhisperSpeechRecognizer


def make_wave(path, *, silent=False):
    with wave.open(str(path), "wb") as wav:
        wav.setparams((1, 2, 16000, 0, "NONE", "not compressed"))
        wav.writeframes((b"\x00\x00" if silent else b"\x01\x00") * 16000)


def test_mlx_keeps_real_segment_times_and_skips_non_speech(tmp_path, monkeypatch):
    pytest.importorskip("numpy")
    vad = SimpleNamespace(get_speech_timestamps=lambda _samples: [])
    monkeypatch.setitem(sys.modules, "faster_whisper.vad", vad)
    audio = tmp_path / "audio.wav"
    calls = []

    def transcribe(samples, **settings):
        calls.append((samples.shape, settings))
        return {"language": "zh", "segments": [
            {"start": 0.1, "end": 0.6, "text": " 第一段 "},
            {"start": 0.62, "end": 1.02, "text": "第二段"},
            {"start": 1.5, "end": 2, "text": "填充区"},
        ]}

    engine = quality.MlxWhisperSpeechRecognizer(tmp_path, "auto", transcribe)
    make_wave(audio, silent=True)
    assert not engine.transcribe(audio).segments and not calls
    make_wave(audio)
    assert not engine.transcribe(audio).segments and not calls
    vad.get_speech_timestamps = lambda _samples: [{"start": 0, "end": 16000}]
    result = engine.transcribe(audio)
    assert result.language == "zh"
    assert [(s.start_ms, s.end_ms, s.text) for s in result.segments] == [
        (100, 600, "第一段"), (620, 1000, "第二段")]
    assert calls == [((16000,), {"path_or_hf_repo": str(tmp_path), "language": None,
                                  "word_timestamps": True, "condition_on_previous_text": False,
                                  "hallucination_silence_threshold": 2.0, "verbose": None})]


def test_factory_ignores_truncated_weights_and_explicit_small_uses_original_backend(tmp_path, monkeypatch):
    np = pytest.importorskip("numpy")
    tensor_io = pytest.importorskip("safetensors.numpy")
    monkeypatch.setattr(quality.platform, "system", lambda: "Darwin")
    monkeypatch.setattr(quality.platform, "machine", lambda: "arm64")
    monkeypatch.setattr(quality, "FasterWhisperSpeechRecognizer", lambda model, **kw: (model, kw["device"]))
    monkeypatch.setitem(sys.modules, "mlx_whisper", SimpleNamespace(transcribe=lambda *_args: None))
    snapshot = tmp_path / "huggingface/hub/models--mlx-community--whisper-large-v3-turbo/snapshots/test"
    snapshot.mkdir(parents=True)
    (snapshot / "config.json").write_text(json.dumps({"n_mels": 128, "n_audio_layer": 32, "n_text_layer": 4}))
    weights = snapshot / "weights.safetensors"
    tensors = {name: np.zeros((2,), dtype=np.float16) for name in (
        "decoder.token_embedding.weight", "encoder.blocks.31.attn.query.weight", "decoder.blocks.3.attn.query.weight")}
    tensors["encoder.conv1.weight"] = np.zeros((1280, 3, 128), dtype=np.float16)
    tensor_io.save_file(tensors, weights)
    assert quality.build_quality_recognizer(model_cache=tmp_path).backend == "mlx-whisper"
    assert quality.build_quality_recognizer("small", model_cache=tmp_path) == ("small", "auto")
    assert quality.build_quality_recognizer(model_cache=tmp_path, device="cpu") == (TURBO_MODEL, "cpu")
    weights.write_bytes(weights.read_bytes()[:-1])
    assert quality.build_quality_recognizer(model_cache=tmp_path) == (TURBO_MODEL, "auto")


def test_ct2_turbo_preserves_timestamps_with_vad(tmp_path):
    class Engine:
        def transcribe(self, _audio, **settings):
            assert settings["word_timestamps"] and settings["vad_filter"]
            assert settings["hallucination_silence_threshold"] == 2.0
            assert not settings["condition_on_previous_text"]
            return [SimpleNamespace(start=0.5, end=1.2, text="原话")], SimpleNamespace(language="zh")

    engine = FasterWhisperSpeechRecognizer(TURBO_MODEL, model_cache=tmp_path, engine=Engine())
    assert engine.transcribe(Path("audio.wav")).segments[0].end_ms == 1200


def test_apple_chinese_uses_verified_audio_model_and_only_downloads_during_setup(monkeypatch, tmp_path):
    from liming_analyzer import qwen_speech

    monkeypatch.setattr(quality.platform, "system", lambda: "Darwin")
    monkeypatch.setattr(quality.platform, "machine", lambda: "arm64")
    timing = object()
    monkeypatch.setattr(quality, "FasterWhisperSpeechRecognizer", lambda *_a, **_kw: timing)
    monkeypatch.setattr(qwen_speech, "verified_qwen_model", lambda _cache: tmp_path / "model")
    def offline(_cache):
        raise OSError("unavailable")
    monkeypatch.setattr(qwen_speech, "prepare_qwen_model", offline)
    recognizer = quality.build_quality_recognizer(model_cache=tmp_path)
    assert recognizer.model_path == tmp_path / "model"
    assert recognizer.timing is timing
    assert quality.build_quality_recognizer(model_cache=tmp_path, prepare=True) is timing
    assert quality.build_quality_recognizer(model_cache=tmp_path, language="en") is timing
    assert quality.build_quality_recognizer(model_cache=tmp_path, device="cpu") is timing
    monkeypatch.setattr(quality.platform, "system", lambda: "Windows")
    assert quality.build_quality_recognizer(model_cache=tmp_path) is timing


@pytest.mark.parametrize("failure_stage", ["load", "decode"])
def test_ct2_auto_recovers_gpu_failures_without_partial_or_duplicate_output(tmp_path, monkeypatch, failure_stage):
    folder = tmp_path / f"faster-whisper-{TURBO_MODEL}"
    folder.mkdir()
    for name in ("model.bin", "config.json", "tokenizer.json", "preprocessor_config.json"):
        (folder / name).write_bytes(b"fixture")
    monkeypatch.setitem(sys.modules, "ctranslate2", SimpleNamespace(get_cuda_device_count=lambda: 1))
    monkeypatch.setitem(sys.modules, "faster_whisper.utils", SimpleNamespace(download_model=None))
    devices = []

    def load(_self, device):
        devices.append(device)
        if device == "cuda" and failure_stage == "load":
            raise RuntimeError("cuBLAS library unavailable")

        def segments():
            if device == "cuda":
                yield SimpleNamespace(start=0, end=0.5, text="部分结果")
                raise RuntimeError("CUDA out of memory")
            yield SimpleNamespace(start=0, end=1, text="完整原话")

        return SimpleNamespace(transcribe=lambda *_a, **_kw: (segments(), SimpleNamespace(language="zh")))

    monkeypatch.setattr(FasterWhisperSpeechRecognizer, "_load_engine", load)
    recognizer = FasterWhisperSpeechRecognizer(TURBO_MODEL, model_cache=tmp_path)
    assert recognizer.transcribe(Path("audio.wav")).full_text == "完整原话"
    assert recognizer.transcribe(Path("other.wav")).full_text == "完整原话"
    assert devices == ["cuda", "cpu"]
    with pytest.raises(RuntimeError, match="cuBLAS|CUDA"):
        FasterWhisperSpeechRecognizer(TURBO_MODEL, model_cache=tmp_path, device="cuda").transcribe(Path("audio.wav"))
