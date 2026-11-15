import importlib.util
import json
import os
import sys
from pathlib import Path
from types import ModuleType, SimpleNamespace


def model_module(tmp_path, monkeypatch):
    scripts = Path(__file__).resolve().parents[3] / "scripts"
    runtime_spec = importlib.util.spec_from_file_location("analyzer_local_runtime", scripts / "analyzer_local_runtime.py")
    runtime = importlib.util.module_from_spec(runtime_spec)
    runtime_spec.loader.exec_module(runtime)
    root = tmp_path / "中文安装目录"
    monkeypatch.setenv("PROGRAMDATA", str(tmp_path / "programdata"))
    monkeypatch.setattr(runtime, "ROOT", root)
    monkeypatch.setattr(runtime, "LOCAL", root / ".local")
    monkeypatch.setattr(runtime, "ANALYZER", root / "services/analyzer")
    monkeypatch.setitem(sys.modules, "analyzer_local_runtime", runtime)
    monkeypatch.setitem(sys.modules, "prepare_analyzer_cuda", SimpleNamespace(
        ensure_cuda_runtime=lambda *_args, **_kwargs: {"status": "skipped", "reason": "SYNTHETIC_NO_GPU"},
    ))
    spec = importlib.util.spec_from_file_location("prepare_analyzer_models_test", scripts / "prepare_analyzer_models.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module, runtime


def synthetic_models(module, runtime, monkeypatch, speech_result="大家好，欢迎使用语音识别。", *, timing_state=None, calls=None):

    package = ModuleType("liming_analyzer")
    package.__path__ = []
    calls = [] if calls is None else calls
    class Timing:
        runtime_state = timing_state
        def transcribe(self, path):
            calls.append(("timing", path))
            return SimpleNamespace(full_text=speech_result)
    class Speech:
        backend = "sherpa-onnx"
        model = "Qwen3-ASR-1.7B"
        def transcribe_verified(self, path):
            assert path == runtime.ROOT / "resources/media-tools/asr-check-zh.wav"
            calls.append(("primary", path))
            if self.timing:
                self.timing.transcribe(path)
            return SimpleNamespace(full_text=speech_result)
        def transcribe(self, path):
            return self.transcribe_verified(path)
        def __init__(self, _model, *, model_cache, **_kwargs):
            calls.append(("load", _model))
            self.timing = Timing() if timing_state is not None else None
            model_cache.mkdir(parents=True, exist_ok=True)
            (model_cache / "中文模型.bin").write_bytes(b"synthetic-model")
    class Ocr:
        def recognize(self, _image):
            return "合成模型测试 2026", 1.0
    class Bitmap:
        def save(self, target):
            target.write_bytes(b"synthetic-image-no-network")
    monkeypatch.setitem(sys.modules, "liming_analyzer", package)
    monkeypatch.setitem(sys.modules, "liming_analyzer.quality_speech", SimpleNamespace(build_quality_recognizer=Speech))
    monkeypatch.setitem(sys.modules, "liming_analyzer.providers", SimpleNamespace(FunAsrSpeechRecognizer=Speech, PaddleOcrEngine=Ocr))
    monkeypatch.setitem(sys.modules, "PIL", SimpleNamespace(
        Image=SimpleNamespace(new=lambda *_args: Bitmap()),
        ImageDraw=SimpleNamespace(Draw=lambda _bitmap: SimpleNamespace(text=lambda *_args, **_kwargs: None)),
        ImageFont=SimpleNamespace(truetype=lambda *_args: object(), load_default=lambda **_kwargs: object()),
    ))


def test_model_preparation_writes_utf8_reports_without_real_models(tmp_path, monkeypatch, capsys):
    module, runtime = model_module(tmp_path, monkeypatch)
    synthetic_models(module, runtime, monkeypatch)
    monkeypatch.setenv("ANALYZER_ASR_ENGINE", "faster-whisper")
    monkeypatch.setenv("ANALYZER_ASR_MODEL", "small")
    report_paths = {runtime.LOCAL / "model-cache/models-ready.json", runtime.LOCAL / "verification/media-runtime/result.json"}
    original_write = Path.write_text
    writes = []
    def write(path, text, *args, **kwargs):
        if path.name.startswith("models-ready.json.") and path.suffix == ".tmp":
            recorded = path.with_name("models-ready.json")
        else:
            recorded = path
        if recorded in report_paths:
            assert kwargs.get("encoding") == "utf-8"
            writes.append(recorded)
        return original_write(path, text, *args, **kwargs)
    monkeypatch.setattr(Path, "write_text", write)
    assert module.child() == 0
    assert set(writes) == report_paths
    reports = [json.loads(path.read_bytes().decode("utf-8")) for path in report_paths]
    assert reports[0] == reports[1]
    assert reports[0]["modelsReady"] and reports[0]["ocrVerified"]
    assert reports[0]["asrVerified"] is (module.os.name == "nt")
    assert any(item["path"] == "中文模型.bin" for item in reports[0]["requiredFiles"])
    assert Path(reports[0]["modelCache"]) == runtime.model_cache_path()
    assert json.loads(capsys.readouterr().out.splitlines()[-1])["modelsReady"]


def test_model_child_receives_utf8_and_only_its_own_asr_defaults(tmp_path, monkeypatch):
    module, runtime = model_module(tmp_path, monkeypatch)
    monkeypatch.setenv("ANALYZER_LLM_API_KEY", "foreign-model-key")
    monkeypatch.setenv("PYTHONIOENCODING", "ascii")
    monkeypatch.setenv("PYTHONUTF8", "0")
    monkeypatch.setitem(sys.modules, "dotenv", SimpleNamespace(dotenv_values=lambda _path: {
        "ANALYZER_ASR_ENGINE": "faster-whisper", "ANALYZER_ASR_MODEL": "small",
        "ANALYZER_LLM_API_KEY": "must-not-be-loaded-for-model-download",
    }))
    monkeypatch.setattr(sys, "argv", ["prepare_analyzer_models.py"])
    calls = []
    def call(command, **options):
        calls.append((command, options))
        return 0
    monkeypatch.setattr(module.subprocess, "call", call)
    assert module.main() == 0
    command, options = calls[0]
    assert command[0] == str(runtime.interpreter()) and command[-1] == "--child"
    assert options["cwd"] == runtime.ROOT
    environment = options["env"]
    assert environment["PYTHONIOENCODING"] == "utf-8"
    assert environment["PYTHONUTF8"] == "1"
    assert environment["ANALYZER_ASR_MODEL"] == "small"
    assert "ANALYZER_LLM_API_KEY" not in environment
    assert Path(environment["ANALYZER_MODEL_CACHE"]) == runtime.model_cache_path()


def test_windows_setup_requires_bundled_speech_to_be_recognized_even_without_user_media(tmp_path, monkeypatch):
    import pytest

    module, runtime = model_module(tmp_path, monkeypatch)
    monkeypatch.setattr(module, "expects_windows_qwen", lambda *_args: True)
    receipt = runtime.LOCAL / "model-cache/models-ready.json"
    synthetic_models(module, runtime, monkeypatch)
    assert module.child() == 0
    verified = json.loads(receipt.read_text(encoding="utf-8"))
    assert verified["asrVerified"] and verified["asrBackend"] == "sherpa-onnx"
    assert verified["asrModel"] == "Qwen3-ASR-1.7B" and verified["asrProbe"] == "asr-check-zh.v1"

    synthetic_models(module, runtime, monkeypatch, speech_result="这段话识别错了")
    with pytest.raises(RuntimeError, match="未能识别"):
        module.child()
    assert not receipt.exists()


def synthetic_windows(module, monkeypatch):
    monkeypatch.setattr(module, "os", SimpleNamespace(**dict(vars(os), name="nt")))
    monkeypatch.setattr(module, "expects_windows_qwen", lambda *_args: True)


def test_windows_gpu_preparation_precedes_loading_and_reuses_the_existing_timing_probe(tmp_path, monkeypatch):
    module, runtime = model_module(tmp_path, monkeypatch)
    synthetic_windows(module, monkeypatch)
    calls = []
    synthetic_models(module, runtime, monkeypatch, calls=calls, timing_state={
        "device": "cuda", "gpu_verified": True, "gpu_failure": None,
    })
    def prepare(cache, **options):
        assert cache == runtime.model_cache_path()
        assert options["device"] == "auto"
        calls.append(("prepare", cache))
        return {"status": "prepared", "version": "synthetic"}
    monkeypatch.setitem(sys.modules, "prepare_analyzer_cuda", SimpleNamespace(ensure_cuda_runtime=prepare))
    metadata = [{"path": "bin/synthetic.dll", "size": 12, "mtimeNs": 34, "ctimeNs": 56}]
    monkeypatch.setattr(module, "cuda_readiness_files", lambda _cache: metadata)
    assert module.child() == 0
    assert [call[0] for call in calls] == ["prepare", "load", "primary", "timing"]
    report = json.loads((runtime.LOCAL / "model-cache/models-ready.json").read_text())
    assert report["asrBackend"] == "sherpa-onnx" and report["asrVerified"]
    assert report["cudaRuntime"]["status"] == "prepared"
    assert report["cudaRuntime"]["requiredFiles"] == metadata
    assert report["timingAsr"]["gpuVerified"] is True
    assert report["timingAsr"]["device"] == "cuda" and report["timingAsr"]["status"] == "verified"
    assert report["timingAsr"]["probe"] == "asr-check-zh.v1"
    assert report["timingAsr"]["configuration"]["device"] == "auto"
    assert len(report["timingAsr"]["implementation"]) == 64


def test_failed_optional_cuda_setup_persists_failure_but_keeps_verified_cpu_qwen_usable(tmp_path, monkeypatch):
    module, runtime = model_module(tmp_path, monkeypatch)
    synthetic_windows(module, monkeypatch)
    synthetic_models(module, runtime, monkeypatch, timing_state={
        "device": "cpu", "gpu_verified": False,
        "gpu_failure": {"code": "CUDA_LIBRARY_UNAVAILABLE", "error_type": "RuntimeError"},
    })
    class PreparationError(RuntimeError):
        code = "CUDA_RUNTIME_DOWNLOAD_FAILED"
    def prepare(*_args, **_options):
        raise PreparationError("sanitized fixture failure")
    monkeypatch.setitem(sys.modules, "prepare_analyzer_cuda", SimpleNamespace(ensure_cuda_runtime=prepare))
    assert module.child() == 0
    report = json.loads((runtime.LOCAL / "model-cache/models-ready.json").read_text())
    assert report["ready"] and report["modelsReady"] and report["asrVerified"]
    assert report["cudaRuntime"]["status"] == "failed"
    assert report["cudaRuntime"]["code"] == "CUDA_RUNTIME_DOWNLOAD_FAILED"
    assert report["timingAsr"]["status"] == "failed"
    assert report["timingAsr"]["gpuVerified"] is False and report["timingAsr"]["device"] == "cpu"
    assert report["timingAsr"]["failure"]["code"] == "CUDA_LIBRARY_UNAVAILABLE"


def test_cpu_other_engine_and_non_windows_never_invoke_cuda_installer(tmp_path, monkeypatch):
    module, runtime = model_module(tmp_path, monkeypatch)
    def forbidden(*_args, **_options):
        raise AssertionError("CPU/non-Windows must not prepare or download GPU dependencies")
    monkeypatch.setitem(sys.modules, "prepare_analyzer_cuda", SimpleNamespace(ensure_cuda_runtime=forbidden))
    synthetic_windows(module, monkeypatch)
    assert module.prepare_cuda_runtime(runtime.model_cache_path(), "faster-whisper", "cpu")["reason"] == "CPU_REQUESTED"
    assert module.prepare_cuda_runtime(runtime.model_cache_path(), "funasr", "auto")["status"] == "skipped"
    monkeypatch.setattr(module, "os", SimpleNamespace(**dict(vars(os), name="posix")))
    assert module.prepare_cuda_runtime(runtime.model_cache_path(), "faster-whisper", "auto")["reason"] == "WINDOWS_ONLY"


def test_no_gpu_skip_is_saved_without_claiming_gpu_verification(tmp_path, monkeypatch):
    module, runtime = model_module(tmp_path, monkeypatch)
    synthetic_windows(module, monkeypatch)
    synthetic_models(module, runtime, monkeypatch, timing_state={"device": "cpu", "gpu_verified": False})
    monkeypatch.setitem(sys.modules, "prepare_analyzer_cuda", SimpleNamespace(
        ensure_cuda_runtime=lambda *_args, **_options: {"status": "skipped", "reason": "NVIDIA_GPU_NOT_FOUND"},
    ))
    assert module.child() == 0
    report = json.loads((runtime.LOCAL / "model-cache/models-ready.json").read_text())
    assert report["modelsReady"] and report["asrVerified"]
    assert report["cudaRuntime"] == {"status": "skipped", "reason": "NVIDIA_GPU_NOT_FOUND"}
    assert report["timingAsr"]["gpuVerified"] is False
