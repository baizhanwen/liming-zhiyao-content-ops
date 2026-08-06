import tempfile
import unittest
from pathlib import Path

from liming_analyzer.adapters import (
    MediaInfo,
    NormalizedMedia,
    TranscriptOutput,
    TranscriptSegment,
    VisualObservation,
    VisualOutput,
)
from liming_analyzer.api_client import ClaimedJob
from liming_analyzer.artifacts import ApiArtifactStore, transcript_vtt
from liming_analyzer.providers import (
    FunAsrSpeechRecognizer,
    InstructorStructureAnalyzer,
    PaddleOcrEngine,
    PySceneDetectFrameExtractor,
)
from liming_analyzer.sources import YtDlpPublicVideoResolver


class FakeAsr:
    def generate(self, **_kwargs):
        return [{"language": "zh-CN", "sentence_info": [
            {"start": 100, "end": 900, "text": "先说问题", "confidence": 0.94},
            {"start": 900, "end": 1800, "text": "再给方法", "confidence": 0.88},
        ]}]


class FakeRawAsr:
    def generate(self, **_kwargs):
        return [{
            "text": "<|zh|><|NEUTRAL|><|Speech|><|woitn|>时间轴测试",
            "timestamp": [[480, 720], [720, 960]],
        }]


class FakeOcr:
    def ocr(self, _path, cls=True):
        return [[[[0, 0], [1, 0], [1, 1], [0, 1]], ("管理增长", 0.91)]]


class FakeProcessor:
    ffmpeg = "ffmpeg"

    def __init__(self):
        self.commands = []

    def _execute(self, command):
        self.commands.append(command)


class FakeReport:
    def model_dump(self, mode="json"):
        return {
            "summary": "问题式开场",
            "hook": "先说问题",
            "structure": ["问题", "方法"],
            "audience": "管理者",
            "visual": ["大字标题"],
            "language": ["短句"],
            "highlights": ["开场直接"],
            "risks": [],
            "recommendations": ["保留问题式钩子"],
            "evidence": [{"start_ms": 100, "text": "先说问题", "source": "asr", "confidence": 94}],
            "confidence": 90,
        }


class FakeCompletions:
    last_kwargs = None

    def create(self, **_kwargs):
        type(self).last_kwargs = _kwargs
        return FakeReport()


class FakeClient:
    class Chat:
        completions = FakeCompletions()

    chat = Chat()


class FakeDownloader:
    def __init__(self, options):
        self.options = options

    def __enter__(self):
        return self

    def __exit__(self, *_args):
        return False

    def extract_info(self, _url, download=True):
        path = Path(self.options["outtmpl"].replace("%(ext)s", "mp4"))
        path.write_bytes(b"video")
        return {
            "id": "work-1",
            "title": "公开视频",
            "uploader": "示例账号",
            "timestamp": 1_700_000_000,
            "duration": 12.4,
            "view_count": 1000,
            "like_count": 52,
            "comment_count": 8,
            "share_count": 3,
            "_filename": str(path),
        }


class ArtifactClient:
    def __init__(self):
        self.uploads = []

    def upload_artifact(self, _job, **payload):
        self.uploads.append(payload)
        return {"id": f"asset-{len(self.uploads)}"}


class ProviderTests(unittest.TestCase):
    def test_funasr_normalizes_timeline_and_confidence(self):
        output = FunAsrSpeechRecognizer(engine=FakeAsr()).transcribe(Path("audio.wav"))
        self.assertEqual(output.full_text, "先说问题\n再给方法")
        self.assertEqual(output.segments[0].start_ms, 100)
        self.assertEqual(output.confidence, 91)

    def test_funasr_cleans_rich_tags_and_uses_word_timestamp_span(self):
        output = FunAsrSpeechRecognizer(engine=FakeRawAsr()).transcribe(Path("audio.wav"))
        self.assertEqual(output.full_text, "时间轴测试")
        self.assertEqual((output.segments[0].start_ms, output.segments[0].end_ms), (480, 960))

    def test_paddle_ocr_normalizes_legacy_output(self):
        text, confidence = PaddleOcrEngine(engine=FakeOcr()).recognize(Path("frame.jpg"))
        self.assertEqual(text, "管理增长")
        self.assertEqual(confidence, 91)

    def test_scene_detector_extracts_midpoint_frames(self):
        processor = FakeProcessor()
        extractor = PySceneDetectFrameExtractor(
            processor,
            detector=lambda _path: [(0.0, 2.0), (2.0, 6.0)],
        )
        media = NormalizedMedia(Path("video.mp4"), None, MediaInfo(6000, 1080, 1920, "h264", "aac"))
        with tempfile.TemporaryDirectory() as directory:
            frames = extractor.extract(media, Path(directory))
        self.assertEqual([frame.timestamp_ms for frame in frames], [1000, 4000])
        self.assertEqual(len(processor.commands), 2)

    def test_instructor_rejects_untraceable_evidence(self):
        transcript = TranscriptOutput("zh-CN", (TranscriptSegment(100, 900, "先说问题", 94),), 94)
        visual = VisualOutput((), (VisualObservation("ocr", 0, 0, "管理增长", 91),))
        analyzer = InstructorStructureAnalyzer(
            api_key="",
            base_url="https://example.invalid/v1",
            model="fixture",
            provider="test",
            client=FakeClient(),
            report_model=object,
        )
        job = ClaimedJob("job", "org", "project", "video", "upload", "analyzing", 84, 4, {})
        media = NormalizedMedia(Path("video.mp4"), None, MediaInfo(6000, 1080, 1920, "h264", "aac"))
        result = analyzer.analyze(job, media, transcript, visual)
        self.assertEqual(result.report["evidence"][0]["text"], "先说问题")
        self.assertEqual(result.confidence, 90)

    def test_deepseek_structured_analysis_disables_thinking_mode(self):
        transcript = TranscriptOutput(
            "zh-CN", (TranscriptSegment(100, 900, "先说问题", 94),), 94
        )
        visual = VisualOutput((), (VisualObservation("ocr", 0, 0, "管理增长", 91),))
        analyzer = InstructorStructureAnalyzer(
            api_key="",
            base_url="https://api.deepseek.com",
            model="deepseek-v4-flash",
            provider="deepseek",
            client=FakeClient(),
            report_model=object,
        )
        job = ClaimedJob("job", "org", "project", "video", "upload", "analyzing", 84, 4, {})
        media = NormalizedMedia(
            Path("video.mp4"), None, MediaInfo(6000, 1080, 1920, "h264", "aac")
        )
        analyzer.analyze(job, media, transcript, visual)
        self.assertEqual(
            FakeCompletions.last_kwargs["extra_body"],
            {"thinking": {"type": "disabled"}},
        )

    def test_long_transcript_is_deduplicated_windowed_and_capped(self):
        evidence_text = FakeReport().model_dump()["evidence"][0]["text"]
        segments = [TranscriptSegment(0, 1000, evidence_text, 94)]
        segments.extend(
            TranscriptSegment(index * 1000, (index + 1) * 1000, f"segment-{index}-" + "content" * 8, 90)
            for index in range(1, 40)
        )
        analyzer = InstructorStructureAnalyzer(
            api_key="", base_url="https://example.invalid/v1", model="fixture", provider="test",
            client=FakeClient(), report_model=object, max_source_tokens=240, window_tokens=90,
        )
        result = analyzer.analyze(
            ClaimedJob("job", "org", "project", "video", "upload", "analyzing", 84, 4, {}),
            NormalizedMedia(Path("video.mp4"), None, MediaInfo(1_800_000, 1080, 1920, "h264", "aac")),
            TranscriptOutput("zh-CN", tuple(segments), 90), VisualOutput(),
        )
        meta = result.report["analysis_meta"]
        self.assertEqual(meta["mode"], "budgeted")
        self.assertLess(meta["analyzed_segments"], meta["source_segments"])
        self.assertGreater(meta["chunk_count"], 1)
        self.assertLessEqual(meta["coverage_percent"], 100)

    def test_public_resolver_returns_metadata_and_metrics(self):
        captured = {}

        def factory(options):
            captured.update(options)
            return FakeDownloader(options)

        with tempfile.TemporaryDirectory() as directory:
            result = YtDlpPublicVideoResolver(
                factory,
                cookies_from_browser="edge:Default",
            ).download(
                "https://www.douyin.com/video/1",
                Path(directory) / "source",
            )
        self.assertEqual(result.metadata.platform_work_id, "work-1")
        self.assertEqual(result.metadata.plays, 1000)
        self.assertEqual(result.metadata.duration_sec, 12)
        self.assertEqual(captured["cookiesfrombrowser"], ("edge", "Default", None, None))

    def test_public_resolver_prefers_cookie_snapshot_while_browser_is_open(self):
        captured = {}

        def factory(options):
            captured.update(options)
            return FakeDownloader(options)

        with tempfile.TemporaryDirectory() as directory:
            cookie_file = Path(directory) / "cookies.txt"
            cookie_file.write_text("# Netscape HTTP Cookie File\n", encoding="utf-8")
            YtDlpPublicVideoResolver(
                factory,
                cookies_from_browser="edge",
                cookie_file=str(cookie_file),
            ).download(
                "https://www.douyin.com/video/1",
                Path(directory) / "source",
            )
        self.assertEqual(captured["cookiefile"], str(cookie_file.resolve()))
        self.assertNotIn("cookiesfrombrowser", captured)

    def test_artifact_store_persists_subtitles_and_keyframes(self):
        client = ArtifactClient()
        store = ApiArtifactStore(client)
        job = ClaimedJob("job", "org", "project", "video", "upload", "extracting", 70, 4, {})
        transcript = TranscriptOutput("zh-CN", (TranscriptSegment(0, 1000, "内容", 90),), 90)
        with tempfile.TemporaryDirectory() as directory:
            workspace = Path(directory)
            frame = workspace / "frame.jpg"
            frame.write_bytes(b"jpeg")
            from liming_analyzer.adapters import Keyframe

            visuals = VisualOutput((Keyframe(500, frame, "标题", 88),), ())
            stored = store.persist(job, transcript, visuals, workspace)
        self.assertEqual([item["kind"] for item in client.uploads], ["subtitle", "keyframe"])
        self.assertEqual(stored.keyframes[0].asset_id, "asset-2")
        self.assertIn("00:00:00.000 --> 00:00:01.000", transcript_vtt(transcript))


if __name__ == "__main__":
    unittest.main()
