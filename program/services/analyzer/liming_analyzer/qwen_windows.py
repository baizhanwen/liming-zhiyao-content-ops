"""Qwen3-ASR-1.7B INT8 on Windows x64 CPUs, using pinned sherpa-onnx graphs."""

from __future__ import annotations

import logging
import os
from pathlib import Path
from tempfile import TemporaryDirectory
from types import SimpleNamespace

from .qwen_speech import QWEN_FILES, QwenSpeechRecognizer, _file_digest

MODEL_DIR = "qwen3-asr-1.7b-onnx-int8"
HUB_REPO = "ilmina/qwen3-asr-1.7b-sherpa-onnx"
HUB_REVISION = "66fb5ea2d4d1682ff8a663bf7e788913604996a0"
# The original export linked by sherpa-onnx uses model_1.7B/ for the graphs.
MODELSCOPE_REPO = "zengshuishui/Qwen3-ASR-onnx"
MODELSCOPE_REVISION = "cb045ad80b8970c9d411d463e5b78991a566596c"
FILES = {
    "conv_frontend.onnx": (
        48_080_441,
        "fa894a4ba53da6a4238f2a6ca0b09362e505d39cecbd646051b033e2e8d7e2fb",
    ),
    "encoder.int8.onnx": (
        314_222_162,
        "436fbd910a0c8914851e5ac1354e807be9f283d08a5da728adaa609731c41469",
    ),
    "decoder.int8.onnx": (
        2_037_458_645,
        "c43c853fa6e97d08365cb8a5502b360b595cd43c00dc60e4d8ca7cc18cad460b",
    ),
    "tokenizer/merges.txt": (1_671_853, QWEN_FILES["merges.txt"]),
    "tokenizer/vocab.json": (2_776_833, QWEN_FILES["vocab.json"]),
    "tokenizer/tokenizer_config.json": (12_487, QWEN_FILES["tokenizer_config.json"]),
}


def _valid(path: Path, name: str) -> bool:
    size, digest = FILES[name]
    try:
        stat = path.stat()
        return stat.st_size == size and _file_digest(path, size, stat.st_mtime_ns) == digest
    except OSError:
        return False


def _fetch_original(folder: Path, missing: list[str]) -> None:
    from modelscope.hub.file_download import model_file_download

    with TemporaryDirectory(prefix=".qwen-download-", dir=folder) as staging:
        for name in missing:
            remote = f"model_1.7B/{name}" if name.endswith(".onnx") else name
            downloaded = Path(
                model_file_download(
                    MODELSCOPE_REPO, remote, revision=MODELSCOPE_REVISION, local_dir=staging
                )
            )
            if not _valid(downloaded, name):
                raise RuntimeError(f"Qwen 模型文件校验失败：{name}")
            target = folder / name
            target.parent.mkdir(parents=True, exist_ok=True)
            os.replace(downloaded, target)


def windows_model_path(model_cache: Path, *, prepare: bool) -> Path:
    folder = (model_cache / MODEL_DIR).resolve()
    missing = [name for name in FILES if not _valid(folder / name, name)]
    if not missing:
        return folder
    if not prepare:
        raise RuntimeError("本地 Qwen3-ASR 模型尚未就绪，请点击「一键配置环境并启动」补齐模型。")

    from huggingface_hub import snapshot_download

    folder.mkdir(parents=True, exist_ok=True)
    try:
        snapshot_download(
            HUB_REPO,
            revision=HUB_REVISION,
            local_dir=folder,
            allow_patterns=missing,
            force_download=any((folder / name).is_file() for name in missing),
        )
    except (OSError, RuntimeError, ValueError) as error:
        logging.getLogger(__name__).warning(
            "Hugging Face 模型下载未完成，继续从 ModelScope 获取：%s", type(error).__name__
        )
    remaining = [name for name in missing if not _valid(folder / name, name)]
    if remaining:
        _fetch_original(folder, remaining)
    return folder


class SherpaQwenEngine:
    def __init__(self, folder: Path):
        import sherpa_onnx

        self.recognizer = sherpa_onnx.OfflineRecognizer.from_qwen3_asr(
            conv_frontend=str(folder / "conv_frontend.onnx"),
            encoder=str(folder / "encoder.int8.onnx"),
            decoder=str(folder / "decoder.int8.onnx"),
            tokenizer=str(folder / "tokenizer"),
            num_threads=min(os.cpu_count() or 1, 4),
            provider="cpu",
            max_total_len=512,
        )

    def generate(self, samples, *, language, temperature, max_tokens):
        stream = self.recognizer.create_stream()
        if language:
            stream.set_option("language", language)
        stream.set_option("max_new_tokens", str(max_tokens))
        stream.set_option("temperature", str(temperature))
        stream.accept_waveform(16000, samples)
        self.recognizer.decode_stream(stream)
        result = stream.result
        return SimpleNamespace(
            text=result.text, generation_tokens=len(result.tokens), language=language
        )


class WindowsQwenSpeechRecognizer(QwenSpeechRecognizer):
    backend = "sherpa-onnx"
    # This export has 512 KV positions including audio, instruction, and output.
    # Shorter windows leave enough room for fast speech and CJK tokenization.
    max_window_ms = 16_000

    def _detect_speech(self, samples):
        from faster_whisper.vad import VadOptions, get_speech_timestamps

        # The default 2-second silence threshold misses ordinary sentence pauses
        # on these shorter windows and can split a word at the decoder boundary.
        return get_speech_timestamps(
            samples,
            vad_options=VadOptions(
                min_silence_duration_ms=300,
                speech_pad_ms=100,
                max_speech_duration_s=self.max_window_ms / 1000,
            ),
        )
