from __future__ import annotations

import os
from dataclasses import dataclass, field
from pathlib import Path

from .api_client import AnalyzerApiClient
from .artifacts import ApiArtifactStore
from .ffmpeg import FfmpegMediaProcessor
from .pipeline import AnalysisPipeline
from .providers import (
    FunAsrSpeechRecognizer,
    InstructorStructureAnalyzer,
    PaddleOcrEngine,
    PySceneDetectFrameExtractor,
)
from .sources import PlatformSourceProvider, YtDlpPublicVideoResolver
from .visual import KeyframeVisualAnalyzer


def _default_model_cache() -> str:
    if os.name == "nt" and (local_app_data := os.environ.get("LOCALAPPDATA")):
        return str(Path(local_app_data) / "LimingZhiyao" / "model-cache")
    return "model-cache"


@dataclass(frozen=True)
class AnalyzerSettings:
    base_url: str
    service_token: str
    worker_id: str
    llm_api_key: str
    llm_base_url: str
    llm_model: str
    llm_provider: str
    asr_model: str = "paraformer-zh"
    asr_device: str = "cpu"
    paddle_ocr_detection_model: str = "PP-OCRv5_mobile_det"
    paddle_ocr_recognition_model: str = "PP-OCRv5_mobile_rec"
    ffmpeg: str = "ffmpeg"
    ffprobe: str = "ffprobe"
    model_cache: str = field(default_factory=_default_model_cache)
    yt_dlp_cookies_from_browser: str = ""
    yt_dlp_cookie_file: str = ".local/douyin-cookies.txt"

    @classmethod
    def from_environment(cls) -> AnalyzerSettings:
        required = {
            "base_url": "ANALYZER_BASE_URL",
            "service_token": "ANALYZER_SERVICE_TOKEN",
            "worker_id": "ANALYZER_WORKER_ID",
            "llm_api_key": "ANALYZER_LLM_API_KEY",
            "llm_base_url": "ANALYZER_LLM_BASE_URL",
            "llm_model": "ANALYZER_LLM_MODEL",
            "llm_provider": "ANALYZER_LLM_PROVIDER",
        }
        values = {field: os.environ.get(key, "").strip() for field, key in required.items()}
        missing = [required[field] for field, value in values.items() if not value]
        if missing:
            raise RuntimeError(f"missing analyzer settings: {', '.join(missing)}")
        return cls(
            **values,
            asr_model=os.environ.get("ANALYZER_ASR_MODEL", "paraformer-zh").strip(),
            asr_device=os.environ.get("ANALYZER_ASR_DEVICE", "cpu").strip(),
            paddle_ocr_detection_model=os.environ.get(
                "ANALYZER_PADDLE_OCR_DETECTION_MODEL", "PP-OCRv5_mobile_det"
            ).strip(),
            paddle_ocr_recognition_model=os.environ.get(
                "ANALYZER_PADDLE_OCR_RECOGNITION_MODEL", "PP-OCRv5_mobile_rec"
            ).strip(),
            ffmpeg=os.environ.get("ANALYZER_FFMPEG", "ffmpeg").strip(),
            ffprobe=os.environ.get("ANALYZER_FFPROBE", "ffprobe").strip(),
            model_cache=os.environ.get("ANALYZER_MODEL_CACHE", _default_model_cache()).strip(),
            yt_dlp_cookies_from_browser=os.environ.get(
                "ANALYZER_YTDLP_COOKIES_FROM_BROWSER", ""
            ).strip(),
            yt_dlp_cookie_file=os.environ.get(
                "ANALYZER_YTDLP_COOKIE_FILE", ".local/douyin-cookies.txt"
            ).strip(),
        )


def build_analyzer(settings: AnalyzerSettings) -> tuple[AnalyzerApiClient, AnalysisPipeline]:
    model_cache = Path(settings.model_cache).expanduser().resolve()
    model_cache.mkdir(parents=True, exist_ok=True)
    os.environ.setdefault("PADDLE_PDX_CACHE_HOME", str(model_cache / "paddlex"))
    os.environ.setdefault("MODELSCOPE_CACHE", str(model_cache / "modelscope"))
    os.environ.setdefault("HF_HOME", str(model_cache / "huggingface"))
    client = AnalyzerApiClient(
        settings.base_url,
        settings.service_token,
        settings.worker_id,
    )
    media = FfmpegMediaProcessor(settings.ffmpeg, settings.ffprobe)
    speech = FunAsrSpeechRecognizer(
        settings.asr_model,
        device=settings.asr_device,
    )
    visual = KeyframeVisualAnalyzer(
        PySceneDetectFrameExtractor(media),
        PaddleOcrEngine(
            detection_model=settings.paddle_ocr_detection_model,
            recognition_model=settings.paddle_ocr_recognition_model,
        ),
    )
    structure = InstructorStructureAnalyzer(
        api_key=settings.llm_api_key,
        base_url=settings.llm_base_url,
        model=settings.llm_model,
        provider=settings.llm_provider,
    )
    pipeline = AnalysisPipeline(
        PlatformSourceProvider(
            client,
            YtDlpPublicVideoResolver(
                cookies_from_browser=settings.yt_dlp_cookies_from_browser,
                cookie_file=settings.yt_dlp_cookie_file,
            ),
            cookie_file=settings.yt_dlp_cookie_file,
        ),
        media,
        speech,
        visual,
        structure,
        ApiArtifactStore(client),
    )
    return client, pipeline
