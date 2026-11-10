"""Local faster-whisper speech recognition using this analyzer's model cache."""
from __future__ import annotations

import math
import os
import re
from pathlib import Path

from .adapters import TranscriptOutput, TranscriptSegment

LOCAL_MODELS = frozenset({"tiny", "base", "small", "medium", "large-v3", "distil-large-v3"})


class FasterWhisperSpeechRecognizer:
    def __init__(self, model="small", *, model_cache, language="zh", device="auto", engine=None):
        if model not in LOCAL_MODELS:
            raise ValueError("unsupported local faster-whisper model")
        if language != "auto" and not re.fullmatch(r"[a-z]{2,3}", language):
            raise ValueError("invalid faster-whisper language")
        if device not in {"auto", "cpu", "cuda"}:
            raise ValueError("invalid faster-whisper device")
        self.language = language
        self.model = model
        self.model_path = Path(model_cache).resolve() / f"faster-whisper-{model}"
        if engine is None:
            import ctranslate2
            from faster_whisper import WhisperModel
            from faster_whisper.utils import download_model

            self.model_path.mkdir(parents=True, exist_ok=True)
            required = ("model.bin", "config.json", "tokenizer.json")
            if not all((self.model_path / name).is_file() for name in required):
                download_model(model, output_dir=str(self.model_path))
            actual_device = "cuda" if device == "auto" and ctranslate2.get_cuda_device_count() else "cpu" if device == "auto" else device
            engine = WhisperModel(
                str(self.model_path), device=actual_device,
                compute_type="int8" if actual_device == "cpu" else "float16",
                cpu_threads=max(1, min(os.cpu_count() or 4, 4)), local_files_only=True,
            )
        self.engine = engine

    def transcribe(self, audio):
        rows, info = self.engine.transcribe(
            str(audio), language=None if self.language == "auto" else self.language,
            beam_size=5, word_timestamps=False, vad_filter=True,
        )
        segments = []
        for row in rows:
            text = str(row.text).strip()
            start, end = float(row.start), float(row.end)
            if not math.isfinite(start) or not math.isfinite(end) or start < 0 or end < start:
                raise ValueError("local faster-whisper returned an invalid timestamp")
            if text:
                segments.append(TranscriptSegment(round(start * 1000), round(end * 1000), text))
        language = str(getattr(info, "language", "") or self.language)
        return TranscriptOutput(language, tuple(segments))
