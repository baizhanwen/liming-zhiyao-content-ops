from pathlib import Path
from types import SimpleNamespace

import pytest

from liming_analyzer.faster_whisper_asr import FasterWhisperSpeechRecognizer


def test_local_whisper_emits_real_segment_times_and_does_not_download_with_injected_engine(tmp_path):
    calls = []
    class Engine:
        def transcribe(self, audio, **options):
            calls.append((audio, options))
            return iter([SimpleNamespace(start=1.25, end=2.75, text=" 测试转写 "), SimpleNamespace(start=3, end=4, text=" ")]), SimpleNamespace(language="zh")
    recognizer = FasterWhisperSpeechRecognizer("small", model_cache=tmp_path, language="zh", device="auto", engine=Engine())
    result = recognizer.transcribe(Path("fixture.wav"))
    assert result.full_text == "测试转写"
    assert (result.segments[0].start_ms, result.segments[0].end_ms) == (1250, 2750)
    assert result.language == "zh"
    assert calls == [("fixture.wav", {"language": "zh", "beam_size": 5, "word_timestamps": False, "vad_filter": True})]
    assert recognizer.model_path == tmp_path / "faster-whisper-small"


@pytest.mark.parametrize("start,end", [(3, 2), (-1, 2), (float("nan"), 3), (1, float("inf"))])
def test_local_whisper_rejects_invalid_timestamps(start, end, tmp_path):
    class Engine:
        def transcribe(self, *_args, **_kwargs):
            return [SimpleNamespace(start=start, end=end, text="bad")], SimpleNamespace(language="zh")
    with pytest.raises(ValueError, match="invalid timestamp"):
        FasterWhisperSpeechRecognizer(model_cache=tmp_path, engine=Engine()).transcribe(Path("fixture.wav"))
