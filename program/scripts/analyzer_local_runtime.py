"""Start this checkout's analyzer with isolated configuration, caches and logs."""
from __future__ import annotations

import argparse
import json
import os
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
    cache = LOCAL / "model-cache"
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


def readiness_snapshot():
    record = active_process()
    packages = ANALYZER / ".venv" / ("Lib/site-packages" if os.name == "nt" else "lib/python3.11/site-packages")
    cache = LOCAL / "model-cache"
    model_record = cache / "models-ready.json"
    try:
        prepared = json.loads(model_record.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        prepared = {}
    required = prepared.get("requiredFiles", [])
    tools = resolve_media_tools()
    models_ready = bool(prepared.get("modelsReady") and required and all(
        isinstance(item, dict) and (cache / item.get("path", "")).is_file()
        and (cache / item["path"]).stat().st_size == item.get("size") for item in required
    ))
    checks = [{"name": "pythonEnvironment", "ok": interpreter().is_file()}]
    for name, directory in [("torch", "torch"), ("torchaudio", "torchaudio"), ("FunASR", "funasr"), ("PaddlePaddle", "paddle"), ("PaddleOCR", "paddleocr"), ("OpenCV", "cv2"), ("faster-whisper", "faster_whisper"), ("PyAV", "av")]:
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
    missing = [item["name"] for item in checks if not item["ok"]]
    return {"available": True, "message": "本地分析环境已就绪。" if not missing else "仍需准备：" + "、".join(missing), "ready": not missing, "workerRunning": record is not None, "missing": missing, "checks": checks,
            "modelsReady": models_ready, "modelCache": str(cache), "pid": record["pid"] if record else None}


def setup():
    current_state = readiness_snapshot()
    if current_state["ready"] and all(path and _test_media_binary(path) for path in resolve_media_tools().values()):
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
    parser.add_argument("command", choices=("setup", "start", "stop", "status", "check", "install-media-tools"))
    args = parser.parse_args()
    if args.command == "status":
        print(json.dumps(readiness_snapshot(), ensure_ascii=False))
        return 0
    if args.command == "setup":
        return setup()
    if args.command == "install-media-tools":
        return install_media_packages()
    if args.command == "stop":
        record = active_process()
        if record:
            os.kill(int(record["pid"]), signal.SIGTERM)
            print(json.dumps({**readiness_snapshot(), "workerRunning": False, "message": "已请求停止本项目分析服务。"}, ensure_ascii=False))
        else:
            print(json.dumps({**readiness_snapshot(), "workerRunning": False, "message": "本项目分析服务未运行。"}, ensure_ascii=False))
        PID_FILE.unlink(missing_ok=True)
        return 0
    if args.command == "check":
        result = readiness_snapshot()
        if interpreter().is_file():
            env = runtime_environment(load_configuration=False)
            code = "import torch,torchaudio,funasr,paddle,paddleocr,cv2,faster_whisper,av; print('MEDIA_IMPORTS_OK')"
            imported = subprocess.run([str(interpreter()), "-c", code], cwd=ROOT, env=env, capture_output=True, text=True, timeout=180, check=False)
            passed = imported.returncode == 0 and "MEDIA_IMPORTS_OK" in imported.stdout
            result["checks"].append({"name": "mediaImports", "ok": passed, "id": "media_imports", "label": "媒体依赖实际加载", "status": "ready" if passed else "missing", "message": "加载成功" if passed else "依赖加载失败，请重新准备环境"})
            if not passed:
                result["missing"].append("可加载的本地 ASR/OCR 依赖")
        else:
            passed = False
        result["ready"] = bool(result["ready"] and passed)
        print(json.dumps(result, ensure_ascii=False))
        return 0 if result["ready"] else 1
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
