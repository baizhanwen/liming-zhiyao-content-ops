"""Offline model-source and atomic cache contracts; no weights are downloaded."""
import errno
import hashlib
import io
import sys
from pathlib import Path
from types import SimpleNamespace
from urllib.error import URLError
from urllib.parse import parse_qs, urlsplit

import httpx
import pytest

from liming_analyzer import whisper_model_download as download


class Response(io.BytesIO):
    def __init__(self, data, *, length=True):
        super().__init__(data)
        self.headers = {"Content-Length": str(len(data))} if length else {}


@pytest.fixture
def model(monkeypatch):
    payloads = {"config.json": b'{"synthetic":true}', "tokenizer.json": b"synthetic-tokenizer", "model.bin": b"synthetic-ct2-weights"}
    files = tuple(download.FileSpec(name, len(data), hashlib.sha256(data).hexdigest(), str(index + 1) * 40)
                  for index, (name, data) in enumerate(payloads.items()))
    spec = download.ModelSpec("verified/small", "official/small", "a" * 40, files)
    monkeypatch.setattr(download, "_MODELS", {"small": spec})
    return spec, payloads


def domestic(monkeypatch, payloads, handler=None):
    requests = []
    def open_file(url):
        parsed = urlsplit(url)
        query = parse_qs(parsed.query)
        name = query["FilePath"][0]
        requests.append((name, parsed, query))
        return handler(name) if handler else Response(payloads[name])
    monkeypatch.setattr(download, "_open_modelscope", open_file)
    return requests


def official(monkeypatch, payloads, handler=None):
    requests = []
    def get_file(repo, **settings):
        requests.append((repo, settings))
        if handler:
            return handler(settings)
        path = Path(settings["local_dir"]) / settings["filename"]
        path.write_bytes(payloads[settings["filename"]])
        return str(path)
    monkeypatch.setitem(sys.modules, "huggingface_hub", SimpleNamespace(hf_hub_download=get_file))
    return requests


def test_all_supported_models_have_pinned_equivalent_file_manifests():
    from liming_analyzer.faster_whisper_asr import LOCAL_MODELS
    assert set(download._MODELS) == LOCAL_MODELS
    assert sum(len(model.files) for model in download._MODELS.values()) == 31
    for model in download._MODELS.values():
        assert len(model.huggingface_revision) == 40
        assert {"model.bin", "config.json", "tokenizer.json"} <= {file.name for file in model.files}
        assert all(file.size > 0 and len(file.sha256) == 64 and len(file.modelscope_revision) == 40 for file in model.files)
    turbo = download._MODELS["large-v3-turbo"]
    assert turbo.modelscope_repository == "mobiuslabsgmbh/faster-whisper-large-v3-turbo"
    assert turbo.huggingface_repository == "dropbox-dash/faster-whisper-large-v3-turbo"
    assert turbo.huggingface_revision == "0a363e9161cbc7ed1431c9597a8ceaf0c4f78fcf"
    weights = next(file for file in turbo.files if file.name == "model.bin")
    assert (weights.size, weights.sha256) == (1617884929, "e76620f83d5f5b69efd3d87e3dc180c1bd21df9fbebacfd4335e5e1efcc018da")
    assert "preprocessor_config.json" in {file.name for file in turbo.files}


def test_domestic_first_uses_pinned_resources_and_does_not_call_hf(model, monkeypatch, tmp_path, capsys):
    spec, payloads = model
    calls = domestic(monkeypatch, payloads)
    hf = official(monkeypatch, payloads)
    assert download.download_whisper_model("small", tmp_path) == tmp_path
    assert [call[0] for call in calls] == list(payloads)
    for (name, parsed, query), file in zip(calls, spec.files, strict=True):
        assert parsed.scheme == "https" and parsed.hostname == "modelscope.cn"
        assert query == {"FilePath": [name], "Revision": [file.modelscope_revision]}
    assert not hf
    assert {path.name: path.read_bytes() for path in tmp_path.iterdir()} == payloads
    output = capsys.readouterr().out
    assert "Whisper 时间定位模型 small" in output and "ModelScope 国内源" in output and "下载及校验完成" in output
    assert "https://" not in output


@pytest.mark.parametrize("failure", [ConnectionResetError("reset"), URLError("offline"), httpx.ConnectTimeout("signed-private-url"), httpx.ReadError("signed-private-url")])
def test_transport_failures_switch_to_pinned_per_file_hf(model, monkeypatch, tmp_path, capsys, failure):
    _, payloads = model
    def fail(_name):
        raise failure
    domestic(monkeypatch, payloads, fail)
    hf = official(monkeypatch, payloads)
    download.download_whisper_model("small", tmp_path)
    assert [settings["filename"] for _, settings in hf] == list(payloads)
    for repo, settings in hf:
        assert repo == "official/small"
        assert settings["revision"] == "a" * 40
        assert settings["etag_timeout"] == 10
        assert settings["endpoint"] == "https://huggingface.co"
        assert settings["token"] is False
    output = capsys.readouterr().out
    assert "自动切换官方 Hugging Face" in output and "signed-private-url" not in output


def test_requests_error_also_switches_sources(model, monkeypatch, tmp_path):
    requests = pytest.importorskip("requests")
    _, payloads = model
    def fail(_name):
        raise requests.exceptions.ConnectionError("synthetic connection reset")
    domestic(monkeypatch, payloads, fail)
    hf = official(monkeypatch, payloads)
    download.download_whisper_model("small", tmp_path)
    assert len(hf) == 3


def test_fallback_recomputes_missing_files_and_keeps_successful_files(model, monkeypatch, tmp_path):
    _, payloads = model
    def initial(name):
        if name != "config.json":
            raise ConnectionResetError("reset")
        return Response(payloads[name])
    domestic(monkeypatch, payloads, initial)
    hf = official(monkeypatch, payloads)
    download.download_whisper_model("small", tmp_path)
    assert [settings["filename"] for _, settings in hf] == ["tokenizer.json", "model.bin"]
    assert (tmp_path / "config.json").read_bytes() == payloads["config.json"]
    assert not list(tmp_path.glob(".whisper-*"))


def test_verified_cache_does_not_download_or_print(model, monkeypatch, tmp_path, capsys):
    _, payloads = model
    for name, value in payloads.items():
        (tmp_path / name).write_bytes(value)
    cn = domestic(monkeypatch, payloads)
    hf = official(monkeypatch, payloads)
    download.download_whisper_model("small", tmp_path)
    assert not cn and not hf and not capsys.readouterr().out


def test_read_only_cache_verifier_checks_content_and_never_downloads(model, monkeypatch, tmp_path, capsys):
    _, payloads = model
    cn = domestic(monkeypatch, payloads)
    hf = official(monkeypatch, payloads)
    missing = tmp_path / "missing"
    assert not download.whisper_model_is_complete("small", missing)
    assert not missing.exists()
    for name, value in payloads.items():
        (tmp_path / name).write_bytes(value)
    assert download.whisper_model_is_complete("small", tmp_path)
    path = tmp_path / "model.bin"
    path.write_bytes(b"x" * len(payloads["model.bin"]))
    assert not download.whisper_model_is_complete("small", tmp_path)
    assert path.read_bytes() == b"x" * len(payloads["model.bin"])
    path.unlink()
    assert not download.whisper_model_is_complete("small", tmp_path)
    assert not download.whisper_model_is_complete("unknown-model", tmp_path)
    assert not download.whisper_model_is_complete(None, tmp_path)
    assert not cn and not hf and not capsys.readouterr().out


@pytest.mark.parametrize("kind", ["hash", "oversize", "truncated", "declared_length"])
def test_bad_domestic_file_is_not_published_and_uses_verified_hf(model, monkeypatch, tmp_path, kind):
    _, payloads = model
    def bad(name):
        value = payloads[name]
        if kind == "hash":
            return Response(b"x" * len(value))
        if kind == "oversize":
            return Response(value + b"extra", length=False)
        if kind == "truncated":
            return Response(value[:-1], length=False)
        response = Response(value)
        response.headers["Content-Length"] = str(len(value) + 1)
        return response
    domestic(monkeypatch, payloads, bad)
    official(monkeypatch, payloads)
    download.download_whisper_model("small", tmp_path)
    assert {path.name: path.read_bytes() for path in tmp_path.iterdir()} == payloads


def test_both_failures_keep_old_file_and_remove_unverified_partials(model, monkeypatch, tmp_path, capsys):
    spec, _ = model
    only = spec.files[-1]
    monkeypatch.setattr(download, "_MODELS", {"small": download.ModelSpec(spec.modelscope_repository, spec.huggingface_repository, spec.huggingface_revision, (only,))})
    target = tmp_path / "model.bin"
    target.write_bytes(b"existing-incomplete-cache")
    class Broken(Response):
        def read(self, _length):
            if self.tell():
                raise ConnectionResetError("private-url-cookie-value")
            return super().read(3)
    domestic(monkeypatch, {"model.bin": b"x" * only.size}, lambda _name: Broken(b"x" * only.size))
    def bad_official(settings):
        path = Path(settings["local_dir"]) / settings["filename"]
        path.write_bytes(b"partial")
        raise httpx.ReadError("private-url-cookie-value")
    official(monkeypatch, {}, bad_official)
    with pytest.raises(download.WhisperModelDownloadError) as failure:
        download.download_whisper_model("small", tmp_path)
    assert target.read_bytes() == b"existing-incomplete-cache"
    assert list(tmp_path.iterdir()) == [target]
    assert "private-url-cookie-value" not in str(failure.value) + capsys.readouterr().out


def test_hf_file_must_pass_the_same_checksum_before_publication(model, monkeypatch, tmp_path):
    _, payloads = model
    def fail(_name):
        raise ConnectionResetError("reset")
    domestic(monkeypatch, payloads, fail)
    official(monkeypatch, {name: b"x" * len(value) for name, value in payloads.items()})
    with pytest.raises(download.WhisperModelDownloadError):
        download.download_whisper_model("small", tmp_path)
    assert not list(tmp_path.iterdir())


@pytest.mark.parametrize("code", [errno.EACCES, errno.ENOSPC, errno.EROFS])
@pytest.mark.parametrize("wrapped", [False, True])
def test_local_storage_errors_never_switch_network_source(model, monkeypatch, tmp_path, capsys, code, wrapped):
    _, payloads = model
    error = OSError(code, "private-path-or-sdk-url")
    if wrapped:
        outer = httpx.ReadError("private-signed-url")
        outer.__cause__ = error
        error = outer
    def fail(_name):
        raise error
    domestic(monkeypatch, payloads, fail)
    hf = official(monkeypatch, payloads)
    with pytest.raises(OSError) as failure:
        download.download_whisper_model("small", tmp_path)
    assert failure.value.errno == code
    assert not hf and not list(tmp_path.iterdir())
    text = str(failure.value) + capsys.readouterr().out
    assert "自动切换" not in text and "private-" not in text


def test_https_redirects_reject_downgrades_and_credentials():
    handler = download._HttpsRedirects()
    for url in ["http://example.invalid/file", "https://name:secret@example.invalid/file", "https://example.invalid:8443/file"]:
        with pytest.raises(download.WhisperModelDownloadError):
            handler.redirect_request(None, None, 302, "", {}, url)


def test_keyboard_interrupt_is_not_converted_into_a_fallback(model, monkeypatch, tmp_path):
    _, payloads = model
    def stop(_name):
        raise KeyboardInterrupt()
    domestic(monkeypatch, payloads, stop)
    hf = official(monkeypatch, payloads)
    with pytest.raises(KeyboardInterrupt):
        download.download_whisper_model("small", tmp_path)
    assert not hf and not list(tmp_path.iterdir())
