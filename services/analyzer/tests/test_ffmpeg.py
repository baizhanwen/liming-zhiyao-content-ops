import json
import subprocess
import tempfile
import unittest
from pathlib import Path

from liming_analyzer.ffmpeg import FfmpegMediaProcessor, MediaProcessingError


class FfmpegTests(unittest.TestCase):
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
        self.assertIn("pcm_s16le", commands[1])
        self.assertIsInstance(commands[1], list)

    def test_command_failure_is_redacted_to_bounded_message(self):
        def runner(command, **kwargs):
            return subprocess.CompletedProcess(command, 1, "", "x" * 3000)

        with self.assertRaises(MediaProcessingError) as raised:
            FfmpegMediaProcessor(runner=runner).probe(Path("missing.mp4"))
        self.assertLessEqual(len(str(raised.exception)), 2000)


if __name__ == "__main__":
    unittest.main()
