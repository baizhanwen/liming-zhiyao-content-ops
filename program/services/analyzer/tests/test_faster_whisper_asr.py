import sys
from pathlib import Path
from types import SimpleNamespace

import pytest

from liming_analyzer.faster_whisper_asr import FasterWhisperSpeechRecognizer


def test_local_whisper_emits_real_segment_times_and_does_not_download_with_injected_engine(tmp_path):
    calls = []
    class Engine:
        def transcribe(self, audio, **options):
            calls.append((audio, options))
            return iter([SimpleNamespace(start=1.25, end=2.75, text=" 测试转写 "), SimpleNamespace(start=3, end=4, text=" ")]), SimpleNamespace(language="zh")
    recognizer = FasterWhisperSpeechRecognizer("small", model_cache=tmp_path, language="zh", device="auto", engine=Engine())
    result = recognizer.transcribe(Path("fixture.wav"))
    assert result.full_text == "测试转写"
    assert (result.segments[0].start_ms, result.segments[0].end_ms) == (1250, 2750)
    assert result.language == "zh"
    assert calls == [("fixture.wav", {"language": "zh", "beam_size": 5, "word_timestamps": False, "vad_filter": True})]
    assert recognizer.model_path == tmp_path / "faster-whisper-small"


@pytest.mark.parametrize("start,end", [(3, 2), (-1, 2), (float("nan"), 3), (1, float("inf"))])
def test_local_whisper_rejects_invalid_timestamps(start, end, tmp_path):
    class Engine:
        def transcribe(self, *_args, **_kwargs):
            return [SimpleNamespace(start=start, end=end, text="bad")], SimpleNamespace(language="zh")
    with pytest.raises(ValueError, match="invalid timestamp"):
        FasterWhisperSpeechRecognizer(model_cache=tmp_path, engine=Engine()).transcribe(Path("fixture.wav"))


@pytest.mark.parametrize("model", ["small", "large-v3-turbo"])
def test_existing_complete_cache_is_kept_without_download_or_messages(tmp_path, monkeypatch, capsys, model):
    from liming_analyzer import whisper_model_download

    folder = tmp_path / f"faster-whisper-{model}"
    folder.mkdir()
    names = ["model.bin", "config.json", "tokenizer.json"]
    if model == "large-v3-turbo":
        names.append("preprocessor_config.json")
    for name in names:
        (folder / name).write_bytes(b"pre-existing-model")
    monkeypatch.setitem(sys.modules, "ctranslate2", SimpleNamespace(get_cuda_device_count=lambda: 0))
    monkeypatch.setattr(FasterWhisperSpeechRecognizer, "_load_engine", lambda *_args: object())
    monkeypatch.setattr(whisper_model_download, "download_whisper_model", lambda *_args: pytest.fail("complete cache must not download"))
    FasterWhisperSpeechRecognizer(model, model_cache=tmp_path)
    assert all((folder / name).read_bytes() == b"pre-existing-model" for name in names)
    assert not capsys.readouterr().out


def test_local_files_only_never_downloads_an_incomplete_cache(tmp_path, monkeypatch, capsys):
    from liming_analyzer import whisper_model_download

    monkeypatch.setitem(sys.modules, "ctranslate2", SimpleNamespace(get_cuda_device_count=lambda: 0))
    monkeypatch.setattr(whisper_model_download, "download_whisper_model", lambda *_args: pytest.fail("offline must not download"))
    with pytest.raises(FileNotFoundError, match="incomplete"):
        FasterWhisperSpeechRecognizer("large-v3-turbo", model_cache=tmp_path, local_files_only=True)
    assert not capsys.readouterr().out


def test_new_downloader_keeps_cpu_precision_and_turbo_decode_options(tmp_path, monkeypatch):
    from liming_analyzer import whisper_model_download

    calls = []
    def prepare(model, folder):
        calls.append(("download", model, folder))
        for name in ["model.bin", "config.json", "tokenizer.json", "preprocessor_config.json"]:
            (folder / name).write_bytes(b"synthetic")
    def load(folder, **settings):
        calls.append(("load", folder, settings))
        def decode(audio, **options):
            calls.append(("decode", audio, options))
            return iter([SimpleNamespace(start=0.25, end=1.5, text="原话")]), SimpleNamespace(language="zh")
        return SimpleNamespace(transcribe=decode)
    monkeypatch.setitem(sys.modules, "ctranslate2", SimpleNamespace(get_cuda_device_count=lambda: 0))
    monkeypatch.setitem(sys.modules, "faster_whisper", SimpleNamespace(WhisperModel=load))
    monkeypatch.setattr(whisper_model_download, "download_whisper_model", prepare)
    recognizer = FasterWhisperSpeechRecognizer("large-v3-turbo", model_cache=tmp_path)
    result = recognizer.transcribe(Path("fixture.wav"))
    assert (result.segments[0].start_ms, result.segments[0].end_ms) == (250, 1500)
    assert calls[0] == ("download", "large-v3-turbo", tmp_path / "faster-whisper-large-v3-turbo")
    settings = calls[1][2]
    assert settings["device"] == "cpu" and settings["compute_type"] == "int8" and settings["local_files_only"] is True
    assert 1 <= settings["cpu_threads"] <= 4
    assert calls[2][2] == {"language": "zh", "beam_size": 5, "word_timestamps": True, "vad_filter": True, "condition_on_previous_text": False, "hallucination_silence_threshold": 2.0}
