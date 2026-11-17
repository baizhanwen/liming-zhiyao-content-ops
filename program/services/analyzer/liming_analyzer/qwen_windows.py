"""Qwen3-ASR-1.7B INT8 on Windows x64 CPUs, using pinned sherpa-onnx graphs."""

from __future__ import annotations

import errno
import os
from pathlib import Path
from tempfile import TemporaryDirectory
from types import SimpleNamespace

import httpx

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
    except (FileNotFoundError, NotADirectoryError):
        return False


def _raise_storage_error(error: BaseException) -> None:
    # Changing download servers cannot repair local permissions or a full disk.
    # SDKs may wrap these errors, so inspect their original exception as well.
    seen: set[int] = set()
    while id(error) not in seen:
        seen.add(id(error))
        if isinstance(error, PermissionError) or (
            isinstance(error, OSError)
            and error.errno
            in {
                errno.EACCES,
                errno.EPERM,
                errno.ENOSPC,
                errno.EROFS,
                errno.EIO,
                errno.EISDIR,
                errno.ENOTDIR,
                getattr(errno, "EDQUOT", -1),
            }
        ):
            raise error
        original = error.__cause__ or error.__context__
        if original is None:
            return
        error = original


def _publish_verified(folder: Path, downloaded: Path, name: str) -> None:
    if not _valid(downloaded, name):
        raise RuntimeError(f"Qwen 模型文件校验失败：{name}")
    target = folder / name
    target.parent.mkdir(parents=True, exist_ok=True)
    os.replace(downloaded, target)


def _fetch_original(folder: Path, missing: list[str]) -> None:
    from modelscope.hub.file_download import model_file_download
    from modelscope_hub.errors import HubError
    from urllib3.exceptions import HTTPError as Urllib3HTTPError

    with TemporaryDirectory(prefix=".qwen-download-", dir=folder) as staging:
        for name in missing:
            remote = f"model_1.7B/{name}" if name.endswith(".onnx") else name
            try:
                downloaded = Path(
                    model_file_download(
                        MODELSCOPE_REPO,
                        remote,
                        revision=MODELSCOPE_REVISION,
                        local_dir=staging,
                        endpoint="https://modelscope.cn",
                        token="",
                    )
                )
            except (HubError, Urllib3HTTPError) as error:
                _raise_storage_error(error)
                # SDK messages may contain signed URLs; expose only a safe category.
                raise RuntimeError("ModelScope 模型文件下载失败") from None
            _publish_verified(folder, downloaded, name)


def _fetch_huggingface(folder: Path, missing: list[str]) -> None:
    from huggingface_hub import hf_hub_download

    with TemporaryDirectory(prefix=".qwen-download-", dir=folder) as staging:
        for name in missing:
            try:
                # snapshot_download first enumerates the repository without a
                # timeout in the pinned SDK. The fixed manifest needs no listing.
                hf_hub_download(
                    HUB_REPO,
                    filename=name,
                    revision=HUB_REVISION,
                    local_dir=staging,
                    etag_timeout=10,
                    endpoint="https://huggingface.co",
                    token=False,
                    force_download=(folder / name).is_file(),
                )
            finally:
                # A failed request can still leave a complete file. Publish only
                # verified files, retaining progress without accepting partials.
                downloaded = Path(staging) / name
                if _valid(downloaded, name):
                    _publish_verified(folder, downloaded, name)
            if not _valid(folder / name, name):
                raise RuntimeError(f"Hugging Face 模型文件校验失败：{name}")


def windows_model_path(model_cache: Path, *, prepare: bool) -> Path:
    folder = (model_cache / MODEL_DIR).resolve()
    missing = [name for name in FILES if not _valid(folder / name, name)]
    if not missing:
        return folder
    if not prepare:
        raise RuntimeError("本地 Qwen3-ASR 模型尚未就绪，请点击「一键配置环境并启动」补齐模型。")

    folder.mkdir(parents=True, exist_ok=True)
    for index, (source, fetch) in enumerate(
        (
            ("ModelScope（国内）", _fetch_original),
            ("Hugging Face（备用）", _fetch_huggingface),
        )
    ):
        if index == 0:
            print(f"正在从 {source} 下载 Qwen3-ASR 模型。", flush=True)
        else:
            print(f"Qwen3-ASR 模型国内源未完成，正在切换至 {source} 下载。", flush=True)
        try:
            fetch(folder, missing)
        except (httpx.HTTPError, OSError, RuntimeError, ValueError) as error:
            _raise_storage_error(error)
        missing = [name for name in missing if not _valid(folder / name, name)]
        if not missing:
            print(f"Qwen3-ASR 模型下载及校验完成（{source}）。", flush=True)
            return folder
    raise RuntimeError(
        "Qwen3-ASR 模型下载未完成：ModelScope（国内）与 Hugging Face（备用）均未能提供"
        "完整且校验通过的模型。请检查网络连接后重新点击「一键配置环境并启动」；"
        "已校验的文件会保留并复用。"
    ) from None


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
