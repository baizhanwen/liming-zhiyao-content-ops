import unittest
from dataclasses import replace

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

    def test_manual_transcript_skips_asr_and_drives_reanalysis(self):
        class ForbiddenSpeech:
            def transcribe(self, _audio):
                raise AssertionError("ASR must not run for a manual transcript")

        job = ClaimedJob("job-2", "org-1", "project-1", "video-1", "upload", "queued", 1, 2, {
            "manual_transcript": {"language": "zh-CN", "segments": [{"start_ms": 0, "end_ms": 2200, "text": "人工校正后的原文"}]}
        })
        structure = Structure()

        result = AnalysisPipeline(Source(), Media(), ForbiddenSpeech(), Visual(), structure).process(job, lambda *_: job)

        self.assertEqual(result.transcript.full_text, "人工校正后的原文")
        self.assertEqual(structure.inputs[2].segments[0].text, "人工校正后的原文")

    def test_failed_structure_analysis_resumes_from_persisted_evidence_checkpoint(self):
        class Checkpoints:
            saved = None

            def save(self, _job, stage, checkpoint):
                self.stage = stage
                self.saved = checkpoint

        class FailingStructure:
            def analyze(self, *_):
                raise RuntimeError("model report failed")

        checkpoints = Checkpoints()
        job = ClaimedJob("job-3", "org-1", "project-1", "video-1", "upload", "queued", 1, 2, {})
        with self.assertRaisesRegex(RuntimeError, "model report failed"):
            AnalysisPipeline(Source(), Media(), Speech(), Visual(), FailingStructure(), checkpoints=checkpoints).process(job, lambda *_: job)
        self.assertEqual(checkpoints.stage, "evidence_ready")
        self.assertIsNotNone(checkpoints.saved)

        class Forbidden:
            def __getattr__(self, name):
                raise AssertionError(f"checkpoint resume must not use {name}")

        structure = Structure(); stages = []
        resumed = replace(job, status="queued", progress=82, version=4, checkpoint_stage="evidence_ready", checkpoint=checkpoints.saved, resume_count=1)

        def heartbeat(status, progress, stage):
            stages.append((status, progress, stage))
            return replace(resumed, status=status, progress=progress)

        result = AnalysisPipeline(Forbidden(), Forbidden(), Forbidden(), Forbidden(), structure).process(resumed, heartbeat)
        self.assertEqual([item[0] for item in stages], ["analyzing"])
        self.assertIn("检查点恢复", stages[0][2])
        self.assertEqual(result.transcript.full_text, "先提出问题")


if __name__ == "__main__":
    unittest.main()
