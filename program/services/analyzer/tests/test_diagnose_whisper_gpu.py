import builtins
import importlib.util
import json
import subprocess
import sys
from pathlib import Path
from types import ModuleType, SimpleNamespace

import pytest

SCRIPT = Path(__file__).resolve().parents[3] / "scripts/diagnose_whisper_gpu.py"
SPEC = importlib.util.spec_from_file_location("offline_gpu_probe_test", SCRIPT)
probe = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(probe)


def arguments(tmp_path):
    sample = tmp_path / "synthetic.wav"
    sample.write_bytes(b"synthetic fixture")
    return SimpleNamespace(cache=str(tmp_path), model="small", sample=str(sample))


def fake_ct2(monkeypatch, count):
    module = ModuleType("ctranslate2")
    module.get_cuda_device_count = lambda: count
    monkeypatch.setitem(sys.modules, "ctranslate2", module)
    monkeypatch.setattr(probe, "package_versions", lambda: {"ctranslate2": "synthetic-target"})


def local_model(tmp_path):
    folder = tmp_path / "faster-whisper-small"
    folder.mkdir()
    for filename in ("model.bin", "config.json", "tokenizer.json"):
        (folder / filename).write_bytes(b"synthetic fixture")
    return folder


def test_no_gpu_reports_not_tested_and_never_initializes_whisper(monkeypatch, tmp_path):
    fake_ct2(monkeypatch, 0)
    module = ModuleType("faster_whisper")
    module.WhisperModel = lambda *a, **k: pytest.fail("No CUDA device must not invoke a decoder")
    monkeypatch.setitem(sys.modules, "faster_whisper", module)
    result = probe.decode_probe(arguments(tmp_path))
    assert result["status"] == "not_tested"
    assert result["reason"] == "CUDA_DEVICE_UNAVAILABLE"
    assert result["gpu_count"] == 0


def test_success_requires_exhausting_the_cuda_only_local_generator(monkeypatch, tmp_path):
    fake_ct2(monkeypatch, 1)
    folder = local_model(tmp_path)
    calls = []

    class Engine:
        def __init__(self, model, **options):
            calls.append((model, options))

        def transcribe(self, *_args, **_kwargs):
            def generated():
                calls.append("actual decode")
                yield SimpleNamespace(text="中文诊断样本")
            return generated(), None

    module = ModuleType("faster_whisper")
    module.WhisperModel = Engine
    monkeypatch.setitem(sys.modules, "faster_whisper", module)
    result = probe.decode_probe(arguments(tmp_path))
    assert result["status"] == "passed"
    assert calls == [(str(folder), {"device": "cuda", "compute_type": "float16", "cpu_threads": 4, "local_files_only": True}), "actual decode"]


def test_visible_gpu_without_cached_model_does_not_download(monkeypatch, tmp_path):
    fake_ct2(monkeypatch, 1)
    module = ModuleType("faster_whisper")
    module.WhisperModel = lambda *a, **k: pytest.fail("Missing model must not initialize/download")
    monkeypatch.setitem(sys.modules, "faster_whisper", module)
    result = probe.decode_probe(arguments(tmp_path))
    assert result["status"] == "not_tested"
    assert result["reason"] == "LOCAL_MODEL_INCOMPLETE"


def test_old_installation_without_managed_helper_keeps_original_cuda_probe(tmp_path):
    assert probe.managed_cuda_runtime(SimpleNamespace(cache=str(tmp_path), program=str(tmp_path)))["status"] == "missing"


def test_missing_portable_helper_still_produces_a_private_safe_diagnostic(monkeypatch):
    original = builtins.__import__

    def without_helper(name, *args, **kwargs):
        if name in {"gpu_diagnostics", "liming_analyzer.gpu_diagnostics"}:
            raise ModuleNotFoundError("synthetic missing bundle file")
        return original(name, *args, **kwargs)

    monkeypatch.setattr(builtins, "__import__", without_helper)
    result = probe.safe_error(RuntimeError(r"C:\Users\Alice\private api_key=private-value"))
    assert result["code"] == "DIAGNOSTIC_HELPER_UNAVAILABLE"
    assert "Alice" not in json.dumps(result)
    assert "private-value" not in json.dumps(result)


def test_portable_adjacent_helper_is_available_under_isolated_python(tmp_path):
    portable = tmp_path / "diagnose_whisper_gpu.py"
    portable.write_text(SCRIPT.read_text(encoding="utf-8"), encoding="utf-8")
    (tmp_path / "gpu_diagnostics.py").write_text(
        "def gpu_failure_details(error):\n    return {'code': 'ADJACENT_HELPER_LOADED'}\n", encoding="utf-8")
    result = subprocess.run([sys.executable, "-I", str(portable), "--program", str(tmp_path / "missing-checkout")], capture_output=True, text=True, timeout=15, check=False)
    assert result.returncode == 2
    assert json.loads(result.stdout)["error"]["code"] == "ADJACENT_HELPER_LOADED"
    assert "Traceback" not in result.stderr


def parent_fixture(monkeypatch, tmp_path, child_result):
    monkeypatch.setattr(probe.platform, "platform", lambda: "Windows-11-synthetic")
    program = tmp_path / "old-c2fe-checkout"
    (program / "scripts").mkdir(parents=True)
    (program / "scripts/analyzer_local_runtime.py").write_text("# synthetic old helper", encoding="utf-8")
    interpreter = program / "synthetic-target-python.exe"
    interpreter.write_bytes(b"synthetic")
    sample = tmp_path / "asr-check-zh.wav"
    sample.write_bytes(b"synthetic")
    fake_runtime = SimpleNamespace(interpreter=lambda: interpreter, runtime_environment=lambda *, load_configuration: {"ANALYZER_MODEL_CACHE": str(tmp_path), "PATH": "synthetic-path"})
    monkeypatch.setattr(probe.import_util, "spec_from_file_location", lambda *_a: SimpleNamespace(loader=SimpleNamespace(exec_module=lambda module: None)))
    monkeypatch.setattr(probe.import_util, "module_from_spec", lambda *_a: fake_runtime)
    calls = []

    def run(command, **options):
        calls.append((command, options))
        if command[0] == "nvidia-smi":
            raise FileNotFoundError("No GPU driver fixture")
        if isinstance(child_result, Exception):
            raise child_result
        return child_result

    monkeypatch.setattr(probe.subprocess, "run", run)
    args = SimpleNamespace(program=str(program), sample=str(sample), model="small", timeout=30, output=str(tmp_path / "result.json"))
    return args, calls


def test_parent_uses_target_venv_versions_and_no_gpu_is_not_success(monkeypatch, tmp_path):
    child = {"status": "not_tested", "reason": "CUDA_DEVICE_UNAVAILABLE", "python": "3.11-target", "packages": {"torch": "synthetic+cpu", "ctranslate2": "synthetic-ct2"}}
    args, calls = parent_fixture(monkeypatch, tmp_path, SimpleNamespace(returncode=0, stdout="GPU_PROBE_JSON=" + json.dumps(child), stderr=""))
    assert probe.run_diagnostic(args) == 2
    report = json.loads(Path(args.output).read_text(encoding="utf-8"))
    assert report["python"] == "3.11-target"
    assert report["torch"] == "synthetic+cpu"
    assert report["probe"]["status"] == "not_tested"
    assert len(calls) == 2
    _, child_options = calls[-1]
    assert calls[-1][0][calls[-1][0].index("--program") + 1] == args.program
    assert child_options["timeout"] == 30
    assert child_options["env"]["HF_HUB_OFFLINE"] == "1"
    assert child_options["env"]["TRANSFORMERS_OFFLINE"] == "1"


@pytest.mark.parametrize("stdout,code", [("", 1), ("GPU_PROBE_JSON=null", 0), ("GPU_PROBE_JSON={broken", 0), ('GPU_PROBE_JSON={"status":"passed"}', 7)])
def test_child_crash_or_invalid_result_cannot_be_reported_as_gpu_success(monkeypatch, tmp_path, stdout, code):
    args, _ = parent_fixture(monkeypatch, tmp_path, SimpleNamespace(returncode=code, stdout=stdout, stderr="synthetic native crash"))
    assert probe.run_diagnostic(args) == 2
    assert json.loads(Path(args.output).read_text(encoding="utf-8"))["probe"]["status"] == "failed"


def test_child_timeout_returns_a_bounded_not_tested_report(monkeypatch, tmp_path):
    args, _ = parent_fixture(monkeypatch, tmp_path, subprocess.TimeoutExpired(["synthetic"], 30))
    assert probe.run_diagnostic(args) == 2
    result = json.loads(Path(args.output).read_text(encoding="utf-8"))["probe"]
    assert result == {"status": "not_tested", "reason": "GPU_PROBE_TIMEOUT", "timeout_seconds": 30}


def test_windows_inventory_is_bounded_named_and_profile_private(monkeypatch, tmp_path):
    monkeypatch.setattr(probe.sys, "platform", "win32")
    profile = tmp_path / "Custom Profiles/Alice Smith 中文"
    venv = profile / "venv"
    pair = venv / "Lib/site-packages/nvidia/cublas/bin"
    pair.mkdir(parents=True)
    for name in probe.CUDA_DLLS[:2]:
        (pair / name).write_bytes(b"dll fixture")
    (pair / "private-unrelated.dll").write_bytes(b"unrelated")
    monkeypatch.setattr(probe.sys, "prefix", str(venv))
    monkeypatch.setenv("USERPROFILE", str(profile))
    private_directory = tmp_path / "PrivateClientProject-secret-folder"
    monkeypatch.setenv("PATH", str(pair) + probe.os.pathsep + str(private_directory))
    monkeypatch.setenv("AZURE_OPENAI_API_KEY", "SECRET_SENTINEL_DO_NOT_READ")
    monkeypatch.setattr(probe, "package_versions", lambda: {"nvidia-cublas-cu12": "12.8.4.1"})
    inventory, candidates = probe.cuda_dll_inventory()
    assert inventory["status"] == "found" and candidates == [pair]
    assert inventory["packages"]["nvidia-cublas-cu12"] == "12.8.4.1"
    exported = json.dumps(inventory, ensure_ascii=False)
    assert "Alice Smith" not in exported and "SECRET_SENTINEL" not in exported and "private-unrelated" not in exported
    assert "PrivateClientProject-secret-folder" not in exported
    assert all({row["name"] for row in directory["dlls"]} == set(probe.CUDA_DLLS) for directory in inventory["directories"])


def test_inventory_reports_missing_pair_without_attempting_install(monkeypatch, tmp_path):
    monkeypatch.setattr(probe.sys, "platform", "win32")
    monkeypatch.setattr(probe.sys, "prefix", str(tmp_path))
    monkeypatch.setenv("PATH", "")
    monkeypatch.setattr(probe, "package_versions", dict)
    inventory, candidates = probe.cuda_dll_inventory()
    assert inventory["status"] == "missing" and candidates == []


def test_loader_trials_are_fresh_bounded_and_use_candidate_indexes(monkeypatch, tmp_path):
    calls = []
    def run(command, **options):
        calls.append((command, options))
        return SimpleNamespace(returncode=0, stdout='DLL_PROBE_JSON={"status":"loaded"}', stderr="")
    monkeypatch.setattr(probe.subprocess, "run", run)
    args = SimpleNamespace(program=str(tmp_path / "real-program"))
    result = probe.dll_load_trials(args, 3, interpreter="target-python", environment={"fixture": "target"})
    assert len(calls) == 4 and len(result) == 4
    assert [command[-1] for command, _ in calls] == ["bare", "absolute", "bare", "absolute"]
    assert all(command[command.index("--program") + 1] == args.program for command, _ in calls)
    assert all(0 < options["timeout"] <= 10 for _, options in calls)
    assert all(command[0] == "target-python" and "--dll-directory" not in command for command, _ in calls)
    assert all(options["env"] == {"fixture": "target"} for _, options in calls)


@pytest.mark.parametrize("failure", [subprocess.TimeoutExpired(["fixture"], 10), SimpleNamespace(returncode=7, stdout='DLL_PROBE_JSON={"status":"loaded"}', stderr="")])
def test_loader_timeout_or_crash_cannot_claim_loaded(monkeypatch, tmp_path, failure):
    def run(*_args, **_options):
        if isinstance(failure, Exception):
            raise failure
        return failure
    monkeypatch.setattr(probe.subprocess, "run", run)
    results = probe.dll_load_trials(SimpleNamespace(program=str(tmp_path)), 1)
    assert len(results) == 2 and all(row["status"] != "loaded" for row in results)


def test_loader_total_budget_stops_additional_children(monkeypatch, tmp_path):
    ticks = iter([0, 31])
    monkeypatch.setattr(probe.time, "monotonic", lambda: next(ticks))
    monkeypatch.setattr(probe.subprocess, "run", lambda *_a, **_k: pytest.fail("budget already expired"))
    assert probe.dll_load_trials(SimpleNamespace(program=str(tmp_path)), 1) == [
        {"status": "not_tested", "reason": "DLL_LOAD_BUDGET_EXHAUSTED"}]


def test_native_loader_error_keeps_winerror_and_redacts_custom_profile(monkeypatch, tmp_path):
    profile = str(tmp_path / "People/Alice Smith")
    monkeypatch.setenv("USERPROFILE", profile)
    error = OSError(126, profile + "/cublas64_12.dll could not load")
    error.winerror = 126
    result = probe.dll_error(error)
    assert result["winerror"] == 126
    assert "Alice Smith" not in json.dumps(result)


def test_loader_tail_timeout_preserves_completed_original_gpu_failure(monkeypatch, tmp_path):
    baseline = {"status": "failed", "code": "CUDA_LIBRARY_UNAVAILABLE", "detail": "original cublas failure"}
    expired = subprocess.TimeoutExpired(["fixture"], 30, output=("GPU_BASELINE_JSON=" + json.dumps(baseline)).encode())
    args, _ = parent_fixture(monkeypatch, tmp_path, expired)
    assert probe.run_diagnostic(args) == 2
    result = json.loads(Path(args.output).read_text())["probe"]
    assert result["code"] == baseline["code"] and result["detail"] == baseline["detail"]
    assert result["dll_load_trials"][0]["reason"] == "DLL_LOAD_DIAGNOSTIC_TIMEOUT"


@pytest.mark.parametrize("mode", ["bare", "absolute"])
@pytest.mark.parametrize("path_style", ["native", "windows"])
def test_loader_uses_legacy_bare_or_safe_absolute_and_reports_actual_location(monkeypatch, tmp_path, mode, path_style):
    import ctypes
    monkeypatch.setattr(probe.sys, "platform", "win32")
    monkeypatch.delenv("CUDA_PATH", raising=False)
    calls, closed = [], []
    loaded_path = str(tmp_path / "actual/cublas.dll") if path_style == "native" else r"C:\CUDA\actual\cublas.dll"
    def actual_path(_handle, buffer, _size):
        buffer.value = loaded_path
        return len(buffer.value)
    kernel = SimpleNamespace(GetModuleFileNameW=actual_path)
    def load(name, **options):
        if name == "kernel32":
            return kernel
        calls.append((name, options["winmode"]))
        return SimpleNamespace(_handle=123)
    monkeypatch.setattr(ctypes, "WinDLL", load, raising=False)
    monkeypatch.setattr(probe.os, "add_dll_directory", lambda path: SimpleNamespace(close=lambda: closed.append(path)), raising=False)
    result = probe.dll_load_probe(SimpleNamespace(dll_directory=str(tmp_path), dll_load_mode=mode))
    assert result["status"] == "loaded" and len(result["loads"]) == 2
    assert all(row["actual_path"].replace("\\", "/").endswith("actual/cublas.dll") for row in result["loads"])
    assert [value for _, value in calls] == ([0, 0] if mode == "bare" else [0x1100, 0x1100])
    assert [Path(name).is_absolute() for name, _ in calls] == [mode == "absolute"] * 2
    assert len(closed) == (mode == "absolute")


@pytest.mark.parametrize("code", [126, 193])
def test_actual_loader_function_exports_native_winerror(monkeypatch, tmp_path, code):
    import ctypes
    monkeypatch.setattr(probe.sys, "platform", "win32")
    monkeypatch.delenv("CUDA_PATH", raising=False)
    def actual_path(*_args):
        return 1
    def load(name, **_options):
        if name == "kernel32":
            return SimpleNamespace(GetModuleFileNameW=actual_path)
        error = OSError(code, "synthetic dependency/architecture failure")
        error.winerror = code
        raise error
    monkeypatch.setattr(ctypes, "WinDLL", load, raising=False)
    result = probe.dll_load_probe(SimpleNamespace(dll_directory=str(tmp_path), dll_load_mode="bare"))
    assert result["status"] == "failed"
    assert result["loads"][0]["error"]["winerror"] == code


def test_baseline_child_has_no_nested_loader_processes(monkeypatch, tmp_path):
    monkeypatch.setattr(probe, "cuda_dll_inventory", lambda: ({"status": "found", "candidate_count": 1}, [tmp_path]))
    monkeypatch.setattr(probe, "decode_probe", lambda _args: {"status": "failed", "code": "CUDA_LIBRARY_UNAVAILABLE"})
    monkeypatch.setattr(probe.subprocess, "run", lambda *_a, **_k: pytest.fail("GPU child must not create grandchildren"))
    result = probe.child_diagnostic(SimpleNamespace(program=str(tmp_path)))
    assert result["status"] == "failed" and result["dll_inventory"]["candidate_count"] == 1
    assert "dll_load_trials" not in result


def test_report_parent_keeps_baseline_after_direct_loader_children_timeout(monkeypatch, tmp_path):
    baseline = {"status": "failed", "code": "CUDA_LIBRARY_UNAVAILABLE", "detail": "original cublas failure",
                "dll_inventory": {"candidate_count": 1}}
    args, calls = parent_fixture(monkeypatch, tmp_path, SimpleNamespace(returncode=0, stdout="GPU_PROBE_JSON=" + json.dumps(baseline), stderr=""))
    baseline_run = probe.subprocess.run
    def run(command, **options):
        if "--child-dll-load" in command:
            calls.append((command, options))
            raise subprocess.TimeoutExpired(command, options["timeout"])
        return baseline_run(command, **options)
    monkeypatch.setattr(probe.subprocess, "run", run)
    assert probe.run_diagnostic(args) == 2
    result = json.loads(Path(args.output).read_text())["probe"]
    assert result["status"] == "failed" and result["detail"] == baseline["detail"]
    assert len(result["dll_load_trials"]) == 2
    baseline_calls = [(cmd, opt) for cmd, opt in calls if "--child" in cmd]
    loader_calls = [(cmd, opt) for cmd, opt in calls if "--child-dll-load" in cmd]
    assert len(baseline_calls) == 1 and len(loader_calls) == 2
    for command, options in loader_calls:
        assert command[0] == baseline_calls[0][0][0]
        assert options["env"] == baseline_calls[0][1]["env"]
        assert Path(options["cwd"]) == Path(args.program)
        assert command[command.index("--candidate-index") + 1] == "0"


def test_loader_candidate_recomputes_inventory_and_never_falls_back(monkeypatch, tmp_path):
    monkeypatch.setattr(probe.sys, "platform", "win32")
    monkeypatch.setattr(probe, "cuda_dll_inventory", lambda: ({"status": "missing"}, []))
    result = probe.dll_load_probe(SimpleNamespace(candidate_index=1, dll_directory=str(tmp_path)))
    assert result == {"status": "not_tested", "reason": "DLL_CANDIDATE_NO_LONGER_AVAILABLE", "candidate_index": 1}


def test_inventory_rejects_unc_and_device_paths_before_any_scan(monkeypatch, tmp_path):
    monkeypatch.setattr(probe.sys, "platform", "win32")
    monkeypatch.setattr(probe.sys, "prefix", str(tmp_path))
    monkeypatch.setenv("PATH", "//private-server/private-share")
    monkeypatch.setenv("CUDA_PATH", r"\\private-server\private-share")
    monkeypatch.setenv("CUDA_PATH_V12_8", r"\\?\C:\private-device")
    monkeypatch.setenv("ProgramFiles", "//private-server/programs")
    monkeypatch.setattr(probe, "package_versions", dict)
    real_is_file, real_glob = Path.is_file, Path.glob
    def is_file(path):
        assert "private-server" not in str(path) and "private-device" not in str(path)
        return real_is_file(path)
    def glob(path, pattern):
        assert "private-server" not in str(path)
        return real_glob(path, pattern)
    monkeypatch.setattr(Path, "is_file", is_file)
    monkeypatch.setattr(Path, "glob", glob)
    result, candidates = probe.cuda_dll_inventory()
    assert not candidates and result["network_or_device_paths_omitted"] >= 4
    assert "private-server" not in json.dumps(result) and "private-device" not in json.dumps(result)
