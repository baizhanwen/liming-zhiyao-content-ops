"""Offline semantic-fidelity checks; correction callbacks never contact an SDK."""
import copy
from dataclasses import replace
from pathlib import Path

import pytest

from liming_analyzer.adapters import Keyframe, TranscriptOutput, TranscriptSegment, VisualOutput
from liming_analyzer.canonical_transcript import (
    build_canonical_transcript,
    create_canonical_response_model,
    protected_numeric_facts,
    restore_canonical_transcript,
)
from liming_analyzer.evidence import normalize_evidence_text


def transcript(*texts):
    return TranscriptOutput("zh-CN", tuple(TranscriptSegment(index * 2000, index * 2000 + 1500, text, 92) for index, text in enumerate(texts)), 92)


def ocr(*texts):
    return VisualOutput(tuple(Keyframe(index * 2000 + offset, Path(f"frame-{index}-{offset}.jpg"), text, 96)
                              for index, text in enumerate(texts) for offset in (0, 500)))


def callback(*texts):
    def request(_task, payload, _limit):
        return {"segments": [{"s": row["s"], "t": texts[row["s"] - 1]} for row in payload["segments"]]}
    return request


def test_repeated_aligned_ocr_anchors_names_without_overwriting_raw_asr_or_times():
    raw = transcript("宝宝们这次我们测试GrowlBot", "它使用Opus五点五版本")
    original = copy.deepcopy(raw)
    visuals = ocr("朋友们这次我们测试GrokBot", "它使用Opus5.5版本")
    calls = []

    def request(task, payload, limit):
        calls.append((task, payload, limit))
        return callback("朋友们这次我们测试GrokBot。", "它使用Opus5.5版本。")(task, payload, limit)

    result = build_canonical_transcript(raw, visuals, request)
    assert result.status == "completed", result.validation
    assert raw == original
    assert result.transcript.segments[0].text == "朋友们这次我们测试GrokBot。"
    assert [(row.start_ms, row.end_ms) for row in result.transcript.segments] == [(row.start_ms, row.end_ms) for row in raw.segments]
    assert result.segments[0]["original_text"] == raw.segments[0].text
    assert result.segments[0]["evidence_ids"] == ["ocr:0001", "ocr:0002"]
    assert result.to_dict()["changes"][0]["evidence_ids"] == ["ocr:0001", "ocr:0002"]
    assert calls[0][0] == "canonical_transcript" and calls[0][2] == 6000
    assert result.spoken_script_set["corrected_original"]["status"] == "completed"


@pytest.mark.parametrize("screen", ["Opus5.5版本", "Opus4.5版本"])
def test_known_version_cannot_be_downgraded_even_when_ocr_disagrees(screen):
    calls = []

    def request(*_args):
        calls.append(True)
        return {"segments": [{"s": 1, "t": "现在使用Opus4.5版本。"}]}

    result = build_canonical_transcript(transcript("现在使用Opus5.5版本"), ocr(screen), request)
    assert result.status == "failed"
    assert result.transcript is None
    assert any("numeric_or_version_changed" in issue for issue in result.validation["issues"])
    assert len(calls) == 1  # No inner retry multiplying the SDK wrapper's attempts.
    with pytest.raises(ValueError, match="verified"):
        result.to_checkpoint()


@pytest.mark.parametrize(("original", "corrected"), [
    ("售价两百元版本五点五MP四", "售价200元版本5.5 MP4。"),
    ("IP六八和一千元，百分之五", "IP68和1,000元，5%。"),
    ("这是第一步", "这是第1步。"),
    ("Opus五点零版本", "Opus5.0版本。"),
    ("一定记住千万不要错过", "一定记住千万不要错过。"),
    ("this is its setup", "this is its set up."),
])
def test_semantically_equivalent_numeric_and_surface_forms_are_allowed(original, corrected):
    result = build_canonical_transcript(transcript(original), VisualOutput(), callback(corrected))
    assert result.status == "completed", result.validation


def test_dotted_version_components_and_repetition_are_not_decimal_rounding():
    assert protected_numeric_facts("Opus5.50和Opus5.5") == ["5.50", "5.5"]
    assert protected_numeric_facts("两百元和两百元") == ["200", "200"]
    result = build_canonical_transcript(transcript("Opus5.50和Opus5.5"), VisualOutput(), callback("Opus5.5和Opus5.5"))
    assert result.status == "failed"


@pytest.mark.parametrize("visuals", [VisualOutput(), VisualOutput((Keyframe(0, Path("single.jpg"), "GrokBot", 99),)),
                                     VisualOutput((Keyframe(0, Path("a.jpg"), "GrokBot", 20), Keyframe(500, Path("b.jpg"), "GrokBot", 20)))])
def test_a_single_or_low_confidence_screen_cannot_rewrite_a_technical_name(visuals):
    result = build_canonical_transcript(transcript("这次我们测试GrowlBot"), visuals, callback("这次我们测试GrokBot。"))
    assert result.status == "failed"
    assert any("without_ocr" in issue or "without_repeated_ocr" in issue for issue in result.validation["issues"])


def test_unrelated_screen_and_wholesale_caption_copy_are_not_audio_truth():
    source = transcript("我们今天讨论如何整理会议记录并分配具体负责人")
    screen = "购买课程立刻获得限时优惠并马上进入直播间"
    result = build_canonical_transcript(source, ocr(screen), callback(screen))
    assert result.status == "failed"
    assert any("meaning_or_sequence_changed" in issue for issue in result.validation["issues"])


@pytest.mark.parametrize("rows", [[], [{"s": 2, "t": "内容"}], [{"s": 1, "t": "内容"}, {"s": 1, "t": "重复"}],
                                  [{"s": True, "t": "内容"}], [{"s": 1, "t": ""}]])
def test_missing_duplicate_reordered_boolean_or_empty_segments_fail_closed(rows):
    result = build_canonical_transcript(transcript("内容"), VisualOutput(), lambda *_args: {"segments": rows})
    assert result.status == "failed" and result.transcript is None
    assert result.diagnostics["request_count"] == 1


def test_a_749_character_source_is_not_rendered_as_one_reading_paragraph():
    source_text = ("这是原稿中需要保留的表达我们按顺序讨论问题并提供具体方法，" * 28)[:749]
    source = transcript(source_text)
    result = build_canonical_transcript(source, VisualOutput(), callback(source_text))
    assert result.status == "completed", result.validation
    assert len(result.paragraphs) >= 4
    assert max(len(row["text"]) for row in result.paragraphs) <= 180
    assert normalize_evidence_text("".join(row["text"] for row in result.paragraphs)) == normalize_evidence_text(source_text)
    assert all((row["start_ms"], row["end_ms"]) == (0, 1500) for row in result.paragraphs)
    assert result.validation["time_precision"] == "original_asr_segment"


def test_successful_checkpoint_revalidates_source_protocol_and_numeric_fidelity():
    source = transcript("现在使用Opus5.5版本")
    visuals = ocr("Opus5.5")
    result = build_canonical_transcript(source, visuals, callback("现在使用Opus5.5版本。"))
    checkpoint = result.to_checkpoint()
    restored = restore_canonical_transcript(checkpoint, source, visuals)
    assert restored and restored.status == "completed" and restored.diagnostics["request_count"] == 0
    assert restore_canonical_transcript(checkpoint, transcript("现在使用Opus4.5版本"), visuals) is None
    assert restore_canonical_transcript({**checkpoint, "protocol_version": "old"}, source, visuals) is None
    assert restore_canonical_transcript({**checkpoint, "validation": {"passed": False}}, source, visuals) is None
    tampered = copy.deepcopy(checkpoint)
    tampered["segments"][0]["text"] = "现在使用Opus4.5版本。"
    assert restore_canonical_transcript(tampered, source, visuals) is None
    assert restore_canonical_transcript(checkpoint, source, replace(visuals, keyframes=(replace(visuals.keyframes[0], confidence=10),))) is None


def test_empty_asr_is_explicit_not_applicable_and_never_calls_model():
    result = build_canonical_transcript(TranscriptOutput("zh-CN", ()), VisualOutput(), lambda *_args: pytest.fail("must not call"))
    assert result.status == "not_applicable" and result.validation["reason"] == "transcript_empty"


def test_sdk_model_is_compact_and_rejects_additional_fields():
    model = create_canonical_response_model()
    assert model.model_validate({"segments": [{"s": 1, "t": "正文"}]}).model_dump() == {"segments": [{"s": 1, "t": "正文"}]}
    with pytest.raises(ValueError):
        model.model_validate({"segments": [{"s": 1, "t": "正文", "start_ms": 100}]})


def test_name_anchors_are_generic_and_conflicting_screen_numbers_remain_reference_only():
    source = transcript("我们测试NeroDev版本2.7")
    result = build_canonical_transcript(source, ocr("我们测试NovaDev版本9.0"), callback("我们测试NovaDev版本2.7。"))
    assert result.status == "completed", result.validation
    assert result.transcript.segments[0].text.endswith("2.7。")
    assert result.segments[0]["evidence_ids"] == ["ocr:0001", "ocr:0002"]


def test_large_transcript_batches_preserve_global_source_indices_and_never_hide_late_failure():
    source = transcript(*(f"这是第{index}段内容" for index in range(1, 100)))
    seen = []

    def request(_task, payload, _limit):
        indices = [row["s"] for row in payload["segments"]]
        seen.append(indices)
        return {"segments": [{"s": row["s"], "t": row["t"] + "。"} for row in payload["segments"]]}

    result = build_canonical_transcript(source, VisualOutput(), request)
    assert result.status == "completed"
    assert seen == [list(range(1, 97)), [97, 98, 99]]
    assert result.segments[-1]["source_segment_id"] == "transcript:0099"
    assert len(result.transcript.segments) == 99

    def failing_request(task, payload, limit):
        if payload["segments"][0]["s"] > 96:
            raise TimeoutError("synthetic failure must not be retried by the helper")
        return request(task, payload, limit)

    failed = build_canonical_transcript(source, VisualOutput(), failing_request)
    assert failed.status == "failed" and failed.transcript is None
    assert failed.diagnostics["request_count"] == 2
    assert len(failed.segments) == 96
    assert failed.validation["source_segment_coverage_percent"] == 0


@pytest.mark.parametrize(("before", "after"), [
    ("他会问你他以后负责什么", "它会问你它以后负责什么。"),
    ("请新件一个表格任务", "请新建一个表格任务。"),
    ("有绝对的系统机权线", "有绝对的系统级权限。"),
    ("我又建了一个隐石助手", "我又建了一个饮食助手。"),
    ("请选择适合自己的坐位", "请选择适合自己的座位。"),
    ("这份财务帐目已经导出", "这份财务账目已经导出。"),
])
def test_bounded_common_homophones_and_pronouns_do_not_require_missing_ocr(before, after):
    result = build_canonical_transcript(transcript(before), VisualOutput(), callback(after))
    assert result.status == "completed", result.validation
    assert result.segments[0]["evidence_ids"] == []  # No invented screen support.


@pytest.mark.parametrize(("before", "after"), [
    ("上了之后再给我答案", "说了之后再给我答案"),
    ("这家公司的售价很低", "这家公司的售价更低"),
    ("我们准备下周发布", "我们保证下周发布"),
    ("他在新件系统机权线", "它再新建系统级权限"),
])
def test_small_edit_rule_never_accepts_unsupported_candidate_words(before, after):
    result = build_canonical_transcript(transcript(before), VisualOutput(), callback(after))
    if "small_edit_budget_exceeded" in ":".join(result.validation["issues"]):
        assert result.status == "failed" and result.transcript is None
    else:
        assert result.status == "completed"
        assert result.transcript.segments[0].text == before
        assert result.segments[0]["original_text"] == before
        assert result.diagnostics["retained_source_segments"] == [{"source_segment_id": "transcript:0001", "reason": "text_changed_without_repeated_ocr"}]


@pytest.mark.parametrize(("before", "after"), [
    ("系统无写入权限", "系统有写入权限"),
    ("禁止上传客户文件", "允许上传客户文件"),
    ("这个功能不能运行", "这个功能可以运行"),
    ("大家别上传这个文件", "大家要上传这个文件"),
    ("当前版本Opus5.5", "当前版本Opus4.5"),
    ("价格是五百元", "价格是六百元"),
])
def test_even_repeated_ocr_cannot_override_numbers_versions_or_negation(before, after):
    result = build_canonical_transcript(transcript(before), ocr(after), callback(after))
    assert result.status == "failed"
    assert any("numeric_or_version_changed" in issue or "negation_changed" in issue for issue in result.validation["issues"])


def test_confirmed_name_spelling_is_reusable_at_a_distant_segment_with_real_source_refs():
    source = TranscriptOutput("zh-CN", (TranscriptSegment(0, 3000, "我们今天试用LoominaDesk"),
                                      TranscriptSegment(90000, 92000, "最后买了LumenaDesk")))
    screen = VisualOutput((Keyframe(0, Path("a.jpg"), "我们今天试用LuminaDesk", 95),
                           Keyframe(500, Path("b.jpg"), "我们今天试用LuminaDesk", 95)))
    payloads = []

    def request(task, payload, limit):
        payloads.append(payload)
        return callback("我们今天试用LuminaDesk。", "最后买了LuminaDesk。")(task, payload, limit)

    result = build_canonical_transcript(source, screen, request)
    assert result.status == "completed", result.validation
    assert result.segments[1]["evidence_ids"] == ["ocr:0001", "ocr:0002"]
    assert payloads[0]["confirmed_name_anchors"] == [{"term": "LuminaDesk", "evidence_ids": ["ocr:0001", "ocr:0002"]}]
    assert result.segments[1]["start_ms"] == 90000


@pytest.mark.parametrize("confidence,times", [(99, (0,)), (99, (0, 0)), (50, (0, 500))])
def test_global_name_reuse_still_requires_confident_temporally_distinct_frames(confidence, times):
    source = TranscriptOutput("zh-CN", (TranscriptSegment(90000, 92000, "最后买了LumenaDesk"),))
    screen = VisualOutput(tuple(Keyframe(stamp, Path(f"{index}.jpg"), "LuminaDesk", confidence) for index, stamp in enumerate(times)))
    result = build_canonical_transcript(source, screen, callback("最后买了LuminaDesk。"))
    assert result.status == "failed"


def test_confirmed_name_is_not_changed_into_another_confirmed_product():
    screen = VisualOutput((Keyframe(0, Path("a"), "HeliosDesk HeliosDusk", 95),
                           Keyframe(500, Path("b"), "HeliosDesk HeliosDusk", 95)))
    result = build_canonical_transcript(transcript("这次选择HeliosDesk"), screen, callback("这次选择HeliosDusk。"))
    assert result.status == "failed"
    assert any("confirmed_name_changed" in issue for issue in result.validation["issues"])


@pytest.mark.parametrize(("before", "after"), [
    ("宝宝这个月我几乎天天都在测试这个工具", "朋友们这个月我几乎天天都在测试这个工具"),
    ("甲甲今天我们一起介绍新的备课流程", "大家今天我们一起介绍新的备课流程"),
])
def test_repeated_similar_opening_line_is_explicit_in_prompt_and_unfixed_prefix_fails(before, after):
    screen = ocr(after)
    payloads = []

    def keep_original(task, payload, limit):
        payloads.append(payload)
        return callback(before)(task, payload, limit)

    failed = build_canonical_transcript(transcript(before), screen, keep_original)
    assert failed.status == "failed"
    assert "repeated_subtitle_correction_unapplied" in ":".join(failed.validation["issues"])
    anchor = payloads[0]["segments"][0]["repeated_subtitle_anchors"][0]
    assert anchor["text"] == after and anchor["evidence_ids"] == ["ocr:0001", "ocr:0002"]
    fixed = build_canonical_transcript(transcript(before), screen, callback(after))
    assert fixed.status == "completed", fixed.validation


def test_repeated_caption_number_mismatch_is_not_a_mandatory_opening_anchor():
    source = transcript("那又到要两个人一起回答的问题怎么办")
    result = build_canonical_transcript(source, ocr("那一道要两个人一起回答的问题怎么办"), callback(source.segments[0].text))
    assert result.status == "completed", result.validation


def test_supported_distinction_is_not_mistaken_for_a_negative_command():
    result = build_canonical_transcript(transcript("这是它和别的工具最大的训练"), ocr("这是它和别的工具最大的区别"), callback("这是它和别的工具最大的区别。"))
    assert result.status == "completed", result.validation


def test_difficult_alias_needs_local_sentence_alignment_in_addition_to_global_name_quorum():
    raw = TranscriptOutput("zh-CN", (TranscriptSegment(90000, 92000, "而且Gorable的在这台电脑上"),))
    confirmed = (Keyframe(0, Path("a"), "Grok Bot", 96), Keyframe(500, Path("b"), "Grok Bot", 96))
    local = Keyframe(91000, Path("mixed-ui"), "term@cloud open\n而且GrokBot在这台电脑上有系统权限", 62)
    supported = build_canonical_transcript(raw, VisualOutput((*confirmed, local)), callback("而且GrokBot在这台电脑上。"))
    assert supported.status == "completed", supported.validation
    assert supported.segments[0]["evidence_ids"] == ["ocr:0001", "ocr:0002", "ocr:0003"]
    unsupported = build_canonical_transcript(raw, VisualOutput(confirmed), callback("而且GrokBot在这台电脑上。"))
    assert unsupported.status == "failed"


def long_spoken_source():
    texts = ["今天我们结合真实的工作流程解释如何整理资料并且分配任务给相应的负责人" for _ in range(12)]
    return TranscriptOutput("zh-CN", tuple(TranscriptSegment(index * 4000, index * 4000 + 3900, text) for index, text in enumerate(texts)))


def test_long_chinese_speech_without_punctuation_cannot_be_claimed_complete():
    source = long_spoken_source()
    result = build_canonical_transcript(source, VisualOutput(), callback(*(row.text for row in source.segments)))
    assert result.status == "failed" and result.transcript is None
    assert result.validation["readability"]["applicable"]
    assert "long_spoken_script_punctuation_insufficient" in result.validation["issues"]
    assert "long_spoken_script_sentence_end_missing" in result.validation["issues"]


def test_contextual_punctuation_allows_cross_segment_sentences_without_changed_source_times():
    source = long_spoken_source()
    texts = [row.text + ("，" if index % 2 == 0 else "。") for index, row in enumerate(source.segments)]
    result = build_canonical_transcript(source, VisualOutput(), callback(*texts))
    assert result.status == "completed", result.validation
    assert result.validation["readability"]["sentence_endings"] == 6
    assert len(result.paragraphs) > 1
    assert [(row.start_ms, row.end_ms) for row in result.transcript.segments] == [(row.start_ms, row.end_ms) for row in source.segments]


def test_commas_without_natural_sentence_endings_do_not_pass_long_script_readability():
    source = long_spoken_source()
    texts = [row.text + ("，" if index < len(source.segments) - 1 else "。") for index, row in enumerate(source.segments)]
    result = build_canonical_transcript(source, VisualOutput(), callback(*texts))
    assert result.status == "failed"
    assert "long_spoken_script_punctuation_insufficient" in result.validation["issues"]


@pytest.mark.parametrize("mode", ["short_video", "short_phrase_labels"])
def test_short_clips_and_label_like_fragments_do_not_require_prose_sentence_punctuation(mode):
    if mode == "short_video":
        source = transcript("今天我们了解一种整理资料的新方法", "先建目录再给文件命名")
    else:
        source = TranscriptOutput("zh-CN", tuple(TranscriptSegment(index * 1000, index * 1000 + 900, "产品展示") for index in range(60)))
    result = build_canonical_transcript(source, VisualOutput(), callback(*(row.text for row in source.segments)))
    assert result.status == "completed", result.validation
    assert result.validation["readability"]["applicable"] is False


def test_two_similarly_named_products_do_not_let_a_distant_alias_be_guessed():
    raw = TranscriptOutput("zh-CN", (TranscriptSegment(90000, 92000, "这次选择LumiaDesk"),))
    screen = VisualOutput((Keyframe(0, Path("a"), "LumaDesk\nLuminaDesk", 96),
                           Keyframe(500, Path("b"), "LumaDesk\nLuminaDesk", 96)))
    result = build_canonical_transcript(raw, screen, callback("这次选择LumaDesk。"))
    assert result.status == "failed"


@pytest.mark.parametrize(("before", "candidate", "accepted"), [
    ("上了之后再给我一个明确的答案", "然后再给我一个明确的答案。", "上了之后再给我一个明确的答案。"),
    ("再加你可以用自己的电脑操控它", "在家你可以用自己的电脑操控它，", "再加你可以用自己的电脑操控它，"),
    ("在外面用手机的型", "在外面用手机的话，", "在外面用手机的型，"),
    ("老马对于中国用户", "对于中国用户，", "老马对于中国用户，"),
    ("我是张工", "我是章工，", "我是张工，"),
])
def test_unsupported_small_chinese_change_is_discarded_without_another_request(before, candidate, accepted):
    calls = []

    def request(*args):
        calls.append(args)
        return callback(candidate)(*args)

    source = transcript(before)
    result = build_canonical_transcript(source, VisualOutput(), request)
    assert result.status == "completed", result.validation
    assert len(calls) == 1
    assert result.transcript.segments[0].text == accepted
    assert result.segments[0]["original_text"] == before
    assert normalize_evidence_text(accepted) == normalize_evidence_text(before)
    assert result.segments[0]["evidence_ids"] == []
    assert result.to_dict()["changes"][0]["after"] == accepted
    restored = restore_canonical_transcript(result.to_checkpoint(), source, VisualOutput())
    assert restored and restored.status == "completed"
    assert restored.transcript.segments[0].text == accepted
    assert restored.diagnostics["retained_source_segments"] == result.diagnostics["retained_source_segments"]


@pytest.mark.parametrize(("before", "candidate"), [
    ("这是Opus5.5版本的真实测试", "这是Opus4.5版本的真实测验。"),
    ("现在不能上传这份客户资料", "现在可以上传这份客户资料。"),
    ("我们测试LumaDesk的整理效果", "我们测试LumaDusk的整理效果。"),
    ("we prepare this draft", "we guarantee this draft."),
    ("我们准备使用新的目录整理这份资料并分配任务", "我们将要换用旧的文件删除这份资料并重新分工。"),
])
def test_numeric_negation_technical_latin_and_large_changes_are_not_sanitized(before, candidate):
    result = build_canonical_transcript(transcript(before), VisualOutput(), callback(candidate))
    assert result.status == "failed" and result.transcript is None
    assert result.diagnostics["retained_source_segments"] == []


def test_retaining_source_cannot_bypass_a_repeated_opening_subtitle_anchor():
    source = transcript("宝宝这个月我每天测试这个工具")
    screen = ocr("朋友们这个月我每天测试这个工具")
    # The candidate fixes the evidenced opening but invents an unrelated small
    # wording change. Retaining the entire source brings back the ASR opening,
    # which must still fail the original full evidence gate.
    result = build_canonical_transcript(source, screen, callback("朋友们这个月我每日测试这个工具。"))
    assert result.status == "failed" and result.transcript is None
    assert "repeated_subtitle_correction_unapplied" in ":".join(result.validation["issues"])
    assert result.segments[0]["text"] == source.segments[0].text + "。"


def test_99_segment_batches_keep_all_source_ids_after_sanitizing_both_sides_of_boundary():
    source = transcript(*(f"这是第{index}段人工稿我会整理资料。" for index in range(1, 100)))
    changed = {1, 96, 97, 99}
    calls = []

    def request(_task, payload, _limit):
        calls.append([row["s"] for row in payload["segments"]])
        return {"segments": [{"s": row["s"], "t": row["t"].replace("整理", "删除") if row["s"] in changed else row["t"]} for row in payload["segments"]]}

    result = build_canonical_transcript(source, VisualOutput(), request)
    assert result.status == "completed", result.validation
    assert calls == [list(range(1, 97)), [97, 98, 99]]
    assert [row.text for row in result.transcript.segments] == [row.text for row in source.segments]
    assert [row["source_segment_id"] for row in result.diagnostics["retained_source_segments"]] == [f"transcript:{index:04d}" for index in sorted(changed)]
    assert [row["source_segment_id"] for row in result.segments] == [f"transcript:{index:04d}" for index in range(1, 100)]


def test_missing_wire_segment_still_fails_instead_of_filling_it_from_source():
    source = transcript("我们现在整理资料", "然后再分配具体任务")
    result = build_canonical_transcript(source, VisualOutput(), lambda *_args: {"segments": [{"s": 1, "t": "我们现在删除资料。"}]})
    assert result.status == "failed" and result.transcript is None
    assert result.diagnostics["retained_source_segments"] == []


def test_retention_does_not_invent_internal_punctuation_to_bypass_readability_gate():
    source = long_spoken_source()
    candidates = [row.text.replace("解释", "讲述") for row in source.segments]
    result = build_canonical_transcript(source, VisualOutput(), callback(*candidates))
    assert result.status == "failed" and result.transcript is None
    assert "long_spoken_script_punctuation_insufficient" in result.validation["issues"]
    assert [row["text"] for row in result.segments] == [row.text for row in source.segments]
