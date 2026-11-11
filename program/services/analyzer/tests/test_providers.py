import ast
import json
import sys
import tempfile
import unittest
import wave
from dataclasses import replace
from pathlib import Path
from types import ModuleType
from typing import ClassVar
from unittest.mock import Mock, patch

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
    SparseTailFallbackSpeechRecognizer,
    _assess_report_quality,
    _build_insight_evidence_repair_payload,
    _build_spoken_script_set,
    _generate_corrected_script,
    _immutable_facts,
    _merge_insight_evidence,
    _normalize_cta_analysis,
    _prepare_asr_correction_text,
    _recover_partial_json_report,
    _repair_insight_evidence,
    _repair_light_rewrite_mapping,
    _repair_report_evidence,
    _script_validation,
    _supplement_required_insight_evidence,
)
from liming_analyzer.sources import YtDlpPublicVideoResolver
from liming_analyzer.visual import KeyframeVisualAnalyzer, OpenAiCompatibleVisionEngine


class FakeAsr:
    def generate(self, **_kwargs):
        self.last_options = _kwargs
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
    def test_cta_analysis_normalizes_to_exact_source_evidence(self):
        cta, evidence, validation = _normalize_cta_analysis(
            {
                "present": True,
                "items": [{
                    "cta_type": "关注引导",
                    "stage": "",
                    "evidence_text": "点击主页关注我。",
                    "target_action": "进入主页并关注",
                    "handoff_path": "视频 -> 主页 -> 关注",
                    "strength": "强",
                    "effectiveness": "动作明确，但没有说明关注后的收益。",
                    "recommendation": "补充关注后可持续获得的内容收益。",
                }],
                "overall_assessment": "结尾有明确关注 CTA。",
                "overall_recommendation": "补充关注收益。",
            },
            ["结尾设置关注引导。"],
            [{
                "start_ms": 9_000,
                "text": "点击主页关注我",
                "source": "asr",
                "confidence": 94,
            }],
            duration_ms=10_000,
        )
        self.assertTrue(cta["present"])
        self.assertEqual(cta["items"][0]["stage"], "结尾")
        self.assertEqual(cta["items"][0]["start_ms"], 9_000)
        self.assertEqual(cta["items"][0]["evidence_text"], "点击主页关注我")
        self.assertEqual(cta["items"][0]["strength"], "strong")
        self.assertEqual(evidence[0]["source"], "asr")
        self.assertEqual(validation["accepted_count"], 1)
        self.assertEqual(validation["dropped_count"], 0)

    def test_cta_analysis_drops_untraceable_claim_without_failing_no_cta_state(self):
        cta, evidence, validation = _normalize_cta_analysis(
            {
                "present": True,
                "items": [{
                    "cta_type": "私信引导",
                    "start_ms": 8_000,
                    "stage": "结尾",
                    "evidence_text": "私信我领取资料",
                    "target_action": "私信",
                    "handoff_path": "私信",
                    "strength": "strong",
                    "effectiveness": "强",
                    "recommendation": "保留",
                }],
                "overall_assessment": "结尾有非常强的私信 CTA。",
            },
            ["结尾转化设计还可以更明确。"],
            [{"start_ms": 8_000, "text": "感谢观看", "source": "asr"}],
            duration_ms=10_000,
        )
        self.assertFalse(cta["present"])
        self.assertEqual(cta["items"], [])
        self.assertEqual(
            cta["overall_assessment"],
            "候选 CTA 无法绑定到原始证据，本次不确认 CTA。",
        )
        self.assertNotIn("非常强", cta["overall_assessment"])
        self.assertEqual(cta["overall_recommendation"], "结尾转化设计还可以更明确。")
        self.assertEqual(evidence, [])
        self.assertEqual(validation["dropped_count"], 1)

    def test_cta_time_only_disambiguates_text_equivalent_occurrences(self):
        cta, _evidence, validation = _normalize_cta_analysis(
            {
                "present": True,
                "items": [{
                    "cta_type": "关注引导",
                    "start_ms": 8_700,
                    "stage": "结尾",
                    "evidence_text": "点击主页关注我",
                    "target_action": "关注",
                    "handoff_path": "主页",
                    "strength": "strong",
                    "effectiveness": "动作明确",
                    "recommendation": "补充收益",
                }],
                "overall_assessment": "结尾 CTA 明确。",
                "overall_recommendation": "补充收益。",
            },
            [],
            [
                {"start_ms": 1_000, "text": "点击主页关注我", "source": "asr"},
                {"start_ms": 9_000, "text": "点击主页关注我", "source": "asr"},
                {"start_ms": 8_700, "text": "这里没有 CTA", "source": "asr"},
            ],
            duration_ms=10_000,
        )
        self.assertEqual(cta["items"][0]["start_ms"], 9_000)
        self.assertEqual(validation["evidence_match_modes"]["exact"], 1)

    def test_cta_insight_evidence_links_target_nested_items(self):
        report = {
            "cta_analysis": {
                "present": True,
                "items": [{
                    "cta_type": "关注引导",
                    "start_ms": 9_000,
                    "stage": "结尾",
                    "evidence_text": "点击主页关注我",
                    "target_action": "关注",
                    "handoff_path": "主页",
                    "strength": "strong",
                    "effectiveness": "动作明确",
                    "recommendation": "补充收益",
                }],
                "overall_assessment": "有 CTA",
                "overall_recommendation": "补充收益",
            },
        }
        links = _repair_insight_evidence(
            [{
                "section": "cta_analysis",
                "item_index": 0,
                "evidence_text": "点击主页关注我",
            }],
            report,
            [{"start_ms": 9_000, "text": "点击主页关注我", "source": "asr"}],
            {},
        )
        self.assertEqual(links, [{
            "section": "cta_analysis",
            "item_index": 0,
            "evidence_text": "点击主页关注我",
        }])

    def test_funasr_normalizes_timeline_and_confidence(self):
        output = FunAsrSpeechRecognizer(engine=FakeAsr()).transcribe(Path("audio.wav"))
        self.assertEqual(output.full_text, "先说问题\n再给方法")
        self.assertEqual(output.segments[0].start_ms, 100)
        self.assertEqual(output.confidence, 91)

    def test_funasr_cleans_rich_tags_and_uses_word_timestamp_span(self):
        # The injected ASR engine must also supply its optional postprocessor;
        # this unit test runs without installing FunASR or its model runtime.
        postprocess = Mock(return_value="时间轴测试")
        module = ModuleType("funasr.utils.postprocess_utils")
        module.rich_transcription_postprocess = postprocess
        with patch.dict(sys.modules, {
            "funasr": ModuleType("funasr"),
            "funasr.utils": ModuleType("funasr.utils"),
            "funasr.utils.postprocess_utils": module,
        }):
            output = FunAsrSpeechRecognizer(engine=FakeRawAsr()).transcribe(Path("audio.wav"))
        postprocess.assert_called_once_with("<|zh|><|NEUTRAL|><|Speech|><|woitn|>时间轴测试")
        self.assertEqual(output.full_text, "时间轴测试")
        self.assertEqual((output.segments[0].start_ms, output.segments[0].end_ms), (480, 960))

    def test_funasr_uses_title_without_hashtags_as_contextual_hotword(self):
        engine = FakeAsr()
        recognizer = FunAsrSpeechRecognizer(engine=engine)
        recognizer.set_context("你们那边天气怎么样？ #程序员日常 #实习vlog")
        recognizer.transcribe(Path("audio.wav"))
        self.assertEqual(engine.last_options["hotword"], "你们那边天气怎么样？")

    def test_sparse_tail_fallback_recovers_only_the_incomplete_tail(self):
        primary_output = TranscriptOutput(
            "zh-CN",
            (
                TranscriptSegment(0, 2_000, "这是正常完整口播", 90),
                TranscriptSegment(2_000, 5_000, "后面少", 80),
                TranscriptSegment(5_000, 9_000, "一句", 70),
            ),
            80,
        )
        fallback_output = TranscriptOutput(
            "zh-CN",
            (
                TranscriptSegment(0, 7_000, "后面的完整口播内容已经全部找回来了", 92),
            ),
            92,
        )

        class StaticRecognizer:
            def __init__(self, output):
                self.output = output
                self.context = None

            def set_context(self, title):
                self.context = title

            def transcribe(self, _audio):
                return self.output

        primary = StaticRecognizer(primary_output)
        fallback = StaticRecognizer(fallback_output)
        recognizer = SparseTailFallbackSpeechRecognizer(primary, lambda: fallback)
        recognizer.set_context("天气怎么样 #实习vlog")
        with tempfile.TemporaryDirectory() as directory:
            audio = Path(directory) / "audio.wav"
            with wave.open(str(audio), "wb") as target:
                target.setnchannels(1)
                target.setsampwidth(2)
                target.setframerate(16_000)
                target.writeframes(b"\0\0" * 16_000 * 9)
            output = recognizer.transcribe(audio)

        self.assertEqual(output.segments[0].text, "这是正常完整口播")
        self.assertEqual(output.segments[-1].text, "后面的完整口播内容已经全部找回来了")
        self.assertEqual((output.segments[-1].start_ms, output.segments[-1].end_ms), (2_000, 9_000))
        self.assertEqual(fallback.context, "天气怎么样")
        self.assertEqual(recognizer.last_stats["status"], "tail_recovered")

    def test_sparse_tail_fallback_does_not_run_for_dense_primary_transcript(self):
        class DenseRecognizer:
            def transcribe(self, _audio):
                return TranscriptOutput(
                    "zh-CN",
                    (
                        TranscriptSegment(0, 2_000, "这是一段正常密度的完整口播内容", 90),
                        TranscriptSegment(2_000, 4_000, "结尾也能够被完整识别出来", 90),
                    ),
                    90,
                )

        fallback_calls = []
        recognizer = SparseTailFallbackSpeechRecognizer(
            DenseRecognizer(),
            lambda: fallback_calls.append(True),
        )
        output = recognizer.transcribe(Path("unused.wav"))

        self.assertIn("结尾也能够被完整识别出来", output.full_text)
        self.assertEqual(fallback_calls, [])
        self.assertEqual(recognizer.last_stats["status"], "primary_complete")
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
        self.assertEqual(frames[0].timestamp_ms, 0)
        self.assertGreaterEqual(frames[-1].timestamp_ms, 4_000)
        self.assertEqual(len(processor.commands), len(frames))
        self.assertEqual(extractor.last_stats["strategy"], "scene_plus_timeline")
        self.assertEqual(extractor.last_stats["scene_count"], 2)
        self.assertEqual(extractor.last_stats["target_count"], 12)
        self.assertEqual(extractor.last_stats["analysis_profile"], "standard")

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
        self.assertGreaterEqual(len(frames), 37)
        self.assertLessEqual(sum("representative" in frame.roles for frame in frames), 40)
        self.assertLessEqual(len(frames), 40 + 6 + 4 * 6)
        self.assertEqual(frames[0].timestamp_ms, 0)
        self.assertGreaterEqual(frames[-1].timestamp_ms, 1_028_000)
        self.assertEqual(extractor.last_stats["target_count"], 37)
        self.assertEqual(extractor.last_stats["analysis_profile"], "standard")

    def test_scene_detector_targets_120_to_180_frames_for_thirty_minute_video(self):
        processor = FakeProcessor()
        extractor = PySceneDetectFrameExtractor(
            processor,
            analysis_profile="max",
            detector=lambda _path: [(0.0, 450.0), (450.0, 900.0), (900.0, 1_350.0), (1_350.0, 2_302.0)],
        )
        media = NormalizedMedia(Path("video.mp4"), None, MediaInfo(2_302_000, 1080, 1920, "h264", "aac"))
        with tempfile.TemporaryDirectory() as directory:
            frames = extractor.extract(media, Path(directory))
        self.assertGreaterEqual(len(frames), 120)
        self.assertLessEqual(len(frames), 180)
        self.assertGreaterEqual(extractor.last_stats["target_count"], 120)
        self.assertLessEqual(extractor.last_stats["target_count"], 180)
        self.assertLessEqual(extractor.last_stats["anchor_interval_seconds"], 20)

    def test_standard_profile_uses_a_lower_frame_budget_than_max(self):
        standard = PySceneDetectFrameExtractor(FakeProcessor(), analysis_profile="standard", detector=lambda _path: [])
        maximum = PySceneDetectFrameExtractor(FakeProcessor(), analysis_profile="max", detector=lambda _path: [])
        standard_target, standard_limit = standard._target_frame_count(2_302)
        max_target, max_limit = maximum._target_frame_count(2_302)
        self.assertEqual((standard_target, standard_limit), (68, 90))
        self.assertEqual((max_target, max_limit), (137, 180))
        self.assertLess(standard_target, max_target)

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

        blocked_snapshots = []

        class Ocr:
            calls = 0

            def recognize(self, _path):
                # Snapshot while the current OCR call has not returned yet.
                blocked_snapshots.append(analyzer.progress_snapshot())
                self.calls += 1
                return ("有效标题", 90) if self.calls == 1 else ("低置信乱码", 20)

        history = []

        class ObservedAnalyzer(KeyframeVisualAnalyzer):
            def _set_progress(self, progress):
                history.append(dict(progress))
                super()._set_progress(progress)

        analyzer = ObservedAnalyzer(Extractor(), Ocr())
        with tempfile.TemporaryDirectory() as directory:
            output = analyzer.analyze(
                NormalizedMedia(Path("video.mp4"), None, MediaInfo(6_000, 64, 64, "h264", "aac")),
                Path(directory),
            )
        # Image-only filtering now finishes before OCR/VLM can overlap. Those
        # checks are complete while the separate OCR counters remain honest.
        self.assertEqual([row["candidates_checked"] for row in blocked_snapshots], [4, 4, 4])
        self.assertEqual([row["ocr_completed"] for row in blocked_snapshots], [0, 1, 2])
        actual = analyzer.progress_snapshot()
        self.assertEqual(actual["candidates_checked"], 4)
        self.assertEqual(actual["candidates_total"], 4)
        self.assertEqual(actual["ocr_completed"], 3)
        self.assertEqual(actual["ocr_total"], 3)
        self.assertEqual(actual["sampled_frames"], 3)
        kept_counts = [row["sampled_frames"] for row in history if "sampled_frames" in row]
        self.assertEqual(kept_counts, sorted(kept_counts))
        self.assertEqual(len(output.keyframes), 3)
        self.assertEqual(len(output.observations), 1)
        self.assertEqual(output.keyframes[2].ocr_text, None)
        self.assertEqual(output.stats["similar_removed"], 1)
        self.assertEqual(output.stats["kept_count"], 3)
        self.assertEqual(output.stats["visual_understanding"]["status"], "unavailable")

    def test_independent_vision_engine_returns_timed_visual_observations(self):
        class VisionCompletions:
            calls: ClassVar[list[dict[str, object]]] = []

            def create(self, **kwargs):
                self.calls.append(kwargs)
                message = type("Message", (), {
                    "content": json.dumps({
                        "observations": [
                            {
                                "frame_index": 1,
                                "composition": "人物居中",
                                "people_actions": "正面讲解",
                                "scene": "办公室",
                                "camera_expression": "固定中景",
                                "visual_role": "建立可信感",
                                "confidence": 0.91,
                            },
                            {
                                "frame_index": 2,
                                "composition": "产品界面占满画面",
                                "people_actions": "无人物",
                                "scene": "屏幕录制",
                                "camera_expression": "画面切换",
                                "visual_role": "展示操作步骤",
                                "confidence": 88,
                            },
                        ],
                    }, ensure_ascii=False),
                    "tool_calls": None,
                })()
                return type("Response", (), {
                    "choices": [type("Choice", (), {"message": message})()],
                })()

        completions = VisionCompletions()
        client = type("Client", (), {
            "chat": type("Chat", (), {"completions": completions})(),
        })()
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            first = root / "first.jpg"
            second = root / "second.jpg"
            Image.new("RGB", (64, 64), "white").save(first)
            Image.new("RGB", (64, 64), "black").save(second)
            engine = OpenAiCompatibleVisionEngine(
                api_key="",
                base_url="https://vision.example.invalid/v1",
                model="vision-fixture",
                provider="fixture",
                batch_size=2,
                client=client,
            )
            observations = engine.analyze([
                Keyframe(1_000, first),
                Keyframe(6_000, second),
            ])
        self.assertEqual([item.kind for item in observations], ["vision", "vision"])
        self.assertEqual([item.start_ms for item in observations], [1_000, 6_000])
        self.assertIn("构图：人物居中", observations[0].text)
        self.assertEqual(engine.last_stats["status"], "completed")
        self.assertEqual(engine.last_stats["observation_count"], 2)
        user_content = completions.calls[0]["messages"][1]["content"]
        self.assertEqual([item["type"] for item in user_content], ["text", "image_url", "image_url"])

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
        self.assertEqual(result.confidence, result.report["analysis_meta"]["quality_audit"]["score"])
        self.assertEqual(result.report["analysis_meta"]["quality_audit"]["status"], "degraded")

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
            "content": '{"summary":"核心摘要","hook":"问题开场","structure":["问题","方法"],"audience":"企业老板","spoken_script":["先说问题，再给方法。"],"cta_analysis":{"present":true,"items":[{"cta_type":"行动建议","start_ms":100,"stage":"开场","evidence_text":"先说问题","target_action":"继续观看","handoff_path":"开场到正文","strength":"medium","effectiveness":"动作可理解","recommendation":"补充收益"}],"overall_assessment":"有引导","overall_recommendation":"补充收益"},"highlights":["逻辑清晰"],"evidence":[',
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
        self.assertTrue(recovered["cta_analysis"]["present"])
        self.assertEqual(recovered["cta_analysis"]["items"][0]["start_ms"], 100)

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
            "summary": "短摘要",
            "hook": "开头先交代问题，再给出继续观看的理由。",
            "structure": ["提出问题", "解释机制", "案例验证", "给出方法"],
            "audience": "正在评估企业 AI 落地方案的经营者和管理者。",
            "spoken_script": ["短口播"],
            "highlights": ["带时间码的有效亮点一", "带时间码的有效亮点二", "带时间码的有效亮点三"],
            "visual": ["人物正面口播", "镜头切换用于分隔观点", "字幕强化核心数字"],
            "language": ["短句开场", "案例段使用具体动词", "收束段给出行动指令"],
            "spoken_script_set": {
                "corrected_original": {
                    "status": "completed",
                    "text": "完整稿件",
                    "paragraphs": ["完整稿件"],
                    "source_segment_ids": ["t-0001"],
                    "validation": {"passed": True, "checks": []},
                },
            },
            "cta_analysis": {
                "present": False,
                "items": [],
                "overall_assessment": "未识别到有原话证据支持的明确 CTA。",
                "overall_recommendation": "如需要转化，应明确用户下一步动作与承接路径。",
            },
            "evidence": evidence,
            "insight_evidence": [
                {"section": specialist_sections[index % len(specialist_sections)], "item_index": 0, "evidence_text": evidence[index]["text"]}
                for index in range(12)
            ],
        }
        for section_index, section in enumerate(specialist_sections):
            report[section] = [f"{section} 的第 {item} 条具体诊断 {section_index}" for item in range(3)]
        report["insight_evidence"].extend([
            {"section": "highlights", "item_index": 0, "evidence_text": evidence[8]["text"]},
            {"section": "visual", "item_index": 0, "evidence_text": evidence[9]["text"]},
            {"section": "language", "item_index": 0, "evidence_text": evidence[10]["text"]},
        ])
        audit = _assess_report_quality(
            report,
            profile="deep",
            available_evidence_count=20,
            coverage_percent=100,
            recovered_json_outputs=0,
            evidence_repair={"used_fallback": False},
            visual_stats={
                "kept_count": 12,
                "target_count": 16,
                "visual_understanding": {"status": "completed", "observation_count": 12},
            },
            has_video=True,
        )
        self.assertEqual(audit["status"], "passed")
        self.assertTrue(audit["acceptance_passed"])
        self.assertEqual(audit["score"], 100)
        self.assertTrue(next(
            check for check in audit["checks"] if check["key"] == "cta"
        )["passed"])

    def test_quality_audit_marks_partial_recovery_as_degraded(self):
        audit = _assess_report_quality(
            {"summary": "过短摘要", "hook": "开头", "structure": ["开头"], "audience": "老板", "spoken_script": ["过短口播"], "evidence": []},
            profile="deep",
            available_evidence_count=20,
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
        FakeCompletions.calls = []
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
        self.assertLessEqual(meta["segment_analysis_count"], 6)
        self.assertEqual(meta["analysis_passes"], meta["segment_analysis_count"] + 1)
        self.assertLess(meta["analyzed_segments"], meta["source_segments"])
        self.assertGreater(meta["chunk_count"], 1)
        self.assertLess(meta["coverage_percent"], 100)
        self.assertEqual(meta["actual_input_tokens"], 720 * meta["analysis_passes"])
        self.assertEqual(meta["actual_output_tokens"], 180 * meta["analysis_passes"])
        self.assertEqual(meta["actual_total_tokens"], 900 * meta["analysis_passes"])
        self.assertEqual(result.schema_version, "analysis.v9")
        self.assertIn("cta_analysis", result.report)
        self.assertFalse(result.report["cta_analysis"]["present"])
        self.assertIn("cta_validation", meta)
        self.assertTrue(any(
            "CTA 候选" in call["messages"][0]["content"]
            for call in FakeCompletions.calls[:-1]
        ))

    def test_tail_segment_cta_survives_when_final_synthesis_omits_it(self):
        tail_text = "点击主页私信我领取完整清单"

        class PayloadReport:
            def __init__(self, value):
                self.value = value

            def model_dump(self, mode="json"):
                return self.value

        class SegmentAwareCompletions:
            def __init__(self):
                self.calls = []

            def create_with_completion(self, **kwargs):
                self.calls.append(kwargs)
                payload = ast.literal_eval(kwargs["messages"][1]["content"])
                value = FakeReport().model_dump()
                if "segment" in payload:
                    rows = payload["transcript_window"]
                    evidence_row = rows[-1]
                    value["evidence"] = [{
                        "start_ms": evidence_row["start_ms"],
                        "text": evidence_row["text"],
                        "source": "asr",
                        "confidence": evidence_row.get("confidence"),
                    }]
                    if payload["segment"]["index"] == payload["segment"]["count"]:
                        self.assert_tail(evidence_row["text"])
                        value["cta_analysis"] = {
                            "present": True,
                            "items": [{
                                "cta_type": "私信领取",
                                "start_ms": evidence_row["start_ms"],
                                "stage": "结尾",
                                "evidence_text": evidence_row["text"],
                                "target_action": "私信",
                                "handoff_path": "视频 -> 主页 -> 私信",
                                "strength": "strong",
                                "effectiveness": "动作和领取收益都很明确。",
                                "recommendation": "补充私信关键词。",
                            }],
                            "overall_assessment": "尾段有明确私信 CTA。",
                            "overall_recommendation": "补充私信关键词。",
                        }
                    else:
                        value["cta_analysis"] = {
                            "present": False,
                            "items": [],
                            "overall_assessment": "本段无 CTA。",
                            "overall_recommendation": "无。",
                        }
                else:
                    # Deliberately emulate a synthesis response that omits CTA entirely.
                    value.pop("cta_analysis", None)
                usage = type(
                    "Usage",
                    (),
                    {"prompt_tokens": 720, "completion_tokens": 180, "total_tokens": 900},
                )()
                return PayloadReport(value), type("RawCompletion", (), {"usage": usage})()

            @staticmethod
            def assert_tail(value):
                if value != tail_text:
                    raise AssertionError(f"expected tail CTA evidence, received: {value}")

        completions = SegmentAwareCompletions()
        client = type("Client", (), {
            "chat": type("Chat", (), {"completions": completions})(),
        })()
        rows = [TranscriptSegment(0, 1_000, "先说问题", 94)]
        rows.extend(
            TranscriptSegment(
                index * 30_000,
                index * 30_000 + 1_000,
                tail_text if index == 59 else f"第{index}段内容" + "补充信息" * 8,
                90,
            )
            for index in range(1, 60)
        )
        analyzer = InstructorStructureAnalyzer(
            api_key="",
            base_url="https://example.invalid/v1",
            model="fixture",
            provider="test",
            client=client,
            report_model=object,
            max_source_tokens=360,
            window_tokens=100,
        )
        result = analyzer.analyze(
            ClaimedJob("job-tail", "org", "project", "video", "upload", "analyzing", 84, 4, {}),
            NormalizedMedia(
                Path("video.mp4"),
                None,
                MediaInfo(1_800_000, 1080, 1920, "h264", "aac"),
            ),
            TranscriptOutput("zh-CN", tuple(rows), 90),
            VisualOutput(),
        )
        self.assertEqual(result.report["analysis_meta"]["processing_mode"], "segmented")
        self.assertTrue(result.report["cta_analysis"]["present"])
        self.assertEqual(result.report["cta_analysis"]["items"][0]["evidence_text"], tail_text)
        self.assertEqual(result.report["cta_analysis"]["items"][0]["start_ms"], 59 * 30_000)
        self.assertEqual(
            result.report["analysis_meta"]["cta_validation"]["accepted_count"],
            1,
        )

    def test_standard_and_max_profiles_execute_different_budgets(self):
        transcript = TranscriptOutput(
            "zh-CN", (TranscriptSegment(100, 900, FakeReport().model_dump()["evidence"][0]["text"], 94),), 94
        )
        analyzer = InstructorStructureAnalyzer(
            api_key="", base_url="https://example.invalid/v1", model="fixture", provider="test",
            client=FakeClient(), report_model=object,
        )
        media = NormalizedMedia(Path("video.mp4"), None, MediaInfo(6000, 1080, 1920, "h264", "aac"))
        FakeCompletions.calls = []
        standard = analyzer.analyze(
            ClaimedJob("job-1", "org", "project", "video", "upload", "analyzing", 84, 4, {}, analysis_profile="standard"),
            media, transcript, VisualOutput(),
        )
        standard_calls = list(FakeCompletions.calls)
        FakeCompletions.calls = []
        maximum = analyzer.analyze(
            ClaimedJob("job-2", "org", "project", "video", "upload", "analyzing", 84, 4, {}, analysis_profile="max"),
            media, transcript, VisualOutput(),
        )
        standard_meta = standard.report["analysis_meta"]
        max_meta = maximum.report["analysis_meta"]
        self.assertEqual(standard_meta["analysis_profile"], "standard")
        self.assertEqual(standard_meta["maximum_source_tokens"], 32_000)
        self.assertEqual(standard_meta["maximum_output_tokens"], 6_000)
        self.assertEqual(standard_meta["maximum_total_tokens"], 39_200)
        self.assertEqual(standard_meta["generation_strategy"], "single_pass_standard")
        self.assertEqual(standard_meta["rewrite_variant_requests"], 0)
        self.assertEqual(len(standard_calls), 1)
        self.assertEqual(standard_calls[0]["max_tokens"], 6_000)
        self.assertEqual(max_meta["analysis_profile"], "max")
        self.assertEqual(max_meta["maximum_source_tokens"], 64_000)
        self.assertEqual(max_meta["maximum_output_tokens"], 12_000)
        self.assertEqual(max_meta["maximum_total_tokens"], 142_400)
        self.assertEqual(max_meta["generation_strategy"], "dual_pass_full")
        self.assertEqual(max_meta["rewrite_variant_requests"], 0)
        self.assertEqual(len(FakeCompletions.calls), 2)
        self.assertEqual([call["max_tokens"] for call in FakeCompletions.calls], [6_000, 6_000])
        self.assertIn("最高能力的主体报告", FakeCompletions.calls[0]["messages"][0]["content"])
        self.assertIn("最高能力的专项诊断", FakeCompletions.calls[1]["messages"][0]["content"])
        self.assertEqual(standard.schema_version, "analysis.v9")
        self.assertEqual(maximum.schema_version, "analysis.v9")
        self.assertEqual(maximum.prompt_version, "video-analysis.v10-content-v1")
        self.assertEqual(set(maximum.report["spoken_script_set"]), {"corrected_original"})
        self.assertEqual(maximum.report["spoken_script_set"]["corrected_original"]["status"], "failed")
    def test_public_resolver_returns_metadata_and_metrics(self):
        captured = {}

        def factory(options):
            captured.update(options)
            return FakeDownloader(options)

        with tempfile.TemporaryDirectory() as directory:
            result = YtDlpPublicVideoResolver(
                factory,
                cookies_from_browser="edge:Default",
                ffmpeg_location=r"C:\media\ffmpeg.exe",
            ).download(
                "https://www.douyin.com/video/1",
                Path(directory) / "source",
            )
        self.assertEqual(result.metadata.platform_work_id, "work-1")
        self.assertEqual(result.metadata.plays, 1000)
        self.assertEqual(result.metadata.duration_sec, 12)
        self.assertEqual(captured["cookiesfrombrowser"], ("edge", "Default", None, None))
        self.assertEqual(captured["ffmpeg_location"], r"C:\media\ffmpeg.exe")

    def test_public_resolver_prefers_cookie_snapshot_over_host_browser(self):
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
        self.assertNotEqual(captured["cookiefile"], str(cookie_file.resolve()))
        self.assertFalse(Path(captured["cookiefile"]).exists())
        self.assertNotIn("cookiesfrombrowser", captured)

    def test_public_resolver_falls_back_to_host_browser_when_cookie_snapshot_fails(self):
        captured = []

        class CookieFailure:
            def __enter__(self):
                return self

            def __exit__(self, *_):
                return False

            def extract_info(self, *_args, **_kwargs):
                raise RuntimeError("cookie file expired")

        def factory(options):
            captured.append(options)
            return CookieFailure() if "cookiefile" in options else FakeDownloader(options)

        with tempfile.TemporaryDirectory() as directory:
            cookie_file = Path(directory) / "cookies.txt"
            cookie_file.write_text("# Netscape HTTP Cookie File\n", encoding="utf-8")
            result = YtDlpPublicVideoResolver(
                factory,
                cookies_from_browser="edge",
                cookie_file=str(cookie_file),
            ).download(
                "https://www.douyin.com/video/1",
                Path(directory) / "source",
            )
        self.assertEqual(result.metadata.platform_work_id, "work-1")
        self.assertNotEqual(captured[0]["cookiefile"], str(cookie_file.resolve()))
        self.assertFalse(Path(captured[0]["cookiefile"]).exists())
        self.assertIn("cookiesfrombrowser", captured[1])
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


    def test_corrected_original_is_the_only_normal_analysis_script(self):
        report = {
            "spoken_script_set": {
                "corrected_original": {
                    "text": "事实一。随后提供方法。",
                    "paragraphs": ["事实一。随后提供方法。"],
                    "source_segment_ids": ["t-0001", "t-0002"],
                },
            },
        }
        result = _build_spoken_script_set(
            report,
            [
                {"segment_id": "t-0001", "text": "事实一"},
                {"segment_id": "t-0002", "text": "随后提供方法"},
            ],
            model_provider="deepseek",
            model_name="deepseek-chat",
            prompt_version="spoken-script-correction.v1",
        )
        self.assertEqual(set(result), {"corrected_original"})
        self.assertEqual(result["corrected_original"]["status"], "completed")
        self.assertEqual(
            result["corrected_original"]["provenance"]["source"],
            "model_transcript_correction",
        )
        self.assertEqual(report["spoken_script"], ["事实一。随后提供方法。"])

    def test_failed_correction_preserves_candidate_without_claiming_success(self):
        report = {
            "spoken_script_set": {
                "corrected_original": {
                    "paragraphs": ["只保留了事实一"],
                    "source_segment_ids": ["t-0001"],
                },
            },
        }
        result = _build_spoken_script_set(
            report,
            [
                {"segment_id": "t-0001", "text": "事实一"},
                {"segment_id": "t-0002", "text": "方法二"},
            ],
        )
        corrected = result["corrected_original"]
        self.assertEqual(corrected["status"], "failed")
        self.assertEqual(corrected["paragraphs"], ["只保留了事实一"])
        self.assertEqual(report["spoken_script"], [])
        self.assertTrue(corrected["candidate_available"])
        self.assertIn("候选稿已保留", corrected["error"])

    def test_correction_retries_once_after_incomplete_mapping(self):
        calls = []

        def request(task, payload, _output_tokens):
            self.assertEqual(task, "corrected_original")
            calls.append(payload)
            paragraph = payload["paragraphs"][0]
            if len(calls) == 1:
                return {"paragraphs": []}
            return {
                "paragraphs": [{
                    "paragraph_id": paragraph["paragraph_id"],
                    "text": "我们应该先检查数据。",
                }],
            }

        candidate, error = _generate_corrected_script(
            [{"segment_id": "t-0001", "text": "我们因该先检查数据"}],
            request,
        )
        self.assertEqual(error, "")
        self.assertIsNotNone(candidate)
        self.assertEqual(len(calls), 2)
        self.assertEqual(candidate["paragraphs"], ["我们应该先检查数据。"])
        self.assertEqual(candidate["mapping_repairs"], 0)

    def test_correction_ignores_asr_punctuation_without_a_facts_gate(self):
        source = "时候 MP，四以前。增长百分之六十，使用三十帧视频。"
        candidate = "时候，MP4 以前，增长 60%，使用 30fps 视频。"
        self.assertEqual(
            _prepare_asr_correction_text(source),
            "时候 MP 四以前 增长百分之六十 使用三十帧视频",
        )
        validation = _script_validation(
            "corrected_original",
            [candidate],
            ["t-0001"],
            [source],
            ["t-0001"],
        )
        self.assertNotIn("facts", {item["key"] for item in validation["checks"]})
        self.assertNotIn("missing_immutable_facts", validation)

    def test_correction_does_not_reject_changed_numbers(self):
        validation = _script_validation(
            "corrected_original",
            ["项目在 2028 年增长 60%。"],
            ["t-0001"],
            ["项目在 2027 年增长 60%。"],
            ["t-0001"],
        )
        self.assertTrue(validation["passed"])
        self.assertNotIn("facts", {item["key"] for item in validation["checks"]})

    def test_numeric_changes_do_not_trigger_a_correction_retry(self):
        calls = []

        def request(_task, payload, _output_tokens):
            calls.append(payload)
            paragraph = payload["paragraphs"][0]
            self.assertNotIn("numeric_facts", paragraph)
            return {
                "paragraphs": [{
                    "paragraph_id": paragraph["paragraph_id"],
                    "text": "项目在 2028 年增长 60%。",
                }],
            }

        candidate, error = _generate_corrected_script(
            [{"segment_id": "t-0001", "text": "项目在 2027 年增长 60%"}],
            request,
        )
        self.assertIsNotNone(candidate)
        self.assertEqual(error, "")
        self.assertEqual(len(calls), 1)
        self.assertEqual(candidate["paragraphs"], ["项目在 2028 年增长 60%。"])
        self.assertTrue(candidate.get("validation", {"passed": True})["passed"])



    def test_light_mapping_repair_never_cross_assigns_paragraphs(self):
        units = [
            {"paragraph_id": "p-0001", "text": "第一段原文"},
            {"paragraph_id": "p-0002", "text": "第二段原文"},
        ]
        repaired, count = _repair_light_rewrite_mapping(
            [{"paragraph_id": "p-0001", "text": "第一段微调"}],
            units,
            {"p-0002": "第二段上一轮"},
        )
        self.assertEqual(
            repaired,
            {"p-0001": "第一段微调", "p-0002": "第二段上一轮"},
        )
        self.assertEqual(count, 1)
        source_repaired, source_count = _repair_light_rewrite_mapping([], units, {})
        self.assertEqual(source_repaired["p-0002"], "第二段原文")
        self.assertEqual(source_count, 2)
    def test_immutable_facts_exclude_plain_lowercase_words(self):
        self.assertEqual(
            _immutable_facts("open to deep AI OpenAI GPT-5 7.1 %"),
            {"ai", "openai", "gpt-5", "7.1%"},
        )


    def test_merge_insight_evidence_preserves_core_and_specialist_links(self):
        highlight = {
            "section": "highlights",
            "item_index": 0,
            "evidence_text": "逐字亮点证据",
        }
        rhythm = {
            "section": "rhythm_analysis",
            "item_index": 1,
            "evidence_text": "逐字节奏证据",
        }
        merged = _merge_insight_evidence(
            [highlight],
            [rhythm, highlight, {"section": "", "item_index": 0, "evidence_text": "无效"}],
        )
        self.assertEqual(merged, [highlight, rhythm])

    def test_required_insight_evidence_is_supplemented_from_supported_sources(self):
        existing = [{
            "section": "rhythm_analysis",
            "item_index": 0,
            "evidence_text": "开场先抛出问题，然后快速给出答案",
        }]
        report = {
            "highlights": ["麦格克效应演示直观有趣，是内容亮点"],
            "language": ["频繁使用“对吧”拉近与观众的距离"],
            "rhythm_analysis": ["开场快速进入主题"],
            "visual": ["口型特写画面强化了视听错觉的演示"],
        }
        evidence = [
            {
                "start_ms": 1_000,
                "text": "一个很有趣的心理学现象叫做麦格克效应",
                "source": "asr",
            },
            {
                "start_ms": 3_000,
                "text": "大家可以看到这个口型特写画面",
                "source": "vision",
            },
            {
                "start_ms": 4_000,
                "text": "这里有口型特写几个字",
                "source": "ocr",
            },
            {
                "start_ms": 5_000,
                "text": "这很容易理解对吧我们继续说",
                "source": "asr",
            },
        ]

        links, stats = _supplement_required_insight_evidence(
            existing,
            report,
            evidence,
            has_video=True,
        )

        by_section = {link["section"]: link for link in links}
        self.assertEqual(set(by_section), {"highlights", "language", "rhythm_analysis", "visual"})
        self.assertEqual(by_section["visual"]["evidence_text"], "大家可以看到这个口型特写画面")
        self.assertEqual(stats["supplemented_count"], 3)
        self.assertEqual(stats["unresolved_sections"], [])

    def test_visual_insight_evidence_never_uses_ocr_or_asr_as_a_fallback(self):
        links, stats = _supplement_required_insight_evidence(
            [],
            {
                "highlights": [],
                "language": [],
                "rhythm_analysis": [],
                "visual": ["蓝色字幕卡出现并占满画面"],
            },
            [
                {"start_ms": 1_000, "text": "蓝色字幕卡出现并占满画面", "source": "ocr"},
                {"start_ms": 2_000, "text": "蓝色字幕卡出现并占满画面", "source": "asr"},
            ],
            has_video=True,
        )

        self.assertEqual(links, [])
        self.assertIn("visual", stats["unresolved_sections"])

    def test_model_repair_candidates_are_filtered_by_section_source(self):
        payload = _build_insight_evidence_repair_payload(
            {
                "language": ["使用对吧增强交流感"],
                "visual": ["蓝色字幕卡占满画面"],
            },
            [
                {"start_ms": 1_000, "text": "对吧我们继续说", "source": "asr"},
                {"start_ms": 2_000, "text": "蓝色字幕卡占满画面", "source": "ocr"},
                {"start_ms": 3_000, "text": "蓝色字幕卡占满画面", "source": "vision"},
            ],
            ["language", "visual"],
        )

        sections = {item["section"]: item for item in payload["sections"]}
        self.assertEqual(
            {item["source"] for item in sections["language"]["candidate_evidence"]},
            {"asr"},
        )
        self.assertEqual(
            {item["source"] for item in sections["visual"]["candidate_evidence"]},
            {"vision"},
        )

    def test_evidence_repair_supplements_to_twelve_exact_sources(self):
        sources = [
            {"start_ms": index * 1000, "text": f"第{index}条逐字证据", "source": "asr", "confidence": 90}
            for index in range(15)
        ]
        repaired, _aliases, stats = _repair_report_evidence([sources[0]], sources)
        self.assertEqual(len(repaired), 12)
        self.assertEqual(stats["supplemented_count"], 11)
        self.assertFalse(stats["used_fallback"])


    def test_long_video_quality_uses_full_transcript_coverage_not_ocr_sampling(self):
        transcript = TranscriptOutput(
            "zh-CN",
            (TranscriptSegment(100, 900, "先说问题", 94),),
            94,
        )
        visual = VisualOutput(
            (),
            tuple(
                VisualObservation(
                    "ocr",
                    index * 5_000,
                    index * 5_000,
                    f"第{index}张画面文字" + "辅助字幕" * 40,
                    90,
                )
                for index in range(300)
            ),
        )
        analyzer = InstructorStructureAnalyzer(
            api_key="",
            base_url="https://example.invalid/v1",
            model="fixture",
            provider="test",
            client=FakeClient(),
            report_model=object,
            max_source_tokens=2_000,
        )
        result = analyzer.analyze(
            ClaimedJob("job", "org", "project", "video", "upload", "analyzing", 84, 4, {}),
            NormalizedMedia(
                Path("video.mp4"),
                None,
                MediaInfo(1_800_000, 1080, 1920, "h264", "aac"),
            ),
            transcript,
            visual,
        )
        meta = result.report["analysis_meta"]
        self.assertEqual(meta["coverage_percent"], 100)
        self.assertEqual(meta["transcript_coverage_percent"], 100)
        self.assertLess(meta["evidence_coverage_percent"], 100)

    def test_long_video_reuses_completed_segment_checkpoints_after_failure(self):
        class FailAfterOne:
            def __init__(self):
                self.calls = []

            def create_with_completion(self, **kwargs):
                self.calls.append(kwargs)
                if len(self.calls) == 2:
                    raise RuntimeError("segment failure")
                usage = type("Usage", (), {"prompt_tokens": 720, "completion_tokens": 180, "total_tokens": 900})()
                return FakeReport(), type("RawCompletion", (), {"usage": usage})()

        class Client:
            def __init__(self, completions):
                self.chat = type("Chat", (), {"completions": completions})()

        transcript = TranscriptOutput("zh-CN", tuple(
            TranscriptSegment(index * 1000, (index + 1) * 1000, f"segment-{index}-" + "content" * 8, 90)
            for index in range(1, 40)
        ), 90)
        media = NormalizedMedia(Path("video.mp4"), None, MediaInfo(1_800_000, 1080, 1920, "h264", "aac"))
        job = ClaimedJob("job-resume", "org", "project", "video", "upload", "analyzing", 84, 4, {})
        progress = []
        analyzer = InstructorStructureAnalyzer(
            api_key="", base_url="https://example.invalid/v1", model="fixture", provider="test",
            client=Client(FailAfterOne()), report_model=object, max_source_tokens=240, window_tokens=90,
        )
        analyzer.set_segment_checkpoint(progress.append)
        with self.assertRaisesRegex(RuntimeError, "segment failure"):
            analyzer.analyze(job, media, transcript, VisualOutput())
        checkpoint = progress[-1]
        completed = [row for row in checkpoint["segments"] if row["status"] == "completed"]
        self.assertGreaterEqual(len(completed), 1)
        self.assertTrue(any(row["status"] == "failed" for row in checkpoint["segments"]))

        FakeCompletions.calls = []
        resumed = replace(job, checkpoint_stage="segment_progress", checkpoint={"checkpoint_version": 1, "media": {}, "transcript": {}, "visuals": {}, "segment_progress": checkpoint})
        resumed_analyzer = InstructorStructureAnalyzer(
            api_key="", base_url="https://example.invalid/v1", model="fixture", provider="test",
            client=FakeClient(), report_model=object, max_source_tokens=240, window_tokens=90,
        )
        result = resumed_analyzer.analyze(resumed, media, transcript, VisualOutput())
        total = len(checkpoint["window_keys"])
        self.assertEqual(result.report["analysis_meta"]["segment_progress"]["total"], total)
        self.assertEqual(result.report["analysis_meta"]["segment_progress"]["reused"], len(completed))
        self.assertEqual(len(FakeCompletions.calls), total - len(completed) + 1)

if __name__ == "__main__":
    unittest.main()
