import builtins
import importlib.util
import json
import os
import subprocess
import sys
import wave
from pathlib import Path
from types import SimpleNamespace

import pytest


SCRIPT = Path(__file__).resolve().parents[3] / "scripts/check_analyzer_cuda.py"
SPEC = importlib.util.spec_from_file_location("check_cuda_script_test", SCRIPT)
check = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(check)


@pytest.fixture(autouse=True)
def isolated_offline_flags(monkeypatch):
    for name in ("HF_HUB_OFFLINE", "TRANSFORMERS_OFFLINE", "HF_HUB_DISABLE_TELEMETRY", "PYTHONDONTWRITEBYTECODE"):
        monkeypatch.setenv(name, os.environ.get(name, "not-yet-enabled"))


def arguments(tmp_path, *, device="auto", seconds=1):
    sample = tmp_path / "sample.wav"
    with wave.open(str(sample), "wb") as output:
        output.setparams((1, 2, 16000, 0, "NONE", "not compressed"))
        output.writeframes(b"\x01\x00" * int(seconds * 16000))
    return SimpleNamespace(model_cache=str(tmp_path / "models"), model="small", language="zh",
                           sample=str(sample), device=device)


def cached_model(args):
    folder = Path(args.model_cache) / ("faster-whisper-" + args.model)
    folder.mkdir(parents=True)
    for filename in ("model.bin", "config.json", "tokenizer.json"):
        (folder / filename).write_bytes(b"fixture")


@pytest.mark.parametrize("platform,device,reason,status", [("darwin", "auto", "WINDOWS_ONLY", "not_verified"),
    ("win32", "cpu", "CPU_REQUESTED", "cpu")])
def test_skipped_platform_or_cpu_never_imports_any_model_dependency(monkeypatch, tmp_path, platform, device, reason, status):
    monkeypatch.setattr(check.sys, "platform", platform)
    args = arguments(tmp_path, device=device)
    original = builtins.__import__
    def guarded(name, *args, **kwargs):
        if name.startswith(("ctranslate2", "faster_whisper", "liming_analyzer", "torch")):
            pytest.fail("skipped check must not import model dependencies")
        return original(name, *args, **kwargs)
    monkeypatch.setattr(builtins, "__import__", guarded)
    result = check.check_cuda(args)
    assert result["status"] == status and result["reason"] == reason and result["gpuVerified"] is False
    assert not Path(args.model_cache).exists()


def test_no_nvidia_gpu_is_not_verified_and_does_not_load_recognizer(monkeypatch, tmp_path):
    monkeypatch.setattr(check.sys, "platform", "win32")
    monkeypatch.setitem(sys.modules, "ctranslate2", SimpleNamespace(get_cuda_device_count=lambda: 0))
    result = check.check_cuda(arguments(tmp_path))
    assert result["status"] == "not_verified" and result["reason"] == "NVIDIA_GPU_NOT_FOUND"


def test_incomplete_model_does_not_create_cache_or_download(monkeypatch, tmp_path):
    monkeypatch.setattr(check.sys, "platform", "win32")
    monkeypatch.setitem(sys.modules, "ctranslate2", SimpleNamespace(get_cuda_device_count=lambda: 1))
    args = arguments(tmp_path)
    result = check.check_cuda(args)
    assert result["status"] == "not_verified" and result["reason"] == "LOCAL_MODEL_INCOMPLETE"
    assert not Path(args.model_cache).exists()


@pytest.mark.parametrize("variant", ["missing", "not_wave", "too_long"])
def test_only_the_bounded_pcm_short_sample_is_accepted(monkeypatch, tmp_path, variant):
    monkeypatch.setattr(check.sys, "platform", "win32")
    monkeypatch.setitem(sys.modules, "ctranslate2", SimpleNamespace(get_cuda_device_count=lambda: 1))
    args = arguments(tmp_path, seconds=16 if variant == "too_long" else 1)
    cached_model(args)
    if variant == "missing":
        Path(args.sample).unlink()
    elif variant == "not_wave":
        Path(args.sample).write_bytes(b"not a wave")
    result = check.check_cuda(args)
    assert result["status"] == "failed" and result["failure"]["code"] == "CUDA_CHECK_SAMPLE_INVALID"


@pytest.mark.parametrize("outcome", ["success", "lazy_failure", "silence"])
def test_real_public_recognizer_uses_cuda_only_and_exhausts_output_without_exporting_text(monkeypatch, tmp_path, outcome):
    importlib.import_module("liming_analyzer.faster_whisper_asr")
    monkeypatch.setattr(check.sys, "platform", "win32")
    monkeypatch.setitem(sys.modules, "ctranslate2", SimpleNamespace(get_cuda_device_count=lambda: 1))
    args = arguments(tmp_path)
    cached_model(args)
    calls, consumed = [], []
    private_sample_words = "SAMPLE_TRANSCRIPT_MUST_NOT_BE_STORED"
    class Engine:
        def __init__(self, folder, **options):
            calls.append((folder, options))
        def transcribe(self, sample, **options):
            assert sample == args.sample and options["vad_filter"]
            def rows():
                if outcome != "silence":
                    yield SimpleNamespace(start=0, end=1, text=private_sample_words)
                consumed.append(True)
                if outcome == "lazy_failure":
                    raise RuntimeError("Library cublas64_12.dll is not found or cannot be loaded")
            return rows(), SimpleNamespace(language="zh")
    monkeypatch.setitem(sys.modules, "faster_whisper", SimpleNamespace(WhisperModel=Engine))
    monkeypatch.setitem(sys.modules, "faster_whisper.utils", SimpleNamespace(download_model=lambda *_a, **_k: pytest.fail("offline check cannot download")))
    result = check.check_cuda(args)
    assert consumed == [True] and len(calls) == 1
    assert calls[0][1]["device"] == "cuda" and calls[0][1]["local_files_only"] is True
    assert private_sample_words not in json.dumps(result)
    assert result["probe"] == "asr-check-zh.v1" and result["checkedAt"].endswith("Z")
    assert check.os.environ["HF_HUB_OFFLINE"] == "1" and check.os.environ["TRANSFORMERS_OFFLINE"] == "1"
    if outcome == "success":
        assert result["status"] == "verified" and result["gpuVerified"] is True
    elif outcome == "lazy_failure":
        assert result["status"] == "failed" and result["failure"]["code"] == "CUDA_LIBRARY_UNAVAILABLE"
    else:
        assert result["status"] == "failed" and result["failure"]["code"] == "CUDA_CHECK_NO_SPEECH_OUTPUT"


def test_cpu_cli_works_with_no_site_packages_and_emits_one_json_without_writes(tmp_path):
    result = subprocess.run([sys.executable, "-I", "-S", "-B", str(SCRIPT), "--model-cache", str(tmp_path / "models"),
                             "--model", "small", "--sample", str(tmp_path / "unused.wav"), "--device", "cpu"],
                            capture_output=True, text=True, timeout=10, check=False)
    assert result.returncode == 0, result.stderr
    report = json.loads(result.stdout)
    assert report["status"] == "cpu" and report["reason"] == "CPU_REQUESTED"
    assert list(tmp_path.iterdir()) == []


def test_nonempty_output_cannot_claim_gpu_when_public_runtime_state_does_not_confirm_it(monkeypatch, tmp_path):
    asr = importlib.import_module("liming_analyzer.faster_whisper_asr")
    monkeypatch.setattr(check.sys, "platform", "win32")
    monkeypatch.setitem(sys.modules, "ctranslate2", SimpleNamespace(get_cuda_device_count=lambda: 1))
    args = arguments(tmp_path)
    cached_model(args)
    speech = SimpleNamespace(transcribe=lambda _sample: SimpleNamespace(segments=(object(),)),
                             runtime_state={"device": "cpu", "gpu_verified": False})
    monkeypatch.setattr(asr, "FasterWhisperSpeechRecognizer", lambda *_a, **_k: speech)
    result = check.check_cuda(args)
    assert result["status"] == "failed" and result["gpuVerified"] is False
    assert result["failure"]["code"] == "CUDA_INFERENCE_UNCONFIRMED"


def test_failure_keeps_library_evidence_without_profile_or_credentials(monkeypatch):
    importlib.import_module("liming_analyzer.gpu_diagnostics")
    monkeypatch.setenv("USERPROFILE", r"D:\People\Alice Smith")
    result = check._failure(RuntimeError(r"Library cublas64_12.dll is not found D:\People\Alice Smith\cache api_key=SECRET_SENTINEL"))
    assert result["code"] == "CUDA_LIBRARY_UNAVAILABLE"
    exported = json.dumps(result)
    assert "cublas64_12.dll" in exported and "Alice Smith" not in exported and "SECRET_SENTINEL" not in exported
