import tempfile
import unittest
from pathlib import Path
from typing import ClassVar

from PIL import Image

from liming_analyzer.adapters import (
    Keyframe,
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
    _assess_report_quality,
    _recover_partial_json_report,
)
from liming_analyzer.sources import YtDlpPublicVideoResolver
from liming_analyzer.visual import KeyframeVisualAnalyzer


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
            "spoken_script": ["先把问题讲清楚，再给出能够执行的方法。"],
            "hook_analysis": ["以目标人群正在经历的问题直接开场。"],
            "viral_points": ["问题与解决方法形成清晰反差。"],
            "rhythm_analysis": ["开场快，方法部分逐步展开。"],
            "emotion_curve": ["从问题压力推进到解决希望。"],
            "conversion_design": ["结尾用明确行动建议完成转化。"],
            "insight_evidence": [{"section": "hook_analysis", "item_index": 0, "evidence_text": "先说问题"}],
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
    calls: ClassVar[list[dict]] = []

    def create(self, **_kwargs):
        type(self).last_kwargs = _kwargs
        type(self).calls.append(_kwargs)
        return FakeReport()

    def create_with_completion(self, **_kwargs):
        type(self).last_kwargs = _kwargs
        type(self).calls.append(_kwargs)
        usage = type("Usage", (), {"prompt_tokens": 720, "completion_tokens": 180, "total_tokens": 900})()
        return FakeReport(), type("RawCompletion", (), {"usage": usage})()


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

    def test_scene_detector_combines_scenes_with_full_timeline_anchors(self):
        processor = FakeProcessor()
        extractor = PySceneDetectFrameExtractor(
            processor,
            detector=lambda _path: [(0.0, 2.0), (2.0, 6.0)],
        )
        media = NormalizedMedia(Path("video.mp4"), None, MediaInfo(6000, 1080, 1920, "h264", "aac"))
        with tempfile.TemporaryDirectory() as directory:
            frames = extractor.extract(media, Path(directory))
        self.assertEqual([frame.timestamp_ms for frame in frames], [0, 3000, 5750])
        self.assertEqual(len(processor.commands), 3)
        self.assertEqual(extractor.last_stats["strategy"], "scene_plus_timeline")
        self.assertEqual(extractor.last_stats["scene_count"], 2)
        self.assertEqual(extractor.last_stats["anchor_count"], 3)

    def test_scene_detector_uses_ffmpeg_scores_and_enforces_minimum_scene_length(self):
        class SceneProcessor:
            ffmpeg = "ffmpeg"

            def __init__(self):
                self.command = []

            def _execute(self, command):
                self.command = command
                return type(
                    "Result",
                    (),
                    {"stderr": "pts_time:0.4 scene:0.4 pts_time:2.0 scene:0.5 pts_time:2.5 pts_time:7.0"},
                )()

            def probe(self, _source):
                return MediaInfo(10_000, 1080, 1920, "h264", "aac")

        processor = SceneProcessor()
        extractor = PySceneDetectFrameExtractor(processor, minimum_scene_seconds=1.0)
        self.assertEqual(extractor._detect(Path("video.mp4")), [(0.0, 2.0), (2.0, 7.0), (7.0, 10.0)])
        self.assertIn(r"select=gt(scene\,0.32),showinfo", processor.command)

    def test_scene_detector_gives_long_videos_even_full_length_coverage(self):
        processor = FakeProcessor()
        extractor = PySceneDetectFrameExtractor(
            processor,
            detector=lambda _path: [(0.0, 120.0), (500.0, 700.0), (900.0, 1029.0)],
        )
        media = NormalizedMedia(Path("video.mp4"), None, MediaInfo(1_029_000, 1080, 1920, "h264", "aac"))
        with tempfile.TemporaryDirectory() as directory:
            frames = extractor.extract(media, Path(directory))
        self.assertGreaterEqual(len(frames), 14)
        self.assertLessEqual(len(frames), 24)
        self.assertEqual(frames[0].timestamp_ms, 0)
        self.assertGreaterEqual(frames[-1].timestamp_ms, 1_028_000)
        self.assertEqual(extractor.last_stats["target_count"], 16)

    def test_visual_analyzer_retains_boundaries_and_drops_local_duplicates(self):
        class Extractor:
            def extract(self, _media, output_dir):
                output_dir.mkdir(parents=True, exist_ok=True)
                black = output_dir / "black.jpg"; first = output_dir / "first.jpg"; duplicate = output_dir / "duplicate.jpg"; second = output_dir / "second.jpg"
                Image.new("L", (64, 64), 0).save(black)
                image = Image.new("L", (64, 64), 0)
                for x in range(32, 64):
                    for y in range(64): image.putpixel((x, y), 255)
                image.save(first); image.save(duplicate)
                Image.eval(image, lambda value: 255 - value).save(second)
                return [Keyframe(0, black), Keyframe(1_000, first), Keyframe(2_000, duplicate), Keyframe(3_000, second)]

        class Ocr:
            calls = 0

            def recognize(self, _path):
                self.calls += 1
                return ("有效标题", 90) if self.calls == 1 else ("低置信乱码", 20)

        with tempfile.TemporaryDirectory() as directory:
            output = KeyframeVisualAnalyzer(Extractor(), Ocr()).analyze(
                NormalizedMedia(Path("video.mp4"), None, MediaInfo(6_000, 64, 64, "h264", "aac")),
                Path(directory),
            )
        self.assertEqual(len(output.keyframes), 3)
        self.assertEqual(len(output.observations), 1)
        self.assertEqual(output.keyframes[2].ocr_text, None)
        self.assertEqual(output.stats["similar_removed"], 1)
        self.assertEqual(output.stats["kept_count"], 3)

    def test_instructor_rejects_untraceable_evidence(self):
        transcript = TranscriptOutput("zh-CN", (TranscriptSegment(100, 900, "先说问题", 94),), 94)
        visual = VisualOutput((), (VisualObservation("ocr", 0, 0, "管理增长", 91),), {"kept_count": 12})
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
        self.assertEqual(result.report["insight_evidence"][0]["section"], "hook_analysis")
        self.assertEqual(result.report["analysis_meta"]["visual_extraction"]["kept_count"], 12)
        self.assertEqual(result.confidence, 88)
        self.assertEqual(result.report["analysis_meta"]["quality_audit"]["status"], "review")

    def test_instructor_repairs_punctuation_changes_to_exact_source_evidence(self):
        class PunctuatedReport(FakeReport):
            def model_dump(self, mode="json"):
                value = super().model_dump(mode=mode)
                value["evidence"][0]["text"] = "先说问题。"
                value["insight_evidence"][0]["evidence_text"] = "先说问题。"
                return value

        class PunctuatedCompletions:
            def create_with_completion(self, **_kwargs):
                return PunctuatedReport(), object()

        client = type("Client", (), {
            "chat": type("Chat", (), {"completions": PunctuatedCompletions()})(),
        })()
        analyzer = InstructorStructureAnalyzer(
            api_key="", base_url="https://example.invalid/v1", model="fixture", provider="test",
            client=client, report_model=object,
        )
        result = analyzer.analyze(
            ClaimedJob("job", "org", "project", "video", "upload", "analyzing", 84, 4, {}),
            NormalizedMedia(Path("video.mp4"), None, MediaInfo(6000, 1080, 1920, "h264", "aac")),
            TranscriptOutput("zh-CN", (TranscriptSegment(100, 900, "先说问题", 94),), 94),
            VisualOutput(),
        )
        self.assertEqual(result.report["evidence"][0]["text"], "先说问题")
        self.assertEqual(result.report["evidence"][0]["source"], "asr")
        self.assertEqual(result.report["insight_evidence"][0]["evidence_text"], "先说问题")
        self.assertEqual(result.report["analysis_meta"]["evidence_repair"]["repaired_count"], 1)
        self.assertFalse(result.report["analysis_meta"]["evidence_repair"]["used_fallback"])

    def test_instructor_falls_back_to_selected_source_when_model_evidence_is_unusable(self):
        class UnsupportedReport(FakeReport):
            def model_dump(self, mode="json"):
                value = super().model_dump(mode=mode)
                value["evidence"] = [{
                    "start_ms": 999_999,
                    "text": "模型自行改写且无法对应原文",
                    "source": "asr",
                    "confidence": 90,
                }]
                value["insight_evidence"][0]["evidence_text"] = "模型自行改写且无法对应原文"
                return value

        class UnsupportedCompletions:
            def create_with_completion(self, **_kwargs):
                return UnsupportedReport(), object()

        client = type("Client", (), {
            "chat": type("Chat", (), {"completions": UnsupportedCompletions()})(),
        })()
        analyzer = InstructorStructureAnalyzer(
            api_key="", base_url="https://example.invalid/v1", model="fixture", provider="test",
            client=client, report_model=object,
        )
        result = analyzer.analyze(
            ClaimedJob("job", "org", "project", "video", "upload", "analyzing", 84, 4, {}),
            NormalizedMedia(Path("video.mp4"), None, MediaInfo(6000, 1080, 1920, "h264", "aac")),
            TranscriptOutput("zh-CN", (TranscriptSegment(100, 900, "先说问题", 94),), 94),
            VisualOutput(),
        )
        self.assertEqual(result.report["evidence"][0]["text"], "先说问题")
        self.assertEqual(result.report["insight_evidence"], [])
        self.assertTrue(result.report["analysis_meta"]["evidence_repair"]["used_fallback"])
        self.assertEqual(result.report["analysis_meta"]["evidence_repair"]["unmatched_count"], 1)

    def test_partial_json_recovery_keeps_complete_fields_and_source_evidence(self):
        message = type("Message", (), {
            "content": '{"summary":"核心摘要","hook":"问题开场","structure":["问题","方法"],"audience":"企业老板","spoken_script":["先说问题，再给方法。"],"highlights":["逻辑清晰"],"evidence":[',
            "tool_calls": None,
        })()
        completion = type("Completion", (), {
            "choices": [type("Choice", (), {"message": message})()],
        })()
        error = RuntimeError("invalid json")
        error.last_completion = completion
        recovered = _recover_partial_json_report(
            error,
            {"transcript_windows": [[{
                "start_ms": 100,
                "end_ms": 900,
                "text": "先说问题",
                "source": "asr",
                "confidence": 94,
            }]]},
            compact=False,
        )
        self.assertIsNotNone(recovered)
        self.assertEqual(recovered["summary"], "核心摘要")
        self.assertEqual(recovered["structure"], ["问题", "方法"])
        self.assertEqual(recovered["evidence"][0]["text"], "先说问题")

    def test_quality_audit_accepts_a_complete_traceable_deep_report(self):
        specialist_sections = (
            "hook_analysis", "viral_points", "rhythm_analysis", "emotion_curve",
            "conversion_design", "risks", "recommendations",
        )
        evidence = [
            {"start_ms": index * 1_000, "text": f"逐字来源证据 {index}", "source": "asr", "confidence": 90}
            for index in range(12)
        ]
        report = {
            "summary": "这是一段解释核心机制、案例与结论关系的完整摘要。" * 5,
            "hook": "开头先交代问题，再给出继续观看的理由。",
            "structure": ["提出问题", "解释机制", "案例验证", "给出方法"],
            "audience": "正在评估企业 AI 落地方案的经营者和管理者。",
            "spoken_script": ["这是按原意整理的完整口播稿，保留事实、案例与论证链。" * 24],
            "evidence": evidence,
            "insight_evidence": [
                {"section": specialist_sections[index % len(specialist_sections)], "item_index": 0, "evidence_text": evidence[index]["text"]}
                for index in range(12)
            ],
        }
        for section_index, section in enumerate(specialist_sections):
            report[section] = [f"{section} 的第 {item} 条具体诊断 {section_index}" for item in range(3)]
        audit = _assess_report_quality(
            report,
            profile="deep",
            available_evidence_count=20,
            source_characters=1_000,
            coverage_percent=100,
            recovered_json_outputs=0,
            evidence_repair={"used_fallback": False},
            visual_stats={"kept_count": 12, "target_count": 16},
            has_video=True,
        )
        self.assertEqual(audit["status"], "passed")
        self.assertTrue(audit["acceptance_passed"])
        self.assertEqual(audit["score"], 100)

    def test_quality_audit_marks_partial_recovery_as_degraded(self):
        audit = _assess_report_quality(
            {"summary": "过短摘要", "hook": "开头", "structure": ["开头"], "audience": "老板", "spoken_script": ["过短口播"], "evidence": []},
            profile="deep",
            available_evidence_count=20,
            source_characters=2_000,
            coverage_percent=52,
            recovered_json_outputs=1,
            evidence_repair={"used_fallback": True},
            visual_stats={"kept_count": 2, "target_count": 16},
            has_video=True,
        )
        self.assertEqual(audit["status"], "degraded")
        self.assertFalse(audit["acceptance_passed"])
        self.assertTrue(any("JSON" in issue for issue in audit["issues"]))

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
        self.assertEqual(meta["processing_mode"], "segmented")
        self.assertGreater(meta["segment_analysis_count"], 1)
        self.assertEqual(meta["analysis_passes"], meta["segment_analysis_count"] + 1)
        self.assertLess(meta["analyzed_segments"], meta["source_segments"])
        self.assertGreater(meta["chunk_count"], 1)
        self.assertLessEqual(meta["coverage_percent"], 100)
        self.assertEqual(meta["actual_input_tokens"], 720 * meta["analysis_passes"])
        self.assertEqual(meta["actual_output_tokens"], 180 * meta["analysis_passes"])
        self.assertEqual(meta["actual_total_tokens"], 900 * meta["analysis_passes"])

    def test_analysis_profiles_apply_distinct_token_budgets(self):
        transcript = TranscriptOutput(
            "zh-CN", (TranscriptSegment(100, 900, FakeReport().model_dump()["evidence"][0]["text"], 94),), 94
        )
        analyzer = InstructorStructureAnalyzer(
            api_key="", base_url="https://example.invalid/v1", model="fixture", provider="test",
            client=FakeClient(), report_model=object,
        )
        media = NormalizedMedia(Path("video.mp4"), None, MediaInfo(6000, 1080, 1920, "h264", "aac"))
        economy = analyzer.analyze(
            ClaimedJob("job-1", "org", "project", "video", "upload", "analyzing", 84, 4, {}, analysis_profile="economy"),
            media, transcript, VisualOutput(),
        )
        FakeCompletions.calls = []
        deep = analyzer.analyze(
            ClaimedJob("job-2", "org", "project", "video", "upload", "analyzing", 84, 4, {}, analysis_profile="deep"),
            media, transcript, VisualOutput(),
        )
        self.assertEqual(economy.report["analysis_meta"]["maximum_source_tokens"], 8_000)
        self.assertEqual(economy.report["analysis_meta"]["maximum_output_tokens"], 2_000)
        self.assertEqual(economy.report["analysis_meta"]["maximum_total_tokens"], 11_200)
        self.assertEqual(deep.report["analysis_meta"]["maximum_source_tokens"], 32_000)
        self.assertEqual(deep.report["analysis_meta"]["maximum_output_tokens"], 12_000)
        self.assertEqual(deep.report["analysis_meta"]["maximum_total_tokens"], 78_400)
        self.assertEqual(deep.report["analysis_meta"]["generation_strategy"], "dual_pass_full")
        self.assertEqual(len(FakeCompletions.calls), 2)
        self.assertEqual([call["max_tokens"] for call in FakeCompletions.calls], [6_000, 6_000])
        self.assertIn("深度模式的主体报告", FakeCompletions.calls[0]["messages"][0]["content"])
        self.assertIn("深度模式的专项诊断", FakeCompletions.calls[1]["messages"][0]["content"])
        self.assertEqual(FakeCompletions.last_kwargs["max_tokens"], 6_000)
        self.assertEqual(deep.schema_version, "analysis.v5")

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

            visuals = VisualOutput((Keyframe(500, frame, "标题", 88),), (), {"kept_count": 1})
            stored = store.persist(job, transcript, visuals, workspace)
        self.assertEqual([item["kind"] for item in client.uploads], ["subtitle", "keyframe"])
        self.assertEqual(stored.keyframes[0].asset_id, "asset-2")
        self.assertEqual(stored.stats["kept_count"], 1)
        self.assertIn("00:00:00.000 --> 00:00:01.000", transcript_vtt(transcript))


if __name__ == "__main__":
    unittest.main()
