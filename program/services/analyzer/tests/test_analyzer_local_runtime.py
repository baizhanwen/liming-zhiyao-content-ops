import importlib.util
import json
import os
import subprocess
import time
from pathlib import Path
from types import SimpleNamespace


def runtime_module():
    path = Path(__file__).resolve().parents[3] / "scripts/analyzer_local_runtime.py"
    spec = importlib.util.spec_from_file_location("analyzer_local_runtime_test", path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def isolate(module, tmp_path, monkeypatch):
    monkeypatch.setattr(module, "ROOT", tmp_path)
    monkeypatch.setattr(module, "LOCAL", tmp_path / ".local")
    monkeypatch.setattr(module, "ANALYZER", tmp_path / "services/analyzer")
    monkeypatch.setattr(module, "PID_FILE", tmp_path / ".local/analyzer-local.json")


def test_runtime_does_not_inherit_other_project_configuration(tmp_path, monkeypatch):
    module = runtime_module()
    isolate(module, tmp_path, monkeypatch)
    monkeypatch.setenv("ANALYZER_LLM_API_KEY", "other-project-key")
    monkeypatch.setenv("HF_TOKEN", "other-project-hf-key")
    monkeypatch.setenv("PYTHONPATH", "/other/project")
    monkeypatch.setenv("PADDLE_PDX_CACHE_HOME", "/other/cache")
    env = module.runtime_environment(load_configuration=False)
    assert "ANALYZER_LLM_API_KEY" not in env and "HF_TOKEN" not in env
    assert env["PYTHONPATH"] == str(tmp_path / "services/analyzer")
    for key in ("PADDLE_PDX_CACHE_HOME", "MODELSCOPE_CACHE", "HF_HOME", "TORCH_HOME", "XDG_CACHE_HOME", "PLAYWRIGHT_BROWSERS_PATH"):
        assert Path(env[key]).is_relative_to(tmp_path)


def test_ready_setup_is_idempotent_even_with_running_worker(monkeypatch, capsys):
    module = runtime_module()
    monkeypatch.setattr(module, "readiness_snapshot", lambda: {"ready": True, "workerRunning": True, "checks": [], "missing": []})
    monkeypatch.setattr(module, "resolve_media_tools", lambda *_args: {"ffmpeg": "fixture-ffmpeg", "ffprobe": "fixture-ffprobe"})
    monkeypatch.setattr(module, "_test_media_binary", lambda _path: True)
    monkeypatch.setattr(module.subprocess, "run", lambda *_args, **_kwargs: (_ for _ in ()).throw(AssertionError("ready setup must not reinstall")))
    assert module.setup() == 0
    result = json.loads(capsys.readouterr().out)
    assert result["alreadyPrepared"] and result["alreadyRunning"]


def test_missing_uv_is_bootstrapped_inside_project(tmp_path, monkeypatch, capsys):
    module = runtime_module()
    isolate(module, tmp_path, monkeypatch)
    module.LOCAL.mkdir()
    snapshots = iter([{"ready": False, "workerRunning": False}, {"ready": True, "workerRunning": False, "missing": []}])
    monkeypatch.setattr(module, "readiness_snapshot", lambda: next(snapshots))
    monkeypatch.setattr(module, "active_process", lambda: None)
    monkeypatch.setattr(module.shutil, "which", lambda name, **_kwargs: "/fixture/npm" if name in {"npm", "npm.cmd"} else None)
    monkeypatch.setattr(module, "runtime_environment", lambda **_kwargs: {})
    created = []
    class Builder:
        def __init__(self, **_kwargs):
            pass
        def create(self, path):
            created.append(Path(path))
            Path(path).mkdir(parents=True)
    monkeypatch.setattr(module.venv, "EnvBuilder", Builder)
    commands = []
    def run(command, **_kwargs):
        commands.append(command)
        if "--target" in command:
            destination = Path(command[command.index("--target") + 1])
            executable = destination / "bin" / ("uv.exe" if module.os.name == "nt" else "uv")
            executable.parent.mkdir(parents=True)
            executable.write_text("fixture")
            executable.chmod(0o700)
        return SimpleNamespace(returncode=0)
    monkeypatch.setattr(module.subprocess, "run", run)
    assert module.setup() == 0
    assert created == [tmp_path / ".local/installer-venv"]
    assert commands[0][commands[0].index("--target") + 1] == str(tmp_path / ".local/installer-tools")
    assert commands[1][0] == str(tmp_path / ".local/installer-tools/bin" / ("uv.exe" if module.os.name == "nt" else "uv"))
    assert json.loads(capsys.readouterr().out.splitlines()[-1])["ready"]


def test_recorded_project_media_tools_restore_worker_path_without_parent_process_reload(tmp_path, monkeypatch):
    module = runtime_module()
    isolate(module, tmp_path, monkeypatch)
    module.LOCAL.mkdir()
    binaries = module.LOCAL / "media-tools/node_modules/fixture-platform"
    binaries.mkdir(parents=True)
    suffix = ".exe" if module.os.name == "nt" else ""
    for name in ("ffmpeg", "ffprobe"):
        path = binaries / (name + suffix)
        path.write_text("synthetic binary fixture")
        path.chmod(0o700)
    (module.LOCAL / "ffmpeg.path").write_text(str(binaries) + "\n")
    monkeypatch.setattr(module.shutil, "which", lambda *_args, **_kwargs: None)
    env = module.runtime_environment(load_configuration=False)
    assert env["ANALYZER_FFMPEG"] == str((binaries / ("ffmpeg" + suffix)).resolve())
    assert env["ANALYZER_FFPROBE"] == str((binaries / ("ffprobe" + suffix)).resolve())
    assert str(binaries) in env["PATH"].split(module.os.pathsep)


def test_missing_media_tools_install_only_from_locked_project_manifest(tmp_path, monkeypatch, capsys):
    module = runtime_module()
    isolate(module, tmp_path, monkeypatch)
    resources = tmp_path / "resources/media-tools"
    resources.mkdir(parents=True)
    (resources / "package.json").write_text('{"private":true}')
    (resources / "package-lock.json").write_text('{"lockfileVersion":3}')
    monkeypatch.setattr(module, "runtime_environment", lambda **_kwargs: {})
    monkeypatch.setattr(module.shutil, "which", lambda name, **_kwargs: "/fixture/" + name if name in {"npm", "npm.cmd", "node"} else None)
    folder = module.LOCAL / "media-tools"
    bin_dir = folder / "node_modules/fixture-platform"
    suffix = ".exe" if module.os.name == "nt" else ""
    pair = {name: str(bin_dir / (name + suffix)) for name in ("ffmpeg", "ffprobe")}
    commands = []
    def run(command, **_kwargs):
        commands.append(command)
        if "ci" in command:
            bin_dir.mkdir(parents=True)
            for path in pair.values():
                Path(path).write_text("synthetic executable fixture")
            return SimpleNamespace(returncode=0)
        if "-e" in command:
            return SimpleNamespace(returncode=0, stdout=json.dumps(pair))
        return SimpleNamespace(returncode=0)
    monkeypatch.setattr(module.subprocess, "run", run)
    assert module.install_media_packages() == 0
    assert commands[0][1:] == ["ci", "--prefix", str(folder), "--omit=dev", "--no-audit", "--no-fund"]
    assert (folder / "package-lock.json").read_text() == (resources / "package-lock.json").read_text()
    assert json.loads((module.LOCAL / "media-tools.json").read_text())["ffmpeg"] == pair["ffmpeg"]
    assert (module.LOCAL / "ffmpeg.path").read_text().strip() == str(bin_dir)
    assert all(Path(path).is_relative_to(tmp_path) for path in pair.values())
    assert json.loads(capsys.readouterr().out)["ready"]


def test_setup_pins_uv_to_own_environment_and_selected_python(tmp_path, monkeypatch, capsys):
    module = runtime_module()
    isolate(module, tmp_path, monkeypatch)
    for key, value in {
        "UV_PROJECT_ENVIRONMENT": "/another/project/venv",
        "UV_CACHE_DIR": "/another/cache",
        "UV_PYTHON": "/another/python",
        "UV_CONFIG_FILE": "/another/uv.toml",
        "UV_NO_SYNC": "1",
        "UV_PYTHON_DOWNLOADS": "automatic",
        "PYTHONIOENCODING": "ascii",
        "PYTHONUTF8": "0",
    }.items():
        monkeypatch.setenv(key, value)
    snapshots = iter([{"ready": False, "workerRunning": False}, {"ready": True, "workerRunning": False}])
    monkeypatch.setattr(module, "readiness_snapshot", lambda: next(snapshots))
    monkeypatch.setattr(module, "active_process", lambda: None)
    monkeypatch.setattr(module.shutil, "which", lambda name, **_kwargs: "/fixture/" + name if name in {"uv", "npm", "npm.cmd"} else None)
    monkeypatch.setattr(module, "resolve_media_tools", lambda *_args: {"ffmpeg": "/fixture/ffmpeg", "ffprobe": "/fixture/ffprobe"})
    monkeypatch.setattr(module, "_test_media_binary", lambda _path: True)
    calls = []
    def run(command, *, env, cwd, **_kwargs):
        calls.append((command, env.copy(), cwd))
        return SimpleNamespace(returncode=0)
    monkeypatch.setattr(module.subprocess, "run", run)
    assert module.setup() == 0
    command, env, cwd = calls[0]
    assert cwd == module.ANALYZER
    assert command[:4] == ["/fixture/uv", "sync", "--no-config", "--locked"]
    assert command[command.index("--python") + 1] == str(Path(module.sys.executable).resolve())
    assert {key: value for key, value in env.items() if key.startswith("UV_")} == {
        "UV_CACHE_DIR": str(module.LOCAL / "uv-cache"),
        "UV_PROJECT_ENVIRONMENT": str(module.ANALYZER / ".venv"),
        "UV_PYTHON": str(Path(module.sys.executable).resolve()),
        "UV_PYTHON_DOWNLOADS": "never",
        "UV_NO_CONFIG": "1",
    }
    for _command, subprocess_env, _cwd in calls:
        assert subprocess_env["PYTHONIOENCODING"] == "utf-8"
        assert subprocess_env["PYTHONUTF8"] == "1"
    assert calls[-1][0] == [str(module.interpreter()), str(module.ROOT / "scripts/prepare_analyzer_models.py")]
    assert json.loads(capsys.readouterr().out.splitlines()[-1])["ready"]


def test_worker_and_model_records_round_trip_utf8_paths(tmp_path, monkeypatch):
    module = runtime_module()
    isolate(module, tmp_path / "中文安装目录", monkeypatch)
    monkeypatch.setenv("PROGRAMDATA", str(tmp_path / "programdata"))
    cache = module.model_cache_path()
    cache.mkdir(parents=True)
    (module.LOCAL / "model-cache").mkdir(parents=True, exist_ok=True)
    (module.ROOT / ".dev.vars").write_text("ANALYZER_ASR_MODEL=small\n", encoding="utf-8")
    model = cache / "语音模型.bin"
    model.write_bytes(b"fixture-model")
    model_record = module.LOCAL / "model-cache/models-ready.json"
    model_record.write_text(json.dumps({"modelsReady": True, "asr": "faster-whisper/small", "requiredFiles": [{"path": model.name, "size": model.stat().st_size}], "message": "模型已准备"}, ensure_ascii=False), encoding="utf-8")
    record = {"pid": 424242, "project": str(module.ROOT), "log": str(module.LOCAL / "中文日志.log")}
    module.PID_FILE.write_text(json.dumps(record, ensure_ascii=False), encoding="utf-8")
    if module.os.name == "nt":
        controller_calls = []
        def controller(action, base_url=None):
            controller_calls.append((action, base_url))
            return 0, {"workerRunning": True, "processRunning": True, "pid": record["pid"]}
        monkeypatch.setattr(module, "windows_control", controller)
        monkeypatch.setattr(module.os, "kill", lambda *_args: (_ for _ in ()).throw(AssertionError("Windows status must not signal a PID")))
        expected_process = {"pid": record["pid"]}
        expected_reads = {model_record}
    else:
        monkeypatch.setattr(module.os, "kill", lambda *_args: None)
        monkeypatch.setattr(module.subprocess, "check_output", lambda *_args, **_kwargs: f"{module.interpreter()} -m liming_analyzer")
        expected_process = record
        expected_reads = {module.PID_FILE, model_record}
    original_read = Path.read_text
    reads = []
    def read(path, *args, **kwargs):
        if path in {module.PID_FILE, model_record}:
            assert kwargs.get("encoding") == "utf-8"
            reads.append(path)
        return original_read(path, *args, **kwargs)
    monkeypatch.setattr(Path, "read_text", read)
    assert module.active_process() == expected_process
    snapshot = module.readiness_snapshot()
    assert snapshot["modelsReady"] and snapshot["workerRunning"]
    assert set(reads) == expected_reads
    if module.os.name == "nt":
        assert controller_calls == [("status", None), ("status", None)]


def windows_ready_fixture(tmp_path, monkeypatch):
    module = runtime_module()
    isolate(module, tmp_path, monkeypatch)
    monkeypatch.setattr(module, "os", SimpleNamespace(**dict(vars(os), name="nt")))
    monkeypatch.setattr(module.platform, "machine", lambda: "AMD64")
    monkeypatch.setattr(module, "windows_control", lambda *_args, **_kwargs: (0, {"workerRunning": False, "message": "服务未启动。"}))
    monkeypatch.setattr(module, "resolve_media_tools", lambda *_args: {"ffmpeg": "fixture-ffmpeg", "ffprobe": "fixture-ffprobe"})
    monkeypatch.setattr(module.shutil, "which", lambda *_args, **_kwargs: "fixture-node")
    cache = tmp_path / "cache"
    monkeypatch.setattr(module, "model_cache_path", lambda: cache)
    cache.mkdir()
    model = cache / "qwen.bin"
    model.write_bytes(b"synthetic qwen model")
    packages = module.ANALYZER / ".venv/Lib/site-packages"
    for folder in ("torch", "torchaudio", "funasr", "paddle", "paddleocr", "cv2", "faster_whisper", "av", "pypinyin", "sherpa_onnx", "sherpa_onnx_core-2.0.1.dist-info"):
        (packages / folder).mkdir(parents=True)
    module.interpreter().parent.mkdir(parents=True)
    module.interpreter().write_bytes(b"synthetic interpreter")
    (module.ANALYZER / "liming_analyzer/douyin_collector/node/node_modules/@playwright/test").mkdir(parents=True)
    (module.LOCAL / "collector-browsers/chromium-synthetic").mkdir(parents=True)
    runtime_directory = tmp_path / "cuda-runtime/synthetic"
    (runtime_directory / "bin").mkdir(parents=True)
    (runtime_directory / "receipt.json").write_text('{"synthetic":true}')
    dlls = ("cudart64_12.dll", "cublasLt64_12.dll", "cublas64_12.dll")
    for name in dlls:
        (runtime_directory / "bin" / name).write_bytes(b"synthetic DLL")
    monkeypatch.setattr(module, "cuda_runtime_tools", lambda: SimpleNamespace(
        runtime_directory=lambda _cache: runtime_directory, REQUIRED_DLLS=dlls,
        validate_runtime=lambda *_args: (_ for _ in ()).throw(AssertionError("status must not hash large DLLs")),
    ))
    data = {"modelsReady": True, "asr": "faster-whisper/large-v3-turbo", "asrBackend": "sherpa-onnx",
            "asrModel": "Qwen3-ASR-1.7B", "asrVerified": True, "asrProbe": "asr-check-zh.v1",
            "requiredFiles": [{"path": "qwen.bin", "size": model.stat().st_size, "mtimeNs": model.stat().st_mtime_ns}]}
    receipt = module.LOCAL / "model-cache/models-ready.json"
    receipt.parent.mkdir(parents=True)
    def save():
        receipt.write_text(json.dumps(data), encoding="utf-8")
    save()
    return module, data, save, runtime_directory


def saved_gpu_probe(module, data):
    data["cudaRuntime"] = {"status": "prepared", "requiredFiles": module.cuda_readiness_files(module.model_cache_path())}
    data["timingAsr"] = {"gpuVerified": True, "device": "cuda", "status": "verified", "probe": "asr-check-zh.v1",
                         "configuration": {"engine": "faster-whisper", "model": "large-v3-turbo", "language": "zh", "device": "auto"},
                         "implementation": module.timing_implementation_fingerprint(), "checkedAt": "2026-11-15T10:00:00Z"}


def test_optional_gpu_warning_does_not_block_cpu_or_claim_legacy_green_means_cuda(tmp_path, monkeypatch):
    module, _data, _save, _directory = windows_ready_fixture(tmp_path, monkeypatch)
    snapshot = module.readiness_snapshot()
    assert snapshot["ready"] and snapshot["modelsReady"] and snapshot["missing"] == []
    gpu = next(item for item in snapshot["checks"] if item["id"] == "whisper_timing_gpu")
    assert gpu["status"] == "warning" and gpu["ok"] is False and gpu["required"] is False
    assert "尚未" in gpu["message"] and "CPU" in snapshot["message"]
    assert snapshot["gpuPreparationNeeded"] is True


def test_saved_gpu_pass_is_historical_and_invalidated_by_dll_config_or_implementation_changes(tmp_path, monkeypatch):
    module, data, save, directory = windows_ready_fixture(tmp_path, monkeypatch)
    saved_gpu_probe(module, data)
    save()
    def gpu():
        snapshot = module.readiness_snapshot()
        assert snapshot["ready"] and snapshot["modelsReady"]
        return snapshot, next(item for item in snapshot["checks"] if item["id"] == "whisper_timing_gpu")
    snapshot, check = gpu()
    assert check["status"] == "ready" and "上次" in check["message"] and "未重新运行" in check["message"]
    assert "2026-11-15T10:00:00Z" in check["message"] and snapshot["gpuPreparationNeeded"] is False
    dll = directory / "bin/cublas64_12.dll"
    contents = dll.read_bytes()
    dll.unlink()
    assert gpu()[1]["status"] == "warning"
    dll.write_bytes(contents)
    assert gpu()[1]["status"] == "warning", "a replaced DLL must not inherit the previous probe"
    saved_gpu_probe(module, data)
    save()
    assert gpu()[1]["status"] == "ready"
    (module.ROOT / ".dev.vars").write_text("ANALYZER_ASR_LANGUAGE=en\n")
    assert gpu()[1]["status"] == "warning"
    (module.ROOT / ".dev.vars").unlink()
    implementation = module.ANALYZER / "liming_analyzer/faster_whisper_asr.py"
    implementation.write_text("# changed timing implementation\n")
    assert gpu()[1]["status"] == "warning"


def test_failed_and_skipped_gpu_receipts_remain_visible_without_running_installer(tmp_path, monkeypatch):
    module, data, save, _directory = windows_ready_fixture(tmp_path, monkeypatch)
    saved_gpu_probe(module, data)
    monkeypatch.setattr(module.subprocess, "run", lambda *_args, **_kwargs: (_ for _ in ()).throw(AssertionError("status must not launch downloads or GPU probes")))
    data["cudaRuntime"] = {"status": "failed", "code": "CUDA_RUNTIME_DOWNLOAD_FAILED"}
    data["timingAsr"].update(status="failed", gpuVerified=False, device="cpu")
    save()
    snapshot = module.readiness_snapshot()
    assert snapshot["ready"] and snapshot["missing"] == []
    gpu = next(item for item in snapshot["checks"] if item["id"] == "whisper_timing_gpu")
    assert gpu["status"] == "warning" and "CUDA_RUNTIME_DOWNLOAD_FAILED" in gpu["message"]
    data["cudaRuntime"]["code"] = "CUDA_ARCHIVE_SOURCE_REJECTED"
    data["timingAsr"]["failure"] = {"code": "CUDA_LIBRARY_UNAVAILABLE", "error_type": "RuntimeError"}
    save()
    gpu = next(item for item in module.readiness_snapshot()["checks"] if item["id"] == "whisper_timing_gpu")
    assert "CUDA_ARCHIVE_SOURCE_REJECTED" in gpu["message"] and "来源校验" in gpu["message"]
    assert "CUDA_LIBRARY_UNAVAILABLE" in gpu["message"]
    assert gpu["message"].index("CUDA_ARCHIVE_SOURCE_REJECTED") < gpu["message"].index("CUDA_LIBRARY_UNAVAILABLE")
    data["timingAsr"].pop("failure")
    data["cudaRuntime"] = {"status": "skipped", "reason": "NVIDIA_GPU_NOT_FOUND"}
    data["timingAsr"]["status"] = "not_verified"
    save()
    for _ in range(2):
        snapshot = module.readiness_snapshot()
        assert snapshot["ready"] and snapshot["gpuPreparationNeeded"] is False
        assert next(item for item in snapshot["checks"] if item["id"] == "whisper_timing_gpu")["status"] == "warning"
    (module.ROOT / ".dev.vars").write_text("ANALYZER_ASR_DEVICE=cpu\n")
    snapshot = module.readiness_snapshot()
    assert snapshot["ready"] and snapshot["gpuPreparationNeeded"] is False
    assert "CPU 模式" in next(item for item in snapshot["checks"] if item["id"] == "whisper_timing_gpu")["message"]


def test_explicit_setup_can_upgrade_a_legacy_ready_cache_instead_of_early_return(tmp_path, monkeypatch):
    module = runtime_module()
    isolate(module, tmp_path, monkeypatch)
    snapshots = iter([{"ready": True, "workerRunning": False, "gpuPreparationNeeded": True},
                      {"ready": True, "workerRunning": False, "gpuPreparationNeeded": False}])
    monkeypatch.setattr(module, "readiness_snapshot", lambda: next(snapshots))
    monkeypatch.setattr(module, "active_process", lambda: None)
    monkeypatch.setattr(module, "runtime_environment", lambda **_kwargs: {})
    monkeypatch.setattr(module.shutil, "which", lambda name, **_kwargs: "fixture-" + name)
    monkeypatch.setattr(module, "resolve_media_tools", lambda *_args: {"ffmpeg": "fixture-ffmpeg", "ffprobe": "fixture-ffprobe"})
    monkeypatch.setattr(module, "_test_media_binary", lambda _path: True)
    calls = []
    def run(command, **_kwargs):
        calls.append(command)
        return SimpleNamespace(returncode=0)
    monkeypatch.setattr(module.subprocess, "run", run)
    assert module.setup() == 0
    assert calls[-1] == [str(module.interpreter()), str(module.ROOT / "scripts/prepare_analyzer_models.py")]


def test_explicit_gpu_check_uses_one_bounded_offline_child_and_updates_verification_only(tmp_path, monkeypatch):
    module, data, save, _directory = windows_ready_fixture(tmp_path, monkeypatch)
    saved_gpu_probe(module, data)
    save()
    receipt = module.LOCAL / "model-cache/models-ready.json"
    calls = []
    def run(command, **options):
        calls.append((command, options))
        assert command[0] == str(module.interpreter())
        assert command[1] == str(module.ROOT / "scripts/check_analyzer_cuda.py")
        assert "prepare_analyzer_cuda.py" not in " ".join(command)
        assert options["timeout"] <= 90 and options["capture_output"]
        assert options["env"]["HF_HUB_OFFLINE"] == options["env"]["TRANSFORMERS_OFFLINE"] == "1"
        return SimpleNamespace(returncode=0, stdout=json.dumps({"status": "verified", "device": "cuda", "gpuVerified": True,
            "probe": "asr-check-zh.v1", "checkedAt": "2026-11-15T11:00:00Z"}))
    monkeypatch.setattr(module.subprocess, "run", run)
    result = module.readiness_snapshot()
    module.check_timing_gpu(result, deadline=time.monotonic() + 230)
    assert len(calls) == 1 and result["ready"]
    check = next(item for item in result["checks"] if item["id"] == "whisper_timing_gpu")
    assert check["status"] == "ready" and "本轮" in check["message"]
    current = json.loads(receipt.read_text())
    assert current["asrBackend"] == data["asrBackend"] and current["requiredFiles"] == data["requiredFiles"]
    assert current["timingAsr"]["checkedAt"] == "2026-11-15T11:00:00Z"
    assert current["timingAsr"]["gpuVerified"] is True


def test_gpu_check_does_not_compete_with_a_running_or_unconfirmed_worker_or_cpu_setting(tmp_path, monkeypatch):
    module, data, save, _directory = windows_ready_fixture(tmp_path, monkeypatch)
    saved_gpu_probe(module, data)
    save()
    receipt = module.LOCAL / "model-cache/models-ready.json"
    before = receipt.read_bytes()
    monkeypatch.setattr(module.subprocess, "run", lambda *_args, **_options: (_ for _ in ()).throw(AssertionError("no GPU child while worker running/unknown or CPU requested")))
    for flags, expected in (({"workerRunning": True}, "分析服务正在运行"), ({"processRunning": True}, "分析服务正在运行"),
                            ({"processStateAvailable": False}, "无法确认")):
        result = {**module.readiness_snapshot(), **flags}
        module.check_timing_gpu(result, deadline=time.monotonic() + 230)
        check = next(item for item in result["checks"] if item["id"] == "whisper_timing_gpu")
        assert check["status"] == "warning" and expected in check["message"]
        assert "2026-11-15T10:00:00Z" in check["message"] and receipt.read_bytes() == before
    result = module.readiness_snapshot()
    def started_after_initial_status(_action, _base_url=None, **options):
        assert options["timeout_seconds"] <= 5
        return 0, {"workerRunning": True, "processRunning": True}
    monkeypatch.setattr(module, "windows_control", started_after_initial_status)
    module.check_timing_gpu(result, deadline=time.monotonic() + 230)
    assert "先停止" in next(item for item in result["checks"] if item["id"] == "whisper_timing_gpu")["message"]
    assert receipt.read_bytes() == before
    monkeypatch.setattr(module, "windows_control", lambda *_args, **_options: (0, {"workerRunning": False}))
    (module.ROOT / ".dev.vars").write_text("ANALYZER_ASR_DEVICE=cpu\n")
    result = module.readiness_snapshot()
    module.check_timing_gpu(result, deadline=time.monotonic() + 230)
    assert "CPU 模式" in next(item for item in result["checks"] if item["id"] == "whisper_timing_gpu")["message"]
    assert receipt.read_bytes() == before


def test_gpu_probe_failures_and_invalid_replies_do_not_turn_cpu_checks_red_or_gpu_green(tmp_path, monkeypatch):
    module, data, save, _directory = windows_ready_fixture(tmp_path, monkeypatch)
    saved_gpu_probe(module, data)
    save()
    cases = [subprocess.TimeoutExpired(["synthetic"], 90), SimpleNamespace(returncode=0, stdout="not JSON"),
             SimpleNamespace(returncode=7, stdout='{"status":"verified","device":"cuda","gpuVerified":true,"probe":"asr-check-zh.v1"}'),
             SimpleNamespace(returncode=0, stdout='{"status":"verified","device":"cuda","gpuVerified":false}'),
             SimpleNamespace(returncode=0, stdout='{"status":"failed","device":"cuda","gpuVerified":false,"failure":{"code":"CUDA_LIBRARY_UNAVAILABLE"}}')]
    for reply in cases:
        def run(*_args, _reply=reply, **_options):
            if isinstance(_reply, Exception):
                raise _reply
            return _reply
        monkeypatch.setattr(module.subprocess, "run", run)
        result = module.readiness_snapshot()
        module.check_timing_gpu(result, deadline=time.monotonic() + 230)
        assert result["ready"] and result["missing"] == []
        assert next(item for item in result["checks"] if item["id"] == "whisper_timing_gpu")["status"] == "warning"
        report = json.loads((module.LOCAL / "model-cache/models-ready.json").read_text())
        assert report["timingAsr"]["gpuVerified"] is False


def test_gpu_check_cannot_overwrite_a_changed_model_receipt_or_configuration(tmp_path, monkeypatch):
    module, data, save, _directory = windows_ready_fixture(tmp_path, monkeypatch)
    saved_gpu_probe(module, data)
    save()
    receipt = module.LOCAL / "model-cache/models-ready.json"
    def reply():
        return SimpleNamespace(returncode=0, stdout='{"status":"verified","device":"cuda","gpuVerified":true,"probe":"asr-check-zh.v1"}')
    def changed_receipt(*_args, **_options):
        data["newerReceipt"] = True
        save()
        return reply()
    monkeypatch.setattr(module.subprocess, "run", changed_receipt)
    result = module.readiness_snapshot()
    module.check_timing_gpu(result, deadline=time.monotonic() + 230)
    assert json.loads(receipt.read_text())["newerReceipt"] is True
    assert json.loads(receipt.read_text())["timingAsr"]["checkedAt"] == "2026-11-15T10:00:00Z"
    assert next(item for item in result["checks"] if item["id"] == "whisper_timing_gpu")["status"] == "warning"
    original = receipt.read_bytes()
    def changed_configuration(*_args, **_options):
        (module.ROOT / ".dev.vars").write_text("ANALYZER_ASR_DEVICE=cpu\n")
        return reply()
    monkeypatch.setattr(module.subprocess, "run", changed_configuration)
    result = module.readiness_snapshot()
    module.check_timing_gpu(result, deadline=time.monotonic() + 230)
    assert receipt.read_bytes() == original
    assert not list(receipt.parent.glob("*.gpu-*.tmp"))


def test_check_gpu_uses_only_the_remaining_budget_and_never_runs_after_deadline(tmp_path, monkeypatch):
    module, _data, _save, _directory = windows_ready_fixture(tmp_path, monkeypatch)
    calls = []
    def run(*_args, **options):
        calls.append(options["timeout"])
        return SimpleNamespace(returncode=0, stdout='{"status":"not_verified","device":"cpu","gpuVerified":false,"reason":"NVIDIA_GPU_NOT_FOUND"}')
    monkeypatch.setattr(module.subprocess, "run", run)
    result = module.readiness_snapshot()
    module.check_timing_gpu(result, deadline=time.monotonic() + 14)
    # Windows monotonic subtraction can round the 9-second budget to 9.000000000000057.
    assert len(calls) == 1 and 0 < calls[0] <= 9 + 1e-9
    result = module.readiness_snapshot()
    module.check_timing_gpu(result, deadline=time.monotonic() - 1)
    assert len(calls) == 1
    assert "时间预算" in next(item for item in result["checks"] if item["id"] == "whisper_timing_gpu")["message"]


def test_explicit_environment_check_bounds_imports_and_gpu_with_one_overall_deadline(tmp_path, monkeypatch, capsys):
    module, _data, _save, _directory = windows_ready_fixture(tmp_path, monkeypatch)
    clock = [1000.0]
    original_snapshot = module.readiness_snapshot
    def snapshot(*_args):
        clock[0] += 80  # Slow controller status still consumes the overall budget.
        return original_snapshot()
    monkeypatch.setattr(module, "readiness_snapshot", snapshot)
    monkeypatch.setattr(module.time, "monotonic", lambda: clock[0])
    monkeypatch.setattr(module.sys, "argv", ["analyzer_local_runtime.py", "check"])
    calls = []
    def run(command, **options):
        calls.append((command, options["timeout"]))
        clock[0] += options["timeout"]
        if command[1] == "-c":
            return SimpleNamespace(returncode=0, stdout="MEDIA_IMPORTS_OK")
        return SimpleNamespace(returncode=0, stdout='{"status":"not_verified","device":"cpu","gpuVerified":false,"reason":"NVIDIA_GPU_NOT_FOUND"}')
    monkeypatch.setattr(module.subprocess, "run", run)
    assert module.main() == 0
    assert len(calls) == 2 and calls[0][1] == 120 and calls[1][1] == 25
    assert clock[0] - 1000 <= 230
    result = json.loads(capsys.readouterr().out)
    assert result["ready"] and next(item for item in result["checks"] if item["id"] == "whisper_timing_gpu")["status"] == "warning"


def test_strict_cuda_cannot_start_from_a_cpu_cache_while_auto_and_cpu_remain_optional(tmp_path, monkeypatch):
    module, data, save, _directory = windows_ready_fixture(tmp_path, monkeypatch)
    saved_gpu_probe(module, data)
    data["timingAsr"].update(gpuVerified=False, device="cpu", status="not_verified")
    save()
    for device, expected_ready in (("cuda", False), ("auto", True), ("cpu", True)):
        (module.ROOT / ".dev.vars").write_text(f"ANALYZER_ASR_DEVICE={device}\n")
        result = module.readiness_snapshot()
        check = next(item for item in result["checks"] if item["id"] == "whisper_timing_gpu")
        assert result["modelsReady"] and result["ready"] is expected_ready
        assert check["required"] is (device == "cuda")
        assert (check["name"] in result["missing"]) is (device == "cuda")
        if device == "cuda":
            assert check["status"] == "error" and "当前明确指定 CUDA" in check["message"]
            assert "仍可使用 CPU 分析" not in check["message"]
            assert "auto/CPU" in check["message"]


def test_strict_cuda_current_check_can_clear_only_its_own_required_blocker(tmp_path, monkeypatch, capsys):
    module, _data, _save, _directory = windows_ready_fixture(tmp_path, monkeypatch)
    (module.ROOT / ".dev.vars").write_text("ANALYZER_ASR_DEVICE=cuda\n")
    before = module.readiness_snapshot()
    assert before["modelsReady"] and before["ready"] is False
    monkeypatch.setattr(module.sys, "argv", ["analyzer_local_runtime.py", "check"])
    def run(command, **_options):
        if command[1] == "-c":
            return SimpleNamespace(returncode=0, stdout="MEDIA_IMPORTS_OK")
        return SimpleNamespace(returncode=0, stdout='{"status":"verified","device":"cuda","gpuVerified":true,"probe":"asr-check-zh.v1"}')
    monkeypatch.setattr(module.subprocess, "run", run)
    assert module.main() == 0
    result = json.loads(capsys.readouterr().out)
    check = next(item for item in result["checks"] if item["id"] == "whisper_timing_gpu")
    assert check["required"] is True and check["ok"] is True and check["status"] == "ready"
    assert result["ready"] and result["missing"] == []
    assert "仍需准备" not in result["message"] and "需完成 GPU 实际转写验证后才能启动" not in result["message"]
    cached = module.readiness_snapshot()
    assert cached["ready"], "the successful current probe must also unblock the next startup"
    monkeypatch.setattr(module, "resolve_media_tools", lambda *_args: {"ffmpeg": None, "ffprobe": "fixture-ffprobe"})
    assert module.main() == 1
    result = json.loads(capsys.readouterr().out)
    assert result["ready"] is False and result["missing"] == ["FFmpeg"]
    assert next(item for item in result["checks"] if item["id"] == "whisper_timing_gpu")["ok"] is True


def test_strict_cuda_current_probe_failure_remains_required_and_does_not_offer_silent_cpu_fallback(tmp_path, monkeypatch, capsys):
    module, _data, _save, _directory = windows_ready_fixture(tmp_path, monkeypatch)
    (module.ROOT / ".dev.vars").write_text("ANALYZER_ASR_DEVICE=cuda\n")
    monkeypatch.setattr(module.sys, "argv", ["analyzer_local_runtime.py", "check"])
    def run(command, **_options):
        if command[1] == "-c":
            return SimpleNamespace(returncode=0, stdout="MEDIA_IMPORTS_OK")
        return SimpleNamespace(returncode=0, stdout='{"status":"failed","device":"cuda","gpuVerified":false,"failure":{"code":"CUDA_LIBRARY_UNAVAILABLE"}}')
    monkeypatch.setattr(module.subprocess, "run", run)
    assert module.main() == 1
    result = json.loads(capsys.readouterr().out)
    check = next(item for item in result["checks"] if item["id"] == "whisper_timing_gpu")
    assert result["ready"] is False and check["required"] is True and check["ok"] is False
    assert check["name"] in result["missing"] and check["status"] == "error"
    assert "CUDA_LIBRARY_UNAVAILABLE" in check["message"] and "当前明确指定 CUDA" in check["message"]
    assert "CPU 基础环境检查结果见上方" not in check["message"]
