"""Prepare and exercise local ASR/OCR models in this checkout's cache only."""
from __future__ import annotations

import argparse
import json
import os
import subprocess
import time
from pathlib import Path

from analyzer_local_runtime import ROOT, interpreter, runtime_environment


def emit(phase: str, **values):
    print(json.dumps({"phase": phase, **values}, ensure_ascii=False), flush=True)


def child() -> int:
    from liming_analyzer.faster_whisper_asr import FasterWhisperSpeechRecognizer
    from liming_analyzer.providers import FunAsrSpeechRecognizer, PaddleOcrEngine
    from PIL import Image, ImageDraw, ImageFont

    started = time.monotonic()
    verification = ROOT / ".local/verification/media-runtime"
    verification.mkdir(parents=True, exist_ok=True)
    emit("loading_asr")
    engine = os.environ.get("ANALYZER_ASR_ENGINE") or "faster-whisper"
    model = os.environ.get("ANALYZER_ASR_MODEL") or ("small" if engine == "faster-whisper" else "paraformer-zh")
    if engine == "faster-whisper":
        speech = FasterWhisperSpeechRecognizer(model, model_cache=ROOT / ".local/model-cache", language=os.environ.get("ANALYZER_ASR_LANGUAGE") or "zh", device="auto")
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
    if sample.is_file():
        audio = verification / "asr-sample.wav"
        subprocess.run([os.environ["ANALYZER_FFMPEG"], "-nostdin", "-v", "error", "-y", "-i", str(sample), "-t", "8", "-vn", "-ac", "1", "-ar", "16000", str(audio)], check=True)
        result = speech.transcribe(audio)
        transcript_chars = len(result.full_text.strip())
        if not transcript_chars:
            raise RuntimeError("Local ASR returned no text for the verification speech sample.")
        emit("asr_inference_passed", transcribed_characters=transcript_chars)
    report = {"ready": True, "modelsReady": True, "asr": engine + "/" + model, "ocr": "PP-OCRv5_mobile_det/rec", "ocrVerified": True,
              "asrVerified": transcript_chars is not None, "transcribedCharacters": transcript_chars,
              "modelCache": str(ROOT / ".local/model-cache"), "elapsedSeconds": round(time.monotonic() - started, 2)}
    cache = ROOT / ".local/model-cache"
    report["requiredFiles"] = [{"path": str(file.relative_to(cache)), "size": file.stat().st_size} for file in cache.rglob("*")
                               if file.is_file() and file.suffix in {".pt", ".bin", ".pdiparams", ".json", ".yml", ".yaml"} and file.name != "models-ready.json" and not any(part.startswith(".") for part in file.relative_to(cache).parts)]
    (ROOT / ".local/model-cache/models-ready.json").write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n")
    (verification / "result.json").write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n")
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
