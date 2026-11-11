import json
import subprocess
import tempfile
import unittest
from pathlib import Path

from liming_analyzer.ffmpeg import FfmpegMediaProcessor, MediaProcessingError


class FfmpegTests(unittest.TestCase):
    def test_probe_preserves_rotation_and_sample_aspect_ratio(self):
        def runner(command, **kwargs):
            payload = {"streams": [{"codec_type": "video", "codec_name": "h264", "width": 1440, "height": 1080,
                                    "sample_aspect_ratio": "4:3", "display_aspect_ratio": "16:9",
                                    "tags": {"rotate": "0"}, "side_data_list": [{"rotation": -90}]}],
                       "format": {"duration": "4"}}
            return subprocess.CompletedProcess(command, 0, json.dumps(payload), "")
        info = FfmpegMediaProcessor(runner=runner).probe(Path("fixture.mp4"))
        self.assertEqual(info.rotation_degrees, -90)
        self.assertEqual(info.sample_aspect_ratio, "4:3")
        self.assertEqual(info.display_aspect_ratio, "16:9")

    def test_prepare_uses_argument_lists_and_fixed_asr_audio_format(self):
        commands = []

        def runner(command, **kwargs):
            commands.append(command)
            if command[0] == "ffprobe":
                payload = {"streams": [{"codec_type": "video", "codec_name": "h264", "width": 1080, "height": 1920}, {"codec_type": "audio", "codec_name": "aac"}], "format": {"duration": "12.5"}}
                return subprocess.CompletedProcess(command, 0, json.dumps(payload), "")
            return subprocess.CompletedProcess(command, 0, "", "")

        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary); source = root / "source.mp4"; source.write_bytes(b"test")
            media = FfmpegMediaProcessor(runner=runner).prepare(source, root / "out")
        self.assertEqual(media.info.duration_ms, 12500)
        self.assertIn("16000", commands[1])
        self.assertIn("highpass=f=80,lowpass=f=7600,loudnorm=I=-16:LRA=11:TP=-1.5", commands[1])
        self.assertIn("pcm_s16le", commands[1])
        self.assertIsInstance(commands[1], list)

    def test_probe_preserves_chinese_path_and_parses_utf8_json(self):
        observed = {}

        def runner(command, **kwargs):
            observed["command"] = command
            observed["kwargs"] = kwargs
            payload = {
                "streams": [
                    {
                        "codec_type": "video",
                        "codec_name": "h264",
                        "width": 1920,
                        "height": 1080,
                        "tags": {"title": "利明智耀中文视频"},
                    },
                    {"codec_type": "audio", "codec_name": "aac"},
                ],
                "format": {
                    "duration": "17.25",
                    "tags": {"comment": "企业 AI 落地素材"},
                },
            }
            stdout = json.dumps(payload, ensure_ascii=False).encode("utf-8").decode("utf-8")
            return subprocess.CompletedProcess(command, 0, stdout, "")

        with tempfile.TemporaryDirectory(prefix="利明智耀-媒体探测-") as temporary:
            source = Path(temporary) / "客户素材" / "中文标题-第一版.mp4"
            source.parent.mkdir()
            source.write_bytes(b"test")
            info = FfmpegMediaProcessor(runner=runner).probe(source)

        self.assertEqual(observed["command"][-1], str(source))
        self.assertTrue(observed["kwargs"]["text"])
        self.assertEqual(observed["kwargs"]["encoding"], "utf-8")
        self.assertEqual(observed["kwargs"]["errors"], "replace")
        self.assertEqual(info.duration_ms, 17250)
        self.assertEqual((info.width, info.height), (1920, 1080))
        self.assertEqual((info.video_codec, info.audio_codec), ("h264", "aac"))

    def test_command_failure_is_redacted_to_bounded_message(self):
        def runner(command, **kwargs):
            return subprocess.CompletedProcess(command, 1, "", "x" * 3000)

        with self.assertRaises(MediaProcessingError) as raised:
            FfmpegMediaProcessor(runner=runner).probe(Path("missing.mp4"))
        self.assertLessEqual(len(str(raised.exception)), 2000)

    def test_missing_binary_is_reported_as_an_actionable_media_error(self):
        def runner(*_args, **_kwargs):
            raise FileNotFoundError(2, "The system cannot find the file specified")

        with self.assertRaisesRegex(
            MediaProcessingError,
            r"ffprobe executable was not found.*setup-analyzer\.bat",
        ):
            FfmpegMediaProcessor(runner=runner).probe(Path("source.mp4"))


if __name__ == "__main__":
    unittest.main()
