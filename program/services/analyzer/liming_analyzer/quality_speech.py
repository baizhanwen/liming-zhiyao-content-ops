"""Select the local speech models for whole-recording transcription."""
from __future__ import annotations

import json
import logging
import math
import platform
import re
import wave
from pathlib import Path

from .adapters import TranscriptOutput, TranscriptSegment
from .faster_whisper_asr import TURBO_MODEL, FasterWhisperSpeechRecognizer


def _cached_mlx_model(model_cache: Path) -> Path | None:
    """Use MLX only when this installation already owns the complete snapshot."""
    snapshots = model_cache / "huggingface/hub/models--mlx-community--whisper-large-v3-turbo/snapshots"
    for folder in sorted(snapshots.glob("*")):
        try:
            from safetensors import SafetensorError, safe_open
        except ImportError:
            return None
        try:
            config = json.loads((folder / "config.json").read_text(encoding="utf-8"))
            if (config["n_mels"], config["n_audio_layer"], config["n_text_layer"]) != (128, 32, 4):
                continue
            # safe_open checks that tensor offsets match the complete file length.
            with safe_open(folder / "weights.safetensors", framework="numpy") as weights:
                layers = {"encoder.conv1.weight", "encoder.blocks.31.attn.query.weight",
                          "decoder.token_embedding.weight", "decoder.blocks.3.attn.query.weight"}
                if (layers.issubset(weights.keys())
                        and weights.get_slice("encoder.conv1.weight").get_shape() == [1280, 3, 128]):
                    return folder.resolve()
        except (OSError, ValueError, KeyError, TypeError, SafetensorError):
            continue
    return None


class MlxWhisperSpeechRecognizer:
    model = TURBO_MODEL
    backend = "mlx-whisper"

    def __init__(self, model_path: Path, language: str, transcribe):
        self.model_path = model_path
        self.language = language
        self._transcribe = transcribe

    def transcribe(self, audio: Path) -> TranscriptOutput:
        import numpy as np
        from faster_whisper.vad import get_speech_timestamps

        # FFmpeg already normalizes the input in the media stage. Passing PCM
        # directly also works when the app bundled FFmpeg outside the user's PATH.
        with wave.open(str(audio), "rb") as wav:
            if (wav.getframerate(), wav.getnchannels(), wav.getsampwidth()) != (16_000, 1, 2):
                raise ValueError("speech recognition requires normalized 16 kHz mono PCM16 audio")
            samples = np.frombuffer(wav.readframes(wav.getnframes()), dtype="<i2")
        if not samples.any():
            return TranscriptOutput(self.language, ())
        waveform = samples.astype(np.float32) / 32768.0
        # Use the same bundled speech detector as the cross-platform backend.
        # Decode the original uncut track so returned times remain source times.
        if not get_speech_timestamps(waveform):
            return TranscriptOutput(self.language, ())
        result = self._transcribe(
            waveform,
            path_or_hf_repo=str(self.model_path),
            language=None if self.language == "auto" else self.language,
            word_timestamps=True, condition_on_previous_text=False,
            hallucination_silence_threshold=2.0, verbose=None,
        )
        duration_ms = round(samples.size / 16)
        segments = []
        for row in result["segments"]:
            text = row["text"].strip()
            if not text:
                continue
            start, end = float(row["start"]), float(row["end"])
            if not math.isfinite(start) or not math.isfinite(end) or start < 0 or end < start:
                raise ValueError("MLX speech recognition returned an invalid timestamp")
            start_ms = round(start * 1000)
            if start_ms < duration_ms:
                segments.append(TranscriptSegment(start_ms, min(round(end * 1000), duration_ms), text))
        return TranscriptOutput(result.get("language") or self.language, tuple(segments))


def build_quality_recognizer(model: str = TURBO_MODEL, *, model_cache, language: str = "zh",
                             device: str = "auto", prepare: bool = False):
    if language != "auto" and not re.fullmatch(r"[a-z]{2,3}", language):
        raise ValueError("invalid whisper language")
    apple_gpu = model == TURBO_MODEL and device == "auto" and platform.system() == "Darwin" and platform.machine() == "arm64"
    cache = Path(model_cache).expanduser()
    if (model == TURBO_MODEL and language in {"zh", "auto"} and device in {"auto", "cpu"}
            and platform.system() == "Windows" and platform.machine().lower() in {"amd64", "x86_64"}):
        from .qwen_windows import SherpaQwenEngine, WindowsQwenSpeechRecognizer, windows_model_path
        folder = windows_model_path(cache, prepare=prepare)
        try:
            timing = FasterWhisperSpeechRecognizer(model, model_cache=cache, language=language,
                                                  device=device, local_files_only=not prepare)
        except (ImportError, OSError, RuntimeError, ValueError) as error:
            logging.getLogger(__name__).warning("Whisper 时间定位不可用，使用原声音频窗口 (%s)", type(error).__name__)
            timing = None
        return WindowsQwenSpeechRecognizer(folder, language, timing, engine=SherpaQwenEngine(folder))
    timing = None
    if apple_gpu:
        model_path = _cached_mlx_model(cache)
        if model_path:
            try:
                from mlx_whisper import transcribe
            except ImportError:
                pass
            else:
                timing = MlxWhisperSpeechRecognizer(model_path, language, transcribe)
    if timing is None:
        timing = FasterWhisperSpeechRecognizer(model, model_cache=cache, language=language, device=device)
    if apple_gpu and language in {"zh", "auto"}:
        from .qwen_speech import QwenSpeechRecognizer, prepare_qwen_model, verified_qwen_model
        try:
            qwen_path = prepare_qwen_model(cache) if prepare else verified_qwen_model(cache)
        except (ImportError, OSError, RuntimeError, ValueError) as error:
            logging.getLogger(__name__).warning("本地 Qwen 语音模型未就绪，使用 Whisper (%s)", type(error).__name__)
        else:
            if qwen_path:
                return QwenSpeechRecognizer(qwen_path, language, timing)
    return timing
