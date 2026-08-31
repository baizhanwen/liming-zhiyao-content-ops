from __future__ import annotations

from collections.abc import Mapping, Sequence
from typing import Any


ANALYSIS_METHODOLOGY_VERSION = "video-methodology.v1-curated-2026-08-28"


_TYPE_TERMS: dict[str, tuple[str, ...]] = {
    "selling_point": (
        "产品", "功能", "成分", "材质", "参数", "使用", "价格", "优惠", "购买", "下单",
        "适合", "好用", "卖点", "测评", "开箱",
    ),
    "pain_point": (
        "痛点", "问题", "难题", "困扰", "踩坑", "避坑", "别再", "不要", "错误", "失败",
        "解决", "怎么办",
    ),
    "result": (
        "结果", "效果", "提升", "增长", "降低", "改善", "前后", "对比", "案例", "客户",
        "变成", "做到",
    ),
    "persona": (
        "我的一天", "今天带你", "跟我", "工作日常", "创业", "经历", "故事", "vlog", "幕后",
        "现场", "真实记录",
    ),
    "knowledge_talk": (
        "为什么", "是什么", "怎么", "如何", "方法", "步骤", "逻辑", "概念", "知识", "首先",
        "其次", "原因", "本质", "记住",
    ),
}


# Product words also appear in neutral tutorials.  Do not route a knowledge
# explanation into the commerce rubric unless the transcript contains a real
# transaction cue or a recognisable product-pitch/demo pattern.
_DIRECT_COMMERCE_TERMS: tuple[str, ...] = (
    "价格", "优惠", "购买", "下单", "点击购买", "立即购买", "领券", "折扣",
    "到手价", "直播间", "购物车", "加购", "包邮", "赠品",
)
_PRODUCT_PITCH_TERMS: tuple[str, ...] = (
    "这款", "卖点", "测评", "开箱", "实测", "材质", "参数", "成分", "对比",
    "好用", "推荐",
)


_UNIVERSAL_MODULES: tuple[dict[str, Any], ...] = (
    {
        "id": "analysis.evidence-boundary",
        "name": "事实与证据边界",
        "scope": "universal",
        "rules": (
            "观察只能来自输入中的转写、OCR 或 vision；方法只用于解释观察，不能充当视频事实。",
            "数字、身份、效果、案例、价格、资质和承诺必须引用同一条可定位证据；缺证据时标记为无法确认。",
        ),
        "required_evidence": ("asr", "ocr", "vision", "timecode"),
    },
    {
        "id": "analysis.single-core",
        "name": "单一核心机制",
        "scope": "universal",
        "rules": (
            "先识别一个核心主张，再判断其他内容是在解释、证明、举例还是给方案。",
            "多个主张并列且互不服务时，指出核心被稀释，不强行归纳成完整体系。",
        ),
        "required_evidence": ("asr", "timecode"),
    },
    {
        "id": "analysis.hook-fulfilment",
        "name": "开头钩子与正文兑现",
        "scope": "universal",
        "rules": (
            "检查前 5 秒是否独立交代话题、继续观看的理由和真实可信依据。",
            "检查 5 至 10 秒是否自然进入核心内容，以及正文是否兑现开头承诺。",
        ),
        "required_evidence": ("asr", "ocr", "timecode"),
    },
    {
        "id": "analysis.script-flow",
        "name": "逻辑与口播流动",
        "scope": "universal",
        "rules": (
            "逐段检查逻辑断裂、信息密度下降、重复表达、长句、书面语和未解释术语。",
            "区分内容本身的问题与 ASR 识别问题，不把转写错误当作作者表达缺陷。",
        ),
        "required_evidence": ("asr", "timecode"),
    },
)


_TYPE_MODULES: dict[str, tuple[dict[str, Any], ...]] = {
    "knowledge_talk": (
        {
            "id": "analysis.knowledge-explanation",
            "name": "知识口播解释链",
            "scope": "knowledge_talk",
            "rules": (
                "检查问题、概念、观点、案例和方案是否形成可理解的解释链。",
                "判断术语是否紧跟大白话解释，案例是否真正证明核心观点。",
            ),
            "required_evidence": ("asr", "timecode"),
        },
    ),
    "selling_point": (
        {
            "id": "analysis.first-selling-point",
            "name": "第一卖点与视觉证明",
            "scope": "selling_point",
            "rules": (
                "判断是否只突出一个第一卖点，其他卖点是否作为证明或补充。",
                "检查口播卖点是否被真实画面、操作、对比、参数或可见结果支持。",
            ),
            "required_evidence": ("asr", "vision", "timecode"),
        },
        {
            "id": "analysis.conversion-path",
            "name": "转化路径",
            "scope": "selling_point",
            "rules": (
                "检查行动引导是否与受众当前认知和视频承诺一致。",
                "不得把出现购买引导解释为一定能够成交。",
            ),
            "required_evidence": ("asr", "ocr", "timecode"),
        },
    ),
    "pain_point": (
        {
            "id": "analysis.pain-solution",
            "name": "痛点到方案",
            "scope": "pain_point",
            "rules": (
                "检查痛点是否具体到人群与场景，是否存在制造焦虑或扩大问题。",
                "检查方案是否回应前置痛点，并说明适用条件而非绝对有效。",
            ),
            "required_evidence": ("asr", "vision", "timecode"),
        },
    ),
    "result": (
        {
            "id": "analysis.result-proof",
            "name": "结果与证明",
            "scope": "result",
            "rules": (
                "区分视频声称的结果、画面可见的结果和分析者推断的结果。",
                "没有前后基线、数据口径或可见证明时，不得把相关性写成因果。",
            ),
            "required_evidence": ("asr", "ocr", "vision", "timecode"),
        },
    ),
    "persona": (
        {
            "id": "analysis.persona-story",
            "name": "人设与故事真实性",
            "scope": "persona",
            "rules": (
                "检查人物身份、场景、事件和观点是否互相支持，而不是只靠自我标签。",
                "判断故事转折是否服务核心观点，不根据单条视频推断长期人设。",
            ),
            "required_evidence": ("asr", "vision", "timecode"),
        },
    ),
}


def _rows_text(rows: Sequence[Mapping[str, Any]], maximum: int = 24_000) -> str:
    parts: list[str] = []
    used = 0
    for row in rows:
        value = str(row.get("text") or "").strip().lower()
        if not value:
            continue
        remaining = maximum - used
        if remaining <= 0:
            break
        parts.append(value[:remaining])
        used += min(len(value), remaining)
    return "\n".join(parts)


def _type_scores(text: str) -> dict[str, int]:
    scores: dict[str, int] = {}
    for content_type, terms in _TYPE_TERMS.items():
        scores[content_type] = sum(min(3, text.count(term)) for term in terms)
    return scores


def _has_explicit_selling_intent(text: str) -> bool:
    if any(term in text for term in _DIRECT_COMMERCE_TERMS):
        return True
    pitch_signals = sum(1 for term in _PRODUCT_PITCH_TERMS if term in text)
    return pitch_signals >= 2


def select_video_analysis_methodology(
    transcript_rows: Sequence[Mapping[str, Any]],
    visual_rows: Sequence[Mapping[str, Any]] = (),
) -> dict[str, Any]:
    """Select a small auditable rubric. It never creates facts about the video."""
    text = _rows_text(transcript_rows)
    scores = _type_scores(text)
    routing_scores = dict(scores)
    selling_intent = _has_explicit_selling_intent(text)
    if not selling_intent:
        # Generic words such as 产品、功能、使用、适合 are common in knowledge
        # videos and must not by themselves activate an ecommerce diagnosis.
        routing_scores["selling_point"] = min(
            routing_scores.get("selling_point", 0),
            1,
        )
    ranked = sorted(routing_scores.items(), key=lambda item: (-item[1], item[0]))
    primary_type, primary_score = ranked[0] if ranked else ("knowledge_talk", 0)
    if primary_score < 2:
        primary_type = "knowledge_talk"
    secondary_types = [
        content_type
        for content_type, score in ranked
        if content_type != primary_type and score >= max(3, primary_score - 2)
    ][:1]

    selected = [*map(dict, _UNIVERSAL_MODULES)]
    selected.extend(map(dict, _TYPE_MODULES.get(primary_type, ())))
    for secondary in secondary_types:
        for module in _TYPE_MODULES.get(secondary, ()):
            if module["id"] not in {item["id"] for item in selected}:
                selected.append(dict(module))

    evidence_sources = sorted({
        str(row.get("source") or "asr")
        for row in [*transcript_rows, *visual_rows]
        if str(row.get("text") or "").strip()
    })
    return {
        "version": ANALYSIS_METHODOLOGY_VERSION,
        "primary_type": primary_type,
        "secondary_types": secondary_types,
        "type_scores": scores,
        "selling_intent_detected": selling_intent,
        "selected_method_ids": [item["id"] for item in selected],
        "available_evidence_sources": evidence_sources,
        "modules": selected,
    }


def analysis_methodology_prompt(snapshot: Mapping[str, Any]) -> str:
    lines = [
        "\n本次动态分析方法（方法不是视频事实）：",
        f"- 视频类型路由：{snapshot.get('primary_type') or 'knowledge_talk'}。只在证据支持时使用该类型量表。",
    ]
    modules = snapshot.get("modules")
    if isinstance(modules, Sequence) and not isinstance(modules, (str, bytes)):
        for module in modules:
            if not isinstance(module, Mapping):
                continue
            rules = module.get("rules")
            if isinstance(rules, Sequence) and not isinstance(rules, (str, bytes)):
                rule_text = "；".join(
                    str(rule) for rule in rules if str(rule).strip()
                )
            else:
                rule_text = ""
            lines.append(
                f"- [{module.get('id')}] {module.get('name')}：{rule_text}"
            )
    lines.append(
        "必须把输出区分为：视频中可观察的事实、基于方法的解释、可复用但有条件的建议。"
        "方法库和参考案例不得作为事实证据；每条内容判断继续绑定输入中的逐字证据与时间码。"
    )
    return "\n".join(lines)
