import pytest

from liming_analyzer.adapters import TranscriptOutput, TranscriptSegment
from liming_analyzer.subtitle_evidence import (
    Caption,
    _choose_track,
    _segment_caption,
    recover_burned_subtitles,
)


def line(t, words, y=.94, confidence=97):
    return Caption(t, words, y, confidence)


def test_track_requires_distinct_captions_aligned_across_the_recording():
    words = ["今天我们来上课", "上次讲过的公式", "一起回顾这条公式", "下一步开始做实验", "最后记录数据"]
    probes = [(i, s, [line(i * 1000, s), line(i * 1000, "请点击这里", .82)]) for i, s in enumerate(words)]
    assert _choose_track({True: probes}) == (True, .94)
    assert _choose_track({True: [(i, s, [line(i * 1000, "请点击这里")]) for i, s in enumerate(words)]}) is None
    assert _choose_track({True: [(i, s, [line(i * 1000, "窗外落下的雨")]) for i, s in enumerate(words)]}) is None


def test_two_consecutive_lines_keep_temporal_evidence_and_exclude_side_cards(monkeypatch):
    import liming_analyzer.subtitle_evidence as reader

    monkeypatch.setattr(reader, "_words", lambda: {"写出"})
    labels = [line(300, "不仅每天自动盯盘"), line(600, "不仅每天自动盯盘"),
              line(900, "还能秒级写出逐字稿"), line(1200, "还能秒级写出逐字稿"),
              line(900, "今日入库作品", .81), line(1200, "今日入库作品", .81)]
    assert _segment_caption("不仅每天自动盯盘 还能秒击印象书主子稿", labels, .94) == (
        "不仅每天自动盯盘 还能秒级写出逐字稿", [300, 600, 900, 1200])


def test_single_frame_duplicates_or_unrelated_recurring_ui_do_not_replace_speech():
    assert _segment_caption("这台设备每次都要核对", [line(500, "这台设备没次都要核对")] * 2, .94) is None
    assert _segment_caption("这台设备每次都要核对", [line(200, "立即领取清单"), line(600, "立即领取清单")], .94) is None


def test_partial_subtitle_does_not_delete_words_and_confidence_is_required():
    source = "我们现在把本地的这份数据完整的读一遍"
    assert _segment_caption(source, [line(120, "完整的读一遍"), line(360, "完整的读一遍")], .94) is None
    assert _segment_caption("完全的读一遍", [line(200, "完整的读一遍", confidence=73),
                                        line(600, "完整的读一遍", confidence=76)], .94) is None


def test_no_media_or_no_eligible_speech_falls_back_to_original(tmp_path):
    pytest.importorskip("cv2")
    source = TranscriptOutput("zh", tuple(TranscriptSegment(i * 1000, i * 1000 + 900, "这段实际的讲话") for i in range(3)))
    assert recover_burned_subtitles(tmp_path / "absent.mp4", source, ocr=None).transcript is source


def test_short_standalone_utterance_needs_three_frames_and_matching_audio_syllables(monkeypatch):
    import liming_analyzer.subtitle_evidence as reader

    monkeypatch.setattr(reader, "_words", lambda: {"写出"})
    source, target = "还能秒级逆向书竹子稿", "还能秒级写出逐字稿"
    rows = [line(t, target, confidence=99) for t in (100, 450, 800)]
    assert _segment_caption(source, rows, .94)[0] == target
    assert _segment_caption(source, rows[:2], .94) is None
    assert _segment_caption("还能秒级保管报价稿", rows, .94) is None


def test_caption_crossing_speech_boundary_and_hidden_tail(monkeypatch):
    import liming_analyzer.subtitle_evidence as reader

    monkeypatch.setattr(reader, "_words", lambda: {"价值"})
    assert _segment_caption("海量的口博稿", [line(t, "海量的口播稿我们也看不过来") for t in (100, 420)], .94)[0] == "海量的口播稿"
    source = "加上高杂质的选题对标库"
    details = {}
    assert _segment_caption(source, [line(t, "加上高价值的选题") for t in (100, 420)], .94, details)[0] == "加上高价值的选题对标库"
    assert not details["full_caption_match"]
    assert details["captions"][0]["text"] == "加上高价值的选题"


def test_unattested_subtitle_spelling_and_censored_identifier_do_not_replace_source(monkeypatch):
    import liming_analyzer.subtitle_evidence as reader

    monkeypatch.setattr(reader, "_words", lambda: {"速度", "输入", "思路", "搭建"})
    for source in ("那么这套搭建速度", "那么这套搭建输入"):
        assert _segment_caption(source, [line(t, "那么这套搭建速路") for t in (100, 400, 700)], .94) is None
    assert _segment_caption("我们只要把链接一粘贴", [line(t,"我们只需要把XX一粘贴") for t in (100, 400)], .94) is None


def test_recording_cut_midword_uses_repeated_final_caption_only_at_end(monkeypatch):
    import liming_analyzer.subtitle_evidence as reader

    monkeypatch.setattr(reader, "_words", lambda: {"带走"})
    source, target = "评论区回复资料直接打包带", "评论区回复资料直接打包带走"
    rows = [line(t, target, confidence=99) for t in (1300, 1650)]
    assert _segment_caption(source, rows, .94)[0] == source
    assert _segment_caption(source, rows, .94, clip_end_ms=3000)[0] == source
    assert _segment_caption(source, rows, .94, clip_end_ms=1800)[0] == target


def test_short_clause_only_uses_homophonic_edge_of_repeated_caption():
    rows = [line(t, "从对标搜集爆款拆解") for t in (200, 480, 740)]
    assert _segment_caption("报款拆解", rows, .94)[0] == "爆款拆解"
    assert _segment_caption("退款拆解", rows, .94) is None


def test_repeated_caption_misspelling_cannot_break_an_established_spoken_expression(monkeypatch):
    import liming_analyzer.subtitle_evidence as reader

    monkeypatch.setattr(reader, "_words", lambda: {"开源节流", "井井有条"})
    for source, caption in (("我们会继续开源节流", "我们会继续开原节流"), ("整个过程井井有条", "整个过程井井有调")):
        assert _segment_caption(source, [line(t, caption, confidence=99) for t in (100, 430, 770)], .94) is None
    assert _segment_caption("我们会继续开原节流", [line(t, "我们会继续开源节流", confidence=99) for t in (100, 430, 770)], .94)[0] == "我们会继续开源节流"


def test_near_sound_needs_agreement_from_separate_audio_decode_and_repeated_captions(monkeypatch):
    import liming_analyzer.subtitle_evidence as reader

    monkeypatch.setattr(reader, "_words", frozenset)
    source, target = "我们把资料放竞甲组手册", "我们把资料放进甲组手册"
    rows = [line(t, target, confidence=97) for t in (100, 430, 760)]
    assert _segment_caption(source, rows, .94) is None
    assert _segment_caption(source, rows, .94, timing_text="旁边另一段音频") is None
    assert _segment_caption(source, rows[:1], .94, timing_text=target) is None
    details = {}
    assert _segment_caption(source, rows, .94, details, timing_text=target)[0] == target
    assert details["timing_asr_confirmed"]
