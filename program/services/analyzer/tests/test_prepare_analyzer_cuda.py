"""Synthetic archives only: no NVIDIA downloads, native DLLs, models or databases."""

import copy
import hashlib
import importlib.util
import io
import json
import os
import stat
import sys
import time
import urllib.error
import zipfile
from pathlib import Path
from types import SimpleNamespace

import pytest

SCRIPT = Path(__file__).resolve().parents[3] / "scripts/prepare_analyzer_cuda.py"
SPEC = importlib.util.spec_from_file_location("prepare_cuda_test", SCRIPT)
installer = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(installer)


class Response(io.BytesIO):
    status = 200

    def __init__(self, data, url, *, declared_length=None):
        super().__init__(data)
        self.url = url
        self.headers = {"Content-Length": str(len(data) if declared_length is None else declared_length)}

    def geturl(self):
        return self.url


def archive_bytes(spec, *, extra=(), missing=()):
    root = Path(spec["url"]).name.removesuffix(".zip")
    stream = io.BytesIO()
    with zipfile.ZipFile(stream, "w", compression=zipfile.ZIP_DEFLATED) as archive:
        for name in spec["dlls"]:
            if name not in missing:
                archive.writestr(root + "/bin/" + name, b"SYNTHETIC DLL fixture: " + name.encode())
        if "license" not in missing:
            archive.writestr(root + "/LICENSE", b"Synthetic test license, not NVIDIA binaries.")
        archive.writestr(root + "/include/ignored.h", b"not needed for runtime")
        for name, content in extra:
            archive.writestr(name, content)
    return stream.getvalue()


@pytest.fixture
def bundle(monkeypatch, tmp_path):
    spec = copy.deepcopy(installer.CUDA_RUNTIME_SPEC)
    data = {}
    for archive in spec["archives"].values():
        content = archive_bytes(archive)
        archive["size_bytes"] = len(content)
        archive["sha256"] = hashlib.sha256(content).hexdigest()
        data[archive["url"]] = content
    monkeypatch.setattr(installer, "CUDA_RUNTIME_SPEC", spec)
    monkeypatch.setattr(installer._runtime, "CUDA_RUNTIME_SPEC", spec)
    monkeypatch.setattr(installer, "_eligible", lambda _device: None)
    requests = []

    def open_request(request, *, timeout):
        requests.append((request.full_url, timeout))
        return Response(data[request.full_url], request.full_url)

    monkeypatch.setattr(installer.urllib.request, "build_opener", lambda *_args: SimpleNamespace(open=open_request))
    return SimpleNamespace(spec=spec, data=data, requests=requests, cache=tmp_path / "project/model-cache", progress=[])


def prepare(bundle, **options):
    return installer.ensure_cuda_runtime(bundle.cache, progress=bundle.progress.append, **options)


def test_installs_only_three_dlls_and_licenses_then_shared_validator_accepts(bundle):
    previous_path = os.environ.get("PATH")
    result = prepare(bundle)
    assert result["status"] == "prepared" and result["cuda_decode_verified"] is False
    assert result["version"] == bundle.spec["bundle"]
    root = Path(result["directory"])
    assert root == bundle.cache.parent / "cuda-runtime" / bundle.spec["bundle"]
    assert installer.validate_runtime(bundle.cache)["status"] == "ready"
    assert {path.name for path in (root / "bin").iterdir()} == set(installer.REQUIRED_DLLS)
    assert len(list((root / "licenses").rglob("LICENSE"))) == 2
    assert not list(root.rglob("ignored.h")) and not list(root.rglob("*.zip"))
    receipt = json.loads((root / "receipt.json").read_text())
    assert set(receipt["files"]) == set(installer.REQUIRED_DLLS)
    assert receipt["schema"] == "cuda12-runtime.v1"
    assert len(bundle.requests) == 2
    assert all(0 < timeout <= 30 for _url, timeout in bundle.requests)
    assert any(row["phase"] == "cuda_runtime_download" and row["downloaded_bytes"] == 0 for row in bundle.progress)
    assert bundle.progress[-1]["phase"] == "cuda_runtime_prepared"
    assert os.environ.get("PATH") == previous_path
    assert not list(root.parent.glob(".cuda-staging-*")) and not list(root.parent.rglob("*.part"))


def test_existing_valid_runtime_is_reused_without_network_or_mutation(bundle, monkeypatch):
    first = prepare(bundle)
    root = Path(first["directory"])
    before = {str(path.relative_to(root)): (path.stat().st_mtime_ns, path.read_bytes()) for path in root.rglob("*") if path.is_file()}
    monkeypatch.setattr(installer, "_download_archive", lambda *_a: pytest.fail("A valid runtime must not be replaced"))
    second = prepare(bundle)
    after = {str(path.relative_to(root)): (path.stat().st_mtime_ns, path.read_bytes()) for path in root.rglob("*") if path.is_file()}
    assert second["status"] == "ready" and before == after


def test_missing_or_invalid_no_download_does_not_prepare_anything(bundle):
    assert prepare(bundle, download=False)["status"] == "missing"
    root = installer.runtime_directory(bundle.cache)
    root.mkdir(parents=True)
    (root / "receipt.json").write_text("invalid synthetic receipt")
    assert prepare(bundle, download=False)["status"] == "invalid"
    assert bundle.requests == []
    assert not list(root.parent.glob(".cuda-staging-*"))


@pytest.mark.parametrize("device,platform_name,machine,gpu_count,reason", [
    ("cpu", "win32", "AMD64", 1, "CPU_OR_OTHER_DEVICE_SELECTED"),
    ("auto", "darwin", "arm64", 1, "WINDOWS_ONLY"),
    ("cuda", "win32", "ARM64", 1, "WINDOWS_X64_ONLY"),
    ("auto", "win32", "AMD64", 0, "CUDA_DEVICE_UNAVAILABLE"),
    ("auto", "win32", "AMD64", None, "CUDA_DEVICE_DISCOVERY_UNAVAILABLE"),
])
def test_eligibility_never_downloads_for_cpu_other_platform_or_missing_gpu(monkeypatch, device, platform_name, machine, gpu_count, reason):
    monkeypatch.setattr(installer.sys, "platform", platform_name)
    monkeypatch.setattr(installer.platform, "machine", lambda: machine)
    def get_count():
        if gpu_count is None:
            raise RuntimeError("synthetic native enumeration failure")
        return gpu_count
    monkeypatch.setattr(installer.importlib, "import_module", lambda _name: SimpleNamespace(get_cuda_device_count=get_count))
    assert installer._eligible(device) == reason


def test_prepare_eligible_skip_does_not_create_cache_or_load_runtime(monkeypatch, tmp_path):
    monkeypatch.setattr(installer, "_eligible", lambda _device: "CUDA_DEVICE_UNAVAILABLE")
    monkeypatch.setattr(installer, "validate_runtime", lambda _cache: pytest.fail("Skip must not access cache"))
    assert installer.ensure_cuda_runtime(tmp_path / "unused") == {"status": "skipped", "reason": "CUDA_DEVICE_UNAVAILABLE"}
    assert not list(tmp_path.iterdir())


@pytest.mark.parametrize("damage,code", [
    ("hash", "CUDA_ARCHIVE_HASH_MISMATCH"),
    ("truncated", "CUDA_ARCHIVE_SIZE_MISMATCH"),
    ("oversized", "CUDA_ARCHIVE_SIZE_MISMATCH"),
    ("headers", "CUDA_ARCHIVE_SIZE_MISMATCH"),
])
def test_download_failures_remove_partials_and_preserve_original_invalid_runtime(bundle, monkeypatch, damage, code):
    root = installer.runtime_directory(bundle.cache)
    root.mkdir(parents=True)
    old = root / "receipt.json"
    old.write_bytes(b"old invalid receipt must survive failed download")
    first = next(iter(bundle.spec["archives"].values()))
    data = bundle.data[first["url"]]
    if damage == "hash":
        damaged = bytes([data[0] ^ 1]) + data[1:]
    elif damage == "truncated":
        damaged = data[:-1]
    elif damage == "oversized":
        damaged = data + b"oversize"
    else:
        damaged = data
    header_length = len(data) if damage != "headers" else len(data) + 10
    monkeypatch.setattr(installer.urllib.request, "build_opener", lambda *_a: SimpleNamespace(open=lambda request, **_k: Response(damaged, request.full_url, declared_length=header_length)))
    with pytest.raises(installer.CudaRuntimePreparationError) as caught:
        prepare(bundle)
    assert caught.value.code == code
    assert old.read_bytes() == b"old invalid receipt must survive failed download"
    assert not list(root.parent.glob(".cuda-staging-*")) and not list(root.parent.rglob("*.part"))


@pytest.mark.parametrize("url", ["http://developer.download.nvidia.com/cuda.zip", "https://evil.invalid/cuda.zip", "https://developer.download.nvidia.com.evil.invalid/cuda.zip", "https://name:password@developer.download.nvidia.com/cuda.zip", "https://developer.download.nvidia.com:8443/cuda.zip"])
def test_non_official_or_insecure_source_and_redirect_are_rejected(url):
    with pytest.raises(installer.CudaRuntimePreparationError, match="NVIDIA HTTPS"):
        installer._official_url(url)
    with pytest.raises(installer.CudaRuntimePreparationError):
        installer._OfficialRedirects().redirect_request(None, None, 302, "redirect", {}, url)


def test_download_deadline_and_error_message_do_not_export_credentials(bundle, monkeypatch):
    def failure(*_args, **_kwargs):
        raise urllib.error.URLError("https://private:secret@proxy.invalid?api_key=SECRET_SENTINEL")
    monkeypatch.setattr(installer.urllib.request, "build_opener", lambda *_a: SimpleNamespace(open=failure))
    with pytest.raises(installer.CudaRuntimePreparationError) as caught:
        prepare(bundle)
    assert caught.value.code == "CUDA_RUNTIME_PREPARATION_FAILED"
    assert "SECRET_SENTINEL" not in str(caught.value) and "private" not in str(caught.value)
    assert not list(installer.runtime_directory(bundle.cache).parent.rglob("*.part"))
    with pytest.raises(installer.CudaRuntimePreparationError) as expired:
        installer._remaining(time.monotonic() - 1)
    assert expired.value.code == "CUDA_RUNTIME_PREPARATION_TIMEOUT"


def test_stream_crossing_total_deadline_removes_partial(bundle, monkeypatch, tmp_path):
    spec = bundle.spec["archives"]["cublas"]
    clock = [0]
    monkeypatch.setattr(installer.time, "monotonic", lambda: clock[0])
    class SlowResponse(Response):
        def read(self, count=-1):
            data = super().read(count)
            clock[0] = 11
            return data
    monkeypatch.setattr(installer.urllib.request, "build_opener", lambda *_a: SimpleNamespace(
        open=lambda request, **_k: SlowResponse(bundle.data[request.full_url], request.full_url)))
    with pytest.raises(installer.CudaRuntimePreparationError) as caught:
        installer._download_archive("cublas", spec, tmp_path, 10, bundle.progress.append)
    assert caught.value.code == "CUDA_RUNTIME_PREPARATION_TIMEOUT"
    assert not list(tmp_path.glob("*.part")) and not list(tmp_path.glob("*.zip"))


@pytest.mark.parametrize("unsafe", ["../escape.dll", "/absolute/escape.dll", "C:/escape.dll", "{root}/../escape.dll", "{root}/./bin/extra.dll", "{root}\\bin\\escape.dll"])
def test_zip_slip_and_ambiguous_paths_are_rejected_without_writing_outside_staging(bundle, tmp_path, unsafe):
    spec = bundle.spec["archives"]["cublas"]
    root = Path(spec["url"]).name.removesuffix(".zip")
    archive = tmp_path / "unsafe.zip"
    archive.write_bytes(archive_bytes(spec, extra=[(unsafe.format(root=root), b"unsafe")]))
    payload = tmp_path / "payload"
    payload.mkdir()
    with pytest.raises(installer.CudaRuntimePreparationError) as caught:
        installer._extract_archive("cublas", spec, archive, payload, time.monotonic() + 30)
    assert caught.value.code == "CUDA_ARCHIVE_UNSAFE_ENTRY" and not list(payload.iterdir())
    assert not (tmp_path / "escape.dll").exists()


def test_zip_symlink_duplicate_dll_and_missing_license_are_rejected(bundle, tmp_path):
    spec = bundle.spec["archives"]["cublas"]
    root = Path(spec["url"]).name.removesuffix(".zip")
    link = zipfile.ZipInfo(root + "/bin/extra-link")
    link.create_system = 3
    link.external_attr = (stat.S_IFLNK | 0o777) << 16
    cases = [
        archive_bytes(spec, extra=[(link, b"../../outside")]),
        archive_bytes(spec, extra=[(root + "/bin/CUBLAS64_12.DLL", b"duplicate")]),
        archive_bytes(spec, missing={"license"}),
    ]
    for index, data in enumerate(cases):
        archive = tmp_path / f"invalid-{index}.zip"
        archive.write_bytes(data)
        payload = tmp_path / f"payload-{index}"
        payload.mkdir()
        with pytest.raises(installer.CudaRuntimePreparationError):
            installer._extract_archive("cublas", spec, archive, payload, time.monotonic() + 30)
        assert not list(payload.iterdir())


def test_selected_uncompressed_size_limit_is_enforced_before_writing(bundle, monkeypatch, tmp_path):
    spec = bundle.spec["archives"]["cublas"]
    archive = tmp_path / "too-large.zip"
    archive.write_bytes(archive_bytes(spec))
    payload = tmp_path / "payload"
    payload.mkdir()
    monkeypatch.setattr(installer, "MAX_DLL_BYTES", 1)
    with pytest.raises(installer.CudaRuntimePreparationError):
        installer._extract_archive("cublas", spec, archive, payload, time.monotonic() + 30)
    assert not list(payload.iterdir())


def test_os_lock_rejects_concurrent_preparation_then_releases(tmp_path):
    with installer._preparation_lock(tmp_path):
        with pytest.raises(installer.CudaRuntimePreparationError) as caught, installer._preparation_lock(tmp_path):
            pytest.fail("Concurrent lock must not be acquired")
        assert caught.value.code == "CUDA_RUNTIME_PREPARATION_BUSY"
    with installer._preparation_lock(tmp_path):
        pass


def test_publish_failure_restores_original_invalid_runtime(bundle, monkeypatch):
    root = installer.runtime_directory(bundle.cache)
    root.mkdir(parents=True)
    (root / "receipt.json").write_bytes(b"prior runtime")
    original = installer.os.replace
    def replace(source, destination):
        if Path(source).name == "runtime" and Path(destination) == root:
            raise OSError("synthetic atomic publish failure with private details")
        return original(source, destination)
    monkeypatch.setattr(installer.os, "replace", replace)
    with pytest.raises(installer.CudaRuntimePreparationError):
        prepare(bundle)
    assert (root / "receipt.json").read_bytes() == b"prior runtime"
    assert not list(root.parent.glob(".cuda-staging-*"))
    assert not list(root.parent.glob(".cuda-invalid-*"))


def test_publish_failure_cannot_delete_valid_install_that_won_the_race(bundle, monkeypatch):
    import shutil
    root = installer.runtime_directory(bundle.cache)
    original = installer.os.replace
    def replace(source, destination):
        if Path(source).name == "runtime" and Path(destination) == root:
            shutil.copytree(source, root)
            raise FileExistsError("Another valid runtime appeared before rename")
        return original(source, destination)
    monkeypatch.setattr(installer.os, "replace", replace)
    with pytest.raises(installer.CudaRuntimePreparationError):
        prepare(bundle)
    assert installer.validate_runtime(bundle.cache)["status"] == "ready"
    assert not list(root.parent.glob(".cuda-staging-*"))


def test_valid_install_appearing_during_download_is_never_replaced(bundle, monkeypatch):
    root = installer.runtime_directory(bundle.cache)
    original = installer._verify_staging
    witness = {}
    def verify_and_publish_elsewhere(payload, receipt, deadline):
        original(payload, receipt, deadline)
        shutil = __import__("shutil")
        shutil.copytree(payload, root)
        (root / "receipt.json").write_text(json.dumps(receipt))
        witness["inode"] = root.stat().st_ino
    monkeypatch.setattr(installer, "_verify_staging", verify_and_publish_elsewhere)
    assert prepare(bundle)["status"] == "ready"
    assert root.stat().st_ino == witness["inode"]
    assert installer.validate_runtime(bundle.cache)["status"] == "ready"


def test_portable_helper_loads_without_importing_analyzer_package(tmp_path):
    import subprocess
    (tmp_path / SCRIPT.name).write_bytes(SCRIPT.read_bytes())
    shared = SCRIPT.parents[1] / "services/analyzer/liming_analyzer/cuda_runtime.py"
    (tmp_path / "cuda_runtime.py").write_bytes(shared.read_bytes())
    result = subprocess.run([sys.executable, "-I", "-S", "-B", str(tmp_path / SCRIPT.name), "--model-cache", str(tmp_path / "cache"), "--device", "cpu"], capture_output=True, text=True, timeout=10, check=False)
    assert result.returncode == 0
    assert json.loads(result.stdout)["status"] == "skipped"
    assert not list(tmp_path.rglob("__pycache__"))
