import unittest
from pathlib import Path

from liming_analyzer.adapters import TranscriptOutput, TranscriptSegment
from liming_analyzer.asr_timeline import aligned_asr_segments
from liming_analyzer.evidence import clean_transcript
from liming_analyzer.providers import FunAsrSpeechRecognizer


class AsrTimelineTests(unittest.TestCase):
    def test_mixed_language_punctuation_does_not_shift_subsequent_words(self):
        payload = {
            "raw_text": "对 对 那 后 来 GT 三 呢",
            "text": "对对，那后来Gt三呢？",
            "timestamp": [[index * 200, (index + 1) * 200] for index in range(8)],
            "sentence_info": [{"start": 0, "end": 400, "text": "对那，"},
                              {"start": 400, "end": 1600, "text": "后来GT三呢，"},
                              {"start": 1600, "end": 1800, "text": "。"}],
        }

        class Engine:
            def generate(self, **kwargs):
                assert kwargs["return_raw_text"] is True
                return [payload]

        transcript = FunAsrSpeechRecognizer(engine=Engine()).transcribe(Path("unused.wav"))
        self.assertEqual(transcript.full_text, "对对，\n那后来Gt三呢？")
        self.assertEqual([(row.start_ms, row.end_ms) for row in transcript.segments], [(0, 400), (400, 1600)])

    def test_decimal_and_english_words_keep_their_acoustic_timestamp(self):
        rows = aligned_asr_segments({"words": ["AI", "costs", "3.14", "元"],
            "timestamp": [[0, 100], [110, 300], [310, 800], [810, 1000]],
            "text": "AI costs 3.14元。"})
        self.assertEqual([(row.start_ms, row.end_ms, row.text) for row in rows], [(0, 1000, "AI costs 3.14元。")])

    def test_punctuation_model_cannot_delete_or_invent_spoken_words(self):
        rows = aligned_asr_segments({"raw_text": "这 是 原 话", "text": "这是猜测。",
            "timestamp": [[0, 100], [100, 200], [200, 300], [300, 400]]})
        self.assertEqual(rows[0].text, "这是原话")

    def test_long_unpunctuated_speech_is_bounded_without_losing_tokens(self):
        rows = aligned_asr_segments({"raw_text": " ".join(["话"] * 14000), "text": "话" * 14000,
            "timestamp": [[index * 150, index * 150 + 150] for index in range(14000)]})
        self.assertEqual("".join(row.text for row in rows), "话" * 14000)
        self.assertEqual(rows[-1].end_ms, 2100000)
        self.assertTrue(all(row.end_ms - row.start_ms <= 12000 and len(row.text) <= 80 for row in rows))

    def test_trailing_unpunctuated_words_and_pause_are_preserved(self):
        rows = aligned_asr_segments({"raw_text": "前 后", "text": "前后",
            "timestamp": [[100, 300], [2000, 2300]]})
        self.assertEqual([(row.start_ms, row.end_ms, row.text) for row in rows], [(100, 300, "前"), (2000, 2300, "后")])

    def test_unverifiable_timestamps_are_not_guessed(self):
        for stamps in ([[0, 1]], [[0, 1], [float("nan"), 5]], [[2, 3], [1, 2]], [[0, 1], [True, 2]]):
            with self.subTest(stamps=stamps):
                self.assertIsNone(aligned_asr_segments({"raw_text": "一 二", "text": "一二", "timestamp": stamps}))

    def test_punctuation_only_is_removed_but_real_repeated_speech_is_kept(self):
        transcript = TranscriptOutput("zh-CN", (
            TranscriptSegment(0, 100, "，"), TranscriptSegment(100, 500, "我来"),
            TranscriptSegment(600, 1000, "我来"), TranscriptSegment(1100, 1600, "我来")))
        self.assertEqual(clean_transcript(transcript).full_text, "我来\n我来\n我来")

    def test_overlapping_duplicate_recognition_is_still_merged(self):
        transcript = TranscriptOutput("zh-CN", (
            TranscriptSegment(100, 500, "这是同一段话"), TranscriptSegment(150, 550, "这是同一段话")))
        self.assertEqual(len(clean_transcript(transcript).segments), 1)

    def test_missing_word_alignment_cannot_silently_accept_truncated_cues(self):
        class Engine:
            def generate(self, **_kwargs):
                return [{"text": "这句话必须完整", "raw_text": "这 句 话 必 须 完 整",
                         "timestamp": [[0, 100]],
                         "sentence_info": [{"start": 0, "end": 100, "text": "这句话，"},
                                           {"start": 100, "end": 200, "text": "。"}]}]

        with self.assertRaisesRegex(RuntimeError, "未采用错位字幕"):
            FunAsrSpeechRecognizer(engine=Engine()).transcribe(Path("unused.wav"))


if __name__ == "__main__":
    unittest.main()
