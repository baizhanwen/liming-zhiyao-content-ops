"""Download the existing CT2 Whisper models from verified, pinned file sources.

The ModelScope file SHA-256s were checked against upstream HF LFS objects and
Git blobs on 2026-11-17. Repositories are not enumerated at installation time.
"""
from __future__ import annotations

import errno
import hashlib
import http.client
import os
import ssl
import tempfile
from dataclasses import dataclass
from pathlib import Path
from urllib.error import URLError
from urllib.parse import urlencode, urlsplit
from urllib.request import HTTPRedirectHandler, Request, build_opener

from httpx import HTTPError as HttpxHTTPError


@dataclass(frozen=True)
class FileSpec:
    name: str
    size: int
    sha256: str
    modelscope_revision: str


@dataclass(frozen=True)
class ModelSpec:
    modelscope_repository: str
    huggingface_repository: str
    huggingface_revision: str
    files: tuple[FileSpec, ...]


_MODELS: dict[str, ModelSpec] = {
    'tiny': ModelSpec(
        'Systran/faster-whisper-tiny',
        'Systran/faster-whisper-tiny', 'd90ca5fe260221311c53c58e660288d3deb8d356', (
            FileSpec('config.json', 2249,
                     'a73a28cdfe1c43ccc7202fa333d1f89c202477271407ae9a7f19afa52039cac8',
                     '16ccadbe765d566aad608afb2a6346f72c8634c4'),
            FileSpec('tokenizer.json', 2203239,
                     'fb7b63191e9bb045082c79fd742a3106a12c99513ab30df4a0d47fa6cb6fd0ab',
                     '16ccadbe765d566aad608afb2a6346f72c8634c4'),
            FileSpec('vocabulary.txt', 459861,
                     '34ce3fe1c5041027b3f8d42912270993f986dbc4bb34cf27f951e34a1e453913',
                     '16ccadbe765d566aad608afb2a6346f72c8634c4'),
            FileSpec('model.bin', 75538270,
                     'dcb76c6586fc06cbdac6dd21f14cfd129cc4cdd9dce19bf4ffa62e59cbe6e6d1',
                     '9530ee785810b90b6e14e404dea7806b56518394'),
        )),
    'base': ModelSpec(
        'Systran/faster-whisper-base',
        'Systran/faster-whisper-base', 'ebe41f70d5b6dfa9166e2c581c45c9c0cfc57b66', (
            FileSpec('config.json', 2309,
                     '56a6d8110d311f19c8f0471e562832c7527f146b567275bfca59fcf7c184da9a',
                     '6d0e9ebe91c417db6c9200acaca39d581105f26b'),
            FileSpec('tokenizer.json', 2203239,
                     'fb7b63191e9bb045082c79fd742a3106a12c99513ab30df4a0d47fa6cb6fd0ab',
                     '6d0e9ebe91c417db6c9200acaca39d581105f26b'),
            FileSpec('vocabulary.txt', 459861,
                     '34ce3fe1c5041027b3f8d42912270993f986dbc4bb34cf27f951e34a1e453913',
                     '6d0e9ebe91c417db6c9200acaca39d581105f26b'),
            FileSpec('model.bin', 145217532,
                     'd01c3014881c9c6f3133c182f3d2887eb6ca1c789a7538c5c007196857a0a6a9',
                     'f445defbb81556b9d64c07284683f4cdc2cc17f5'),
        )),
    'small': ModelSpec(
        'Systran/faster-whisper-small',
        'Systran/faster-whisper-small', '536b0662742c02347bc0e980a01041f333bce120', (
            FileSpec('config.json', 2370,
                     'b55496ac7940a7ae47d2c01eab40edfd8701feec1229d9cce3b40014383fb828',
                     'afb04c7b910ac0b9851459d068069ab337931534'),
            FileSpec('tokenizer.json', 2203239,
                     'fb7b63191e9bb045082c79fd742a3106a12c99513ab30df4a0d47fa6cb6fd0ab',
                     'afb04c7b910ac0b9851459d068069ab337931534'),
            FileSpec('vocabulary.txt', 459861,
                     '34ce3fe1c5041027b3f8d42912270993f986dbc4bb34cf27f951e34a1e453913',
                     'afb04c7b910ac0b9851459d068069ab337931534'),
            FileSpec('model.bin', 483546902,
                     '3e305921506d8872816023e4c273e75d2419fb89b24da97b4fe7bce14170d671',
                     'ace8b2ad9dee031c53b6371f6c3c918b5e4f1db9'),
        )),
    'medium': ModelSpec(
        'Systran/faster-whisper-medium',
        'Systran/faster-whisper-medium', '08e178d48790749d25932bbc082711ddcfdfbc4f', (
            FileSpec('config.json', 2257,
                     '3622a2ddc41ec0e0fd4e68c13c6830f03b90c38d89aaad184de02c8c642cf807',
                     'ef0277181b9c31ebecd6b3002eb315a73848eccd'),
            FileSpec('tokenizer.json', 2203239,
                     'fb7b63191e9bb045082c79fd742a3106a12c99513ab30df4a0d47fa6cb6fd0ab',
                     'ef0277181b9c31ebecd6b3002eb315a73848eccd'),
            FileSpec('vocabulary.txt', 459861,
                     '34ce3fe1c5041027b3f8d42912270993f986dbc4bb34cf27f951e34a1e453913',
                     'ef0277181b9c31ebecd6b3002eb315a73848eccd'),
            FileSpec('model.bin', 1527906378,
                     '9b45e1009dcc4ab601eff815b61d80e60ce3fd8c74c1a14f4a282258286b51ae',
                     '4425f9d17a866befa63d7400866fdb136304b04f'),
        )),
    'large-v3': ModelSpec(
        'Systran/faster-whisper-large-v3',
        'Systran/faster-whisper-large-v3', 'edaa852ec7e145841d8ffdb056a99866b5f0a478', (
            FileSpec('config.json', 2394,
                     'a9306624f5ec14270a014b647e5c316b6e03a662c369758d1b90697a7b0655b9',
                     'ca60c2d07d52d6303db069f8e682706495f2daa0'),
            FileSpec('preprocessor_config.json', 340,
                     '7ccc62c6f2765af1f3b46c00c9b5894426835a05021c8b9c01eecb6dfb542711',
                     'ca60c2d07d52d6303db069f8e682706495f2daa0'),
            FileSpec('tokenizer.json', 2480617,
                     '6d8cbd7cd0d8d5815e478dac67b85a26bbe77c1f5e0c6d76d1ce2abc0e5f21ca',
                     'ca60c2d07d52d6303db069f8e682706495f2daa0'),
            FileSpec('vocabulary.json', 1068114,
                     'c69260f2ab26d659b7c398f9a2b2b48ed0df16c3b47d7326782fd9cba71690c1',
                     'ca60c2d07d52d6303db069f8e682706495f2daa0'),
            FileSpec('model.bin', 3087284237,
                     '69f74147e3334731bc3a76048724833325d2ec74642fb52620eda87352e3d4f1',
                     'fb999d399593f8d6ac57a40cd2d036a43b489721'),
        )),
    'distil-large-v3': ModelSpec(
        'Systran/faster-distil-whisper-large-v3',
        'Systran/faster-distil-whisper-large-v3', 'c3058b475261292e64a0412df1d2681c06260fab', (
            FileSpec('config.json', 2690,
                     '90c55f775cc4e0bb17293d0bf12f96557a486f20dea886fabd8e6075a3588b21',
                     '89c0aa833f420e31459bb0fdc7556d9330642f5d'),
            FileSpec('preprocessor_config.json', 340,
                     '7ccc62c6f2765af1f3b46c00c9b5894426835a05021c8b9c01eecb6dfb542711',
                     '89c0aa833f420e31459bb0fdc7556d9330642f5d'),
            FileSpec('tokenizer.json', 2480617,
                     '6d8cbd7cd0d8d5815e478dac67b85a26bbe77c1f5e0c6d76d1ce2abc0e5f21ca',
                     '89c0aa833f420e31459bb0fdc7556d9330642f5d'),
            FileSpec('vocabulary.json', 1068114,
                     'c69260f2ab26d659b7c398f9a2b2b48ed0df16c3b47d7326782fd9cba71690c1',
                     '89c0aa833f420e31459bb0fdc7556d9330642f5d'),
            FileSpec('model.bin', 1512927867,
                     'b79368e19b6623813609431a6e5ee309a71506701ebc49fd7820e692dec7c5f5',
                     '3e48e961c58d944c3563e6c0090c5102d19b7125'),
        )),
    'large-v3-turbo': ModelSpec(
        'mobiuslabsgmbh/faster-whisper-large-v3-turbo',
        'dropbox-dash/faster-whisper-large-v3-turbo', '0a363e9161cbc7ed1431c9597a8ceaf0c4f78fcf', (
            FileSpec('config.json', 2263,
                     'b0253ea6c0d3bea6b1e19e91a02acfd3b53f4467362efcb5a3e6b16c9b3a9b7e',
                     '2c8b6212cab564a21146bddc3aa503d2b1173d7b'),
            FileSpec('preprocessor_config.json', 340,
                     '7ccc62c6f2765af1f3b46c00c9b5894426835a05021c8b9c01eecb6dfb542711',
                     '2c8b6212cab564a21146bddc3aa503d2b1173d7b'),
            FileSpec('tokenizer.json', 2710337,
                     '297b13372ac43916285644fb9687add3cc62ee2a1adb60da3dc25cc94c1871fd',
                     '2c8b6212cab564a21146bddc3aa503d2b1173d7b'),
            FileSpec('vocabulary.json', 1068114,
                     'c69260f2ab26d659b7c398f9a2b2b48ed0df16c3b47d7326782fd9cba71690c1',
                     '2c8b6212cab564a21146bddc3aa503d2b1173d7b'),
            FileSpec('model.bin', 1617884929,
                     'e76620f83d5f5b69efd3d87e3dc180c1bd21df9fbebacfd4335e5e1efcc018da',
                     '2c8b6212cab564a21146bddc3aa503d2b1173d7b'),
        )),
}


class WhisperModelDownloadError(RuntimeError):
    pass


class _SourceFileError(WhisperModelDownloadError):
    pass


class _HttpsRedirects(HTTPRedirectHandler):
    def redirect_request(self, request, response, code, message, headers, new_url):
        parsed = urlsplit(new_url)
        if parsed.scheme != "https" or parsed.username or parsed.password or parsed.port not in (None, 443):
            raise _SourceFileError("模型源返回了不安全的下载跳转。")
        return super().redirect_request(request, response, code, message, headers, new_url)


def _open_modelscope(url):
    request = Request(url, headers={"User-Agent": "LimingZhiyao-Whisper-Setup/1.0"})
    # No Cookie jar, authentication handler or disabled TLS verification.
    return build_opener(_HttpsRedirects()).open(request, timeout=30)


def _valid_file(path: Path, spec: FileSpec) -> bool:
    if not path.is_file() or path.stat().st_size != spec.size:
        return False
    digest = hashlib.sha256()
    with path.open("rb") as source:
        for chunk in iter(lambda: source.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest() == spec.sha256


def whisper_model_is_complete(name: str, output_dir: str | Path) -> bool:
    """Read-only pinned-cache check for setup acceptance; never starts a download."""
    model = _MODELS.get(name) if isinstance(name, str) else None
    if model is None:
        return False
    try:
        directory = Path(output_dir)
        return all(_valid_file(directory / spec.name, spec) for spec in model.files)
    except OSError:
        return False


def _download_modelscope(model: ModelSpec, spec: FileSpec, destination: Path) -> None:
    query = urlencode({"Revision": spec.modelscope_revision, "FilePath": spec.name})
    url = f"https://modelscope.cn/api/v1/models/{model.modelscope_repository}/repo?{query}"
    pending = None
    try:
        with tempfile.NamedTemporaryFile(prefix=".whisper-", suffix=".part", dir=destination.parent, delete=False) as output:
            pending = Path(output.name)
            digest = hashlib.sha256()
            size = 0
            with _open_modelscope(url) as response:
                declared = response.headers.get("Content-Length")
                if declared is not None and (not declared.isdigit() or int(declared) != spec.size):
                    raise _SourceFileError("模型文件长度校验未通过。")
                for chunk in iter(lambda: response.read(1024 * 1024), b""):
                    size += len(chunk)
                    if size > spec.size:
                        raise _SourceFileError("模型文件超过已核实的长度。")
                    digest.update(chunk)
                    output.write(chunk)
        if size != spec.size or digest.hexdigest() != spec.sha256:
            raise _SourceFileError("模型文件完整性校验未通过。")
        # All input/output handles are closed before replacement on Windows.
        os.replace(pending, destination)
    finally:
        if pending is not None:
            pending.unlink(missing_ok=True)


def _download_huggingface(model: ModelSpec, spec: FileSpec, destination: Path) -> None:
    from huggingface_hub import hf_hub_download

    # A fixed per-file download avoids snapshot_download's unbounded directory
    # listing. local_dir also avoids making a second permanent copy of weights.
    with tempfile.TemporaryDirectory(prefix=".whisper-hf-", dir=destination.parent) as temporary:
        downloaded = Path(hf_hub_download(
            model.huggingface_repository, filename=spec.name,
            revision=model.huggingface_revision, local_dir=temporary,
            endpoint="https://huggingface.co", token=False, etag_timeout=10,
        ))
        expected = Path(temporary) / spec.name
        if downloaded.resolve() != expected.resolve() or downloaded.is_symlink() or not _valid_file(downloaded, spec):
            raise _SourceFileError("官方模型文件完整性校验未通过。")
        os.replace(downloaded, destination)


def _storage_error(error):
    """Recognize disk/permission failures even under SDK transport wrappers."""
    pending = [error]
    seen = set()
    storage_codes = {getattr(errno, name, None) for name in (
        "EACCES", "EPERM", "ENOSPC", "EROFS", "EDQUOT", "EFBIG", "ENAMETOOLONG",
        "ENOENT", "ENOTDIR", "EISDIR", "EBUSY", "EIO", "EINVAL",
    )} - {None}
    while pending:
        current = pending.pop()
        if id(current) in seen:
            continue
        seen.add(id(current))
        if isinstance(current, PermissionError):
            return current
        if (isinstance(current, OSError)
                and not isinstance(current, (URLError, ssl.SSLError, http.client.HTTPException,
                                             ConnectionError, TimeoutError))
                and (current.errno in storage_codes or getattr(current, "winerror", None) in {5, 19, 32, 112, 206})):
            return current
        for related in (current.__cause__, current.__context__, getattr(current, "reason", None)):
            if isinstance(related, BaseException):
                pending.append(related)
    return None


def _raise_storage_error(error):
    code = error.errno or errno.EACCES
    message = "Whisper 时间定位模型缓存读写失败，请检查磁盘空间与目录权限。"
    if isinstance(error, PermissionError):
        raise PermissionError(code, message) from None
    raise OSError(code, message) from None


def download_whisper_model(name: str, output_dir: str | Path) -> Path:
    model = _MODELS.get(name)
    if model is None:
        raise ValueError("unsupported local faster-whisper model")
    directory = Path(output_dir)
    directory.mkdir(parents=True, exist_ok=True)
    if all(_valid_file(directory / spec.name, spec) for spec in model.files):
        return directory
    sources = (("ModelScope 国内源", _download_modelscope), ("官方 Hugging Face", _download_huggingface))
    for index, (label, download) in enumerate(sources):
        print(f"[模型下载] Whisper 时间定位模型 {name}：使用{label}。", flush=True)
        try:
            # Recompute missing files after a failed source. Already verified
            # files survive, including a successfully downloaded large weight.
            for spec in model.files:
                target = directory / spec.name
                if not _valid_file(target, spec):
                    download(model, spec, target)
            print(f"[模型下载] Whisper 时间定位模型 {name}：{label}下载及校验完成。", flush=True)
            return directory
        # requests' exceptions inherit OSError; httpx's hierarchy does not.
        except (OSError, RuntimeError, ValueError, http.client.HTTPException, HttpxHTTPError) as error:
            local_error = _storage_error(error)
            if local_error is not None:
                _raise_storage_error(local_error)
            if index == 0:
                print(f"[模型下载] Whisper 时间定位模型 {name}：国内源未完成，自动切换官方 Hugging Face。", flush=True)
    raise WhisperModelDownloadError("Whisper 时间定位模型下载未完成；国内源和官方源均已尝试，请检查网络后重新准备。") from None
