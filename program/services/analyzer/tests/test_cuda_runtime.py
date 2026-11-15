import ctypes
import hashlib
import json
import os
import subprocess
import sys
from pathlib import Path
from types import SimpleNamespace

import pytest

from liming_analyzer import cuda_runtime as runtime
from liming_analyzer.faster_whisper_asr import FasterWhisperSpeechRecognizer


def prepared_runtime(tmp_path):
    cache = tmp_path / "models"
    directory = runtime.runtime_directory(cache)
    (directory / "bin").mkdir(parents=True)
    files = {}
    for name in runtime.REQUIRED_DLLS:
        data = ("synthetic:" + name).encode()
        (directory / "bin" / name).write_bytes(data)
        files[name] = {"size_bytes": len(data), "sha256": hashlib.sha256(data).hexdigest()}
    receipt = {"schema": runtime.CUDA_RUNTIME_SPEC["schema"], "archives": {
        name: {key: record[key] for key in ("version", "sha256")}
        for name, record in runtime.CUDA_RUNTIME_SPEC["archives"].items()}, "files": files}
    (directory / "receipt.json").write_text(json.dumps(receipt))
    return cache, directory, receipt


@pytest.fixture(autouse=True)
def isolated_module_state(monkeypatch):
    monkeypatch.setattr(runtime, "_hashes", {})
    monkeypatch.setattr(runtime, "_active", {})
    monkeypatch.setattr(runtime, "_libraries", [])
    monkeypatch.setattr(runtime, "_directory_handles", [])


def test_missing_runtime_is_read_only_and_ready_requires_all_verified_files(tmp_path):
    cache = tmp_path / "models"
    assert runtime.validate_runtime(cache)["status"] == "missing"
    assert not runtime.runtime_directory(cache).exists()
    cache, directory, _ = prepared_runtime(tmp_path)
    state = runtime.validate_runtime(cache)
    assert state["status"] == "ready" and set(state["files"]) == set(runtime.REQUIRED_DLLS)
    assert directory == tmp_path / "cuda-runtime/cuda12-12.8.4.1"


def test_module_loads_standalone_before_any_analyzer_dependencies_are_installed(tmp_path):
    code = "import runpy,sys; m=runpy.run_path(sys.argv[1]); print(m['validate_runtime'](sys.argv[2])['status']); assert 'httpx' not in sys.modules"
    result = subprocess.run([sys.executable, "-I", "-S", "-B", "-c", code, runtime.__file__, str(tmp_path / "models")],
                            capture_output=True, text=True, timeout=10, check=False)
    assert result.returncode == 0, result.stderr
    assert result.stdout.strip() == "missing" and not runtime.runtime_directory(tmp_path / "models").exists()


@pytest.mark.parametrize("change", ["schema", "archive_version", "archive_hash", "file_hash", "file_size", "traversal", "missing_file", "bool_size"])
def test_receipt_or_dll_corruption_cannot_be_ready(tmp_path, change):
    cache, directory, receipt = prepared_runtime(tmp_path)
    name = runtime.REQUIRED_DLLS[0]
    if change == "schema":
        receipt["schema"] = "other"
    elif change == "archive_version":
        receipt["archives"]["cublas"]["version"] = "13"
    elif change == "archive_hash":
        receipt["archives"]["cudart"]["sha256"] = "0" * 64
    elif change == "file_hash":
        receipt["files"][name]["sha256"] = "0" * 64
    elif change == "file_size":
        receipt["files"][name]["size_bytes"] += 1
    elif change == "traversal":
        receipt["files"]["../" + name] = receipt["files"].pop(name)
    elif change == "missing_file":
        (directory / "bin" / name).unlink()
    else:
        receipt["files"][name]["size_bytes"] = True
    (directory / "receipt.json").write_text(json.dumps(receipt))
    assert runtime.validate_runtime(cache)["status"] == "invalid"


def test_hash_cache_reuses_verified_files_and_rechecks_changed_files(tmp_path, monkeypatch):
    cache, directory, _ = prepared_runtime(tmp_path)
    original = runtime.hashlib.sha256
    calls = []
    def digest():
        calls.append(True)
        return original()
    monkeypatch.setattr(runtime.hashlib, "sha256", digest)
    assert runtime.validate_runtime(cache)["status"] == "ready"
    assert runtime.validate_runtime(cache)["status"] == "ready" and len(calls) == 3
    file = directory / "bin" / runtime.REQUIRED_DLLS[0]
    stat = file.stat()
    file.write_bytes(b"x" * stat.st_size)
    os.utime(file, ns=(stat.st_atime_ns, stat.st_mtime_ns + 1000000))
    assert runtime.validate_runtime(cache)["status"] == "invalid" and len(calls) == 4


def test_a_receipted_dll_symlink_cannot_escape_managed_root(tmp_path):
    cache, directory, _ = prepared_runtime(tmp_path)
    file = directory / "bin" / runtime.REQUIRED_DLLS[0]
    outside = tmp_path / "outside.dll"
    outside.write_bytes(file.read_bytes())
    file.unlink()
    try:
        file.symlink_to(outside)
    except OSError:
        pytest.skip("symlink creation needs local privileges")
    assert runtime.validate_runtime(cache)["status"] == "invalid"


def fake_windows_loader(monkeypatch, *, fail=None, wrong_location=None, preloaded=None):
    monkeypatch.setattr(runtime.sys, "platform", "win32")
    calls, handles, directories = [], {}, []
    def module_path(handle, buffer, _size):
        buffer.value = str(wrong_location or handles[handle])
        return len(buffer.value)
    def existing_module(name):
        if preloaded and name == runtime.REQUIRED_DLLS[0]:
            handles[999] = preloaded
            return 999
        return 0
    kernel = SimpleNamespace(GetModuleFileNameW=module_path, GetModuleHandleW=existing_module)
    def load(path, **options):
        if path == "kernel32":
            return kernel
        calls.append((path, options))
        if Path(path).name == fail:
            raise OSError(126, "synthetic missing CUDA dependency")
        handle = len(handles) + 1
        handles[handle] = Path(path)
        return SimpleNamespace(_handle=handle)
    def add(path):
        directory = SimpleNamespace(path=path, closed=False)
        directory.close = lambda: setattr(directory, "closed", True)
        directories.append(directory)
        return directory
    monkeypatch.setattr(ctypes, "WinDLL", load, raising=False)
    monkeypatch.setattr(runtime.os, "add_dll_directory", add, raising=False)
    return calls, directories


def test_activation_loads_only_verified_absolute_dlls_in_order_and_keeps_handles(tmp_path, monkeypatch):
    cache, directory, _ = prepared_runtime(tmp_path)
    calls, directories = fake_windows_loader(monkeypatch)
    monkeypatch.setenv("PATH", "existing-path")
    state = runtime.activate_windows_cuda(cache)
    assert state["status"] == "ready" and list(state["loaded_paths"]) == list(runtime.REQUIRED_DLLS)
    assert [Path(path).name for path, _ in calls] == list(runtime.REQUIRED_DLLS)
    assert all(Path(path).is_absolute() and options["winmode"] == 0x1100 for path, options in calls)
    assert os.environ["PATH"] == str(directory / "bin") + os.pathsep + "existing-path"
    assert len(runtime._libraries) == 3 and runtime._directory_handles == directories and not directories[0].closed
    assert runtime.activate_windows_cuda(cache) == state and len(calls) == 3


@pytest.mark.parametrize("failure", ["dependency", "loaded_path", "preexisting_basename"])
def test_failed_activation_restores_path_and_cannot_claim_ready(tmp_path, monkeypatch, failure):
    cache, _, _ = prepared_runtime(tmp_path)
    outside = tmp_path / "other.dll"
    outside.write_bytes(b"other")
    _, directories = fake_windows_loader(monkeypatch, fail=runtime.REQUIRED_DLLS[1] if failure == "dependency" else None,
                                         wrong_location=outside if failure == "loaded_path" else None,
                                         preloaded=outside if failure == "preexisting_basename" else None)
    monkeypatch.setenv("PATH", "original-path")
    with pytest.raises(RuntimeError, match="CUDA"):
        runtime.activate_windows_cuda(cache)
    assert os.environ["PATH"] == "original-path" and directories[0].closed and not runtime._active


def test_non_windows_or_missing_runtime_never_loads_or_changes_environment(tmp_path, monkeypatch):
    monkeypatch.setenv("PATH", "unchanged")
    monkeypatch.setattr(ctypes, "WinDLL", lambda *_a, **_k: pytest.fail("no DLL loads expected"), raising=False)
    monkeypatch.setattr(runtime.sys, "platform", "darwin")
    assert runtime.activate_windows_cuda(tmp_path)["status"] == "not_applicable"
    monkeypatch.setattr(runtime.sys, "platform", "win32")
    assert runtime.activate_windows_cuda(tmp_path)["status"] == "missing"
    assert os.environ["PATH"] == "unchanged" and not runtime.runtime_directory(tmp_path).exists()


@pytest.mark.parametrize("platform,device,expected", [("win32", "cpu", False), ("darwin", "cuda", False), ("win32", "cuda", True)])
def test_faster_whisper_only_activates_managed_runtime_for_windows_cuda(tmp_path, monkeypatch, platform, device, expected):
    monkeypatch.setattr(runtime.sys, "platform", platform)
    activations = []
    monkeypatch.setattr(runtime, "activate_windows_cuda", lambda cache: activations.append(cache) or {"status": "ready"})
    engine = object()
    monkeypatch.setitem(sys.modules, "faster_whisper", SimpleNamespace(WhisperModel=lambda *_a, **_k: engine))
    recognizer = FasterWhisperSpeechRecognizer(model_cache=tmp_path, engine=object())
    assert recognizer._load_engine(device) is engine
    assert bool(activations) is expected


def test_invalid_managed_runtime_retains_existing_auto_cpu_fallback(tmp_path, monkeypatch):
    monkeypatch.setattr(runtime.sys, "platform", "win32")
    folder = tmp_path / "faster-whisper-small"
    folder.mkdir()
    for name in ("model.bin", "config.json", "tokenizer.json"):
        (folder / name).write_bytes(b"fixture")
    monkeypatch.setitem(sys.modules, "ctranslate2", SimpleNamespace(get_cuda_device_count=lambda: 1))
    monkeypatch.setitem(sys.modules, "faster_whisper.utils", SimpleNamespace(download_model=lambda **_kw: pytest.fail("no downloads")))
    devices = []
    monkeypatch.setitem(sys.modules, "faster_whisper", SimpleNamespace(WhisperModel=lambda *_a, **kw: devices.append(kw["device"]) or object()))
    def invalid(_cache):
        raise RuntimeError("CUDA managed runtime validation failed")
    monkeypatch.setattr(runtime, "activate_windows_cuda", invalid)
    recognizer = FasterWhisperSpeechRecognizer(model_cache=tmp_path, device="auto")
    assert devices == ["cpu"] and recognizer.device == "cpu"
    assert recognizer.last_gpu_failure and recognizer.runtime_state["cuda_runtime"]["status"] == "failed"
    with pytest.raises(RuntimeError, match="CUDA"):
        FasterWhisperSpeechRecognizer(model_cache=tmp_path, device="cuda")
