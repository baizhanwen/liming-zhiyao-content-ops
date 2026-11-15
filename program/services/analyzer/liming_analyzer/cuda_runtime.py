"""Validate and load this installation's optional Windows CUDA runtime.

This module never installs or downloads anything. Disk validation does not
establish that a GPU inference has succeeded.
"""
from __future__ import annotations

import hashlib
import json
import os
import re
import sys
from pathlib import Path
from threading import RLock

CUDA_RUNTIME_SPEC = {
    "schema": "cuda12-runtime.v1",
    "bundle": "cuda12-12.8.4.1",
    "archives": {
        "cublas": {
            "dlls": ("cublas64_12.dll", "cublasLt64_12.dll"),
            "version": "12.8.4.1",
            "url": "https://developer.download.nvidia.com/compute/cuda/redist/libcublas/windows-x86_64/libcublas-windows-x86_64-12.8.4.1-archive.zip",
            "size_bytes": 563660944,
            "sha256": "57a470112cec7e112c95253dde8b3c7184d795dbd92b0bde77a4cb7f8c94c8aa",
        },
        "cudart": {
            "dlls": ("cudart64_12.dll",),
            "version": "12.8.90",
            "url": "https://developer.download.nvidia.com/compute/cuda/redist/cuda_cudart/windows-x86_64/cuda_cudart-windows-x86_64-12.8.90-archive.zip",
            "size_bytes": 3037735,
            "sha256": "4a39058fd8519444a81cfc7ae055d136f48d1a31ffa41ae255b35b2edd61e13b",
        },
    },
}
# Dependency load order is intentional.
REQUIRED_DLLS = ("cudart64_12.dll", "cublasLt64_12.dll", "cublas64_12.dll")
_lock = RLock()
_hashes = {}
_active = {}
_libraries = []
_directory_handles = []


def runtime_directory(model_cache) -> Path:
    return Path(model_cache).expanduser().resolve().parent / "cuda-runtime" / CUDA_RUNTIME_SPEC["bundle"]


def _file_hash(path: Path, stat) -> str:
    key = (str(path), stat.st_size, stat.st_mtime_ns, stat.st_ctime_ns, stat.st_ino, stat.st_dev)
    with _lock:
        if key not in _hashes:
            digest = hashlib.sha256()
            with path.open("rb") as stream:
                for chunk in iter(lambda: stream.read(1024 * 1024), b""):
                    digest.update(chunk)
            if len(_hashes) >= 24:
                _hashes.clear()
            _hashes[key] = digest.hexdigest()
        return _hashes[key]


def validate_runtime(model_cache) -> dict:
    directory = runtime_directory(model_cache)
    base = {"directory": str(directory), "version": CUDA_RUNTIME_SPEC["bundle"]}
    def invalid(reason):
        return {**base, "status": "invalid", "reason": reason}
    try:
        if not directory.exists() and not directory.is_symlink():
            return {**base, "status": "missing", "reason": "CUDA_RUNTIME_NOT_INSTALLED"}
        if not directory.is_dir() or directory.resolve(strict=True) != directory:
            return invalid("CUDA_RUNTIME_DIRECTORY_INVALID")
        receipt_path = directory / "receipt.json"
        if receipt_path.is_symlink() or not receipt_path.is_file() or receipt_path.stat().st_size > 65536:
            return invalid("CUDA_RUNTIME_RECEIPT_INVALID")
        receipt = json.loads(receipt_path.read_text(encoding="utf-8"))
        if not isinstance(receipt, dict) or receipt.get("schema") != CUDA_RUNTIME_SPEC["schema"]:
            return invalid("CUDA_RUNTIME_SCHEMA_INVALID")
        archives = receipt.get("archives")
        if not isinstance(archives, dict) or set(archives) != set(CUDA_RUNTIME_SPEC["archives"]):
            return invalid("CUDA_RUNTIME_ARCHIVES_INVALID")
        for name, expected in CUDA_RUNTIME_SPEC["archives"].items():
            actual = archives[name]
            if (not isinstance(actual, dict) or actual.get("version") != expected["version"]
                    or actual.get("sha256") != expected["sha256"]
                    or ("size_bytes" in actual and actual["size_bytes"] != expected["size_bytes"])):
                return invalid("CUDA_RUNTIME_ARCHIVE_IDENTITY_INVALID")
        files = receipt.get("files")
        if not isinstance(files, dict) or set(files) != set(REQUIRED_DLLS):
            return invalid("CUDA_RUNTIME_FILES_INVALID")
        checked = {}
        for name in REQUIRED_DLLS:
            record = files[name]
            if (not isinstance(record, dict) or type(record.get("size_bytes")) is not int
                    or record["size_bytes"] <= 0 or not isinstance(record.get("sha256"), str)
                    or re.fullmatch(r"[a-f0-9]{64}", record["sha256"]) is None):
                return invalid("CUDA_RUNTIME_FILE_RECEIPT_INVALID")
            path = directory / "bin" / name
            if path.is_symlink() or not path.is_file() or not path.resolve(strict=True).is_relative_to(directory):
                return invalid("CUDA_RUNTIME_DLL_PATH_INVALID")
            stat = path.stat()
            if stat.st_size != record["size_bytes"] or _file_hash(path, stat) != record["sha256"]:
                return invalid("CUDA_RUNTIME_DLL_INTEGRITY_FAILED")
            checked[name] = {"size_bytes": stat.st_size, "sha256": record["sha256"]}
        return {**base, "status": "ready", "files": checked}
    except (OSError, ValueError, TypeError, KeyError):
        return invalid("CUDA_RUNTIME_RECEIPT_OR_FILE_UNREADABLE")


def activate_windows_cuda(model_cache) -> dict:
    """Load verified local DLLs only in this process, before Whisper CUDA use."""
    if sys.platform != "win32":
        return {"status": "not_applicable", "reason": "WINDOWS_ONLY"}
    state = validate_runtime(model_cache)
    if state["status"] == "missing":
        return state
    if state["status"] != "ready":
        raise RuntimeError("CUDA managed runtime validation failed: " + state["reason"])
    directory = Path(state["directory"])
    with _lock:
        if str(directory) in _active:
            active = _active[str(directory)]
            if active["files"] != state["files"]:
                raise RuntimeError("CUDA runtime changed after activation; restart the analysis process")
            return dict(active["metadata"])
        import ctypes
        previous_path = os.environ.get("PATH")
        handle = None
        try:
            binary = directory / "bin"
            handle = os.add_dll_directory(str(binary))
            os.environ["PATH"] = str(binary) + (os.pathsep + previous_path if previous_path else "")
            kernel = ctypes.WinDLL("kernel32", use_last_error=True)
            kernel.GetModuleFileNameW.argtypes = [ctypes.c_void_p, ctypes.c_wchar_p, ctypes.c_ulong]
            kernel.GetModuleFileNameW.restype = ctypes.c_ulong
            kernel.GetModuleHandleW.argtypes = [ctypes.c_wchar_p]
            kernel.GetModuleHandleW.restype = ctypes.c_void_p
            def module_path(module):
                buffer = ctypes.create_unicode_buffer(32768)
                length = kernel.GetModuleFileNameW(module, buffer, len(buffer))
                if not length or length >= len(buffer):
                    raise RuntimeError("CUDA loaded DLL location could not be verified")
                return Path(buffer.value).resolve(strict=True)
            loaded = {}
            for name in REQUIRED_DLLS:
                path = binary / name
                existing = kernel.GetModuleHandleW(name)
                if existing and module_path(existing) != path.resolve(strict=True):
                    # CT2's later bare LoadLibraryA reuses the first loaded
                    # module with this basename, even after an absolute load.
                    raise RuntimeError("CUDA DLL basename is already loaded from a different runtime")
                library = ctypes.WinDLL(str(path), use_last_error=True, winmode=0x1100)
                _libraries.append(library)
                actual = module_path(library._handle)
                if actual != path.resolve(strict=True):
                    raise RuntimeError("CUDA loaded DLL location conflicts with the managed runtime")
                loaded[name] = str(actual)
            _directory_handles.append(handle)
            metadata = {"status": "ready", "version": state["version"], "loaded_paths": loaded}
            _active[str(directory)] = {"metadata": metadata, "files": state["files"]}
            return dict(metadata)
        except (OSError, RuntimeError, ValueError) as error:
            if previous_path is None:
                os.environ.pop("PATH", None)
            else:
                os.environ["PATH"] = previous_path
            if handle is not None:
                handle.close()
            # Include CUDA so the existing auto backend can safely retry on CPU.
            raise RuntimeError("CUDA managed runtime activation failed (" + type(error).__name__ + "): " + str(error)) from error
