import unittest

from liming_analyzer.metrics import (
    engagement_rates,
    group_performance,
    high_performance_summary,
    high_performance_threshold,
    percentile,
)


class MetricTests(unittest.TestCase):
    def test_percentile_uses_linear_interpolation(self):
        self.assertEqual(percentile([0, 10, 20, 30, 40], 0.80), 32)

    def test_high_performance_threshold_matches_frozen_rule(self):
        values = [10, 20, 30, 40, 50, 60, 70, 80, 90, 100]
        summary = high_performance_summary(values)
        self.assertEqual(summary["method"], "max(P80, median+2*MAD, 100)")
        self.assertEqual(summary["threshold"], high_performance_threshold(values))
        self.assertGreaterEqual(summary["threshold"], 100)

    def test_invalid_counts_are_ignored(self):
        summary = high_performance_summary([None, -1, float("nan"), 120])
        self.assertEqual(summary["sample_count"], 1)
        self.assertEqual(summary["threshold"], 120)

    def test_zero_plays_produces_unavailable_rates(self):
        rates = engagement_rates(plays=0, likes=10, comments=2, favorites=3, shares=1)
        self.assertTrue(all(value is None for value in rates.values()))

    def test_group_needs_three_samples_before_reporting_median(self):
        self.assertFalse(group_performance([10, 20])["enough"])
        result = group_performance([10, 20, 30])
        self.assertTrue(result["enough"])
        self.assertEqual(result["median"], 20)


if __name__ == "__main__":
    unittest.main()
