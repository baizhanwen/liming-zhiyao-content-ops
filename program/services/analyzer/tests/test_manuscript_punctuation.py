from dataclasses import replace

from liming_analyzer.adapters import TranscriptOutput, TranscriptSegment
from liming_analyzer.manuscript_punctuation import punctuate_manuscript


def transcript(*values, language="zh"):
    return TranscriptOutput(language, tuple(TranscriptSegment(i * 1000, (i + 1) * 1000, value) for i, value in enumerate(values)))


def test_qwen_punctuation_passes_through_cue_boundaries_and_ocr_word_corrections():
    source = transcript("一个人，一台电脑。", "她看到竹子稿，", "再来写自己的稿子。")
    edited = transcript("一个人，一台电脑。", "她看到逐字稿，", "再来写自己的稿子。")
    assert punctuate_manuscript(source, edited) is edited


def test_marks_removed_inside_equal_length_replacement_are_restored_without_rewriting_words():
    source = transcript("先完成抓气，主子稿再核对。", "记住价格为 3.14 元。")
    edited = transcript("先完成抓取逐字稿再核对。", "记住价格为 3.14 元。")
    output = punctuate_manuscript(source, edited)
    assert output.segments[0].text == "先完成抓取，逐字稿再核对。"
    assert output.segments[1] is edited.segments[1]
    assert punctuate_manuscript(source, output) is output


def test_unpunctuated_asr_clips_do_not_become_one_sentence_for_every_clip():
    source = transcript("今天我们一起读这份", "报告的最后一节", "如果大家看完", "那么就可以开始讨论")
    result = punctuate_manuscript(source, source)
    assert [s.text for s in result.segments] == ["今天我们一起读这份", "报告的最后一节，", "如果大家看完，", "那么就可以开始讨论。"]
    assert [(s.start_ms,s.end_ms) for s in result.segments] == [(s.start_ms,s.end_ms) for s in source.segments]
    assert result.full_text.replace("，","").replace("。","") == source.full_text


def test_chinese_rules_do_not_apply_to_other_languages_or_misaligned_source():
    english = transcript("v3.14 is available", "we can test it", language="en")
    assert punctuate_manuscript(english, english) is english
    source = transcript("原句？", "下一句。")
    target = replace(transcript("新句。"), language="zh-CN")
    assert punctuate_manuscript(source, target) is target
