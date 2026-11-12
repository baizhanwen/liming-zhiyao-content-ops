"""Synthetic-only patch review, recovery and original-source preservation."""
from pathlib import Path

import pytest

from liming_analyzer.adapters import Keyframe, TranscriptOutput, TranscriptSegment, VisualOutput
from liming_analyzer.canonical_review import (
    build_reviewed_transcript,
    create_repair_response_model,
    create_review_response_model,
    restore_reviewed_transcript,
)


def source(*texts):
    return TranscriptOutput("zh-CN", tuple(TranscriptSegment(index * 3000, index * 3000 + 2500, text, 95)
                                         for index, text in enumerate(texts)), 95)


def frames(*texts):
    return VisualOutput(tuple(Keyframe(index * 3000 + offset, Path(f"synthetic-{index}-{offset}.jpg"), text, 96)
                              for index, text in enumerate(texts) for offset in (0, 500)))


def patch(s, before, after, refs=()):
    return {"s": s, "before": before, "after": after, "evidence_ids": list(refs)}


def answer(patches=(), uncertain=(), punctuation=()):
    return {"patches": list(patches), "uncertain": list(uncertain), "punctuation": list(punctuation)}


def test_safe_patch_and_pending_segment_never_erase_other_source_slots_or_leak_candidate():
    raw = source("这次测试OrbitDesk工具", "第二句需要核对具体意思", "第三句原稿保持完整")
    calls = []

    def request(task, payload, _limit):
        calls.append((task, payload))
        if task == "canonical_review":
            return answer([patch(1, "OrbitDesk", "Orbit Desk", ["ocr:0001", "ocr:0002"]),
                           patch(2, "第二句需要核对具体意思", "这是完全不同的商业事实")])
        return answer(uncertain=[{"s": 2, "reason": "缺少证据，不能确认原句"}])

    result = build_reviewed_transcript(raw, frames("这次测试Orbit Desk工具"), request)
    assert result.status == "needs_review"
    assert [row["review_status"] for row in result.segments] == ["accepted", "needs_review", "accepted"]
    assert len(result.analysis_transcript.segments) == 3
    assert result.analysis_transcript.segments[1].text == ""
    assert result.analysis_transcript.segments[2].text == raw.segments[2].text
    assert result.segments[1]["text"] == raw.segments[1].text
    assert result.segments[1]["candidate_text"] == "这是完全不同的商业事实"
    assert "商业事实" not in "".join(result.paragraphs)
    assert "【待核对 00:03.000】" in "".join(result.paragraphs)
    assert "第三句原稿保持完整" in "".join(result.paragraphs)
    assert len(calls) == 1  # Missing semantic evidence is not fixed by asking the same question twice.
    assert raw.segments[0].text == "这次测试OrbitDesk工具"


@pytest.mark.parametrize(("before", "after", "expected"), [
    ("版本5.5不能变", "版本4.5不能变", "numeric_or_version_changed"),
    ("不要删除原始数据", "要删除原始数据", "negation_changed"),
])
def test_protected_facts_remain_pending_even_if_screen_proposes_another_fact(before, after, expected):
    raw = source(before, "其他正常句子继续保留")
    result = build_reviewed_transcript(raw, frames(after), lambda *_: answer([patch(1, before, after)]))
    assert result.status == "needs_review"
    assert result.segments[0]["text"] == before
    assert any(expected in issue for issue in result.segments[0]["issues"])
    assert result.segments[1]["review_status"] == "accepted"
    assert result.analysis_transcript.segments[0].text == ""


def test_name_change_requires_actual_repeated_aligned_ocr():
    raw = source("这是NovaPro型号", "其他正常句子继续保留")
    request = lambda *_: answer([patch(1, "NovaPro", "NovaPlus")])
    unsupported = build_reviewed_transcript(raw, VisualOutput(), request)
    assert unsupported.status == "needs_review"
    assert "technical_identifier_changed_without_ocr" in unsupported.segments[0]["issues"]
    assert unsupported.analysis_transcript.segments[0].text == ""
    supported = build_reviewed_transcript(raw, frames("这是NovaPlus型号"), request)
    assert supported.status == "completed", supported.validation
    assert supported.segments[0]["text"] == "这是NovaPlus型号"
    assert supported.segments[0]["evidence_ids"] == ["ocr:0001", "ocr:0002"]


def test_same_source_unchanged_but_explicit_uncertain_is_not_accepted_after_empty_repair():
    def request(task, _payload, _limit):
        return answer(uncertain=[{"s": 1, "reason": "原识别词疑似乱码"}]) if task == "canonical_review" else answer()

    result = build_reviewed_transcript(source("这一句保留但意思尚待确认", "正常后一段"), VisualOutput(), request)
    assert result.segments[0]["review_status"] == "needs_review"
    assert result.segments[0]["original_text"] == result.segments[0]["text"]
    assert result.review_context["uncertain_segment_ids"] == ["transcript:0001"]
    assert result.review_context["first_source_segment_id"] == "transcript:0001"
    assert result.analysis_transcript.segments[1].text == "正常后一段"


def test_repeated_aligned_subtitle_conflict_cannot_be_accepted_by_echoing_asr():
    raw = source("宝宝们今天介绍OrbitDesk工具")
    result = build_reviewed_transcript(raw, frames("朋友们今天介绍OrbitDesk工具"), lambda *_: answer())
    assert result.status == "needs_review"
    assert any("subtitle" in issue for issue in result.segments[0]["issues"])


def test_two_real_aligned_ocr_rows_can_verify_a_chinese_patch_without_copying_article():
    raw = source("今天讲一下机器人协作的作用")
    visual = frames("这是无关的长文章内容" * 60 + "\n今天讲一下智能体协作的作用")
    captured = []

    def request(_task, payload, _limit):
        captured.append(payload)
        return answer([patch(1, "机器人", "智能体", ["ocr:0001", "ocr:0002"])])

    result = build_reviewed_transcript(raw, visual, request)
    assert result.status == "completed", result.validation
    assert result.analysis_transcript.segments[0].text == "今天讲一下智能体协作的作用"
    assert all(len(row["text"]) < 220 for row in captured[0]["ocr"])
    assert "无关" not in str(captured[0]["ocr"])


@pytest.mark.parametrize("bad_patch", [
    patch(1, "哈", "你好"),
    patch(1, "哈哈", "你好"),  # Overlapping occurrences in 哈哈哈 are ambiguous too.
    patch(1, "不存在", "你好"),
    patch(1, "哈哈哈", "你好", ["ocr:9999"]),
])
def test_patch_before_must_be_unique_and_evidence_real(bad_patch):
    result = build_reviewed_transcript(source("哈哈哈，后面保留"), VisualOutput(), lambda *_: answer([bad_patch]))
    assert result.status == "needs_review"
    assert result.segments[0]["text"] == "哈哈哈，后面保留"


def test_overlapping_patches_never_compose_an_unverified_fact():
    raw = source("他有一个工具")
    result = build_reviewed_transcript(raw, VisualOutput(), lambda *_: answer([
        patch(1, "他", "它"), patch(1, "他有", "她有"),
    ]))
    assert result.status == "needs_review"
    assert "patches_overlap" in result.segments[0]["issues"]
    assert result.analysis_transcript.segments[0].text == ""


@pytest.mark.parametrize(("original", "punctuated", "passed"), [
    ("今天介绍Orbit Desk", "今天，介绍 Orbit Desk。", True),
    ("型号XP-1版本5.50", "型号XP1，版本5.50。", False),
    ("型号XP1版本5.50", "型号XP-1，版本5.50。", False),
    ("版本5.50", "版本5.5。", False),
    ("不要删除", "要删除。", False),
])
def test_punctuation_cannot_modify_source_words_or_technical_separators(original, punctuated, passed):
    result = build_reviewed_transcript(source(original), VisualOutput(),
                                       lambda *_: answer(punctuation=[{"s": 1, "text": punctuated}]))
    assert (result.status == "completed") is passed
    assert result.segments[0]["text"] == (punctuated if passed else original)


def test_one_directed_repair_can_resolve_a_patch_and_preserve_good_neighbor():
    raw = source("今天讲一下机器人协作的作用", "正常后一段完整保留")
    visual = frames("今天讲一下智能体协作的作用")
    calls = []

    def request(task, payload, _limit):
        calls.append((task, payload))
        if task == "canonical_review":
            return answer([patch(1, "机器人误记", "智能体")])
        return answer([patch(1, "机器人", "智能体", ["ocr:0001", "ocr:0002"])])

    result = build_reviewed_transcript(raw, visual, request)
    assert result.status == "completed", result.validation
    assert len(calls) == 2 and len(calls[1][1]["segments"]) == 1
    assert result.analysis_transcript.segments[1].text == raw.segments[1].text


def test_repeated_partial_subtitle_can_prove_edit_near_its_start_boundary():
    raw = source("比如昨天的实施信号是什么")
    visual = frames("实时信号是什么")
    result = build_reviewed_transcript(raw, visual, lambda *_: answer([
        patch(1, "实施", "实时", ["ocr:0001", "ocr:0002"]),
    ]))
    assert result.status == "completed", result.validation
    assert result.segments[0]["text"] == "比如昨天的实时信号是什么"
    assert result.segments[0]["evidence_ids"] == ["ocr:0001", "ocr:0002"]


def test_valid_repair_patch_resolves_old_punctuation_proposal_for_same_corrected_words():
    raw = source("光有数据还不够海量的口波稿")
    visual = frames("海量的口播稿")

    def request(task, _payload, _limit):
        if task == "canonical_review":
            return answer(punctuation=[{"s": 1, "text": "光有数据还不够，海量的口播稿。"}])
        return answer([patch(1, "口波稿", "口播稿", ["ocr:0001", "ocr:0002"])])

    result = build_reviewed_transcript(raw, visual, request)
    assert result.status == "completed", result.validation
    assert result.segments[0]["text"] == "光有数据还不够海量的口播稿"


def test_single_high_confidence_complete_subtitle_can_prove_one_chinese_character():
    raw = source("而是把全网的报款情报")
    visual = VisualOutput((Keyframe(1000, Path("synthetic-one.jpg"), "而是把全网的爆款情报", 100),))
    result = build_reviewed_transcript(raw, visual, lambda *_: answer([
        patch(1, "报款", "爆款", ["ocr:0001"]),
    ]))
    assert result.status == "completed", result.validation
    assert result.segments[0]["text"] == "而是把全网的爆款情报"
    assert result.segments[0]["evidence_ids"] == ["ocr:0001"]


@pytest.mark.parametrize(("original", "corrected", "ocr", "timestamp", "confidence"), [
    ("而是把全网的报款情报", "而是把全网的爆款情报", "而是把全网的爆款情报", 3000, 100),
    ("对标的博主没发这个新视频", "对标的博主每发这个新视频", "对标的博主每发这个新视频", 1000, 100),
    ("这里的模型版本是5.5", "这里的模型版本是4.5", "这里的模型版本是4.5", 1000, 100),
    ("这是NovaPro最新的模型", "这是NovaPlus最新的模型", "这是NovaPlus最新的模型", 1000, 100),
])
def test_single_subtitle_does_not_waive_alignment_confidence_or_fact_protection(original, corrected, ocr, timestamp, confidence):
    visual = VisualOutput((Keyframe(timestamp, Path("synthetic-one.jpg"), ocr, confidence),))
    result = build_reviewed_transcript(source(original), visual, lambda *_: answer([
        patch(1, original, corrected, ["ocr:0001"]),
    ]))
    assert result.status == "needs_review"
    assert result.segments[0]["text"] == original


def test_conflicting_complete_single_subtitles_cannot_pick_a_preferred_word():
    raw = source("而是把全网的报款情报")
    visual = VisualOutput(tuple(Keyframe(time, Path(f"synthetic-{time}.jpg"), text, 100) for time, text in [
        (1000, "而是把全网的爆款情报"), (1100, "而是把全网的拨款情报"),
    ]))
    result = build_reviewed_transcript(raw, visual, lambda *_: answer([
        patch(1, "报款", "爆款", ["ocr:0001"]),
    ]))
    assert result.status == "needs_review"


def prior_validation_checkpoint():
    """Synthetic archived selections rejected by the first v2 validator."""
    raw = source("比如昨天的实施信号是什么", "而是把全网的报款情报", "光有数据还不够海量的口波稿", "仍然需要核对具体内容")
    visual = VisualOutput(tuple(Keyframe(time, Path(f"synthetic-{time}.jpg"), text, 100) for time, text in [
        (0, "实时信号是什么"), (500, "实时信号是什么"),
        (3500, "而是把全网的爆款情报"),
        (6500, "海量的口播稿"), (6750, "海量的口播稿"),
    ]))
    first = build_reviewed_transcript(raw, visual, lambda _task, payload, _limit: answer(uncertain=[
        {"s": row["s"], "reason": "待核对"} for row in payload["segments"]]))
    cp = first.to_checkpoint()
    for s, before, after, refs in [
        (1, "实施", "实时", ["ocr:0001", "ocr:0002"]),
        (2, "报款", "爆款", ["ocr:0003"]),
    ]:
        state = cp["selections"][f"transcript:{s:04d}"]
        state["rejected"] = [{"patch": patch(s, before, after, refs),
                              "issues": ["text_changed_without_repeated_ocr", "lexical_patch_without_repeated_evidence"]}]
        state["uncertain_reason"] = "此前只有一条OCR，无法确认" if s == 2 else None
        state["candidate_text"] = raw.segments[s - 1].text.replace(before, after)
    third = cp["selections"]["transcript:0003"]
    third.update(patches=[patch(3, "口波稿", "口播稿", ["ocr:0004", "ocr:0005"])],
                 rejected=[{"patch": {}, "issues": ["punctuation_changes_source_characters"]}],
                 uncertain_reason=None, candidate_text="光有数据还不够，海量的口播稿。")
    return raw, visual, cp


def test_explicit_repair_locally_revalidates_saved_proposals_without_paid_calls():
    raw, visual, cp = prior_validation_checkpoint()
    # Normal resume is stable: a validator update never silently rewrites a
    # manuscript or removes an existing review state.
    reused = build_reviewed_transcript(raw, visual, lambda *_: pytest.fail("resume must not pay"), resume=cp)
    assert all(row["review_status"] == "needs_review" for row in reused.segments)
    repaired = build_reviewed_transcript(raw, visual, lambda *_: pytest.fail("actual stored proof is sufficient"),
                                        resume=cp, repair_segment_ids=["transcript:0001", "transcript:0002", "transcript:0003"])
    assert [row["review_status"] for row in repaired.segments] == ["accepted", "accepted", "accepted", "needs_review"]
    assert repaired.diagnostics["request_count"] == 0
    assert repaired.diagnostics["local_revalidated_segment_ids"] == ["transcript:0001", "transcript:0002", "transcript:0003"]
    assert repaired.segments[3] == reused.segments[3]
    assert [row.text for row in repaired.analysis_transcript.segments] == [
        "比如昨天的实时信号是什么", "而是把全网的爆款情报", "光有数据还不够海量的口播稿", "",
    ]


def test_local_revalidation_only_sends_still_unproven_targets_to_one_directed_callback():
    raw, visual, cp = prior_validation_checkpoint()
    sent = []

    def request(task, payload, _limit):
        sent.append((task, payload))
        return answer(uncertain=[{"s": 4, "reason": "依然没有实际证据"}])

    result = build_reviewed_transcript(raw, visual, request, resume=cp,
                                       repair_segment_ids=[f"transcript:{s:04d}" for s in range(1, 5)])
    assert len(sent) == 1 and sent[0][0] == "canonical_repair"
    assert [row["s"] for row in sent[0][1]["segments"]] == [4]
    assert result.diagnostics["request_count"] == 1
    assert result.segments[3]["review_status"] == "needs_review"
    assert result.segments[3]["text"] == raw.segments[3].text


def test_repair_budget_exhaustion_keeps_source_pending_and_never_restarts_review():
    class BudgetSpent(RuntimeError):
        safe_failure_kind = "batch_budget_exhausted"

    tasks = []

    def request(task, _payload, _limit):
        tasks.append(task)
        if task == "canonical_review":
            return answer([patch(1, "不在原稿中的词", "正常文字")])
        raise BudgetSpent()

    result = build_reviewed_transcript(source("原稿完整保留", "其他句继续可用"), VisualOutput(), request)
    assert tasks == ["canonical_review", "canonical_repair"]
    assert result.status == "needs_review"
    assert result.segments[1]["review_status"] == "accepted"
    assert result.segments[0]["text"] == "原稿完整保留"


def test_partial_checkpoint_default_resume_reuses_pending_without_another_paid_call():
    raw = source("待确认句", "已核对句")
    first = build_reviewed_transcript(raw, VisualOutput(),
                                      lambda *_: answer(uncertain=[{"s": 1, "reason": "无充分依据"}]))
    cp = first.to_checkpoint()
    restored = restore_reviewed_transcript(cp, raw, VisualOutput())
    assert restored is not None and restored.status == "needs_review"
    second = build_reviewed_transcript(raw, VisualOutput(), lambda *_: pytest.fail("must not pay again"), resume=cp)
    assert second.to_dict() == first.to_dict()


def test_targeted_repair_only_sends_pending_target_and_preserves_every_other_selection():
    raw = source("第一句已核对", "他有一个工具", "第三句已核对")
    first = build_reviewed_transcript(raw, VisualOutput(),
                                      lambda *_: answer(uncertain=[{"s": 2, "reason": "指代待确认"}]))
    sent = []

    def request(task, payload, _limit):
        sent.append((task, payload))
        return answer([patch(2, "他", "它")])

    result = build_reviewed_transcript(raw, VisualOutput(), request, resume=first.to_checkpoint(),
                                       repair_segment_ids=["transcript:0002"])
    assert result.status == "completed", result.validation
    assert sent[0][0] == "canonical_repair" and [row["s"] for row in sent[0][1]["segments"]] == [2]
    assert result.segments[0] == first.segments[0] and result.segments[2] == first.segments[2]
    assert result.analysis_transcript.segments[1].text == "它有一个工具"


def test_checkpoint_revalidates_facts_and_does_not_promote_tampered_uncertain_flag():
    raw = source("版本5.5不能变", "正常句子")
    first = build_reviewed_transcript(raw, VisualOutput(), lambda *_: answer())
    bad = first.to_checkpoint()
    bad["selections"]["transcript:0001"]["patches"] = [patch(1, "5.5", "4.5")]
    restored = restore_reviewed_transcript(bad, raw, VisualOutput())
    assert restored is not None and restored.status == "needs_review"
    assert restored.analysis_transcript.segments[0].text == ""
    pending = build_reviewed_transcript(raw, VisualOutput(), lambda *_: answer(uncertain=[{"s": 1, "reason": "待核对"}]))
    bad = pending.to_checkpoint(); bad["selections"]["transcript:0001"]["uncertain_reason"] = None
    assert restore_reviewed_transcript(bad, raw, VisualOutput()) is None
    assert restore_reviewed_transcript(first.to_checkpoint(), source("版本6.5不能变", "正常句子"), VisualOutput()) is None


def test_batch_checkpoint_is_bounded_and_restores_unreviewed_remaining_batch():
    raw = source(*[f"这是第{index}句原始口播" for index in range(50)])
    checkpoints, calls = [], []

    def request(_task, payload, _limit):
        calls.append(payload)
        return answer()

    first = build_reviewed_transcript(raw, VisualOutput(), request, on_checkpoint=checkpoints.append)
    assert first.status == "completed" and len(calls) == 2
    assert len(checkpoints) == 3  # initial + each real changed batch, not 50 identical writes
    continued = []
    result = build_reviewed_transcript(raw, VisualOutput(),
                                       lambda _task, payload, _limit: continued.append(payload) or answer(),
                                       resume=checkpoints[1])
    assert result.status == "completed"
    assert [row["s"] for row in continued[0]["segments"]] == [49, 50]
    assert len(result.analysis_transcript.segments) == 50


def test_manual_transcript_is_authoritative_without_paid_review_or_ocr_override():
    raw = source("人工确认版本5.5不能改变", "乱码也由人工确认保留")
    result = build_reviewed_transcript(raw, frames("另一段视频版本4.5"),
                                       lambda *_: pytest.fail("manual must not pay"), trusted_manual=True)
    assert result.status == "completed"
    assert result.analysis_transcript.full_text == raw.full_text
    assert restore_reviewed_transcript(result.to_checkpoint(), raw, frames("另一段视频版本4.5")) is None
    assert restore_reviewed_transcript(result.to_checkpoint(), raw, frames("另一段视频版本4.5"), trusted_manual=True).status == "completed"


def test_response_schemas_are_small_and_forbid_unknown_patch_fields():
    model = create_review_response_model()
    assert model is create_repair_response_model()
    assert len(str(model.model_json_schema())) < 6000
    assert model.model_validate(answer()).patches == []
    with pytest.raises(ValueError):
        model.model_validate(answer([{**patch(1, "原", "新"), "offset": 0}]))


def test_source_empty_is_not_applicable_without_a_request():
    result = build_reviewed_transcript(TranscriptOutput("zh-CN", ()), VisualOutput(), lambda *_: pytest.fail("no source"))
    assert result.status == "not_applicable" and result.validation["passed"]
    assert result.review_context["first_source_segment_id"] is None


def common(s, before, after, kind="common_word"):
    return {**patch(s, before, after), "edit_type": kind, "context_basis": "同音或近音听写与本句语法搭配一致"}


@pytest.mark.parametrize(("original", "before", "after"), [
    ("下面分析这篇成稿的股价和完整结构", "股价", "骨架"),
    ("后面可以让系统生存完整的初稿文案", "生存", "生成"),
    ("接下来我们把这个博主收入到对标库当中", "收入", "收录"),
    ("然后分析内容的启程转合以及具体表达方式", "启程转合", "起承转合"),
    ("接下来只需要把这个视频链接一占贴即可", "占贴", "粘贴"),
    ("我们可以一键抓起这个博主最新的五个视频", "抓起", "抓取"),
])
def test_common_chinese_correction_uses_context_without_requiring_ocr(original, before, after):
    calls = []
    result = build_reviewed_transcript(source(original), VisualOutput(),
                                       lambda task, *_: calls.append(task) or answer([common(1, before, after)]))
    assert result.status == "completed", result.validation
    assert result.segments[0]["original_text"] == original
    assert result.segments[0]["text"] == original.replace(before, after)
    assert result.segments[0]["evidence_ids"] == []
    assert result.diagnostics["correction_sources"] == {"transcript:0001": "context"}
    assert calls == ["canonical_review"]


@pytest.mark.parametrize(("original", "before", "after", "issue"), [
    ("我给你转账以后系统就会自动记录这次交易的情况", "我给你", "你给我", "source_actor_changed"),
    ("他给我转账以后系统就会自动记录这次交易的情况", "他给我", "我给他", "source_actor_changed"),
    ("这个月产品的实际价格高于去年而且变化非常明显", "高于", "低于", "source_polarity_changed"),
    ("这项业务目前已经开始盈利而且后面还会继续扩展", "盈利", "亏损", "source_polarity_changed"),
    ("华为公司今天发布这款产品并介绍所有详细使用方法", "华为", "华伟", "identified_entity_changed"),
    ("今天由林青老师讲解这个完整的工作流程", "林青", "林清", "identified_entity_changed"),
    ("今天讨论这家公司的股价和整个行业的后续表现", "股价", "骨架", "source_fact_concept_changed"),
    ("这个项目需要3天时间而且所有流程已经准备完毕", "天", "年", "numeric_unit_or_currency_changed"),
    ("这个服务每月需要20美元而且后面还有其他功能", "美元", "欧元", "numeric_unit_or_currency_changed"),
    ("这个方案需要299元才能开启所有后续功能", "299", "199", "numeric_or_version_changed"),
    ("我们对标的博主没发这个新的完整实操视频", "没发", "每发", "negation_changed"),
    ("今天展示NovaPro最新的完整使用方法", "NovaPro", "NovaPlus", "technical_identifier_changed_without_ocr"),
    ("我们正在讨论这条产线搭建速度以及实际情况", "搭建速度", "搭建思路", "source_fact_concept_changed"),
])
def test_common_type_cannot_override_entities_facts_units_polarity_or_actor_order(original, before, after, issue):
    result = build_reviewed_transcript(source(original), VisualOutput(), lambda *_: answer([common(1, before, after)]))
    assert result.status == "needs_review"
    assert issue in result.segments[0]["issues"]
    assert result.segments[0]["text"] == original


def test_common_changes_are_cumulative_per_original_not_per_patch():
    result = build_reviewed_transcript(source("左特为参考示例和竹子稿"), VisualOutput(), lambda *_: answer([
        common(1, "特", "侧"), common(1, "竹", "逐"), common(1, "子", "字"),
    ]))
    assert result.status == "needs_review"
    assert "common_edit_cumulative_limit" in result.segments[0]["issues"]


def test_common_does_not_delete_particles_or_round_retention_up():
    for original, before, after in [("它的所有的粉丝量都会显示在这里", "所有的", "所有"),
                                    ("在留言区领取模板后打包袋子", "袋子", "带走")]:
        result = build_reviewed_transcript(source(original), VisualOutput(), lambda *_, before=before, after=after: answer([common(1, before, after)]))
        assert result.status == "needs_review"
        assert result.segments[0]["text"] == original


def test_fixed_expression_can_be_corrected_even_if_single_subtitle_has_its_own_typo():
    raw = source("先讲这个案例的启程转合然后给出完整的建议")
    visual = VisualOutput((Keyframe(500, Path("synthetic-expression.jpg"), "先讲这个案例的启承转合然后给出完整的建议", 93),))
    result = build_reviewed_transcript(raw, visual, lambda *_: answer([common(1, "启程转合", "起承转合", "orthography")]))
    assert result.status == "completed", result.validation


def test_single_partial_subtitle_confirming_source_blocks_unnecessary_common_rewording():
    original = "今天我们讨论这个工具的使用方法和完整的操作流程"
    visual = VisualOutput((Keyframe(500, Path("synthetic-confirmation.jpg"), "工具的使用方法和完整的操作流程", 99),))
    result = build_reviewed_transcript(source(original), visual, lambda *_: answer([common(1, "使用", "操作")]))
    assert result.status == "needs_review"
    assert "strong_subtitle_conflict" in result.segments[0]["issues"]


def test_local_subtitle_proves_two_characters_and_rebinds_actual_reference_with_audit():
    raw = source("找到这个视频竹子稿和详细拆解信息")
    visual = VisualOutput((Keyframe(1000, Path("synthetic-caption.jpg"), "逐字稿和详细拆解信息", 94),
                           Keyframe(10000, Path("synthetic-unrelated.jpg"), "完全无关的文字", 99)))
    result = build_reviewed_transcript(raw, visual, lambda *_: answer([patch(1, "竹子稿", "逐字稿", ["ocr:0002"])]))
    assert result.status == "completed", result.validation
    assert result.segments[0]["evidence_ids"] == ["ocr:0001"]
    assert result.selections["transcript:0001"]["reference_rebindings"][0]["before"] == ["ocr:0002"]


def test_unscoped_entity_uncertainty_is_not_cleared_by_a_different_common_patch():
    raw = source("我们先把链接一占贴然后奇马司负责后续的全部分析")
    initial = build_reviewed_transcript(raw, VisualOutput(), lambda *_: answer(uncertain=[{"s": 1, "reason": "后半句人名读音尚未确认"}]))
    result = build_reviewed_transcript(raw, VisualOutput(), lambda *_: answer([common(1, "占贴", "粘贴")]),
                                       resume=initial.to_checkpoint(), repair_segment_ids=["transcript:0001"])
    assert result.status == "needs_review"
    assert result.selections["transcript:0001"]["uncertain_reason"] == "后半句人名读音尚未确认"


def test_old_rejections_are_archived_only_when_their_actual_word_changes_are_resolved():
    raw = source("我们先把链接一占贴然后抓起全部资料进行后续分析")
    initial = build_reviewed_transcript(raw, VisualOutput(), lambda *_: answer([
        patch(1, "占贴", "粘贴"), patch(1, "抓起", "抓取")]))
    result = build_reviewed_transcript(raw, VisualOutput(), lambda *_: answer([common(1, "占贴", "粘贴")]),
                                       resume=initial.to_checkpoint(), repair_segment_ids=["transcript:0001"])
    assert result.status == "needs_review"
    state = result.selections["transcript:0001"]
    assert any(row["patch"].get("before") == "抓起" for row in state["rejected"])
    assert any(row["patch"].get("before") == "占贴" for row in state["archived_rejections"])


def test_superseded_particle_deletion_is_archived_when_new_minimal_patch_preserves_every_word():
    raw = source("它的所有的信息都会被我们抓起并且显示在这里")
    initial = build_reviewed_transcript(raw, VisualOutput(), lambda *_: answer(punctuation=[{
        "s": 1, "text": "它的所有信息都会被我们抓取，并且显示在这里。"}]))
    result = build_reviewed_transcript(raw, VisualOutput(), lambda *_: answer([common(1, "抓起", "抓取")]),
                                       resume=initial.to_checkpoint(), repair_segment_ids=["transcript:0001"])
    assert result.status == "completed", result.validation
    assert "所有的" in result.segments[0]["text"]
    assert result.selections["transcript:0001"]["archived_rejections"]


def test_uncertain_without_repairable_proposal_is_not_asked_twice_but_explicit_retry_can_ask_once():
    calls = []
    raw = source("这个未辨认词需要听原句确认具体含义")
    request = lambda task, *_: calls.append(task) or answer(uncertain=[{"s": 1, "reason": "原词听不清"}])
    first = build_reviewed_transcript(raw, VisualOutput(), request)
    assert calls == ["canonical_review"]
    calls.clear()
    build_reviewed_transcript(raw, VisualOutput(), request, resume=first.to_checkpoint(), repair_segment_ids=["transcript:0001"])
    assert calls == ["canonical_repair"]


def test_explicit_recheck_can_confirm_unchanged_ordinary_source_while_fixing_another_word():
    raw = source("这批文字和图片会自动整理为干净的竹子稿")
    reason = "没有对应OCR，不能确认“这批文字和图片”以及“竹子稿”的原词。"
    first = build_reviewed_transcript(raw, VisualOutput(), lambda *_: answer(uncertain=[{"s": 1, "reason": reason}]))
    seen = []

    def request(task, payload, _limit):
        seen.append(payload)
        return {**answer([common(1, "竹子稿", "逐字稿")]), "confirmed_original": [
            {"s": 1, "text": "这批文字和图片", "basis": "这是通顺普通原文，结合整理内容的上下文可原样保留，不需OCR覆盖"}]}

    result = build_reviewed_transcript(raw, VisualOutput(), request, resume=first.to_checkpoint(), repair_segment_ids=["transcript:0001"])
    assert result.status == "completed", result.validation
    assert result.segments[0]["text"] == "这批文字和图片会自动整理为干净的逐字稿"
    assert seen[0]["review_mode"] == "explicit_recheck"
    assert "历史" in seen[0]["segments"][0]["history_note"]
    assert result.selections["transcript:0001"]["confirmed_original"]
    # The original saved review state remains stable without explicit recheck.
    reused = build_reviewed_transcript(raw, VisualOutput(), lambda *_: pytest.fail("default resume must not ask"), resume=first.to_checkpoint())
    assert reused.status == "needs_review" and not reused.selections["transcript:0001"]["confirmed_original"]


@pytest.mark.parametrize("reason", [
    "没有对应OCR，不能确认“这批文字和图片”以及后半句人名读音。",
    "没有对应OCR，不能确认“这批文字和图片”，句尾词不完整。",
    "没有对应OCR，不能确认“这批文字和图片”，还存在连续乱码。",
    "没有对应OCR，不能确认“这批文字和图片”，数字单位有疑义。",
])
def test_original_confirmation_never_clears_real_historical_risk(reason):
    raw = source("这批文字和图片会自动整理为干净的竹子稿")
    first = build_reviewed_transcript(raw, VisualOutput(), lambda *_: answer(uncertain=[{"s": 1, "reason": reason}]))
    response = {**answer([common(1, "竹子稿", "逐字稿")]), "confirmed_original": [
        {"s": 1, "text": "这批文字和图片", "basis": "语法通顺"}]}
    result = build_reviewed_transcript(raw, VisualOutput(), lambda *_: response, resume=first.to_checkpoint(), repair_segment_ids=["transcript:0001"])
    assert result.status == "needs_review"
    assert result.selections["transcript:0001"]["uncertain_reason"] == reason


def test_original_confirmation_cannot_confirm_a_changed_span_or_hide_a_second_quoted_doubt():
    raw = source("这批文字和图片会自动整理为干净的竹子稿")
    first = build_reviewed_transcript(raw, VisualOutput(), lambda *_: answer(uncertain=[{
        "s": 1, "reason": "没有OCR，无法确认“这批文字和图片”及“干净”的原词。"}]))
    response = {**answer(), "confirmed_original": [{"s": 1, "text": "这批文字和图片", "basis": "语境通顺"}]}
    result = build_reviewed_transcript(raw, VisualOutput(), lambda *_: response, resume=first.to_checkpoint(), repair_segment_ids=["transcript:0001"])
    assert result.status == "needs_review"  # “干净” was neither corrected nor explicitly confirmed.
    response = {**answer([common(1, "竹子稿", "逐字稿")]), "confirmed_original": [
        {"s": 1, "text": "竹子稿", "basis": "同时原样保留"}]}
    result = build_reviewed_transcript(raw, VisualOutput(), lambda *_: response, resume=first.to_checkpoint(), repair_segment_ids=["transcript:0001"])
    assert result.status == "needs_review"
    assert "original_confirmation_protected_or_not_unchanged" in result.segments[0]["issues"]


@pytest.mark.parametrize(("before", "after"), [("股价", "骨架"), ("占贴", "粘贴"), ("抓起", "抓取"),
                                               ("生存", "生成"), ("收入", "收录")])
def test_common_phonetic_gate_accepts_polyphones_and_controlled_initial_final_confusions(before, after):
    raw = source(f"这里先讨论文案里的{before}然后继续讲解其他具体内容")
    result = build_reviewed_transcript(raw, VisualOutput(), lambda *_: answer([common(1, before, after)]))
    assert result.status == "completed", result.validation


@pytest.mark.parametrize(("before", "after"), [("股价", "输出"), ("使用", "操作"), ("快捷", "迅速")])
def test_common_phonetic_gate_blocks_unrelated_or_semantic_replacements(before, after):
    raw = source(f"这里先讨论文案里的{before}然后继续讲解其他具体内容")
    result = build_reviewed_transcript(raw, VisualOutput(), lambda *_: answer([common(1, before, after)]))
    assert result.status == "needs_review"
    assert "common_phonetic_mismatch" in result.segments[0]["issues"]


def test_invalidated_cached_adoption_remains_rejected_across_restore_and_joins_explicit_targets():
    raw = source("接着分析这篇文案的股价和完整表达结构", "这一个普通原句保留不变")
    seed = build_reviewed_transcript(raw, VisualOutput(), lambda *_: answer())
    cp = seed.to_checkpoint()
    cp["selections"]["transcript:0001"]["patches"] = [common(1, "股价", "输出")]
    cp["segments"][0]["text"] = raw.segments[0].text.replace("股价", "输出")
    first = restore_reviewed_transcript(cp, raw, VisualOutput())
    assert first and first.segments[0]["review_status"] == "needs_review"
    assert first.invalidated_cached_segment_ids == ["transcript:0001"]
    assert first.selections["transcript:0001"]["rejected"][0]["origin"] == "cached_patch_revalidation"
    again = restore_reviewed_transcript(first.to_checkpoint(), raw, VisualOutput())
    assert again and again.segments[0]["review_status"] == "needs_review"
    sent = []
    result = build_reviewed_transcript(raw, VisualOutput(),
        lambda _task, payload, _limit: sent.append(payload) or answer([common(1, "股价", "骨架")]),
        resume=first.to_checkpoint(), repair_segment_ids=["transcript:0002"])
    assert [row["s"] for row in sent[0]["segments"]] == [1]
    assert result.status == "completed", result.validation
