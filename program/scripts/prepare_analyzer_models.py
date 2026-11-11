"""Prepare and exercise local ASR/OCR models in this checkout's cache only."""
from __future__ import annotations

import argparse
import json
import os
import subprocess
import time
from pathlib import Path

from analyzer_local_runtime import ROOT, expects_windows_qwen, interpreter, model_cache_path, runtime_environment


def emit(phase: str, **values):
    print(json.dumps({"phase": phase, **values}, ensure_ascii=False), flush=True)


def child() -> int:
    started = time.monotonic()
    verification = ROOT / ".local/verification/media-runtime"
    verification.mkdir(parents=True, exist_ok=True)
    cache = model_cache_path()
    model_record = ROOT / ".local/model-cache/models-ready.json"
    model_record.parent.mkdir(parents=True, exist_ok=True)
    # Do not leave stale successful checks visible after a failed or interrupted repair.
    model_record.unlink(missing_ok=True)
    from liming_analyzer.providers import FunAsrSpeechRecognizer, PaddleOcrEngine
    from liming_analyzer.quality_speech import build_quality_recognizer
    from PIL import Image, ImageDraw, ImageFont

    engine = os.environ.get("ANALYZER_ASR_ENGINE") or "faster-whisper"
    model = os.environ.get("ANALYZER_ASR_MODEL") or ("large-v3-turbo" if engine == "faster-whisper" else "paraformer-zh")
    language = os.environ.get("ANALYZER_ASR_LANGUAGE") or "zh"
    device = os.environ.get("ANALYZER_ASR_DEVICE") or "auto"
    windows_qwen = expects_windows_qwen(engine, model, language, device)
    emit("preparing_windows_qwen" if windows_qwen else "loading_asr")
    if engine == "faster-whisper":
        speech = build_quality_recognizer(
            model, model_cache=cache, language=language, device=device, prepare=True,
        )
    elif engine == "funasr":
        speech = FunAsrSpeechRecognizer(model, device="cpu")
    else:
        raise RuntimeError("Unsupported local ASR engine.")
    emit("asr_loaded")
    emit("loading_ocr")
    ocr = PaddleOcrEngine()
    emit("ocr_loaded")
    image = verification / "ocr-fixture.png"
    bitmap = Image.new("RGB", (900, 220), "white")
    font_path = Path("/System/Library/Fonts/PingFang.ttc")
    if not font_path.exists():
        font_path = Path("C:/Windows/Fonts/msyh.ttc")
    font = ImageFont.truetype(str(font_path), 58) if font_path.exists() else ImageFont.load_default(size=52)
    ImageDraw.Draw(bitmap).text((35, 65), "模型环境测试 2026" if font_path.exists() else "MODEL TEST 2026", fill="black", font=font)
    bitmap.save(image)
    text, _score = ocr.recognize(image)
    if "2026" not in text:
        raise RuntimeError("Local OCR did not recognize the self-authored verification image.")
    emit("ocr_inference_passed", recognized_characters=len(text))
    sample = ROOT / ".local/verification/live-video/source.mp4"
    transcript_chars = None
    if windows_qwen:
        if (getattr(speech, "backend", None), getattr(speech, "model", None)) != ("sherpa-onnx", "Qwen3-ASR-1.7B"):
            raise RuntimeError("Windows Qwen3-ASR-1.7B 未成功加载，请重新配置环境。")
        emit("verifying_windows_qwen")
        # Self-authored eSpeak NG recording: 大家好，欢迎使用语音识别。
        # Exercise the native decoder, without a Whisper fallback or a user's media.
        probe = ROOT / "resources/media-tools/asr-check-zh.wav"
        recognized = speech.transcribe_verified(probe).full_text
        normalized = "".join(letter for letter in recognized if letter.isalnum())
        if not ("欢迎" in normalized and "语音识别" in normalized):
            raise RuntimeError("Qwen3-ASR-1.7B 未能识别验证录音中的中文词句。")
        transcript_chars = len(normalized)
    elif sample.is_file():
        audio = verification / "asr-sample.wav"
        subprocess.run([os.environ["ANALYZER_FFMPEG"], "-nostdin", "-v", "error", "-y", "-i", str(sample), "-t", "8", "-vn", "-ac", "1", "-ar", "16000", str(audio)], check=True)
        result = speech.transcribe(audio)
        transcript_chars = len(result.full_text.strip())
        if not transcript_chars:
            raise RuntimeError("Local ASR returned no text for the verification speech sample.")
    if transcript_chars is not None:
        emit("asr_inference_passed", transcribed_characters=transcript_chars)
    report = {"ready": True, "modelsReady": True, "asr": engine + "/" + model, "asrBackend": getattr(speech, "backend", engine), "ocr": "PP-OCRv5_mobile_det/rec", "ocrVerified": True,
              "asrVerified": transcript_chars is not None, "transcribedCharacters": transcript_chars,
              "asrModel": getattr(speech, "model", model),
              "modelCache": str(cache), "elapsedSeconds": round(time.monotonic() - started, 2)}
    if windows_qwen:
        report["asrProbe"] = "asr-check-zh.v1"
    # Unrelated downloaded or abandoned weights do not determine readiness.
    speech_path = getattr(speech, "model_path", None)
    roots = [Path(speech_path), cache / "paddlex/official_models"] if speech_path else (
        [cache / "modelscope", cache / "paddlex/official_models"] if engine == "funasr" else [cache]
    )
    timing_path = getattr(getattr(speech, "timing", None), "model_path", None)
    if timing_path:
        roots.append(Path(timing_path))
    extensions = {".onnx", ".data", ".pt", ".bin", ".safetensors", ".pdiparams", ".json", ".txt", ".model", ".yml", ".yaml"}
    report["requiredFiles"] = [
        {"path": str(file.relative_to(cache)), "size": file.stat().st_size, "mtimeNs": file.stat().st_mtime_ns}
        for root in roots for file in sorted(root.rglob("*"))
        if file.is_file() and file.suffix in extensions and file.name != "models-ready.json"
        and not any(part.startswith(".") for part in file.relative_to(cache).parts)
    ]
    contents = json.dumps(report, ensure_ascii=False, indent=2) + "\n"
    (verification / "result.json").write_text(contents, encoding="utf-8")
    pending = model_record.with_name(f"{model_record.name}.{os.getpid()}.tmp")
    pending.write_text(contents, encoding="utf-8")
    os.replace(pending, model_record)
    print(json.dumps(report, ensure_ascii=False), flush=True)
    return 0


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--child", action="store_true")
    args = parser.parse_args()
    if args.child:
        return child()
    environment = runtime_environment(load_configuration=False)
    from dotenv import dotenv_values
    configured = dotenv_values(ROOT / ".dev.vars")
    for key in ("ANALYZER_ASR_ENGINE", "ANALYZER_ASR_MODEL", "ANALYZER_ASR_LANGUAGE", "ANALYZER_ASR_DEVICE"):
        if configured.get(key):
            environment[key] = configured[key]
    return subprocess.call([str(interpreter()), str(Path(__file__).resolve()), "--child"], cwd=ROOT, env=environment)


if __name__ == "__main__":
    raise SystemExit(main())
