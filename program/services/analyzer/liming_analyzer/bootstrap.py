from __future__ import annotations

import os
import shutil
import sys
from collections.abc import Callable, Mapping, Sequence
from dataclasses import dataclass, field
from datetime import UTC, datetime
from pathlib import Path, PureWindowsPath
from typing import TypeVar

from .api_client import AnalyzerApiClient
from .artifacts import ApiArtifactStore
from .ffmpeg import FfmpegMediaProcessor
from .minimax_vision import MiniMaxTokenPlanMcpVisionEngine
from .pipeline import AnalysisPipeline
from .providers import (
    FunAsrSpeechRecognizer,
    InstructorStructureAnalyzer,
    PaddleOcrEngine,
    PySceneDetectFrameExtractor,
    SparseTailFallbackSpeechRecognizer,
)
from .quality_speech import build_quality_recognizer
from .sources import PlatformSourceProvider, SkillCollectPublicVideoResolver
from .vision_capabilities import resolve_vision_capability
from .visual import KeyframeVisualAnalyzer, OpenAiCompatibleVisionEngine

T = TypeVar("T")

_EMPTY_JSON_ERROR_MARKERS = (
    "json.exception.parse_error.101",
    "attempting to parse an empty input",
    "unexpected end of input",
)

_MISSING_MODEL_FILE_MARKERS = (
    "cannot open file",
    "inference.json",
    "isfileexists(prog_file_)",
)

_FUNASR_CACHE_PATHS = (
    Path("models/iic--speech_seaco_paraformer_large_asr_nat-zh-cn-16k-common-vocab8404-pytorch"),
    Path("models/iic--speech_fsmn_vad_zh-cn-16k-common-pytorch"),
    Path("models/iic--punc_ct-transformer_cn-en-common-vocab471067-large"),
)

_PADDLE_MODEL_SOURCES = frozenset({"bos", "aistudio", "modelscope", "huggingface"})


def _path_is_ascii(value: str) -> bool:
    try:
        value.encode("ascii")
    except UnicodeEncodeError:
        return False
    return True


def _windows_model_cache(environ: Mapping[str, str]) -> str:
    # Paddle's Windows native inference runtime cannot open model files when
    # their absolute path contains non-ASCII characters. This is common for a
    # Chinese Windows account because LOCALAPPDATA lives below C:\Users\<name>.
    # ProgramData is machine-local, writable for application-created folders,
    # and normally has an ASCII-only path.
    system_drive = (environ.get("SystemDrive") or "C:").rstrip("\\/") + "\\"
    candidates = (
        environ.get("PROGRAMDATA", ""),
        environ.get("PUBLIC", ""),
        str(PureWindowsPath(system_drive) / "ProgramData"),
    )
    for root in candidates:
        if root and _path_is_ascii(root):
            return str(PureWindowsPath(root) / "LimingZhiyao" / "model-cache")
    return r"C:\ProgramData\LimingZhiyao\model-cache"


def _default_model_cache() -> str:
    if os.name == "nt":
        return _windows_model_cache(os.environ)
    return "model-cache"


def _normalize_model_cache(value: str) -> str:
    candidate = value.strip() or _default_model_cache()
    if os.name != "nt" or _path_is_ascii(candidate):
        return candidate
    fallback = _default_model_cache()
    print(
        "[RECOVERY] ANALYZER_MODEL_CACHE contains non-ASCII characters that "
        f"Paddle cannot open on Windows. Using {fallback} instead.",
        file=sys.stderr,
        flush=True,
    )
    return fallback


def _resolve_media_executable(value: str, label: str) -> str:
    configured = value.strip()
    if not configured:
        raise RuntimeError(f"{label} executable is not configured")
    candidate = Path(configured).expanduser()
    if candidate.is_file():
        return str(candidate.resolve())
    resolved = shutil.which(configured)
    if resolved:
        return str(Path(resolved).resolve())
    raise RuntimeError(
        f"{label} executable was not found. Run tools\\setup-analyzer.bat "
        "to repair FFmpeg and ffprobe."
    )


@dataclass(frozen=True)
class AnalyzerSettings:
    base_url: str
    service_token: str
    worker_id: str
    llm_api_key: str
    llm_base_url: str
    llm_model: str
    llm_provider: str
    vision_api_key: str = ""
    vision_base_url: str = ""
    vision_model: str = ""
    vision_provider: str = ""
    vision_concurrency: int = 2
    asr_model: str = "large-v3-turbo"
    asr_engine: str = "faster-whisper"
    asr_language: str = "zh"
    asr_fallback_model: str = "iic/SenseVoiceSmall"
    asr_device: str = "auto"
    paddle_ocr_detection_model: str = "PP-OCRv5_mobile_det"
    paddle_ocr_recognition_model: str = "PP-OCRv5_mobile_rec"
    paddle_model_source: str = "bos"
    ffmpeg: str = "ffmpeg"
    ffprobe: str = "ffprobe"
    model_cache: str = field(default_factory=_default_model_cache)
    yt_dlp_cookies_from_browser: str = "edge"
    yt_dlp_cookie_file: str = ".local/douyin-cookies.txt"

    @classmethod
    def from_environment(cls) -> AnalyzerSettings:
        required = {
            "base_url": "ANALYZER_BASE_URL",
            "service_token": "ANALYZER_SERVICE_TOKEN",
            "worker_id": "ANALYZER_WORKER_ID",
        }
        values = {field: os.environ.get(key, "").strip() for field, key in required.items()}
        missing = [required[field] for field, value in values.items() if not value]
        if missing:
            raise RuntimeError(f"missing analyzer settings: {', '.join(missing)}")
        # The worker can register and wait without cloud credentials. Each
        # claimed job retrieves its own organization-scoped model snapshot;
        # model_configuration() validates those credentials before processing.
        values.update({
            field: os.environ.get(key, "").strip()
            for field, key in {
                "llm_api_key": "ANALYZER_LLM_API_KEY",
                "llm_base_url": "ANALYZER_LLM_BASE_URL",
                "llm_model": "ANALYZER_LLM_MODEL",
                "llm_provider": "ANALYZER_LLM_PROVIDER",
            }.items()
        })
        vision_concurrency_value = os.environ.get(
            "ANALYZER_VISION_CONCURRENCY",
            "2",
        ).strip()
        try:
            vision_concurrency = int(vision_concurrency_value)
        except ValueError as error:
            raise RuntimeError("ANALYZER_VISION_CONCURRENCY must be an integer") from error
        if not 1 <= vision_concurrency <= 3:
            raise RuntimeError("ANALYZER_VISION_CONCURRENCY must be between 1 and 3")
        asr_engine = os.environ.get("ANALYZER_ASR_ENGINE", "faster-whisper").strip()
        return cls(
            **values,
            vision_api_key=os.environ.get("ANALYZER_VISION_API_KEY", "").strip(),
            vision_base_url=os.environ.get("ANALYZER_VISION_BASE_URL", "").strip(),
            vision_model=os.environ.get("ANALYZER_VISION_MODEL", "").strip(),
            vision_provider=os.environ.get("ANALYZER_VISION_PROVIDER", "").strip(),
            vision_concurrency=vision_concurrency,
            asr_model=os.environ.get("ANALYZER_ASR_MODEL", "paraformer-zh" if asr_engine == "funasr" else "large-v3-turbo").strip(),
            asr_engine=asr_engine,
            asr_language=os.environ.get("ANALYZER_ASR_LANGUAGE", "zh").strip(),
            asr_fallback_model=os.environ.get(
                "ANALYZER_ASR_FALLBACK_MODEL", "iic/SenseVoiceSmall"
            ).strip(),
            asr_device=os.environ.get("ANALYZER_ASR_DEVICE", "cpu" if asr_engine == "funasr" else "auto").strip(),
            paddle_ocr_detection_model=os.environ.get(
                "ANALYZER_PADDLE_OCR_DETECTION_MODEL", "PP-OCRv5_mobile_det"
            ).strip(),
            paddle_ocr_recognition_model=os.environ.get(
                "ANALYZER_PADDLE_OCR_RECOGNITION_MODEL", "PP-OCRv5_mobile_rec"
            ).strip(),
            paddle_model_source=os.environ.get(
                "ANALYZER_PADDLE_MODEL_SOURCE", "bos"
            ).strip().lower(),
            ffmpeg=os.environ.get("ANALYZER_FFMPEG", "ffmpeg").strip(),
            ffprobe=os.environ.get("ANALYZER_FFPROBE", "ffprobe").strip(),
            model_cache=_normalize_model_cache(os.environ.get("ANALYZER_MODEL_CACHE", "")),
            yt_dlp_cookies_from_browser=os.environ.get(
                "ANALYZER_YTDLP_COOKIES_FROM_BROWSER", "edge"
            ).strip(),
            yt_dlp_cookie_file=os.environ.get(
                "ANALYZER_YTDLP_COOKIE_FILE", ".local/douyin-cookies.txt"
            ).strip(),
        )


def _configure_paddlex_model_source(source: str) -> None:
    normalized = source.strip().lower()
    if normalized not in _PADDLE_MODEL_SOURCES:
        choices = ", ".join(sorted(_PADDLE_MODEL_SOURCES))
        raise RuntimeError(
            f"unsupported ANALYZER_PADDLE_MODEL_SOURCE={source!r}; choose one of: {choices}"
        )

    # PaddleX 3.7 defaults to Hugging Face. On some Windows installations the
    # Hub reports a successful snapshot download but leaves link-backed model
    # files unavailable to Paddle's native runtime. BOS distributes a regular
    # tar archive, so the extracted inference files are real local files.
    # These flags must be set before paddleocr imports paddlex.utils.flags.
    os.environ["PADDLE_PDX_MODEL_SOURCE"] = normalized
    os.environ["PADDLE_PDX_DISABLE_MODEL_SOURCE_CHECK"] = "True"


def build_client(settings: AnalyzerSettings) -> AnalyzerApiClient:
    return AnalyzerApiClient(
        settings.base_url,
        settings.service_token,
        settings.worker_id,
        browser_auth_nonblocking=True,
        browser_auth_probe=lambda: {
            "status": "disabled", "browser": None,
            "checkedAt": datetime.now(UTC).isoformat().replace("+00:00", "Z"),
            "message": "使用 Skill Collect 独立匿名 Chromium 采集，无需个人浏览器登录态或 Cookie。",
        },
    )


def _exception_messages(error: BaseException) -> str:
    messages: list[str] = []
    seen: set[int] = set()
    current: BaseException | None = error
    while current is not None and id(current) not in seen:
        seen.add(id(current))
        messages.append(str(current))
        current = current.__cause__ or current.__context__
    return " | ".join(messages).lower()


def _is_recoverable_model_cache_error(error: BaseException) -> bool:
    message = _exception_messages(error)
    empty_json = _EMPTY_JSON_ERROR_MARKERS[0] in message and any(
        marker in message for marker in _EMPTY_JSON_ERROR_MARKERS[1:]
    )
    missing_model_file = all(marker in message for marker in _MISSING_MODEL_FILE_MARKERS)
    return empty_json or missing_model_file


def _remove_cache_entries(cache_root: Path, relative_paths: Sequence[Path]) -> tuple[Path, ...]:
    root = cache_root.expanduser().resolve()
    removed: list[Path] = []
    for relative_path in relative_paths:
        candidate = (root / relative_path).resolve()
        if candidate == root or not candidate.is_relative_to(root) or not candidate.exists():
            continue
        if candidate.is_dir():
            shutil.rmtree(candidate)
        else:
            candidate.unlink()
        removed.append(candidate)
    return tuple(removed)


def _initialize_model_with_cache_repair(
    label: str,
    factory: Callable[[], T],
    cache_root: Path,
    recoverable_paths: Sequence[Path],
) -> T:
    try:
        return factory()
    except Exception as error:
        if not _is_recoverable_model_cache_error(error):
            raise RuntimeError(f"{label} model initialization failed: {error}") from error

        try:
            removed = _remove_cache_entries(cache_root, recoverable_paths)
        except OSError as cleanup_error:
            raise RuntimeError(
                f"{label} model cache is damaged and could not be cleared: {cleanup_error}. "
                "Close any other analyzer process, then run tools\\repair-analyzer-models.bat."
            ) from error

        if not removed:
            raise RuntimeError(
                f"{label} model cache is incomplete, but its known cache folders were not found. "
                "Run tools\\repair-analyzer-models.bat, then retry the task."
            ) from error

        print(
            f"[RECOVERY] {label} cache was incomplete. Removed {len(removed)} model folder(s); "
            "downloading a clean copy and retrying once.",
            file=sys.stderr,
            flush=True,
        )
        try:
            return factory()
        except Exception as retry_error:
            raise RuntimeError(
                f"{label} model initialization still failed after automatic cache repair: {retry_error}. "
                "Check that this computer can download model files, then run "
                "tools\\repair-analyzer-models.bat and retry."
            ) from retry_error


def _paddlex_cache_paths(settings: AnalyzerSettings) -> tuple[Path, ...]:
    names = (
        settings.paddle_ocr_detection_model,
        settings.paddle_ocr_recognition_model,
    )
    return tuple(Path("official_models") / name for name in names) + tuple(
        Path("locks/official_models") / name for name in names
    )


def build_pipeline(settings: AnalyzerSettings, client: AnalyzerApiClient, *, transcript_only: bool = False) -> AnalysisPipeline:
    model_cache = Path(settings.model_cache).expanduser().resolve()
    model_cache.mkdir(parents=True, exist_ok=True)
    _configure_paddlex_model_source(settings.paddle_model_source)
    # Override inherited cache variables so stale values below a non-ASCII
    # Windows profile cannot route native model files back to the broken path.
    os.environ["PADDLE_PDX_CACHE_HOME"] = str(model_cache / "paddlex")
    os.environ["MODELSCOPE_CACHE"] = str(model_cache / "modelscope")
    os.environ["HF_HOME"] = str(model_cache / "huggingface")
    resolved_ffmpeg = _resolve_media_executable(settings.ffmpeg, "ffmpeg")
    resolved_ffprobe = _resolve_media_executable(settings.ffprobe, "ffprobe")
    media = FfmpegMediaProcessor(resolved_ffmpeg, resolved_ffprobe)
    if settings.asr_engine == "faster-whisper":
        speech = build_quality_recognizer(
            settings.asr_model, model_cache=model_cache,
            language=settings.asr_language, device=settings.asr_device,
        )
    elif settings.asr_engine == "funasr":
        primary_speech = _initialize_model_with_cache_repair(
            "FunASR speech recognition",
            lambda: FunAsrSpeechRecognizer(settings.asr_model, device=settings.asr_device),
            model_cache / "modelscope", _FUNASR_CACHE_PATHS,
        )
        speech = primary_speech
        if settings.asr_fallback_model and settings.asr_fallback_model != settings.asr_model:
            speech = SparseTailFallbackSpeechRecognizer(
                primary_speech,
                lambda: FunAsrSpeechRecognizer(settings.asr_fallback_model, device=settings.asr_device, punc_model=None),
            )
    else:
        raise RuntimeError("Unsupported ANALYZER_ASR_ENGINE; choose faster-whisper or funasr.")
    source = PlatformSourceProvider(client, SkillCollectPublicVideoResolver(ffmpeg=resolved_ffmpeg, ffprobe=resolved_ffprobe))
    artifact_store = ApiArtifactStore(client)
    try:
        ocr = _initialize_model_with_cache_repair(
            "PaddleOCR visual recognition",
            lambda: PaddleOcrEngine(
                detection_model=settings.paddle_ocr_detection_model,
                recognition_model=settings.paddle_ocr_recognition_model,
            ),
            model_cache / "paddlex", _paddlex_cache_paths(settings),
        )
    except RuntimeError:
        if not transcript_only:
            raise
        import logging
        logging.getLogger(__name__).warning("字幕识别模型未就绪，本次仅使用原声转写")
        ocr = None
    if transcript_only:
        return AnalysisPipeline(source, media, speech, None, None, artifact_store, manuscript_ocr=ocr)
    vision_values = (
        settings.vision_api_key,
        settings.vision_base_url,
        settings.vision_model,
        settings.vision_provider,
    )
    vision_capability = resolve_vision_capability(
        provider=settings.vision_provider,
        model=settings.vision_model,
        api_key=settings.vision_api_key,
        base_url=settings.vision_base_url,
    )
    if vision_capability.adapter == "minimax_token_plan_mcp":
        vision_engine = MiniMaxTokenPlanMcpVisionEngine(
            api_key=settings.vision_api_key,
            api_host=vision_capability.api_host,
            concurrency=settings.vision_concurrency,
        )
        vision_unavailable_reason = ""
    elif vision_capability.adapter == "openai_compatible":
        vision_engine = OpenAiCompatibleVisionEngine(
            api_key=settings.vision_api_key,
            base_url=settings.vision_base_url,
            model=settings.vision_model,
            provider=settings.vision_provider,
        )
        vision_unavailable_reason = ""
    elif any(vision_values):
        vision_engine = None
        vision_unavailable_reason = vision_capability.reason
    else:
        vision_engine = None
        vision_unavailable_reason = (
            "独立视觉模型未配置；OCR 结果不会被当作真实画面分析。"
        )
    visual = KeyframeVisualAnalyzer(
        PySceneDetectFrameExtractor(media),
        ocr,
        vision_engine,
        vision_unavailable_reason=vision_unavailable_reason,
    )
    structure = InstructorStructureAnalyzer(
        api_key=settings.llm_api_key,
        base_url=settings.llm_base_url,
        model=settings.llm_model,
        provider=settings.llm_provider,
        call_recorder=client.record_model_call,
    )
    return AnalysisPipeline(source, media, speech, visual, structure, artifact_store, artifact_store, manuscript_ocr=ocr)
