"""Independent Qwen transcription with cue boundaries from matched Whisper text."""

from __future__ import annotations

import hashlib
import logging
import re
import wave
from difflib import SequenceMatcher
from functools import lru_cache
from pathlib import Path
from threading import Lock

from .adapters import SpeechRecognizer, TranscriptOutput, TranscriptSegment

logger = logging.getLogger(__name__)
QWEN_REPO = "mlx-community/Qwen3-ASR-1.7B-8bit"
QWEN_REVISION = "a8379a2e2f9e313c9292cdf1af4055ab56d50d55"
QWEN_SHA256 = "bf304b009cc7eca79283056f787b44c952d24ac22cec787b39732bba3c23c13c"
QWEN_BYTES = 2_463_307_541
QWEN_DIR = "qwen3-asr-1.7b-mlx-8bit"
# Tokenizer, preprocessing and generation configuration from the same pinned revision.
QWEN_FILES = {
    "chat_template.json": "75a8cfca24f00de72d796fbfed6858fc9614ef3dabd8696684cc3bc03a9c58ff",
    "config.json": "1b76b3b6c655fc54595da025f7a96474ad9fa86363303fbdd61a7d8483ccfaf7",
    "generation_config.json": "1da527824d81e07118facff437e03f2e24a23311e3bdeb2368973fe77e5f275c",
    "merges.txt": "8831e4f1a044471340f7c0a83d7bd71306a5b867e95fd870f74d0c5308a904d5",
    "model.safetensors.index.json": "0a5d0ec11188602242ff81a9969883d0fdeb98cd5d85cd1413089d897c201af5",
    "preprocessor_config.json": "45e120a4eda2c20c5d7f2ea9354e63536bf35e27aa573fb7cdf78017b378770d",
    "tokenizer_config.json": "4942d005604266809309cabc9f4e9cb89ce855d59b14681fdc0e1cc62ea26c4c",
    "vocab.json": "ca10d7e9fb3ed18575dd1e277a2579c16d108e32f27439684afa0e10b1440910",
    "model.safetensors": QWEN_SHA256,
}
LANGUAGES = {
    "zh": "Chinese",
    "en": "English",
    "yue": "Cantonese",
    "ar": "Arabic",
    "de": "German",
    "fr": "French",
    "es": "Spanish",
    "pt": "Portuguese",
    "id": "Indonesian",
    "it": "Italian",
    "ko": "Korean",
    "ru": "Russian",
    "th": "Thai",
    "vi": "Vietnamese",
    "ja": "Japanese",
    "tr": "Turkish",
    "hi": "Hindi",
    "ms": "Malay",
    "nl": "Dutch",
    "sv": "Swedish",
    "da": "Danish",
    "fi": "Finnish",
    "pl": "Polish",
    "cs": "Czech",
    "tl": "Filipino",
    "fil": "Filipino",
    "fa": "Persian",
    "el": "Greek",
    "ro": "Romanian",
    "hu": "Hungarian",
    "mk": "Macedonian",
}
MAX_WINDOW_MS = 45_000


@lru_cache(maxsize=32)
def _file_digest(path: Path, size: int, modified_ns: int) -> str:
    # Size and mtime invalidate the cache if an installer replaces a file.
    with path.open("rb") as source:
        return hashlib.file_digest(source, "sha256").hexdigest()


def _missing_or_invalid(folder: Path) -> list[str]:
    invalid = []
    for name, expected_digest in QWEN_FILES.items():
        path = folder / name
        try:
            stat = path.stat()
            if (
                name == "model.safetensors"
                and stat.st_size != QWEN_BYTES
                or _file_digest(path, stat.st_size, stat.st_mtime_ns) != expected_digest
            ):
                invalid.append(name)
        except OSError:
            invalid.append(name)
    return invalid


def verified_qwen_model(model_cache: Path) -> Path | None:
    folder = (Path(model_cache) / QWEN_DIR).resolve()
    return None if _missing_or_invalid(folder) else folder


def prepare_qwen_model(model_cache: Path) -> Path:
    folder = (Path(model_cache) / QWEN_DIR).resolve()
    invalid = _missing_or_invalid(folder)
    if invalid:
        from huggingface_hub import snapshot_download

        # Corrupt completed files sometimes still have a valid Hub download receipt.
        # Fetch only the damaged/missing objects, forcing a fresh copy for corruption.
        snapshot_download(
            QWEN_REPO,
            revision=QWEN_REVISION,
            local_dir=folder,
            allow_patterns=invalid,
            force_download=any((folder / name).is_file() for name in invalid),
        )
        if _missing_or_invalid(folder):
            raise RuntimeError("Qwen ASR snapshot is incomplete or its checksums do not match")
    return folder


def _lexical(text: str) -> str:
    return "".join(c.lower() for c in text if c.isalnum())


def _aligned_cues(
    text: str, rows: list[TranscriptSegment], start: int, end: int
) -> list[TranscriptSegment]:
    # Only split where consecutive letters/characters straddle a real timed boundary
    # uniquely in both readings. An unaligned stretch stays together with its real audio bounds.
    positions = [i for i, char in enumerate(text) if char.isalnum()]
    new = _lexical(text)
    old_parts = [_lexical(row.text) for row in rows]
    old = "".join(old_parts)
    blocks = SequenceMatcher(None, old, new, autojunk=False).get_matching_blocks()
    cues = []
    old_pos = 0
    last_cut = 0
    cue_start = start
    for i, part in enumerate(old_parts[:-1]):
        old_pos += len(part)
        anchor = old[old_pos - 2 : old_pos + 2] if old_pos >= 2 else ""
        if len(anchor) != 4 or old.count(anchor) != 1 or new.count(anchor) != 1:
            continue
        block = next(
            (b for b in blocks if b.a <= old_pos - 2 and old_pos + 2 <= b.a + b.size), None
        )
        if block is None:
            continue
        cut = positions[block.b + old_pos - block.a]
        time_cut = rows[i + 1].start_ms
        cue_end = min(rows[i].end_ms, time_cut)
        if last_cut < cut and cue_start < cue_end and time_cut < end:
            cues.append(TranscriptSegment(cue_start, cue_end, text[last_cut:cut].strip()))
            last_cut, cue_start = cut, time_cut
    cues.append(TranscriptSegment(cue_start, end, text[last_cut:].strip()))
    return cues


def _plausible(text: str, duration_ms: int, rows: list[TranscriptSegment]) -> bool:
    lexical = _lexical(text)
    if (
        not lexical
        or "<|" in text
        or "<asr_text>" in text
        or re.match(r"language\s+[A-Za-z]+", text, re.IGNORECASE)
    ):
        return False
    if len(lexical) > max(40, duration_ms * 0.028):
        return False
    old = _lexical("".join(row.text for row in rows))
    if old and len(lexical) < len(old) * 0.60:
        return False
    # A fluent partial or loop must not discard an entire unrecognised phrase.
    for tag, a, b, c, d in SequenceMatcher(None, old, lexical, autojunk=False).get_opcodes():
        if (tag == "delete" and b - a >= 6) or (
            tag != "equal" and b - a >= 9 and (d - c) < (b - a) * 0.35
        ):
            return False
    return not re.search(r"(.{3,32})\1{5,}", lexical)


class QwenSpeechRecognizer:
    model = "Qwen3-ASR-1.7B"
    backend = "mlx-audio"
    max_window_ms = MAX_WINDOW_MS

    def __init__(
        self, model_path: Path, language: str, timing: SpeechRecognizer | None, *, engine=None, vad=None
    ):
        self.model_path = Path(model_path)
        self.language = language
        self.timing = timing
        self.engine = engine
        self.vad = vad
        self._timing_lock = Lock()
        self._last_timing: tuple[Path, TranscriptOutput | None] | None = None

    @property
    def last_timing_transcript(self) -> TranscriptOutput | None:
        with self._timing_lock:
            return self._last_timing[1] if self._last_timing else None

    def timing_transcript_for(self, audio: Path) -> TranscriptOutput | None:
        with self._timing_lock:
            record = self._last_timing
            return record[1] if record and record[0] == audio.resolve() else None

    def transcribe(self, audio: Path) -> TranscriptOutput:
        return self._transcribe(audio, require_qwen=False)

    def transcribe_verified(self, audio: Path) -> TranscriptOutput:
        """Installation self-test: a Whisper-only result cannot verify the Qwen decoder."""
        return self._transcribe(audio, require_qwen=True)

    def _transcribe(self, audio: Path, *, require_qwen: bool) -> TranscriptOutput:
        import numpy as np

        active_input = (audio.resolve(), None)
        with self._timing_lock:
            self._last_timing = active_input
        try:
            anchors = self.timing.transcribe(audio) if self.timing else TranscriptOutput(self.language, ())
            with self._timing_lock:
                # An overlapping call may already be listening to a different recording.
                if self._last_timing is active_input:
                    self._last_timing = (active_input[0], anchors if self.timing else None)
            if self.language != "auto" and self.language not in LANGUAGES:
                if require_qwen:
                    raise ValueError("The configured language is unavailable for Qwen ASR")
                return anchors
        except (ValueError, OSError, RuntimeError, ImportError) as error:
            if self.language != "auto" and self.language not in LANGUAGES:
                raise
            logger.warning(
                "Whisper timing unavailable; using measured Qwen audio windows (%s)",
                type(error).__name__,
            )
            anchors = TranscriptOutput(self.language, ())
        try:
            with wave.open(str(audio)) as wav:
                if (wav.getframerate(), wav.getnchannels(), wav.getsampwidth()) != (16000, 1, 2):
                    raise ValueError("expected 16 kHz mono PCM16")
                samples = (
                    np.frombuffer(wav.readframes(wav.getnframes()), dtype="<i2").astype(np.float32)
                    / 32768.0
                )
            if self.vad is None:
                from faster_whisper.vad import get_speech_timestamps

                self.vad = get_speech_timestamps
            speech = self.vad(samples)
            if not speech:
                if require_qwen:
                    raise ValueError("The Qwen validation sample has no detected speech")
                return anchors
            if self.engine is None:
                from mlx_audio.stt.utils import load_model

                if not self.model_path.is_dir():
                    raise FileNotFoundError("missing local Qwen ASR model directory")
                self.engine = load_model(str(self.model_path.resolve()))
            return self._transcribe_windows(samples, speech, anchors, require_qwen=require_qwen)
        except (ValueError, OSError, RuntimeError, ImportError) as error:
            if require_qwen:
                raise
            logger.warning(
                "Qwen ASR unavailable; using independent timestamped transcription (%s)",
                type(error).__name__,
            )
            if not anchors.segments:
                raise
            return anchors

    def _transcribe_windows(self, samples, speech, anchors: TranscriptOutput, *, require_qwen: bool) -> TranscriptOutput:
        import numpy as np

        duration = (len(samples) + 15) // 16
        starts = [s.start_ms for s in anchors.segments]
        speech_ends = [round(i["end"] / 16) for i in speech]
        cues = []
        qwen_windows = 0
        whisper_windows = 0
        language = anchors.language
        start = 0
        while start < duration:
            end = min(start + self.max_window_ms, duration)
            if end < duration:
                # Prefer a pause or the start of the next Whisper cue near the window edge.
                end = max(
                    (t for t in starts if end - 8_000 <= t <= end),
                    default=max((t for t in speech_ends if end - 8_000 <= t <= end), default=end),
                )
            rows = [r for r in anchors.segments if start <= r.start_ms < end]
            voiced = [
                (max(start, interval["start"] // 16), min(end, (interval["end"] + 15) // 16))
                for interval in speech
                if interval["start"] < end * 16 and interval["end"] > start * 16
            ]
            if voiced and np.any(samples[start * 16 : end * 16]):
                spoken_start = min([left for left, _ in voiced] + [r.start_ms for r in rows])
                spoken_end = min(
                    end, max([right for _, right in voiced] + [r.end_ms for r in rows])
                )
                budget = max(80, (spoken_end - spoken_start) // 60)
                result = self.engine.generate(
                    samples[spoken_start * 16 : spoken_end * 16],
                    language=LANGUAGES.get(self.language),
                    temperature=0.0,
                    max_tokens=budget,
                )
                if self.language == "auto" and language in {"auto", "und"}:
                    detected = (
                        result.language[0]
                        if isinstance(result.language, list) and result.language
                        else result.language
                    )
                    language = next(
                        (code for code, name in LANGUAGES.items() if name == detected), language
                    )
                text = result.text.strip()
                if (
                    _plausible(text, spoken_end - spoken_start, rows)
                    and (result.generation_tokens or 0) < budget
                ):
                    qwen_windows += 1
                    cues.extend(_aligned_cues(text, rows, spoken_start, spoken_end))
                else:
                    if require_qwen or not rows:
                        raise RuntimeError("Qwen ASR did not return a complete transcription for the speech window")
                    if any(row.end_ms > end for row in rows):
                        # Keeping a cue that crosses the window would duplicate speech in the next window.
                        return anchors
                    whisper_windows += 1
                    cues.extend(rows)
            else:
                if require_qwen and rows:
                    raise RuntimeError("Qwen ASR did not decode the validation sample")
                if rows:
                    whisper_windows += 1
                cues.extend(rows)
            start = end
        if not require_qwen and qwen_windows:
            if whisper_windows:
                logger.info(
                    "%s %s mixed transcription: Qwen windows=%d Whisper windows=%d",
                    self.model, self.backend, qwen_windows, whisper_windows,
                )
            else:
                logger.info("%s %s transcription completed (windows=%d)", self.model, self.backend, qwen_windows)
        return TranscriptOutput(language, tuple(cues))
