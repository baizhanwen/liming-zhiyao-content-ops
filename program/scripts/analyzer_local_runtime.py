"""Start this checkout's analyzer with isolated configuration, caches and logs."""
from __future__ import annotations

import argparse
import hashlib
import importlib.util
import json
import os
import platform
import re
import shutil
import signal
import subprocess
import sys
import time
import venv
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
ANALYZER = ROOT / "services/analyzer"
LOCAL = ROOT / ".local"
PID_FILE = LOCAL / "analyzer-local.json"


def timing_implementation_fingerprint() -> str:
    """Bind a saved timing probe to the installed implementation, without loading it."""
    digest = hashlib.sha256()
    sources = [ANALYZER / "liming_analyzer" / name for name in (
        "faster_whisper_asr.py", "cuda_runtime.py", "quality_speech.py", "qwen_speech.py", "qwen_windows.py",
    )]
    sources.append(ROOT / "scripts/check_analyzer_cuda.py")
    packages = ANALYZER / ".venv" / ("Lib/site-packages" if os.name == "nt" else "lib/python3.11/site-packages")
    for pattern in ("ctranslate2-*.dist-info/METADATA", "faster_whisper-*.dist-info/METADATA"):
        sources.extend(sorted(packages.glob(pattern)))
    for path in sources:
        digest.update(str(path.relative_to(ROOT)).encode("utf-8"))
        try:
            digest.update(path.read_bytes())
        except OSError:
            digest.update(b"missing")
        digest.update(b"\0")
    return digest.hexdigest()


def asr_configuration() -> dict:
    configured = {}
    path = ROOT / ".dev.vars"
    if path.is_file():
        configured = dict(re.findall(r"""^\s*(ANALYZER_ASR_(?:ENGINE|MODEL|LANGUAGE|DEVICE))\s*=\s*['"]?([A-Za-z0-9._/-]+)""",
                                     path.read_text(encoding="utf-8-sig"), re.MULTILINE))
    engine = configured.get("ANALYZER_ASR_ENGINE") or "faster-whisper"
    return {"engine": engine, "model": configured.get("ANALYZER_ASR_MODEL") or (
        "large-v3-turbo" if engine == "faster-whisper" else "paraformer-zh"),
        "language": configured.get("ANALYZER_ASR_LANGUAGE", "zh"),
        "device": configured.get("ANALYZER_ASR_DEVICE", "auto")}


def cuda_runtime_tools():
    # Bootstrap status runs before the SDK dependencies have been installed.
    # Importing liming_analyzer.__init__ here would import the full pipeline.
    path = ANALYZER / "liming_analyzer/cuda_runtime.py"
    spec = importlib.util.spec_from_file_location("analyzer_cuda_readiness", path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def cuda_readiness_files(cache: Path) -> list[dict]:
    """Capture metadata after setup/activation has checked the full SHA-256s."""
    tools = cuda_runtime_tools()
    directory = tools.runtime_directory(cache)
    paths = [directory / "receipt.json", *(directory / "bin" / name for name in tools.REQUIRED_DLLS)]
    files = []
    for path in paths:
        if path.is_symlink() or not path.resolve(strict=True).is_relative_to(directory):
            raise ValueError("CUDA readiness file escaped the managed runtime")
        stat = path.stat()
        if not path.is_file() or stat.st_size <= 0:
            raise ValueError("CUDA readiness file is missing or empty")
        files.append({"path": str(path.relative_to(directory)), "size": stat.st_size,
                      "mtimeNs": stat.st_mtime_ns, "ctimeNs": stat.st_ctime_ns})
    return files


def _cuda_readiness_files_match(cache: Path, files) -> bool:
    if not isinstance(files, list):
        return False
    try:
        current = cuda_readiness_files(cache)
    except (ImportError, OSError, RuntimeError, TypeError, ValueError):
        return False
    return files == current


def gpu_reason_message(code) -> str:
    return {
        "CUDA_LIBRARY_UNAVAILABLE": "CUDA 运行库缺失或无法加载。",
        "CUDA_OUT_OF_MEMORY": "GPU 显存不足，请释放显存后重新检查。",
        "CUDA_RUNTIME_NOT_INSTALLED": "项目 GPU 运行库尚未准备，请点击一键配置环境。",
        "CUDA_ARCHIVE_DOWNLOAD_FAILED": "NVIDIA 运行库下载未完成，可重新配置环境重试。",
        "CUDA_ARCHIVE_SIZE_MISMATCH": "GPU 运行库下载不完整，未使用该文件。",
        "CUDA_ARCHIVE_HASH_MISMATCH": "GPU 运行库校验未通过，未使用该文件。",
        "GPU_PROBE_TIMEOUT": "本轮检测超时，尚不能判断 GPU 是否可用。",
        "GPU_PROBE_PROCESS_FAILED": "本轮 GPU 检测进程未返回有效结果。",
        "NVIDIA_GPU_NOT_FOUND": "未发现可用的 NVIDIA GPU。",
        "LOCAL_MODEL_INCOMPLETE": "本地 Whisper 模型文件不完整，请配置环境补齐。",
    }.get(code, "") if isinstance(code, str) else ""


def timing_gpu_check(prepared: dict, cache: Path, configuration: dict, models_ready: bool):
    if os.name != "nt" or configuration["engine"] != "faster-whisper":
        return None, False
    runtime = prepared.get("cudaRuntime")
    timing = prepared.get("timingAsr")
    runtime = runtime if isinstance(runtime, dict) else {}
    timing = timing if isinstance(timing, dict) else {}
    status = runtime.get("status")
    same_configuration = timing.get("configuration") == configuration
    same_implementation = timing.get("implementation") == timing_implementation_fingerprint()
    current_files = status in {"ready", "prepared"} and _cuda_readiness_files_match(cache, runtime.get("requiredFiles"))
    verified = bool(models_ready and same_configuration and same_implementation and current_files
                    and timing.get("gpuVerified") is True and timing.get("device") == "cuda"
                    and timing.get("probe") == "asr-check-zh.v1")
    failed = status == "failed" or timing.get("status") == "failed"
    code = runtime.get("code") or runtime.get("reason")
    failure = timing.get("failure")
    if isinstance(failure, dict):
        code = failure.get("code") or code
    if verified:
        message = "上次已通过中文样本的 Whisper CUDA 实际转写验证；当前未重新运行 GPU 探测。"
    elif configuration["device"] == "cpu":
        message = "已选择 CPU 模式，未执行 GPU 验证；CPU 分析可用。"
    elif timing.get("reason") == "NVIDIA_GPU_NOT_FOUND" and same_configuration:
        message = "上次检查未发现可用的 NVIDIA GPU，使用 CPU 分析；GPU 未验证。"
    elif failed and same_configuration:
        message = "上次 Whisper GPU 准备或实际转写验证失败，仍可使用 CPU 分析。"
        message += gpu_reason_message(code)
        if isinstance(code, str) and re.fullmatch(r"[A-Z0-9_]{1,100}", code):
            message += " 原因：" + code + "。"
    elif timing.get("status") == "not_verified" and code and same_configuration:
        message = "上次 GPU 检查未完成，GPU 尚未验证；CPU 基础环境状态见其它检查项。"
        if isinstance(code, str) and re.fullmatch(r"[A-Z0-9_]{1,100}", code):
            message += " 原因：" + code + "。"
    elif status == "skipped" and same_configuration:
        message = "上次未启用可用的 NVIDIA GPU，使用 CPU 分析；GPU 未验证。"
    elif status in {"ready", "prepared"} and not current_files:
        message = "GPU 运行库文件已变化或缺失，上次验证已失效；仍可使用 CPU 分析，请重新配置环境。"
    else:
        message = "Whisper GPU 尚未针对当前配置与实现完成验证；仍可使用 CPU 分析，可重新配置环境进行验证。"
    required = configuration["device"] == "cuda"
    if required and not verified:
        message = "当前明确指定 CUDA，需完成 GPU 实际转写验证后才能启动；或先改为 auto/CPU 后使用。"
        if isinstance(code, str) and re.fullmatch(r"[A-Z0-9_]{1,100}", code):
            message += " " + gpu_reason_message(code) + " 原因：" + code + "。"
    if isinstance(timing.get("checkedAt"), str):
        message += " 上次检查：" + timing["checkedAt"][:30] + "。"
    check = {"name": "Whisper timing GPU", "id": "whisper_timing_gpu", "label": "Whisper GPU 时间定位",
             "required": required, "ok": verified,
             "status": "ready" if verified else "error" if required else "warning", "message": message}
    # Status only reads metadata. Repair/download runs solely after an explicit setup action.
    needs_preparation = bool(configuration["device"] != "cpu" and
                             (not runtime or not same_configuration or not same_implementation
                              or status not in {"skipped", "ready", "prepared"}
                              or status in {"ready", "prepared"} and not verified))
    return check, needs_preparation


def model_cache_path() -> Path:
    local_cache = LOCAL / "model-cache"
    if os.name != "nt" or str(local_cache).isascii():
        return local_cache
    # Paddle's native Windows file loader requires an ASCII absolute path.
    # Keep this installation isolated even when its checkout path is Chinese.
    identity = hashlib.sha256(str(ROOT.resolve()).casefold().encode("utf-8")).hexdigest()[:24]
    for directory in (os.environ.get("PROGRAMDATA"), os.environ.get("PUBLIC"),
                      (os.environ.get("SystemDrive") or "C:") + "/ProgramData"):
        if directory and directory.isascii():
            return Path(directory) / "LimingZhiyao" / "installations" / identity / "model-cache"
    raise RuntimeError("Windows 分析模型需要可写的 ASCII 缓存路径。")


def expects_windows_qwen(engine: str, model: str, language: str, device: str) -> bool:
    return (os.name == "nt" and platform.machine().lower() in {"amd64", "x86_64"}
            and engine == "faster-whisper" and model == "large-v3-turbo"
            and language in {"zh", "auto"} and device in {"auto", "cpu"})


def windows_control(action: str, base_url: str | None = None, *, timeout_seconds: float = 85):
    """Use the same supervisor controller as Windows BAT launchers.

    Windows os.kill(pid, 0) is not a side-effect-free liveness probe. The
    controller instead validates command, image and creation time on a handle.
    """
    command = ["powershell.exe", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File",
               str(ROOT / "scripts/analyzer-windows-control.ps1"), "-Action", action]
    if base_url:
        command.extend(["-BaseUrl", base_url])
    try:
        completed = subprocess.run(command, cwd=ROOT, capture_output=True, text=True, encoding="utf-8-sig",
                                   timeout=timeout_seconds, check=False)
        result = next((json.loads(line) for line in reversed(completed.stdout.splitlines()) if line.strip().startswith("{")), None)
        if not isinstance(result, dict) or not isinstance(result.get("workerRunning"), bool):
            raise TypeError("invalid Windows analyzer control response")
        return completed.returncode, result
    except (OSError, subprocess.SubprocessError, TypeError, ValueError):
        return 1, {"workerRunning": False, "processRunning": False,
                   "message": "本项目 Windows 分析服务控制未完成，请检查环境管理日志。"}


def recorded_media_directories():
    recorded = LOCAL / "ffmpeg.path"
    if not recorded.is_file():
        return []
    raw = recorded.read_bytes()
    try:
        value = raw.decode("utf-8-sig")
    except UnicodeDecodeError:
        if os.name != "nt":
            return []
        value = raw.decode("mbcs")
    return [Path(item.strip()) for item in value.strip().split(os.pathsep) if item.strip()]


def resolve_media_tools(environment=None):
    env = os.environ if environment is None else environment
    directories = recorded_media_directories()
    tools = {}
    for name in ("ffmpeg", "ffprobe"):
        configured = env.get("ANALYZER_" + name.upper(), "")
        filename = name + (".exe" if os.name == "nt" else "")
        candidates = ([Path(configured)] if configured else []) + [folder / filename for folder in directories]
        available = shutil.which(name, path=env.get("PATH", ""))
        if available:
            candidates.append(Path(available))
        tools[name] = next((str(path.resolve()) for path in candidates if path.is_file() and os.access(path, os.X_OK)), None)
    return tools


def _test_media_binary(path):
    try:
        result = subprocess.run([str(path), "-version"], capture_output=True, text=True, timeout=15, check=False)
        return result.returncode == 0
    except (OSError, subprocess.SubprocessError):
        return False


def install_media_packages():
    """Install pinned registry packages inside this checkout; no global PATH edits."""
    environment = runtime_environment(load_configuration=False)
    npm = shutil.which("npm.cmd" if os.name == "nt" else "npm")
    node = shutil.which("node")
    if not npm or not node:
        return 1
    folder = LOCAL / "media-tools"
    if not folder.resolve().is_relative_to(ROOT.resolve()):
        raise RuntimeError("Media tools must remain inside the current project.")
    folder.mkdir(parents=True, exist_ok=True)
    for name in ("package.json", "package-lock.json"):
        shutil.copyfile(ROOT / "resources/media-tools" / name, folder / name)
    installed = subprocess.run([npm, "ci", "--prefix", str(folder), "--omit=dev", "--no-audit", "--no-fund"], cwd=ROOT, env=environment, check=False)
    if installed.returncode:
        return installed.returncode
    # These modules expose the binary already included in the npm artifact;
    # package-lock.json pins every platform artifact and registry integrity.
    code = "process.stdout.write(JSON.stringify({ffmpeg:require('@ffmpeg-installer/ffmpeg').path,ffprobe:require('@ffprobe-installer/ffprobe').path}))"
    resolved = subprocess.run([node, "-e", code], cwd=folder, env=environment, capture_output=True, text=True, timeout=60, check=False)
    if resolved.returncode:
        return resolved.returncode
    pair = json.loads(resolved.stdout)
    if set(pair) != {"ffmpeg", "ffprobe"}:
        raise RuntimeError("Media installer returned an invalid result.")
    for path in pair.values():
        binary = Path(path)
        if not binary.resolve().is_relative_to(folder.resolve()) or not binary.is_file() or not _test_media_binary(binary):
            raise RuntimeError("The project-local media executable did not pass verification.")
    directories = list(dict.fromkeys(str(Path(path).parent) for path in pair.values()))
    (LOCAL / "ffmpeg.path").write_text(os.pathsep.join(directories) + "\n", encoding="utf-8")
    (LOCAL / "media-tools.json").write_text(json.dumps({"source": "locked-npm-registry", **pair}, indent=2) + "\n", encoding="utf-8")
    print(json.dumps({"phase": "media_tools_ready", "ready": True}), flush=True)
    return 0


def interpreter() -> Path:
    return ANALYZER / ".venv" / ("Scripts/python.exe" if os.name == "nt" else "bin/python")


def runtime_environment(*, load_configuration=True) -> dict[str, str]:
    # Ignore inherited configuration belonging to another checkout. Caches and
    # imports are always this project's, even if the caller has an active venv.
    env = {
        key: value for key, value in os.environ.items()
        if not key.startswith(("ANALYZER_", "CONTENT_MODEL_", "PROJECT_ASSISTANT_MODEL_", "UV_"))
        and key not in {"PYTHONPATH", "VIRTUAL_ENV", "PADDLE_PDX_CACHE_HOME", "MODELSCOPE_CACHE", "HF_HOME", "TORCH_HOME", "XDG_CACHE_HOME", "PLAYWRIGHT_BROWSERS_PATH", "HF_TOKEN", "HUGGING_FACE_HUB_TOKEN", "OPENAI_API_KEY", "ANTHROPIC_API_KEY", "MINIMAX_API_KEY"}
    }
    if load_configuration:
        from dotenv import dotenv_values
        for key, value in dotenv_values(ROOT / ".dev.vars").items():
            if value is not None and key.startswith(("ANALYZER_", "CONTENT_MODEL_", "PROJECT_ASSISTANT_MODEL_")):
                env[key] = value
    cache = model_cache_path()
    paths = {
        "ANALYZER_MODEL_CACHE": cache,
        "PADDLE_PDX_CACHE_HOME": cache / "paddlex",
        "MODELSCOPE_CACHE": cache / "modelscope",
        "HF_HOME": cache / "huggingface",
        "TORCH_HOME": cache / "torch",
        "XDG_CACHE_HOME": cache / "xdg",
        "PLAYWRIGHT_BROWSERS_PATH": LOCAL / "collector-browsers",
    }
    for key, path in paths.items():
        path.mkdir(parents=True, exist_ok=True)
        env[key] = str(path)
    env["PYTHONPATH"] = str(ANALYZER)
    env["VIRTUAL_ENV"] = str(interpreter().parent.parent)
    env["PYTHONUNBUFFERED"] = "1"
    # Windows pipes otherwise use the local ANSI codepage, while the bridge
    # decodes UTF-8. Keep Chinese paths and progress reports round-trippable.
    env["PYTHONUTF8"] = "1"
    env["PYTHONIOENCODING"] = "utf-8"
    env["PADDLE_PDX_DISABLE_MODEL_SOURCE_CHECK"] = "True"
    env["PADDLE_PDX_MODEL_SOURCE"] = env.get("ANALYZER_PADDLE_MODEL_SOURCE", "bos") or "bos"
    tools = resolve_media_tools(env)
    env["ANALYZER_FFMPEG"] = tools["ffmpeg"] or "ffmpeg"
    env["ANALYZER_FFPROBE"] = tools["ffprobe"] or "ffprobe"
    media_paths = list(dict.fromkeys(str(Path(path).parent) for path in tools.values() if path))
    env["PATH"] = os.pathsep.join([str(interpreter().parent), *media_paths, env.get("PATH", "")])
    return env


def active_process():
    if os.name == "nt":
        _, state = windows_control("status")
        return {"pid": state.get("pid")} if state.get("processRunning") else None
    if not PID_FILE.is_file():
        return None
    try:
        record = json.loads(PID_FILE.read_text(encoding="utf-8"))
        pid = int(record["pid"])
        os.kill(pid, 0)
        if os.name != "nt":
            command = subprocess.check_output(["ps", "-p", str(pid), "-o", "command="], text=True).strip()
            if str(interpreter()) not in command or "liming_analyzer" not in command:
                return None
        return record
    except (OSError, ValueError, KeyError, subprocess.SubprocessError):
        return None


def readiness_snapshot(base_url: str | None = None):
    controlled = windows_control("status", base_url) if os.name == "nt" else None
    windows_state = controlled[1] if controlled is not None else None
    record = None if windows_state is not None else active_process()
    packages = ANALYZER / ".venv" / ("Lib/site-packages" if os.name == "nt" else "lib/python3.11/site-packages")
    cache = model_cache_path()
    model_record = LOCAL / "model-cache/models-ready.json"
    try:
        prepared = json.loads(model_record.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        prepared = {}
    if not isinstance(prepared, dict):
        prepared = {}
    required = prepared.get("requiredFiles", [])
    # A previous model's files can still be healthy after the configured model changes.
    configured_asr = prepared.get("asr")
    # Readiness is also invoked by the bootstrap interpreter before pip installs dotenv.
    configuration = asr_configuration()
    engine, model, language, device = (configuration[key] for key in ("engine", "model", "language", "device"))
    windows_qwen = expects_windows_qwen(engine, model, language, device)
    if (ROOT / ".dev.vars").is_file() or windows_qwen:
        configured_asr = f"{engine}/{model}"
    tools = resolve_media_tools()
    qwen_verified = (prepared.get("asrBackend") == "sherpa-onnx" and prepared.get("asrModel") == "Qwen3-ASR-1.7B"
                     and prepared.get("asrVerified") is True and prepared.get("asrProbe") == "asr-check-zh.v1"
                     and (packages / "sherpa_onnx").is_dir() and any(packages.glob("sherpa_onnx_core-*.dist-info")))
    def cached_file_matches(item):
        if not isinstance(item, dict) or not isinstance(item.get("path"), str):
            return False
        try:
            stat = (cache / item["path"]).stat()
        except OSError:
            return False
        return stat.st_size == item.get("size") and (not windows_qwen or stat.st_mtime_ns == item.get("mtimeNs"))

    models_ready = bool(prepared.get("modelsReady") and prepared.get("asr") == configured_asr
                        and (not windows_qwen or qwen_verified) and isinstance(required, list)
                        and required and all(cached_file_matches(item) for item in required))
    checks = [{"name": "pythonEnvironment", "ok": interpreter().is_file()}]
    for name, directory in [("torch", "torch"), ("torchaudio", "torchaudio"), ("FunASR", "funasr"), ("PaddlePaddle", "paddle"), ("PaddleOCR", "paddleocr"), ("OpenCV", "cv2"), ("faster-whisper", "faster_whisper"), ("PyAV", "av"), ("pypinyin", "pypinyin")]:
        checks.append({"name": name, "ok": (packages / directory).is_dir()})
    checks.extend([
        {"name": "FFmpeg", "ok": bool(tools["ffmpeg"])},
        {"name": "FFprobe", "ok": bool(tools["ffprobe"])},
        {"name": "Node", "ok": bool(shutil.which("node"))},
        {"name": "Playwright", "ok": (ANALYZER / "liming_analyzer/douyin_collector/node/node_modules/@playwright/test").is_dir()},
        {"name": "Chromium", "ok": any((LOCAL / "collector-browsers").glob("chromium-*"))},
        {"name": "localModels", "ok": models_ready},
    ])
    for item in checks:
        item.update(id=item["name"].lower().replace("-", "_"), label=item["name"], status="ready" if item["ok"] else "missing", message="已就绪" if item["ok"] else "需要准备")
    if windows_qwen:
        checks.append({"name": "Qwen3-ASR-1.7B", "id": "qwen3_asr", "label": "Qwen3-ASR-1.7B 本地转写（CPU）",
                       "ok": models_ready, "status": "ready" if models_ready else "missing",
                       "message": "已通过中文录音识别验证" if models_ready else "需要安装并验证中文语音模型"})
    gpu_check, gpu_preparation_needed = timing_gpu_check(prepared, cache, {
        "engine": engine, "model": model, "language": language, "device": device,
    }, models_ready)
    if gpu_check:
        checks.append(gpu_check)
    missing = [item["name"] for item in checks if item.get("required", True) and not item["ok"]]
    result = {"available": True, "message": "本地分析环境已就绪。" if not missing else "仍需准备：" + "、".join(missing), "ready": not missing, "workerRunning": record is not None, "missing": missing, "checks": checks,
              "modelsReady": models_ready, "modelCache": str(cache), "pid": record["pid"] if record else None,
              "gpuPreparationNeeded": gpu_preparation_needed}
    if windows_state is not None:
        result.update(windows_state)
        result["processStateAvailable"] = controlled[0] == 0
        if missing:
            result["message"] += " 仍需准备：" + "、".join(missing)
    if gpu_check:
        result["message"] += " " + gpu_check["message"]
    return result


def _replace_gpu_check(result: dict, *, verified: bool, message: str):
    required = asr_configuration()["device"] == "cuda"
    if required and not verified:
        message = message.replace("CPU 基础环境检查结果见上方。", "")
        message += " 当前明确指定 CUDA，需完成 GPU 验证；或先改为 auto/CPU 后使用。"
    check = {"name": "Whisper timing GPU", "id": "whisper_timing_gpu", "label": "Whisper GPU 时间定位",
             "required": required, "ok": verified,
             "status": "ready" if verified else "error" if required else "warning", "message": message}
    result["checks"] = [item for item in result["checks"] if item.get("id") != "whisper_timing_gpu"] + [check]
    result["missing"] = [item["name"] for item in result["checks"] if item.get("required", True) and not item["ok"]]
    result["ready"] = bool(result.get("available", True) and not result["missing"])
    summary = "本地分析环境已就绪。" if result["ready"] else "仍需准备：" + "、".join(result["missing"]) + "。"
    result["message"] = summary + " " + message


def _save_timing_check(raw: bytes | None, timing: dict, cache: Path) -> bool:
    """Bridge actions are serialized; also reject a receipt/config changed during the probe."""
    if raw is None:
        return False
    path = LOCAL / "model-cache/models-ready.json"
    pending = path.with_name(f"{path.name}.gpu-{os.getpid()}-{time.time_ns()}.tmp")
    try:
        report = json.loads(raw.decode("utf-8"))
        if not isinstance(report, dict):
            return False
        report["timingAsr"] = timing
        # A verified CUDA decode uses the same hash-checking loader as a new worker.
        if timing["gpuVerified"]:
            try:
                files = cuda_readiness_files(cache)
            except (ImportError, OSError, RuntimeError, TypeError, ValueError):
                files = None
            if files:
                old_runtime = report.get("cudaRuntime")
                report["cudaRuntime"] = {**(old_runtime if isinstance(old_runtime, dict) else {}),
                                         "status": "ready", "requiredFiles": files}
        pending.write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
        if (path.read_bytes() != raw or asr_configuration() != timing["configuration"]
                or timing_implementation_fingerprint() != timing["implementation"]):
            return False
        os.replace(pending, path)
        return True
    except (OSError, ValueError, TypeError):
        return False
    finally:
        try:
            pending.unlink(missing_ok=True)
        except OSError:
            pass


def check_timing_gpu(result: dict, *, deadline: float, base_url: str | None = None):
    """Explicit check only: one offline child, no installer and no background GPU polling."""
    configuration = asr_configuration()
    if os.name != "nt" or configuration["engine"] != "faster-whisper":
        return
    history = next((item.get("message", "") for item in result["checks"]
                    if item.get("id") == "whisper_timing_gpu"), "")
    if configuration["device"] == "cpu":
        _replace_gpu_check(result, verified=False, message="本轮按所选 CPU 模式检查，未执行 GPU 验证。 " + history)
        return
    if result.get("workerRunning") or result.get("processRunning"):
        _replace_gpu_check(result, verified=False, message=(
            "本轮未测试 GPU：分析服务正在运行，为避免抢占显存，请先停止分析服务后重新检查。 " + history))
        return
    if result.get("processStateAvailable") is False:
        _replace_gpu_check(result, verified=False, message="本轮未测试 GPU：无法确认分析服务是否已停止，请检查服务状态后重新检测。 " + history)
        return
    # Imports may take time. Recheck immediately before reserving GPU memory,
    # without allowing a stalled controller to consume the probe's full budget.
    if deadline - time.monotonic() > 6:
        controlled, current = windows_control("status", base_url, timeout_seconds=min(5, deadline - time.monotonic() - 5))
        if controlled or current.get("workerRunning") or current.get("processRunning"):
            reason = "分析服务正在运行，请先停止分析服务后重新检查。" if not controlled else "无法确认分析服务是否已停止，请稍后重新检查。"
            _replace_gpu_check(result, verified=False, message="本轮未测试 GPU：" + reason + " " + history)
            return
    remaining = deadline - time.monotonic() - 5
    if remaining < 1:
        _replace_gpu_check(result, verified=False, message="本轮 GPU 未测试：基础环境检查已用完时间预算，请稍后重新检查。 " + history)
        return
    path = LOCAL / "model-cache/models-ready.json"
    try:
        raw = path.read_bytes()
    except OSError:
        raw = None
    implementation = timing_implementation_fingerprint()
    cache = model_cache_path()
    command = [str(interpreter()), str(ROOT / "scripts/check_analyzer_cuda.py"), "--model-cache", str(cache),
               "--model", configuration["model"], "--language", configuration["language"],
               "--device", configuration["device"], "--sample", str(ROOT / "resources/media-tools/asr-check-zh.wav")]
    environment = runtime_environment(load_configuration=False)
    environment.update(HF_HUB_OFFLINE="1", TRANSFORMERS_OFFLINE="1", HF_HUB_DISABLE_TELEMETRY="1")
    emit_code = "GPU_PROBE_PROCESS_FAILED"
    try:
        completed = subprocess.run(command, cwd=ROOT, env=environment, capture_output=True, text=True,
                                   encoding="utf-8", errors="replace", timeout=min(90, remaining), check=False)
        if completed.returncode:
            raise ValueError("GPU check child failed")
        value = json.loads(completed.stdout.splitlines()[-1])
        value = value.get("timingAsr", value) if isinstance(value, dict) else value
        if (not isinstance(value, dict) or value.get("status") not in {"verified", "failed", "cpu", "not_verified"}
                or type(value.get("gpuVerified")) is not bool
                or not isinstance(value.get("device"), str)
                or "checkedAt" in value and not isinstance(value["checkedAt"], str)
                or (value.get("status") == "verified") != value.get("gpuVerified")
                or value.get("gpuVerified") and (value.get("device") != "cuda" or value.get("status") != "verified"
                                                 or value.get("probe") != "asr-check-zh.v1")):
            raise ValueError("GPU check returned invalid JSON")
        timing = {key: value[key] for key in ("status", "device", "gpuVerified", "failure", "probe", "checkedAt", "reason") if key in value}
    except (OSError, ValueError, TypeError, IndexError, subprocess.SubprocessError) as error:
        if isinstance(error, subprocess.TimeoutExpired):
            emit_code = "GPU_PROBE_TIMEOUT"
        timing = {"status": "not_verified", "device": "unavailable", "gpuVerified": False,
                  "failure": {"code": emit_code}}
    timing.update(configuration=configuration, implementation=implementation)
    timing.setdefault("checkedAt", time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()))
    saved = _save_timing_check(raw, timing, cache)
    if not saved:
        suffix = " 检查结果未写入：模型就绪记录缺失或检查期间发生变化，请准备环境后重新检查。"
    else:
        suffix = ""
    verified = bool(timing["gpuVerified"] and not suffix)
    failure = timing.get("failure")
    code = failure.get("code") if isinstance(failure, dict) else timing.get("reason")
    if verified:
        message = "本轮 Whisper GPU 已通过中文样本的完整 CUDA 转写验证。"
    elif timing["status"] == "failed":
        message = "本轮 Whisper GPU 实际验证失败；CPU 基础环境检查结果见上方。"
    else:
        message = "本轮 Whisper GPU 未完成验证；CPU 基础环境检查结果见上方。"
    if isinstance(code, str) and re.fullmatch(r"[A-Z0-9_]{1,100}", code):
        message += " " + gpu_reason_message(code) + " 原因：" + code + "。"
    _replace_gpu_check(result, verified=verified, message=message + " 检查时间：" + timing["checkedAt"][:30] + "。" + suffix)


def setup():
    current_state = readiness_snapshot()
    if (current_state["ready"] and not current_state.get("restartRequired")
            and not current_state.get("gpuPreparationNeeded")
            and all(path and _test_media_binary(path) for path in resolve_media_tools().values())):
        print(json.dumps({**current_state, "alreadyPrepared": True, "alreadyRunning": current_state["workerRunning"]}, ensure_ascii=False), flush=True)
        return 0
    if active_process():
        print(json.dumps({**readiness_snapshot(), "ready": False, "stopRequired": True, "message": "请先停止分析服务，再准备或修复环境。"}, ensure_ascii=False), flush=True)
        return 1
    env = runtime_environment(load_configuration=False)
    uv = shutil.which("uv")
    npm = shutil.which("npm.cmd" if os.name == "nt" else "npm")
    if not npm:
        print(json.dumps({"ready": False, "workerRunning": bool(active_process()), "missing": ["npm"], "checks": [], "message": "Node.js 运行环境未就绪。"}, ensure_ascii=False))
        return 1
    if not uv:
        print(json.dumps({"phase": "preparing_project_installer"}), flush=True)
        tools = LOCAL / "installer-tools"
        executable_name = "uv.exe" if os.name == "nt" else "uv"
        uv = next((str(path) for path in tools.rglob(executable_name) if path.is_file() and os.access(path, os.X_OK)), None) if tools.exists() else None
        if not uv:
            # Bootstrap pip into a project-owned environment, never into the
            # host Python. The package and executable remain in this checkout.
            bootstrap = LOCAL / "installer-venv"
            venv.EnvBuilder(with_pip=True).create(bootstrap)
            bootstrap_python = bootstrap / ("Scripts/python.exe" if os.name == "nt" else "bin/python")
            installed = subprocess.run([str(bootstrap_python), "-m", "pip", "install", "--target", str(tools), "uv==0.12.5"], cwd=ROOT, env=env, check=False)
            if installed.returncode:
                print(json.dumps({"ready": False, "workerRunning": False, "missing": ["uv"], "checks": [], "message": "本项目安装工具准备失败。"}, ensure_ascii=False), flush=True)
                return installed.returncode
            uv = next((str(path) for path in tools.rglob(executable_name) if path.is_file() and os.access(path, os.X_OK)), None)
        if not uv:
            print(json.dumps({"ready": False, "workerRunning": False, "missing": ["uv"], "checks": [], "message": "未找到本项目安装工具。"}, ensure_ascii=False), flush=True)
            return 1
    # Use exactly the 3.11 interpreter selected/prepared by this checkout's
    # bridge. User uv configuration must never redirect or sync another venv.
    env.update({
        "UV_CACHE_DIR": str(LOCAL / "uv-cache"),
        "UV_PROJECT_ENVIRONMENT": str(ANALYZER / ".venv"),
        "UV_PYTHON": str(Path(sys.executable).resolve()),
        "UV_PYTHON_DOWNLOADS": "never",
        "UV_NO_CONFIG": "1",
    })
    commands = [
        ("installing_media_dependencies", [uv, "sync", "--no-config", "--locked", "--python", env["UV_PYTHON"], "--extra", "media", "--extra", "dev"], ANALYZER),
        ("installing_collector_dependencies", [npm, "ci", "--prefix", str(ANALYZER / "liming_analyzer/douyin_collector/node"), "--omit=dev", "--no-audit", "--no-fund"], ROOT),
        ("installing_browser", [npm, "run", "install-browser", "--prefix", str(ANALYZER / "liming_analyzer/douyin_collector/node")], ROOT),
    ]
    if os.name == "nt":
        commands.append(("checking_windows_native_runtime", ["powershell.exe", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass",
                                                              "-File", str(ROOT / "scripts/install-vcredist.ps1")], ROOT))
    media_tools = resolve_media_tools(env)
    if not all(path and _test_media_binary(path) for path in media_tools.values()):
        if os.name == "nt":
            command = ["powershell.exe", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", str(ROOT / "scripts/install-ffmpeg.ps1"), "-ProjectOnly", "-PathFile", str(LOCAL / "ffmpeg.path")]
        else:
            command = [str(interpreter()), str(ROOT / "scripts/analyzer_local_runtime.py"), "install-media-tools"]
        commands.append(("installing_media_tools", command, ROOT))
    commands.append(("preparing_local_models", [str(interpreter()), str(ROOT / "scripts/prepare_analyzer_models.py")], ROOT))
    for phase, command, cwd in commands:
        print(json.dumps({"phase": phase}, ensure_ascii=False), flush=True)
        completed = subprocess.run(command, cwd=cwd, env=env, check=False)
        if completed.returncode:
            print(json.dumps({**readiness_snapshot(), "ready": False, "failedPhase": phase, "message": "环境准备未完成，请查看当前任务日志。"}, ensure_ascii=False), flush=True)
            return completed.returncode
    result = readiness_snapshot()
    print(json.dumps(result, ensure_ascii=False), flush=True)
    return 0 if result["ready"] else 1


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("command", choices=("setup", "start", "stop", "status", "check", "install-media-tools", "cache-path"))
    parser.add_argument("--base-url", help="Actual local web URL selected by this installation's launcher")
    args = parser.parse_args()
    if args.command == "cache-path":
        print(model_cache_path())
        return 0
    if args.command == "status":
        print(json.dumps(readiness_snapshot(args.base_url), ensure_ascii=False))
        return 0
    if args.command == "setup":
        return setup()
    if args.command == "install-media-tools":
        return install_media_packages()
    if args.command == "stop":
        if os.name == "nt":
            code, state = windows_control("stop", args.base_url)
            print(json.dumps({**readiness_snapshot(args.base_url), **state}, ensure_ascii=False))
            return code
        record = active_process()
        if record:
            os.kill(int(record["pid"]), signal.SIGTERM)
            print(json.dumps({**readiness_snapshot(), "workerRunning": False, "message": "已请求停止本项目分析服务。"}, ensure_ascii=False))
        else:
            print(json.dumps({**readiness_snapshot(), "workerRunning": False, "message": "本项目分析服务未运行。"}, ensure_ascii=False))
        PID_FILE.unlink(missing_ok=True)
        return 0
    if args.command == "check":
        deadline = time.monotonic() + 230
        result = readiness_snapshot(args.base_url)
        if interpreter().is_file():
            env = runtime_environment(load_configuration=False)
            modules = "torch,torchaudio,funasr,paddle,paddleocr,cv2,faster_whisper,av,pypinyin"
            if any(item["id"] == "qwen3_asr" for item in result["checks"]):
                modules += ",sherpa_onnx"
            code = f"import {modules}; print('MEDIA_IMPORTS_OK')"
            remaining = deadline - time.monotonic() - 5
            try:
                imported = subprocess.run([str(interpreter()), "-c", code], cwd=ROOT, env=env, capture_output=True,
                                          text=True, timeout=max(1, min(120, remaining)), check=False)
                passed = imported.returncode == 0 and "MEDIA_IMPORTS_OK" in imported.stdout
            except (OSError, subprocess.SubprocessError):
                passed = False
            result["checks"].append({"name": "mediaImports", "ok": passed, "id": "media_imports", "label": "媒体依赖实际加载", "status": "ready" if passed else "missing", "message": "加载成功" if passed else "依赖加载失败，请重新准备环境"})
            if not passed:
                result["missing"].append("可加载的本地 ASR/OCR 依赖")
        else:
            passed = False
        result["ready"] = bool(result["ready"] and passed)
        check_timing_gpu(result, deadline=deadline, base_url=args.base_url)
        print(json.dumps(result, ensure_ascii=False))
        return 0 if result["ready"] else 1
    if os.name == "nt":
        state = readiness_snapshot(args.base_url)
        if not state["ready"] and not state.get("processRunning"):
            print(json.dumps({**state, "started": False, "message": "请先准备当前项目的分析环境，再启动服务。"}, ensure_ascii=False))
            return 1
        code, controlled = windows_control("start", args.base_url)
        print(json.dumps({**state, **controlled}, ensure_ascii=False))
        return code
    current = active_process()
    if current:
        print(json.dumps({**readiness_snapshot(), "running": True, "pid": current["pid"], "already_running": True}, ensure_ascii=False))
        return 0
    state = readiness_snapshot()
    if not state["ready"]:
        print(json.dumps({**state, "started": False, "message": "请先准备当前项目的分析环境，再启动服务。"}, ensure_ascii=False))
        return 1
    env = runtime_environment()
    log = LOCAL / "logs/analyzer-local.log"
    log.parent.mkdir(parents=True, exist_ok=True)
    with log.open("ab", buffering=0) as output:
        process = subprocess.Popen([str(interpreter()), "-m", "liming_analyzer"], cwd=ROOT, env=env,
                                   stdin=subprocess.DEVNULL, stdout=output, stderr=subprocess.STDOUT,
                                   start_new_session=True)
    PID_FILE.write_text(json.dumps({"pid": process.pid, "project": str(ROOT), "log": str(log)}) + "\n", encoding="utf-8")
    time.sleep(1)
    if process.poll() is not None:
        print(json.dumps({"started": False, "ready": False, "workerRunning": False, "missing": ["分析服务启动失败，请检查本项目模型配置和运行日志"], "checks": []}, ensure_ascii=False))
        return 1
    print(json.dumps({**readiness_snapshot(), "started": True, "pid": process.pid, "log": str(log)}, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
