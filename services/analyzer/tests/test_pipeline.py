import unittest

from liming_analyzer.adapters import (
    Keyframe,
    MediaInfo,
    NormalizedMedia,
    StructureOutput,
    TranscriptOutput,
    TranscriptSegment,
    VisualObservation,
    VisualOutput,
)
from liming_analyzer.api_client import ClaimedJob
from liming_analyzer.pipeline import AnalysisPipeline


class Source:
    def acquire(self, job, destination):
        destination.write_bytes(b"media")
        return destination


class Media:
    def prepare(self, source, output_dir):
        audio = output_dir / "audio.wav"
        output_dir.mkdir(parents=True)
        audio.write_bytes(b"audio")
        return NormalizedMedia(source, audio, MediaInfo(12000, 1080, 1920, "h264", "aac"))


class Speech:
    def transcribe(self, audio):
        return TranscriptOutput("zh-CN", (TranscriptSegment(0, 2200, "先提出问题", 94),), 94)


class Visual:
    def analyze(self, media, output_dir):
        return VisualOutput((Keyframe(0, output_dir / "frame.jpg", "管理增长", 88),), (VisualObservation("ocr", 0, 0, "管理增长", 88),))


class Structure:
    def analyze(self, job, media, transcript, visuals):
        self.inputs = (job, media, transcript, visuals)
        return StructureOutput("analysis.v1", {"summary": "问题式开场", "evidence": [{"start_ms": 0, "text": transcript.segments[0].text}]}, 91, "test", "fixture", "prompt.v1")


class PipelineTests(unittest.TestCase):
    def test_pipeline_preserves_evidence_and_emits_legal_stage_order(self):
        job = ClaimedJob("job-1", "org-1", "project-1", "video-1", "upload", "queued", 1, 2, {})
        structure = Structure(); stages = []

        def heartbeat(status, progress, stage):
            stages.append((status, progress, stage))
            return job

        result = AnalysisPipeline(Source(), Media(), Speech(), Visual(), structure).process(job, heartbeat)
        self.assertEqual([item[0] for item in stages], ["downloading", "processing", "transcribing", "extracting", "analyzing"])
        self.assertEqual(result.transcript.segments[0]["start_ms"], 0)
        self.assertEqual(result.report["evidence"][0]["text"], "先提出问题")
        self.assertEqual(result.confidence, 91)


if __name__ == "__main__":
    unittest.main()
