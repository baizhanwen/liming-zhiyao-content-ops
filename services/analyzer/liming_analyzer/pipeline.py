from __future__ import annotations

from concurrent.futures import ALL_COMPLETED, ThreadPoolExecutor, wait
from pathlib import Path
from tempfile import TemporaryDirectory

from .adapters import (
    AcquiredSource,
    AnalysisArtifactStore,
    MediaProcessor,
    SourceProvider,
    SpeechRecognizer,
    StructureAnalyzer,
    TranscriptOutput,
    VisualAnalyzer,
    build_analysis_result,
)
from .api_client import AnalysisResult, ClaimedJob


class AnalysisPipeline:
    def __init__(
        self,
        source: SourceProvider,
        media: MediaProcessor,
        speech: SpeechRecognizer,
        visual: VisualAnalyzer,
        structure: StructureAnalyzer,
        artifacts: AnalysisArtifactStore | None = None,
        heartbeat_seconds: float = 30.0,
    ) -> None:
        if heartbeat_seconds <= 0:
            raise ValueError("heartbeat_seconds must be positive")
        self.source = source
        self.media = media
        self.speech = speech
        self.visual = visual
        self.structure = structure
        self.artifacts = artifacts
        self.heartbeat_seconds = heartbeat_seconds

    def process(self, job: ClaimedJob, heartbeat) -> AnalysisResult:
        with TemporaryDirectory(prefix="liming-analysis-") as temporary:
            workspace = Path(temporary)
            current = heartbeat("downloading", 5, "正在安全获取源媒体")
            acquired = self.source.acquire(current, workspace / "source-media")
            acquired = acquired if isinstance(acquired, AcquiredSource) else AcquiredSource(acquired)

            current = heartbeat("processing", 18, "正在规范化媒体并提取音轨")
            media = self.media.prepare(acquired.path, workspace / "normalized")
            current = heartbeat("transcribing", 35, "正在并行转写语音与提取画面")

            with ThreadPoolExecutor(max_workers=2, thread_name_prefix="liming-evidence") as executor:
                transcript_future = executor.submit(self.speech.transcribe, media.audio_path) if media.audio_path else None
                visuals_future = executor.submit(self.visual.analyze, media, workspace / "visuals")
                pending = {visuals_future}
                if transcript_future:
                    pending.add(transcript_future)
                progress = 40
                while pending:
                    _done, pending = wait(pending, timeout=self.heartbeat_seconds, return_when=ALL_COMPLETED)
                    if pending:
                        progress = min(64, progress + 4)
                        current = heartbeat("transcribing", progress, "正在转写语音并识别关键画面")
                transcript = transcript_future.result() if transcript_future else TranscriptOutput("zh-CN", ())
                visuals = visuals_future.result()

            current = heartbeat("extracting", 70, "正在整理字幕、OCR 与关键帧证据")
            if self.artifacts:
                visuals = self.artifacts.persist(current, transcript, visuals, workspace)
            current = heartbeat("analyzing", 84, "正在生成可追溯结构化结论")
            structure = self.structure.analyze(current, media, transcript, visuals)
            return build_analysis_result(transcript, structure, acquired.metadata)
