from __future__ import annotations

from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from tempfile import TemporaryDirectory

from .adapters import MediaProcessor, SourceProvider, SpeechRecognizer, StructureAnalyzer, TranscriptOutput, VisualAnalyzer, build_analysis_result
from .api_client import AnalysisResult, ClaimedJob


class AnalysisPipeline:
    def __init__(self, source: SourceProvider, media: MediaProcessor, speech: SpeechRecognizer, visual: VisualAnalyzer, structure: StructureAnalyzer) -> None:
        self.source = source
        self.media = media
        self.speech = speech
        self.visual = visual
        self.structure = structure

    def process(self, job: ClaimedJob, heartbeat) -> AnalysisResult:
        with TemporaryDirectory(prefix="liming-analysis-") as temporary:
            workspace = Path(temporary)
            heartbeat("downloading", 5, "正在安全获取源媒体")
            source_path = self.source.acquire(job, workspace / "source-media")
            heartbeat("processing", 18, "正在规范化媒体并提取音轨")
            media = self.media.prepare(source_path, workspace / "normalized")
            heartbeat("transcribing", 35, "正在并行转写语音与提取画面")
            with ThreadPoolExecutor(max_workers=2, thread_name_prefix="liming-evidence") as executor:
                transcript_future = executor.submit(self.speech.transcribe, media.audio_path) if media.audio_path else None
                visuals_future = executor.submit(self.visual.analyze, media, workspace / "visuals")
                transcript = transcript_future.result() if transcript_future else TranscriptOutput("zh-CN", ())
                visuals = visuals_future.result()
            heartbeat("extracting", 70, "正在整理字幕、OCR 与关键帧证据")
            heartbeat("analyzing", 84, "正在生成可追溯结构化结论")
            structure = self.structure.analyze(job, media, transcript, visuals)
            return build_analysis_result(transcript, structure)
