"""Offline CT2 GPU decode probe. Never installs packages or submits app jobs."""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import platform
import re
import subprocess
import sys
import time
from importlib import metadata as package_metadata
from importlib import util as import_util
from pathlib import Path

SCHEMA = "whisper-gpu-diagnostic.v1"
CUDA_DLLS = ("cublas64_12.dll", "cublasLt64_12.dll", "cudart64_12.dll")
CUDA_PACKAGES = ("nvidia-cublas-cu12", "nvidia-cuda-runtime-cu12", "nvidia-cudnn-cu12")
# Isolated (-I) interpreters omit the script directory. The portable helper
# must still work beside this file on an older checkout without the new module.
sys.path.insert(0, str(Path(__file__).resolve().parent))
sys.path.insert(1, str(Path(__file__).resolve().parents[1] / "services/analyzer"))


def safe_error(error):
    # The portable bundle includes this same helper next to the script, and
    # current checkouts use the analyzer's production logging implementation.
    try:
        from gpu_diagnostics import gpu_failure_details
    except ImportError:
        try:
            from liming_analyzer.gpu_diagnostics import gpu_failure_details
        except ImportError:
            return {"code": "DIAGNOSTIC_HELPER_UNAVAILABLE", "error_type": type(error).__name__,
                    "detail": "The diagnostic helper is missing; raw error text was not exported."}
    details = gpu_failure_details(error)
    return {**details, "detail": private_path(details.get("detail", ""))}


def package_versions():
    versions = {}
    for name in ("ctranslate2", "faster-whisper", "torch", "sherpa-onnx", *CUDA_PACKAGES):
        try:
            versions[name] = package_metadata.version(name)
        except package_metadata.PackageNotFoundError:
            versions[name] = "not_installed"
    return versions


def managed_cuda_runtime(arguments):
    """Use the same optional app-local loader as the formal Whisper adapter."""
    paths = [Path(__file__).resolve().parent / "cuda_runtime.py"]
    program = getattr(arguments, "program", None)
    if program:
        paths.append(Path(program) / "services/analyzer/liming_analyzer/cuda_runtime.py")
    for path in paths:
        if not path.is_file():
            continue
        name = "_diagnostic_managed_cuda_" + hashlib.sha256(str(path.resolve()).encode()).hexdigest()[:16]
        module = sys.modules.get(name)
        if module is None:
            spec = import_util.spec_from_file_location(name, path)
            module = import_util.module_from_spec(spec)
            sys.modules[name] = module  # Keep DLL and add_dll_directory handles alive.
            spec.loader.exec_module(module)
        state = module.activate_windows_cuda(Path(arguments.cache))
        return {key: ({name: private_path(value) for name, value in item.items()} if key == "loaded_paths"
                      else private_path(item) if isinstance(item, str) else item) for key, item in state.items()}
    return {"status": "missing", "reason": "MANAGED_CUDA_HELPER_NOT_AVAILABLE"}


def private_path(value):
    """Export useful library locations without Windows/custom profile names."""
    text = str(value)
    for home in (os.environ.get("USERPROFILE"), os.environ.get("HOME"), str(Path.home())):
        if home and len(home) > 3:
            pattern = r"[\\/]".join(re.escape(part) for part in re.split(r"[\\/]", home.rstrip("\\/")))
            text = re.sub(pattern, "<profile>", text, flags=re.IGNORECASE)
    text = re.sub(r"(?i)([a-z]:[\\/](?:Users|Profiles)[\\/])[^\\/\r\n]+", r"\1<user>", text)
    text = re.sub(r"(/(?:Users|home)/)[^/\r\n]+", r"\1<user>", text)
    return text[:1200]


def dll_error(error):
    detail = safe_error(error)
    return {**detail, "detail": private_path(detail.get("detail", "")),
            "winerror": getattr(error, "winerror", None), "errno": getattr(error, "errno", None)}


def cuda_dll_inventory():
    """Only stat named DLLs in selected locations; never scan recursively."""
    if sys.platform != "win32":
        return {"status": "not_tested", "reason": "WINDOWS_ONLY"}, []
    locations = []
    cuda_environment = []
    omitted = [0]
    drive_types = {}
    def local_path(path):
        text = str(path)
        if text.startswith(("\\\\", "//", "\\??\\")):
            return False
        if os.name == "nt":
            import ctypes
            anchor = Path(path).anchor
            if anchor not in drive_types:
                try:
                    kernel = ctypes.WinDLL("kernel32", use_last_error=True)
                    kernel.GetDriveTypeW.argtypes = [ctypes.c_wchar_p]
                    kernel.GetDriveTypeW.restype = ctypes.c_uint
                    drive_types[anchor] = kernel.GetDriveTypeW(anchor)
                except OSError:
                    drive_types[anchor] = 0
            # Removable, fixed and RAM disks only; no mapped network drives.
            return drive_types[anchor] in {2, 3, 6}
        return True
    def add(path, source):
        path = Path(path)
        if not local_path(path):
            omitted[0] += 1
            return
        if path.is_absolute() and str(path).casefold() not in {str(p).casefold() for p, _ in locations}:
            locations.append((path, source))
    add(Path(sys.prefix) / "Lib/site-packages/nvidia/cublas/bin", "target_venv_cublas")
    add(Path(sys.prefix) / "Lib/site-packages/nvidia/cuda_runtime/bin", "target_venv_cudart")
    # Only these public CUDA directory variables are read/exported.
    for name in sorted(key for key in os.environ if key == "CUDA_PATH" or re.fullmatch(r"CUDA_PATH_V12_\d+", key)):
        value = os.environ[name]
        if not local_path(value):
            omitted[0] += 1
            continue
        cuda_environment.append({"name": name, "path": private_path(value)})
        add(Path(value) / "bin", name)
        add(Path(value) / "bin/x64", name)
    for variable in ("ProgramFiles", "ProgramFiles(x86)"):
        base = os.environ.get(variable)
        if base:
            cuda = Path(base) / "NVIDIA GPU Computing Toolkit/CUDA"
            if not local_path(cuda):
                omitted[0] += 1
                continue
            try:
                for folder in sorted(cuda.glob("v12.*"))[:20]:
                    if folder.is_dir():
                        add(folder / "bin", "standard_cuda12")
                        add(folder / "bin/x64", "standard_cuda12")
            except OSError:
                pass
    path_entries = [item for item in os.environ.get("PATH", "").split(os.pathsep) if item.strip()]
    for item in path_entries[:128]:
        add(item.strip('"'), "process_path")
    system_root = os.environ.get("SystemRoot") or os.environ.get("WINDIR")
    if system_root:
        add(Path(system_root) / "System32", "system32")
    directories, pairs, path_misses = [], [], 0
    for folder, source in locations:
        files = []
        for name in CUDA_DLLS:
            try:
                file = folder / name
                exists = file.is_file()
                files.append({"name": name, "exists": exists, "size_bytes": file.stat().st_size if exists else None})
            except (OSError, ValueError) as error:
                files.append({"name": name, "exists": False, "error": dll_error(error)})
        if source == "process_path" and not any(row.get("exists") for row in files):
            path_misses += 1
            continue
        directories.append({"source": source, "path": private_path(folder), "dlls": files})
        if all(row.get("exists") and row.get("size_bytes", 0) > 0 for row in files[:2]):
            pairs.append(folder)
    versions = package_versions()
    return {"status": "found" if pairs else "missing", "scope": "selected_local_cuda12_locations_only",
            "candidate_count": min(2, len(pairs)),
            "network_or_device_paths_omitted": omitted[0],
            "packages": {name: versions.get(name, "not_installed") for name in CUDA_PACKAGES},
            "cuda_environment": cuda_environment, "directories": directories,
            "path_directories_without_selected_dlls": path_misses,
            "path_entries_omitted": max(0, len(path_entries) - 128)}, pairs[:2]


def dll_load_probe(arguments):
    """No model import: each loader experiment runs in a fresh process."""
    import ctypes
    if sys.platform != "win32":
        return {"status": "not_tested", "reason": "WINDOWS_ONLY"}
    candidate_index = getattr(arguments, "candidate_index", None)
    if candidate_index is not None:
        _, candidates = cuda_dll_inventory()
        if candidate_index not in {0, 1} or candidate_index >= len(candidates):
            return {"status": "not_tested", "reason": "DLL_CANDIDATE_NO_LONGER_AVAILABLE", "candidate_index": candidate_index}
        folder = candidates[candidate_index]
    else:
        folder = Path(arguments.dll_directory).resolve()
    mode = arguments.dll_load_mode
    result = {"status": "failed", "mode": mode, "directory": private_path(folder), "loads": []}
    handles, directories = [], []
    try:
        if mode == "absolute":
            directories.append(os.add_dll_directory(str(folder)))
        kernel = ctypes.WinDLL("kernel32", use_last_error=True)
        kernel.GetModuleFileNameW.argtypes = [ctypes.c_void_p, ctypes.c_wchar_p, ctypes.c_ulong]
        kernel.GetModuleFileNameW.restype = ctypes.c_ulong
        if mode == "bare" and os.environ.get("CUDA_PATH"):
            # Match CT2's legacy CUDA_PATH/bin search scope in this child only.
            kernel.SetDllDirectoryW.argtypes = [ctypes.c_wchar_p]
            kernel.SetDllDirectoryW(str(Path(os.environ["CUDA_PATH"]) / "bin"))
            result["cuda_path_bin_applied"] = True
        for name in ("cublasLt64_12.dll", "cublas64_12.dll"):
            requested = str(folder / name) if mode == "absolute" else name
            try:
                library = ctypes.WinDLL(requested, use_last_error=True, winmode=0 if mode == "bare" else 0x1100)
                handles.append(library)
                buffer = ctypes.create_unicode_buffer(32768)
                length = kernel.GetModuleFileNameW(library._handle, buffer, len(buffer))
                if not length:
                    raise ctypes.WinError(ctypes.get_last_error())
                result["loads"].append({"name": name, "status": "loaded", "actual_path": private_path(buffer.value)})
            except OSError as error:
                result["loads"].append({"name": name, "status": "failed", "error": dll_error(error)})
                return result
        result["status"] = "loaded"
        return result
    except OSError as error:
        return {**result, "error": dll_error(error)}
    finally:
        for directory in directories:
            directory.close()


def dll_load_trials(arguments, candidate_count, *, interpreter=None, environment=None):
    results = []
    deadline = time.monotonic() + 30
    for index in range(min(2, candidate_count)):
        for mode in ("bare", "absolute"):
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                return results + [{"status": "not_tested", "reason": "DLL_LOAD_BUDGET_EXHAUSTED"}]
            command = [str(interpreter or sys.executable), str(Path(__file__).resolve()), "--program", str(Path(arguments.program).resolve()),
                       "--child-dll-load", "--candidate-index", str(index), "--dll-load-mode", mode]
            try:
                child = subprocess.run(command, capture_output=True, text=True, encoding="utf-8", errors="replace",
                                       env=environment, cwd=Path(arguments.program).resolve(), timeout=min(10, remaining), check=False)
                lines = [line[len("DLL_PROBE_JSON="):] for line in child.stdout.splitlines() if line.startswith("DLL_PROBE_JSON=")]
                value = json.loads(lines[-1]) if lines else None
                if not isinstance(value, dict) or value.get("status") not in {"loaded", "failed", "not_tested"} or child.returncode:
                    value = {"status": "failed", "reason": "DLL_LOAD_PROCESS_ERROR", "exit_code": child.returncode}
            except subprocess.TimeoutExpired:
                value = {"status": "not_tested", "reason": "DLL_LOAD_TIMEOUT"}
            except (OSError, ValueError, TypeError) as error:
                value = {"status": "failed", "error": dll_error(error)}
            results.append({"candidate_index": index, "mode": mode, **value})
    return results


def child_diagnostic(arguments):
    inventory, _ = cuda_dll_inventory()
    baseline = decode_probe(arguments)
    # No nested children: the report parent owns every loader timeout/reap.
    return {**baseline, "dll_inventory": inventory}


def decode_probe(arguments):
    started = time.monotonic()
    runtime = {"python": platform.python_version(), "packages": package_versions()}
    try:
        import ctranslate2
        gpu_count = ctranslate2.get_cuda_device_count()
        if gpu_count < 1:
            return {**runtime, "status": "not_tested", "reason": "CUDA_DEVICE_UNAVAILABLE", "gpu_count": gpu_count,
                    "elapsed_seconds": round(time.monotonic() - started, 2)}
        from faster_whisper import WhisperModel
        folder = Path(arguments.cache) / ("faster-whisper-" + arguments.model)
        required = ["model.bin", "config.json", "tokenizer.json"]
        if arguments.model == "large-v3-turbo":
            required.append("preprocessor_config.json")
        missing = [name for name in required if not (folder / name).is_file() or not (folder / name).stat().st_size]
        if missing:
            return {**runtime, "status": "not_tested", "reason": "LOCAL_MODEL_INCOMPLETE", "missing": missing}
        runtime["managed_cuda_runtime"] = managed_cuda_runtime(arguments)
        engine = WhisperModel(str(folder), device="cuda", compute_type="float16",
                              cpu_threads=4, local_files_only=True)
        options = {"condition_on_previous_text": False, "hallucination_silence_threshold": 2.0} if arguments.model == "large-v3-turbo" else {}
        rows, _ = engine.transcribe(str(arguments.sample), language="zh", beam_size=5,
                                   word_timestamps=arguments.model == "large-v3-turbo", vad_filter=True, **options)
        # Exhaust the lazy generator: construction/GPU enumeration is not an inference test.
        segments = [row for row in rows if str(row.text).strip()]
        return {**runtime, "status": "passed" if segments else "failed", "device": "cuda",
                "gpu_count": gpu_count, "segments": len(segments),
                "characters": sum(len(row.text.strip()) for row in segments),
                "reason": None if segments else "NO_SPEECH_OUTPUT", "elapsed_seconds": round(time.monotonic() - started, 2)}
    except Exception as error:  # noqa: BLE001 - native backend failures are the diagnostic result
        return {**runtime, "status": "failed", **safe_error(error), "elapsed_seconds": round(time.monotonic() - started, 2)}


def run_diagnostic(arguments):
    program = Path(arguments.program).expanduser().resolve()
    runtime_script = program / "scripts/analyzer_local_runtime.py"
    if not runtime_script.is_file():
        raise ValueError("--program must name the program folder containing scripts/analyzer_local_runtime.py")
    spec = import_util.spec_from_file_location("diagnostic_runtime", runtime_script)
    runtime = import_util.module_from_spec(spec)
    spec.loader.exec_module(runtime)
    interpreter = runtime.interpreter()
    if not interpreter.is_file():
        raise ValueError("This checkout's analyzer virtual environment is missing")
    environment = runtime.runtime_environment(load_configuration=False)
    environment.update(HF_HUB_OFFLINE="1", TRANSFORMERS_OFFLINE="1", HF_HUB_DISABLE_TELEMETRY="1",
                       PYTHONDONTWRITEBYTECODE="1", PYTHONUTF8="1", PYTHONIOENCODING="utf-8")
    sample = Path(arguments.sample) if arguments.sample else program / "resources/media-tools/asr-check-zh.wav"
    if not sample.is_file():
        raise ValueError("Bundled self-test WAV is missing")
    report = {"schema": SCHEMA, "created_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
              "platform": platform.platform(), "launcher_python": platform.python_version(),
              "model": arguments.model, "network": "offline", "fallback": "disabled for this probe",
              "qwen_windows_device": "cpu (sherpa-onnx); this probe only verifies Whisper timing CUDA"}
    try:
        driver = subprocess.run(["nvidia-smi", "--query-gpu=name,driver_version,memory.total,memory.free", "--format=csv,noheader"],
                                capture_output=True, text=True, timeout=10, check=False)
        report["nvidia_smi"] = driver.stdout.strip()[:1500] if driver.returncode == 0 else {"exit_code": driver.returncode}
    except (OSError, subprocess.SubprocessError) as error:
        report["nvidia_smi"] = safe_error(error)
    command = [str(interpreter), str(Path(__file__).resolve()), "--program", str(program), "--child", "--cache", environment["ANALYZER_MODEL_CACHE"],
               "--model", arguments.model, "--sample", str(sample.resolve())]
    try:
        child = subprocess.run(command, env=environment, cwd=program, capture_output=True, text=True,
                               encoding="utf-8", errors="replace", timeout=arguments.timeout, check=False)
        lines = [line[len("GPU_PROBE_JSON="):] for line in child.stdout.splitlines() if line.startswith("GPU_PROBE_JSON=")]
        if not lines:
            lines = [line[len("GPU_BASELINE_JSON="):] for line in child.stdout.splitlines() if line.startswith("GPU_BASELINE_JSON=")]
        try:
            probe = json.loads(lines[-1]) if lines else None
            if not isinstance(probe, dict) or probe.get("status") not in {"passed", "failed", "not_tested"}:
                raise ValueError("The child did not return a diagnostic result")
        except (ValueError, TypeError):
            probe = {"status": "failed", "reason": "PROCESS_EXIT_WITHOUT_RESULT", "exit_code": child.returncode,
                     "error": safe_error(RuntimeError(child.stderr[-3000:]))}
        if child.returncode != 0 and probe["status"] == "passed":
            probe = {**probe, "status": "failed", "reason": "CHILD_PROCESS_ERROR"}
        report["probe"] = probe
        report["probe_exit_code"] = child.returncode
    except subprocess.TimeoutExpired as error:
        output = error.stdout or ""
        if isinstance(output, bytes):
            output = output.decode("utf-8", errors="replace")
        baselines = [line[len("GPU_BASELINE_JSON="):] for line in output.splitlines() if line.startswith("GPU_BASELINE_JSON=")]
        try:
            baseline = json.loads(baselines[-1]) if baselines else None
        except (ValueError, TypeError):
            baseline = None
        if isinstance(baseline, dict) and baseline.get("status") in {"passed", "failed", "not_tested"}:
            report["probe"] = {**baseline, "dll_load_trials": [{"status": "not_tested", "reason": "DLL_LOAD_DIAGNOSTIC_TIMEOUT"}]}
        else:
            report["probe"] = {"status": "not_tested", "reason": "GPU_PROBE_TIMEOUT", "timeout_seconds": arguments.timeout}
    inventory = report["probe"].get("dll_inventory", {})
    candidate_count = inventory.get("candidate_count", 0) if isinstance(inventory, dict) else 0
    if report["probe"]["status"] == "failed" and type(candidate_count) is int and candidate_count > 0:
        report["probe"]["dll_load_trials"] = dll_load_trials(arguments, candidate_count, interpreter=interpreter, environment=environment)
    report["python"] = report["probe"].get("python", "unavailable")
    packages = report["probe"].get("packages")
    if isinstance(packages, dict):
        report.update({name: packages.get(name, "unavailable") for name in ("ctranslate2", "faster-whisper", "torch", "sherpa-onnx")})
    output = Path(arguments.output).resolve() if arguments.output else program / ".local/diagnostics" / ("whisper-gpu-" + time.strftime("%Y%m%d-%H%M%S") + ".json")
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
    print(json.dumps({"report": str(output), "probe": report["probe"]}, ensure_ascii=False), flush=True)
    return 0 if report["probe"]["status"] == "passed" else 2


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--program", default=str(Path(__file__).resolve().parents[1]))
    parser.add_argument("--model", default="large-v3-turbo", choices=("tiny", "base", "small", "medium", "large-v3", "distil-large-v3", "large-v3-turbo"))
    parser.add_argument("--sample")
    parser.add_argument("--output")
    parser.add_argument("--timeout", type=int, default=180, choices=range(30, 601))
    parser.add_argument("--child", action="store_true", help=argparse.SUPPRESS)
    parser.add_argument("--cache", help=argparse.SUPPRESS)
    parser.add_argument("--child-dll-load", action="store_true", help=argparse.SUPPRESS)
    parser.add_argument("--dll-directory", help=argparse.SUPPRESS)
    parser.add_argument("--candidate-index", type=int, choices=(0, 1), help=argparse.SUPPRESS)
    parser.add_argument("--dll-load-mode", choices=("bare", "absolute"), default="bare", help=argparse.SUPPRESS)
    args = parser.parse_args()
    if args.child_dll_load:
        print("DLL_PROBE_JSON=" + json.dumps(dll_load_probe(args), ensure_ascii=False), flush=True)
        return 0
    if args.child:
        print("GPU_PROBE_JSON=" + json.dumps(child_diagnostic(args), ensure_ascii=False), flush=True)
        return 0
    try:
        return run_diagnostic(args)
    except Exception as error:  # noqa: BLE001 - report setup/import failures without a private-path traceback
        print(json.dumps({"status": "not_tested", "error": safe_error(error)}, ensure_ascii=False), flush=True)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
