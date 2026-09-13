from __future__ import annotations

import unittest

from liming_analyzer.methodology import (
    ANALYSIS_METHODOLOGY_VERSION,
    analysis_methodology_prompt,
    select_video_analysis_methodology,
)


class VideoAnalysisMethodologyTests(unittest.TestCase):
    def test_knowledge_talk_does_not_force_commerce_rubric(self):
        snapshot = select_video_analysis_methodology([
            {"start_ms": 0, "text": "为什么很多企业买了 AI 工具却没有效果"},
            {"start_ms": 4_000, "text": "问题的本质是流程没有梳理，下面讲三个步骤"},
        ])

        self.assertEqual(snapshot["version"], ANALYSIS_METHODOLOGY_VERSION)
        self.assertEqual(snapshot["primary_type"], "knowledge_talk")
        self.assertIn("analysis.knowledge-explanation", snapshot["selected_method_ids"])
        self.assertNotIn("analysis.conversion-path", snapshot["selected_method_ids"])

    def test_product_tutorial_words_do_not_imply_selling_intent(self):
        snapshot = select_video_analysis_methodology([{
            "start_ms": 0,
            "text": (
                "为什么很多企业买了 AI 产品以后不会使用？今天讲清楚这个工具的功能、"
                "适合人群和三个使用步骤。"
            ),
        }])

        self.assertEqual(snapshot["primary_type"], "knowledge_talk")
        self.assertFalse(snapshot["selling_intent_detected"])
        self.assertNotIn("analysis.conversion-path", snapshot["selected_method_ids"])

    def test_selling_point_selects_visual_and_conversion_checks(self):
        snapshot = select_video_analysis_methodology(
            [
                {"start_ms": 0, "text": "这款产品的第一卖点是材质耐磨，今天现场测评给你看"},
                {"start_ms": 5_000, "text": "使用以后可以直接点击购买，但先看实际对比"},
            ],
            [{"start_ms": 6_000, "text": "画面展示产品刮擦前后", "source": "vision"}],
        )

        self.assertEqual(snapshot["primary_type"], "selling_point")
        self.assertIn("analysis.first-selling-point", snapshot["selected_method_ids"])
        self.assertIn("analysis.conversion-path", snapshot["selected_method_ids"])
        self.assertIn("vision", snapshot["available_evidence_sources"])
        self.assertTrue(snapshot["selling_intent_detected"])

    def test_snapshot_selection_is_deterministic(self):
        transcript = [
            {"start_ms": 0, "text": "为什么这个客户案例能够增长", "source": "asr"},
            {"start_ms": 4_000, "text": "下面讲清楚三个方法", "source": "asr"},
        ]
        visuals = [
            {"start_ms": 1_000, "text": "画面展示流程图", "source": "vision"},
            {"start_ms": 2_000, "text": "字幕写着三个步骤", "source": "ocr"},
        ]

        first = select_video_analysis_methodology(transcript, visuals)
        second = select_video_analysis_methodology(
            list(reversed(transcript)),
            list(reversed(visuals)),
        )

        self.assertEqual(first, second)

    def test_prompt_separates_method_from_fact_and_requires_timed_evidence(self):
        snapshot = select_video_analysis_methodology([
            {"start_ms": 0, "text": "这个客户案例最后做到了增长", "source": "asr"},
        ])
        prompt = analysis_methodology_prompt(snapshot)

        self.assertIn("方法不是视频事实", prompt)
        self.assertIn("可观察的事实", prompt)
        self.assertIn("逐字证据与时间码", prompt)


if __name__ == "__main__":
    unittest.main()
