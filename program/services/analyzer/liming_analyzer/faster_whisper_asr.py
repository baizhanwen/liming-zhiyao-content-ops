"""Local faster-whisper speech recognition using this analyzer's model cache."""
from __future__ import annotations

import logging
import math
import os
import re
from pathlib import Path

from .adapters import TranscriptOutput, TranscriptSegment

TURBO_MODEL = "large-v3-turbo"
LOCAL_MODELS = frozenset({"tiny", "base", "small", "medium", "large-v3", "distil-large-v3", TURBO_MODEL})
logger = logging.getLogger(__name__)


def _cuda_failure(error: Exception) -> bool:
    message = str(error).lower()
    return any(token in message for token in ("cuda", "cublas", "cudnn", "out of memory", "float16 compute type"))


class FasterWhisperSpeechRecognizer:
    backend = "faster-whisper"

    def __init__(self, model="small", *, model_cache, language="zh", device="auto", engine=None,
                 local_files_only=False):
        if model not in LOCAL_MODELS:
            raise ValueError("unsupported local faster-whisper model")
        if language != "auto" and not re.fullmatch(r"[a-z]{2,3}", language):
            raise ValueError("invalid faster-whisper language")
        if device not in {"auto", "cpu", "cuda"}:
            raise ValueError("invalid faster-whisper device")
        self.language = language
        self.model = model
        self.model_path = Path(model_cache).resolve() / f"faster-whisper-{model}"
        self._retry_on_cpu = False
        if engine is None:
            import ctranslate2
            from faster_whisper.utils import download_model

            self.model_path.mkdir(parents=True, exist_ok=True)
            required = ("model.bin", "config.json", "tokenizer.json")
            if model == TURBO_MODEL:
                # v3 needs 128 mel bins. Without this file faster-whisper assumes 80.
                required += ("preprocessor_config.json",)
            if not all((self.model_path / name).is_file() and (self.model_path / name).stat().st_size
                       for name in required):
                if local_files_only:
                    raise FileNotFoundError("The local Whisper timing model is incomplete")
                download_model(model, output_dir=str(self.model_path))
            actual_device = device
            try:
                if device == "auto":
                    actual_device = "cuda" if ctranslate2.get_cuda_device_count() else "cpu"
                    self._retry_on_cpu = actual_device == "cuda"
                engine = self._load_engine(actual_device)
            except (RuntimeError, ValueError) as error:
                if device != "auto" or actual_device == "cpu" or not _cuda_failure(error):
                    raise
                logger.warning("Automatic Whisper GPU initialization failed; using CPU int8.")
                self._retry_on_cpu = False
                engine = self._load_engine("cpu")
        self.engine = engine

    def _load_engine(self, device):
        from faster_whisper import WhisperModel

        return WhisperModel(
            str(self.model_path), device=device, compute_type="int8" if device == "cpu" else "float16",
            cpu_threads=max(1, min(os.cpu_count() or 4, 4)), local_files_only=True,
        )

    def transcribe(self, audio):
        try:
            return self._decode(audio)
        except (RuntimeError, ValueError) as error:
            if not self._retry_on_cpu or not _cuda_failure(error):
                raise
        # CUDA libraries and memory are sometimes first exercised while iterating
        # the lazy segments. Discard the partial pass and restart from the source.
        logger.warning("Automatic Whisper GPU transcription failed; restarting the recording on CPU int8.")
        self._retry_on_cpu = False
        self.engine = self._load_engine("cpu")
        return self._decode(audio)

    def _decode(self, audio):
        options = {}
        if self.model == TURBO_MODEL:
            options["condition_on_previous_text"] = False
            options["hallucination_silence_threshold"] = 2.0
        rows, info = self.engine.transcribe(
            str(audio), language=None if self.language == "auto" else self.language,
            beam_size=5, word_timestamps=self.model == TURBO_MODEL, vad_filter=True, **options,
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
