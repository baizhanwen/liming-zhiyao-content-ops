import hashlib
import logging
import sys
import wave
from pathlib import Path
from types import SimpleNamespace

import httpx
import pytest
import requests
from urllib3.exceptions import MaxRetryError

from liming_analyzer import quality_speech, qwen_windows
from liming_analyzer.adapters import TranscriptOutput, TranscriptSegment


@pytest.mark.parametrize("device", ["auto", "cpu"])
def test_windows_default_requires_qwen_and_passes_preparation_only_on_request(
    tmp_path, monkeypatch, device
):
    monkeypatch.setattr(quality_speech.platform, "machine", lambda: "AMD64")
    monkeypatch.setattr(quality_speech.platform, "system", lambda: "Windows")
    monkeypatch.setattr(
        quality_speech, "FasterWhisperSpeechRecognizer", lambda *_a, **_kw: "timing"
    )
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
    assert (asr.model, asr.backend, asr.engine, asr.timing) == (
        "Qwen3-ASR-1.7B",
        "sherpa-onnx",
        "onnx",
        "timing",
    )
    assert calls == [False, True]
    assert quality_speech.build_quality_recognizer("small", model_cache=tmp_path) == "timing"
    assert quality_speech.build_quality_recognizer(model_cache=tmp_path, language="en") == "timing"


class ModelScopeDownloadError(Exception):
    pass


@pytest.fixture
def small_model(monkeypatch, tmp_path):
    data = {"decoder.int8.onnx": b"onnx", "tokenizer/vocab.json": b"vocab"}
    monkeypatch.setattr(
        qwen_windows, "FILES", {k: (len(v), hashlib.sha256(v).hexdigest()) for k, v in data.items()}
    )
    monkeypatch.setitem(
        sys.modules, "modelscope_hub.errors", SimpleNamespace(HubError=ModelScopeDownloadError)
    )
    return data, tmp_path / qwen_windows.MODEL_DIR


def install_downloads(monkeypatch, domestic, overseas):
    def fixed_domestic(*args, endpoint, token, **kwargs):
        assert endpoint == "https://modelscope.cn" and token == ""
        return domestic(*args, **kwargs)

    monkeypatch.setitem(
        sys.modules,
        "modelscope.hub.file_download",
        SimpleNamespace(model_file_download=fixed_domestic),
    )
    monkeypatch.setitem(sys.modules, "huggingface_hub", SimpleNamespace(hf_hub_download=overseas))


def write_download(folder, name, content):
    path = Path(folder) / name
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(content)
    return str(path)


def test_domestic_download_repairs_only_bad_files_without_accessing_huggingface(
    monkeypatch, tmp_path, small_model, capsys
):
    data, target = small_model
    write_download(target, "decoder.int8.onnx", b"oops")  # same size, different checksum
    write_download(target, "tokenizer/vocab.json", data["tokenizer/vocab.json"])
    calls = []

    def domestic(repo, remote, *, revision, local_dir):
        assert (repo, revision) == (qwen_windows.MODELSCOPE_REPO, qwen_windows.MODELSCOPE_REVISION)
        assert remote == "model_1.7B/decoder.int8.onnx"
        assert Path(local_dir).parent == target
        # The corrupt cache is unchanged until a verified replacement is ready.
        assert (target / "decoder.int8.onnx").read_bytes() == b"oops"
        calls.append(remote)
        return write_download(local_dir, remote, b"onnx")

    def unexpected(*_args, **_kwargs):
        pytest.fail("A complete domestic download must not access Hugging Face")

    install_downloads(monkeypatch, domestic, unexpected)
    with pytest.raises(RuntimeError, match="一键配置"):
        qwen_windows.windows_model_path(tmp_path, prepare=False)
    assert qwen_windows.windows_model_path(tmp_path, prepare=True) == target
    assert qwen_windows.windows_model_path(tmp_path, prepare=False) == target
    assert qwen_windows.windows_model_path(tmp_path, prepare=True) == target
    assert calls == ["model_1.7B/decoder.int8.onnx"]
    assert not list(target.glob(".qwen-download-*"))
    messages = capsys.readouterr().out.splitlines()
    assert len(messages) == 2
    assert "ModelScope（国内）" in messages[0]
    assert "下载及校验完成" in messages[1]
    assert "Hugging Face" not in "\n".join(messages)


@pytest.mark.parametrize(
    "failure",
    [
        httpx.ConnectError("connection reset"),
        httpx.ReadTimeout("slow network"),
        ConnectionResetError("connection reset"),
        requests.ConnectionError("connection reset"),
        requests.ReadTimeout("slow network"),
        requests.HTTPError("download unavailable"),
        ModelScopeDownloadError("hub unavailable"),
        MaxRetryError(
            None, "public-model-file", reason=ModelScopeDownloadError("retries exhausted")
        ),
    ],
)
def test_domestic_download_failure_uses_pinned_huggingface_fallback(
    monkeypatch, tmp_path, small_model, failure, capsys
):
    data, target = small_model
    calls = []

    def domestic(*_args, **_kwargs):
        calls.append("domestic")
        raise failure

    def overseas(
        repo, *, filename, revision, local_dir, etag_timeout, endpoint, token, force_download
    ):
        assert (repo, revision) == (qwen_windows.HUB_REPO, qwen_windows.HUB_REVISION)
        assert etag_timeout == 10
        assert endpoint == "https://huggingface.co" and token is False
        assert not force_download
        assert Path(local_dir).parent == target
        calls.append(filename)
        assert not (target / filename).exists()
        return write_download(local_dir, filename, data[filename])

    install_downloads(monkeypatch, domestic, overseas)
    assert qwen_windows.windows_model_path(tmp_path, prepare=True) == target
    assert calls == ["domestic", *data]
    assert all((target / name).read_bytes() == value for name, value in data.items())
    assert not list(target.glob(".qwen-download-*"))
    messages = capsys.readouterr().out.splitlines()
    assert len(messages) == 3
    assert "ModelScope（国内）" in messages[0]
    assert "切换至 Hugging Face（备用）" in messages[1]
    assert "下载及校验完成（Hugging Face（备用））" in messages[2]


@pytest.mark.parametrize("overseas_failure", ["connect", "read_timeout", "http", "reset"])
def test_both_download_sources_failing_returns_safe_error(
    monkeypatch, tmp_path, small_model, caplog, capsys, overseas_failure
):
    _data, target = small_model
    calls = []
    sensitive_message = "https://example.invalid/model?token=private-test-token"

    def domestic(*_args, **_kwargs):
        calls.append("domestic")
        raise httpx.ConnectError(sensitive_message)

    def overseas(*_args, **_kwargs):
        calls.append("overseas")
        if overseas_failure == "http":
            request = httpx.Request("GET", sensitive_message)
            raise httpx.HTTPStatusError(
                sensitive_message, request=request, response=httpx.Response(503, request=request)
            )
        error_type = {
            "connect": httpx.ConnectError,
            "read_timeout": httpx.ReadTimeout,
            "reset": ConnectionResetError,
        }[overseas_failure]
        raise error_type(sensitive_message)

    install_downloads(monkeypatch, domestic, overseas)
    with pytest.raises(RuntimeError, match="ModelScope.*Hugging Face") as captured:
        qwen_windows.windows_model_path(tmp_path, prepare=True)
    assert calls == ["domestic", "overseas"]
    output = capsys.readouterr().out
    assert "private-test-token" not in str(captured.value) + caplog.text + output
    assert "https://" not in output
    assert captured.value.__cause__ is None
    assert not list(target.glob(".qwen-download-*"))
    with pytest.raises(RuntimeError, match="一键配置"):
        qwen_windows.windows_model_path(tmp_path, prepare=False)


@pytest.mark.parametrize("corrupt", [b"oops", b"too short"])
def test_unverified_downloads_never_replace_cache_or_become_ready(
    monkeypatch, tmp_path, small_model, corrupt
):
    data, target = small_model
    write_download(target, "decoder.int8.onnx", b"old!")
    calls = []

    def domestic(_repo, remote, *, revision, local_dir):
        calls.append("domestic")
        return write_download(local_dir, remote, corrupt)

    def overseas(
        _repo, *, filename, revision, local_dir, etag_timeout, endpoint, token, force_download
    ):
        calls.append("overseas")
        assert etag_timeout == 10
        assert endpoint == "https://huggingface.co" and token is False
        assert force_download
        return write_download(local_dir, filename, corrupt)

    install_downloads(monkeypatch, domestic, overseas)
    with pytest.raises(RuntimeError, match="校验通过"):
        qwen_windows.windows_model_path(tmp_path, prepare=True)
    assert calls == ["domestic", "overseas"]
    assert (target / "decoder.int8.onnx").read_bytes() == b"old!"
    assert not (target / "tokenizer/vocab.json").exists()
    assert not list(target.glob(".qwen-download-*"))
    assert len(data) == 2


def test_partial_domestic_success_is_reused_by_fallback(monkeypatch, tmp_path, small_model):
    data, target = small_model
    calls = []

    def domestic(_repo, remote, *, revision, local_dir):
        calls.append(remote)
        if remote == "tokenizer/vocab.json":
            assert (target / "decoder.int8.onnx").read_bytes() == b"onnx"
            raise httpx.ConnectError("connection reset")
        return write_download(local_dir, remote, b"onnx")

    def overseas(
        _repo, *, filename, revision, local_dir, etag_timeout, endpoint, token, force_download
    ):
        assert filename == "tokenizer/vocab.json" and etag_timeout == 10
        assert endpoint == "https://huggingface.co" and token is False
        calls.append("overseas")
        return write_download(local_dir, filename, data[filename])

    install_downloads(monkeypatch, domestic, overseas)
    assert qwen_windows.windows_model_path(tmp_path, prepare=True) == target
    assert calls == ["model_1.7B/decoder.int8.onnx", "tokenizer/vocab.json", "overseas"]


def test_domestic_checksum_failure_can_be_repaired_by_verified_fallback(
    monkeypatch, tmp_path, small_model
):
    data, target = small_model

    def domestic(_repo, remote, *, revision, local_dir):
        return write_download(local_dir, remote, b"oops")

    def overseas(
        _repo, *, filename, revision, local_dir, etag_timeout, endpoint, token, force_download
    ):
        assert etag_timeout == 10
        assert endpoint == "https://huggingface.co" and token is False
        assert not (target / filename).exists()
        return write_download(local_dir, filename, data[filename])

    install_downloads(monkeypatch, domestic, overseas)
    assert qwen_windows.windows_model_path(tmp_path, prepare=True) == target
    assert all((target / name).read_bytes() == value for name, value in data.items())


def test_partial_overseas_download_survives_failure_and_is_reused_next_attempt(
    monkeypatch, tmp_path, small_model
):
    data, target = small_model

    def unavailable(*_args, **_kwargs):
        raise httpx.ConnectError("connection reset")

    def partial(
        _repo, *, filename, revision, local_dir, etag_timeout, endpoint, token, force_download
    ):
        assert etag_timeout == 10
        assert endpoint == "https://huggingface.co" and token is False
        if filename == "decoder.int8.onnx":
            assert not (target / filename).exists()
            return write_download(local_dir, filename, data[filename])
        write_download(local_dir, filename, b"incomplete")
        assert (target / "decoder.int8.onnx").read_bytes() == b"onnx"
        raise httpx.ReadTimeout("download interrupted")

    install_downloads(monkeypatch, unavailable, partial)
    with pytest.raises(RuntimeError, match="已校验的文件会保留"):
        qwen_windows.windows_model_path(tmp_path, prepare=True)
    assert (target / "decoder.int8.onnx").read_bytes() == b"onnx"
    assert not (target / "tokenizer/vocab.json").exists()
    assert not list(target.glob(".qwen-download-*"))

    def resume(_repo, remote, *, revision, local_dir):
        assert remote == "tokenizer/vocab.json"
        return write_download(local_dir, remote, data[remote])

    install_downloads(monkeypatch, resume, unavailable)
    assert qwen_windows.windows_model_path(tmp_path, prepare=True) == target


@pytest.mark.parametrize("failure", [KeyboardInterrupt(), SystemExit(), PermissionError("denied")])
@pytest.mark.parametrize("source", ["domestic", "overseas"])
def test_interruptions_and_permission_errors_do_not_silently_change_sources(
    monkeypatch, tmp_path, small_model, failure, source
):
    calls = []

    def domestic(*_args, **_kwargs):
        calls.append("domestic")
        if source == "domestic":
            raise failure
        raise httpx.ConnectError("network unavailable")

    def overseas(*_args, **_kwargs):
        calls.append("overseas")
        raise failure

    install_downloads(monkeypatch, domestic, overseas)
    with pytest.raises(type(failure)):
        qwen_windows.windows_model_path(tmp_path, prepare=True)
    assert calls == (["domestic"] if source == "domestic" else ["domestic", "overseas"])


@pytest.mark.parametrize("wrapper", ["hub", "retries"])
def test_sdk_wrapped_storage_permissions_are_not_hidden(
    monkeypatch, tmp_path, small_model, wrapper
):
    def domestic(*_args, **_kwargs):
        try:
            raise PermissionError("cache is read only")
        except PermissionError as error:
            if wrapper == "retries":
                raise MaxRetryError(None, "public-model-file", reason=error) from error
            raise ModelScopeDownloadError("wrapped local error") from error

    def overseas(*_args, **_kwargs):
        pytest.fail("A local permission failure cannot be repaired by another server")

    install_downloads(monkeypatch, domestic, overseas)
    with pytest.raises(PermissionError, match="cache is read only"):
        qwen_windows.windows_model_path(tmp_path, prepare=True)


def test_self_test_cannot_report_fallback_as_success(tmp_path, caplog):
    caplog.set_level(logging.INFO, logger="liming_analyzer.qwen_speech")
    pytest.importorskip("numpy")
    raw = TranscriptOutput("zh", (TranscriptSegment(0, 1000, "这是原始口播"),))
    timing = SimpleNamespace(transcribe=lambda _audio: raw)
    audio = tmp_path / "one.wav"
    with wave.open(str(audio), "wb") as wav:
        wav.setparams((1, 2, 16000, 0, "NONE", "not compressed"))
        wav.writeframes(b"\x00\x01" * 16000)
    worker = qwen_windows.WindowsQwenSpeechRecognizer(
        tmp_path,
        "zh",
        timing,
        engine=SimpleNamespace(
            generate=lambda *_a, **_kw: SimpleNamespace(text="", generation_tokens=0)
        ),
        vad=lambda _: [{"start": 0, "end": 16000}],
    )
    assert worker.transcribe(audio) == raw
    with pytest.raises(RuntimeError, match="complete transcription"):
        worker.transcribe_verified(audio)

    assert "transcription completed" not in caplog.text


def test_default_can_use_qwen_without_whisper_weights(tmp_path, monkeypatch, caplog):
    pytest.importorskip("numpy")
    monkeypatch.setattr(quality_speech.platform, "machine", lambda: "AMD64")
    monkeypatch.setattr(quality_speech.platform, "system", lambda: "Windows")
    monkeypatch.setattr(qwen_windows, "windows_model_path", lambda *_a, **_kw: tmp_path)

    def missing_timing(*_args, local_files_only, **_kwargs):
        assert local_files_only
        raise FileNotFoundError("Optional timing model absent")

    monkeypatch.setattr(quality_speech, "FasterWhisperSpeechRecognizer", missing_timing)
    engine = SimpleNamespace(
        generate=lambda *_a, **_kw: SimpleNamespace(text="测试语音识别。", generation_tokens=6)
    )
    monkeypatch.setattr(qwen_windows, "SherpaQwenEngine", lambda _: engine)
    worker = quality_speech.build_quality_recognizer(model_cache=tmp_path)
    worker.vad = lambda _: [{"start": 0, "end": 16000}]
    audio = tmp_path / "one.wav"
    with wave.open(str(audio), "wb") as wav:
        wav.setparams((1, 2, 16000, 0, "NONE", "not compressed"))
        wav.writeframes(b"\x00\x01" * 16000)
    caplog.set_level(logging.INFO, logger="liming_analyzer.qwen_speech")
    assert worker.transcribe_verified(audio).full_text == "测试语音识别。"
    assert "transcription completed" not in caplog.text
    assert worker.transcribe(audio).full_text == "测试语音识别。"
    assert "Qwen3-ASR-1.7B sherpa-onnx transcription completed (windows=1)" in caplog.text
    engine.generate = lambda *_a, **_kw: SimpleNamespace(text="", generation_tokens=0)
    with pytest.raises(RuntimeError, match="complete transcription"):
        worker.transcribe(audio)
