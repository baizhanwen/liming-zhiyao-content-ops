"""Prepare pinned NVIDIA CUDA DLLs in this project's cache, without pip or drivers."""
from __future__ import annotations

import argparse
import contextlib
import hashlib
import importlib
import importlib.util
import json
import math
import os
import platform
import shutil
import stat
import struct
import sys
import tempfile
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid
import zipfile
from pathlib import Path, PurePosixPath


def _load_runtime_module():
    # Loading by filename avoids liming_analyzer.__init__ and its optional model
    # dependencies. Portable repair bundles carry this exact shared file beside us.
    candidates = (
        Path(__file__).resolve().parent / "cuda_runtime.py",
        Path(__file__).resolve().parents[1] / "services/analyzer/liming_analyzer/cuda_runtime.py",
    )
    for path in candidates:
        if path.is_file():
            specification = importlib.util.spec_from_file_location("_analyzer_cuda_runtime_installer", path)
            module = importlib.util.module_from_spec(specification)
            specification.loader.exec_module(module)
            return module
    raise RuntimeError("The shared CUDA runtime helper is missing from this package.")


_runtime = _load_runtime_module()
CUDA_RUNTIME_SPEC = _runtime.CUDA_RUNTIME_SPEC
REQUIRED_DLLS = _runtime.REQUIRED_DLLS
runtime_directory = _runtime.runtime_directory
validate_runtime = _runtime.validate_runtime
OFFICIAL_HOST = "developer.download.nvidia.com"
MAX_DLL_BYTES = 2 * 1024**3
MAX_SELECTED_BYTES = 3 * 1024**3
MAX_LICENSE_BYTES = 2 * 1024**2
MAX_ZIP_ENTRIES = 4096
LICENSE_NAMES = {"license", "license.txt", "license.md", "eula", "eula.txt", "notice", "notice.txt"}


class CudaRuntimePreparationError(RuntimeError):
    """A stable public error code and a message without credentials or local paths."""

    def __init__(self, code, message):
        super().__init__(message)
        self.code = code


def _emit(progress, phase, **values):
    record = {"phase": phase, **values}
    if progress is not None:
        progress(record)
    else:
        print(json.dumps(record, ensure_ascii=False), flush=True)


def _remaining(deadline):
    remaining = deadline - time.monotonic()
    if remaining <= 0:
        raise CudaRuntimePreparationError("CUDA_RUNTIME_PREPARATION_TIMEOUT", "CUDA runtime preparation timed out; retry setup.")
    return remaining


def _official_url(url):
    parsed = urllib.parse.urlsplit(url)
    try:
        valid = (parsed.scheme == "https" and parsed.hostname == OFFICIAL_HOST
                 and parsed.port in {None, 443} and not parsed.username and not parsed.password)
    except ValueError:
        valid = False
    if not valid:
        raise CudaRuntimePreparationError("CUDA_ARCHIVE_SOURCE_REJECTED", "CUDA runtime downloads must use the pinned NVIDIA HTTPS source.")
    return url


class _OfficialRedirects(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, request, response, code, message, headers, new_url):
        _official_url(new_url)
        return super().redirect_request(request, response, code, message, headers, new_url)


def _download_archive(component, spec, directory, deadline, progress):
    url = _official_url(spec["url"])
    target = directory / (component + ".zip")
    partial = target.with_suffix(".zip.part")
    expected_size = spec["size_bytes"]
    digest = hashlib.sha256()
    count = 0
    last_notice = time.monotonic()
    _emit(progress, "cuda_runtime_download", component=component, downloaded_bytes=0, total_bytes=expected_size)
    opener = urllib.request.build_opener(_OfficialRedirects())
    request = urllib.request.Request(url, headers={"User-Agent": "LimingZhiyao-CUDA-Setup/1", "Accept-Encoding": "identity"})
    try:
        with opener.open(request, timeout=min(30, _remaining(deadline))) as response:
            _official_url(response.geturl())
            if response.status != 200:
                raise CudaRuntimePreparationError("CUDA_ARCHIVE_DOWNLOAD_FAILED", "The NVIDIA server did not return the complete CUDA archive.")
            length = response.headers.get("Content-Length")
            if length is not None and (not length.isdigit() or int(length) != expected_size):
                raise CudaRuntimePreparationError("CUDA_ARCHIVE_SIZE_MISMATCH", "The CUDA archive length does not match the pinned release.")
            with partial.open("xb") as output:
                while True:
                    _remaining(deadline)
                    chunk = response.read(1024 * 1024)
                    _remaining(deadline)
                    if not chunk:
                        break
                    count += len(chunk)
                    if count > expected_size:
                        raise CudaRuntimePreparationError("CUDA_ARCHIVE_SIZE_MISMATCH", "The CUDA archive exceeds the pinned release length.")
                    digest.update(chunk)
                    output.write(chunk)
                    now = time.monotonic()
                    if now - last_notice >= 1:
                        _emit(progress, "cuda_runtime_download", component=component, downloaded_bytes=count, total_bytes=expected_size)
                        last_notice = now
                output.flush()
                os.fsync(output.fileno())
        if count != expected_size:
            raise CudaRuntimePreparationError("CUDA_ARCHIVE_SIZE_MISMATCH", "The CUDA archive is incomplete; retry setup.")
        if digest.hexdigest() != spec["sha256"]:
            raise CudaRuntimePreparationError("CUDA_ARCHIVE_HASH_MISMATCH", "The CUDA archive checksum does not match the pinned NVIDIA release.")
        os.replace(partial, target)
        _emit(progress, "cuda_runtime_download_verified", component=component, downloaded_bytes=count, total_bytes=expected_size)
        return target
    finally:
        partial.unlink(missing_ok=True)


def _safe_zip_parts(info):
    name = info.orig_filename
    parts = PurePosixPath(name).parts
    mode = info.external_attr >> 16
    if (not parts or "\x00" in name or "\\" in name or name.startswith("/") or "." in name.split("/")
            or any(part in {".", ".."} or ":" in part for part in parts)
            or stat.S_IFMT(mode) not in {0, stat.S_IFREG, stat.S_IFDIR}
            or info.flag_bits & 1):
        raise CudaRuntimePreparationError("CUDA_ARCHIVE_UNSAFE_ENTRY", "The CUDA archive contains an unsupported file path or file type.")
    return parts


def _copy_zip_entry(archive, info, destination, deadline):
    digest = hashlib.sha256()
    count = 0
    destination.parent.mkdir(parents=True, exist_ok=True)
    with archive.open(info) as source, destination.open("xb") as output:
        while True:
            _remaining(deadline)
            chunk = source.read(1024 * 1024)
            if not chunk:
                break
            count += len(chunk)
            if count > info.file_size:
                raise CudaRuntimePreparationError("CUDA_ARCHIVE_SIZE_MISMATCH", "A CUDA archive entry exceeds its declared size.")
            output.write(chunk)
            digest.update(chunk)
        output.flush()
        os.fsync(output.fileno())
    if count != info.file_size:
        raise CudaRuntimePreparationError("CUDA_ARCHIVE_SIZE_MISMATCH", "A CUDA archive entry is incomplete.")
    return {"size_bytes": count, "sha256": digest.hexdigest()}


def _extract_archive(component, spec, filename, payload, deadline):
    root_name = Path(urllib.parse.urlsplit(spec["url"]).path).name.removesuffix(".zip")
    required = {name.casefold(): name for name in spec["dlls"]}
    selected, files, licenses = [], {}, {}
    seen, total = set(), 0
    with zipfile.ZipFile(filename) as archive:
        entries = archive.infolist()
        if len(entries) > MAX_ZIP_ENTRIES:
            raise CudaRuntimePreparationError("CUDA_ARCHIVE_TOO_LARGE", "The CUDA archive contains too many entries.")
        for info in entries:
            parts = _safe_zip_parts(info)
            if info.is_dir():
                continue
            target = None
            if len(parts) == 3 and parts[:2] == (root_name, "bin") and parts[2].casefold() in required:
                target = Path("bin") / required[parts[2].casefold()]
                limit = MAX_DLL_BYTES
            elif len(parts) == 2 and parts[0] == root_name and parts[1].casefold() in LICENSE_NAMES:
                target = Path("licenses") / component / parts[1]
                limit = MAX_LICENSE_BYTES
            if target is None:
                continue
            identity = str(target).casefold()
            total += info.file_size
            if (identity in seen or info.file_size <= 0 or info.file_size > limit
                    or total > MAX_SELECTED_BYTES or info.compress_size <= 0
                    or info.file_size > max(1024 * 1024, info.compress_size * 200)):
                raise CudaRuntimePreparationError("CUDA_ARCHIVE_UNSAFE_ENTRY", "A selected CUDA archive entry is duplicated or exceeds safe extraction limits.")
            seen.add(identity)
            selected.append((info, target))
        selected_dlls = {path.name for _entry, path in selected if path.parts[0] == "bin"}
        if selected_dlls != set(spec["dlls"]) or not any(path.parts[0] == "licenses" for _entry, path in selected):
            raise CudaRuntimePreparationError("CUDA_ARCHIVE_LAYOUT_INVALID", "The pinned CUDA archive is missing required DLLs or license files.")
        for info, relative in selected:
            record = _copy_zip_entry(archive, info, payload / relative, deadline)
            if relative.parts[0] == "bin":
                files[relative.name] = record
            else:
                licenses[relative.as_posix()] = record
    return files, licenses


def _hash_file(path, deadline):
    digest = hashlib.sha256()
    with path.open("rb") as source:
        for chunk in iter(lambda: source.read(1024 * 1024), b""):
            _remaining(deadline)
            digest.update(chunk)
    return digest.hexdigest()


def _validated_runtime(model_cache, deadline):
    _remaining(deadline)
    state = validate_runtime(model_cache)
    _remaining(deadline)
    return state


def _verify_staging(payload, receipt, deadline):
    if set(receipt["files"]) != set(REQUIRED_DLLS):
        raise CudaRuntimePreparationError("CUDA_RUNTIME_STAGING_INVALID", "CUDA runtime staging is incomplete.")
    records = {"bin/" + name: record for name, record in receipt["files"].items()}
    records.update(receipt["licenses"])
    for relative, record in records.items():
        path = payload / relative
        if path.is_symlink() or not path.is_file() or path.stat().st_size != record["size_bytes"] or _hash_file(path, deadline) != record["sha256"]:
            raise CudaRuntimePreparationError("CUDA_RUNTIME_STAGING_INVALID", "CUDA runtime staging failed its integrity check.")


@contextlib.contextmanager
def _preparation_lock(base):
    # OS locks are released on a crash. Keeping the tiny lock file avoids the
    # unlink/recreate race that can otherwise admit two preparation processes.
    lock_path = base / ".prepare.lock"
    if lock_path.is_symlink():
        raise CudaRuntimePreparationError("CUDA_RUNTIME_DIRECTORY_INVALID", "The CUDA preparation lock must be a local file.")
    with lock_path.open("a+b") as stream:
        if stream.tell() == 0:
            stream.write(b"\0")
            stream.flush()
        stream.seek(0)
        locked = False
        try:
            try:
                if os.name == "nt":
                    import msvcrt
                    msvcrt.locking(stream.fileno(), msvcrt.LK_NBLCK, 1)
                else:
                    import fcntl
                    fcntl.flock(stream.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
                locked = True
            except OSError:
                raise CudaRuntimePreparationError("CUDA_RUNTIME_PREPARATION_BUSY", "Another CUDA runtime preparation is running; retry after it finishes.") from None
            yield
        finally:
            if locked:
                stream.seek(0)
                if os.name == "nt":
                    msvcrt.locking(stream.fileno(), msvcrt.LK_UNLCK, 1)
                else:
                    fcntl.flock(stream.fileno(), fcntl.LOCK_UN)


def _eligible(device):
    if device not in {"auto", "cuda"}:
        return "CPU_OR_OTHER_DEVICE_SELECTED"
    if sys.platform != "win32":
        return "WINDOWS_ONLY"
    if platform.machine().casefold() not in {"amd64", "x86_64"} or struct.calcsize("P") != 8:
        return "WINDOWS_X64_ONLY"
    try:
        backend = importlib.import_module("ctranslate2")
        if backend.get_cuda_device_count() < 1:
            return "CUDA_DEVICE_UNAVAILABLE"
    except Exception:  # noqa: BLE001 - backend discovery failures must not trigger downloads
        return "CUDA_DEVICE_DISCOVERY_UNAVAILABLE"
    return None


def _remove(path):
    if path.is_dir() and not path.is_symlink():
        shutil.rmtree(path)
    else:
        path.unlink(missing_ok=True)


def ensure_cuda_runtime(model_cache, *, device="auto", download=True, timeout=1800, progress=None):
    """Return ready/prepared/skipped; failed preparation raises a sanitized error.

    ``download=False`` also returns missing/invalid from the shared validator.
    Neither a verified installation nor DLL loading establishes GPU decoding.
    """
    reason = _eligible(device)
    if reason:
        return {"status": "skipped", "reason": reason}
    if not isinstance(timeout, (int, float)) or isinstance(timeout, bool) or not math.isfinite(timeout) or timeout <= 0:
        raise ValueError("timeout must be a positive finite number of seconds")
    deadline = time.monotonic() + timeout
    state = _validated_runtime(model_cache, deadline)
    if state["status"] == "ready" or not download:
        return state
    root = runtime_directory(model_cache)
    base = root.parent
    try:
        if base.is_symlink():
            raise CudaRuntimePreparationError("CUDA_RUNTIME_DIRECTORY_INVALID", "The managed CUDA runtime parent must be a local directory.")
        base.mkdir(parents=True, exist_ok=True)
        with _preparation_lock(base):
            state = _validated_runtime(model_cache, deadline)
            if state["status"] == "ready":
                return state
            with tempfile.TemporaryDirectory(prefix=".cuda-staging-", dir=base) as temporary:
                workspace = Path(temporary)
                payload = workspace / "runtime"
                payload.mkdir()
                archives = workspace / "archives"
                archives.mkdir()
                receipt = {"schema": CUDA_RUNTIME_SPEC["schema"], "bundle": CUDA_RUNTIME_SPEC["bundle"],
                           "platform": "windows-x86_64", "archives": {}, "files": {}, "licenses": {}}
                for component, spec in CUDA_RUNTIME_SPEC["archives"].items():
                    filename = _download_archive(component, spec, archives, deadline, progress)
                    _emit(progress, "cuda_runtime_extract", component=component)
                    files, licenses = _extract_archive(component, spec, filename, payload, deadline)
                    receipt["files"].update(files)
                    receipt["licenses"].update(licenses)
                    receipt["archives"][component] = {key: spec[key] for key in ("version", "sha256", "size_bytes")}
                    filename.unlink()
                _emit(progress, "cuda_runtime_verify")
                _verify_staging(payload, receipt, deadline)
                with (payload / "receipt.json").open("x", encoding="utf-8") as stream:
                    json.dump(receipt, stream, ensure_ascii=False, indent=2)
                    stream.write("\n")
                    stream.flush()
                    os.fsync(stream.fileno())
                # A valid directory may already be loaded by a running worker.
                # Never rename or replace it, even if it appeared during download.
                state = _validated_runtime(model_cache, deadline)
                if state["status"] == "ready":
                    return state
                backup = base / (".cuda-invalid-" + uuid.uuid4().hex)
                previous = root.exists() or root.is_symlink()
                if previous:
                    os.replace(root, backup)
                published = False
                try:
                    os.replace(payload, root)
                    published = True
                    installed = _validated_runtime(model_cache, deadline)
                    if installed["status"] != "ready":
                        raise CudaRuntimePreparationError("CUDA_RUNTIME_STAGING_INVALID", "The published CUDA runtime did not pass validation.")
                except BaseException:
                    if published and (root.exists() or root.is_symlink()):
                        _remove(root)
                    if previous and not root.exists() and not root.is_symlink():
                        os.replace(backup, root)
                    raise
                if previous:
                    try:
                        _remove(backup)
                    except OSError:
                        _emit(progress, "cuda_runtime_cleanup_pending")
                _emit(progress, "cuda_runtime_prepared", version=CUDA_RUNTIME_SPEC["bundle"])
                return {**installed, "status": "prepared", "cuda_decode_verified": False}
    except CudaRuntimePreparationError:
        raise
    except (OSError, ValueError, urllib.error.URLError, zipfile.BadZipFile, RuntimeError) as error:
        raise CudaRuntimePreparationError("CUDA_RUNTIME_PREPARATION_FAILED", "CUDA runtime preparation failed (" + type(error).__name__ + "); retry setup.") from None


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--model-cache", required=True)
    parser.add_argument("--device", default="auto", choices=("auto", "cuda", "cpu"))
    parser.add_argument("--no-download", action="store_true")
    parser.add_argument("--timeout", type=float, default=1800)
    arguments = parser.parse_args()
    try:
        result = ensure_cuda_runtime(arguments.model_cache, device=arguments.device,
                                     download=not arguments.no_download, timeout=arguments.timeout)
        print(json.dumps(result, ensure_ascii=False), flush=True)
        return 0 if result["status"] in {"ready", "prepared", "skipped"} else 2
    except CudaRuntimePreparationError as error:
        print(json.dumps({"status": "failed", "code": error.code, "message": str(error)}, ensure_ascii=False), flush=True)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
