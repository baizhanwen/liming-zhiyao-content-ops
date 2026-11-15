"""Exercise cached Whisper timing CUDA once, without installing or downloading."""
from __future__ import annotations

import argparse
import json
import os
import re
import sys
import time
import wave
from pathlib import Path

MODELS = ("tiny", "base", "small", "medium", "large-v3", "distil-large-v3", "large-v3-turbo")


def _failure(error):
    try:
        from liming_analyzer.gpu_diagnostics import gpu_failure_details
        details = gpu_failure_details(error)
    except ImportError:
        return {"code": "CUDA_CHECK_FAILED", "error_type": type(error).__name__}
    text = details.get("detail", "")
    for home in (os.environ.get("USERPROFILE"), os.environ.get("HOME"), str(Path.home())):
        if home and len(home) > 3:
            pattern = r"[\\/]".join(re.escape(part) for part in re.split(r"[\\/]", home.rstrip("\\/")))
            text = re.sub(pattern, "<profile>", text, flags=re.IGNORECASE)
    text = re.sub(r"(?i)([a-z]:[\\/](?:Users|Profiles)[\\/])[^\\/\r\n]+", r"\1<user>", text)
    text = re.sub(r"(/(?:Users|home)/)[^/\r\n]+", r"\1<user>", text)
    return {**details, "detail": text[:600]}


def _sample_ready(sample):
    if not sample.is_file() or sample.stat().st_size > 2 * 1024 * 1024:
        return False
    try:
        with wave.open(str(sample), "rb") as audio:
            return (audio.getnchannels() == 1 and audio.getsampwidth() == 2
                    and audio.getframerate() == 16000 and audio.getcomptype() == "NONE"
                    and 0 < audio.getnframes() <= 15 * 16000)
    except (OSError, EOFError, wave.Error):
        return False


def check_cuda(arguments):
    base = {"status": "not_verified", "device": "unavailable", "gpuVerified": False,
            "probe": "asr-check-zh.v1", "checkedAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())}
    if arguments.device == "cpu":
        return {**base, "status": "cpu", "device": "cpu", "reason": "CPU_REQUESTED"}
    if sys.platform != "win32":
        return {**base, "reason": "WINDOWS_ONLY"}
    # These affect only this owned check process. No model or installer can use
    # network access to fill a missing cache during this diagnostic.
    os.environ.update(HF_HUB_OFFLINE="1", TRANSFORMERS_OFFLINE="1", HF_HUB_DISABLE_TELEMETRY="1",
                      PYTHONDONTWRITEBYTECODE="1")
    try:
        import ctranslate2
        if ctranslate2.get_cuda_device_count() < 1:
            return {**base, "device": "cpu", "reason": "NVIDIA_GPU_NOT_FOUND"}
        cache = Path(arguments.model_cache).expanduser().resolve()
        model = cache / ("faster-whisper-" + arguments.model)
        required = ["model.bin", "config.json", "tokenizer.json"]
        if arguments.model == "large-v3-turbo":
            required.append("preprocessor_config.json")
        if any(not (model / name).is_file() or not (model / name).stat().st_size for name in required):
            return {**base, "device": "cuda", "reason": "LOCAL_MODEL_INCOMPLETE"}
        sample = Path(arguments.sample).expanduser().resolve()
        if not _sample_ready(sample):
            return {**base, "status": "failed", "device": "cuda", "failure": {"code": "CUDA_CHECK_SAMPLE_INVALID"}}
        # Import the same recognizer used by the worker, including its managed
        # DLL loader. Explicit CUDA forbids the normal automatic CPU fallback.
        from liming_analyzer.faster_whisper_asr import FasterWhisperSpeechRecognizer
        speech = FasterWhisperSpeechRecognizer(arguments.model, model_cache=cache,
                    language=arguments.language, device="cuda", local_files_only=True)
        transcript = speech.transcribe(sample)
        state = speech.runtime_state
        if not transcript.segments:
            return {**base, "status": "failed", "device": "cuda", "failure": {"code": "CUDA_CHECK_NO_SPEECH_OUTPUT"}}
        if not isinstance(state, dict) or state.get("device") != "cuda" or state.get("gpu_verified") is not True:
            return {**base, "status": "failed", "device": "cuda", "failure": {"code": "CUDA_INFERENCE_UNCONFIRMED"}}
        return {**base, "status": "verified", "device": "cuda", "gpuVerified": True}
    except Exception as error:  # noqa: BLE001 - report native/model failures without a traceback or source text
        return {**base, "status": "failed", "device": "cuda", "failure": _failure(error)}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--model-cache", required=True)
    parser.add_argument("--model", choices=MODELS, default="large-v3-turbo")
    parser.add_argument("--language", default="zh")
    parser.add_argument("--sample", required=True)
    parser.add_argument("--device", choices=("auto", "cpu", "cuda"), default="auto")
    arguments = parser.parse_args()
    if arguments.language != "auto" and re.fullmatch(r"[a-z]{2,3}", arguments.language) is None:
        parser.error("--language must be auto or a two/three-letter language code")
    # Source checkouts and installed analyzer wheels are both supported. This
    # directory insertion does not import the analyzer for skipped platforms.
    sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "services/analyzer"))
    print(json.dumps(check_cuda(arguments), ensure_ascii=False), flush=True)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
