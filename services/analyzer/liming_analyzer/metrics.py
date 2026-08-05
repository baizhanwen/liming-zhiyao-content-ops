from __future__ import annotations

import math
from collections.abc import Iterable
from dataclasses import asdict, dataclass
from statistics import median


def _clean_numbers(values: Iterable[int | float | None]) -> list[float]:
    cleaned: list[float] = []
    for value in values:
        if value is None or isinstance(value, bool):
            continue
        number = float(value)
        if math.isfinite(number) and number >= 0:
            cleaned.append(number)
    return sorted(cleaned)


def percentile(values: Iterable[int | float | None], quantile: float) -> float:
    if not 0 <= quantile <= 1:
        raise ValueError("quantile must be between 0 and 1")
    ordered = _clean_numbers(values)
    if not ordered:
        return 0.0
    position = (len(ordered) - 1) * quantile
    lower = math.floor(position)
    upper = math.ceil(position)
    if lower == upper:
        return ordered[lower]
    return ordered[lower] + (ordered[upper] - ordered[lower]) * (position - lower)


def median_absolute_deviation(values: Iterable[int | float | None]) -> float:
    ordered = _clean_numbers(values)
    if not ordered:
        return 0.0
    center = float(median(ordered))
    return float(median(abs(value - center) for value in ordered))


def high_performance_threshold(values: Iterable[int | float | None]) -> float:
    ordered = _clean_numbers(values)
    if not ordered:
        return 100.0
    center = float(median(ordered))
    mad = median_absolute_deviation(ordered)
    return round(max(percentile(ordered, 0.80), center + 2 * mad, 100.0), 1)


def high_performance_summary(values: Iterable[int | float | None]) -> dict[str, object]:
    ordered = _clean_numbers(values)
    threshold = high_performance_threshold(ordered)
    return {
        "sample_count": len(ordered),
        "median": round(float(median(ordered)), 1) if ordered else 0.0,
        "mad": round(median_absolute_deviation(ordered), 1),
        "p80": round(percentile(ordered, 0.80), 1),
        "threshold": threshold,
        "method": "max(P80, median+2*MAD, 100)",
        "high_performance_count": sum(1 for value in ordered if value >= threshold),
    }


def safe_ratio(numerator: int | float | None, denominator: int | float | None) -> float | None:
    if numerator is None or denominator is None:
        return None
    numerator_value = float(numerator)
    denominator_value = float(denominator)
    if not math.isfinite(numerator_value) or not math.isfinite(denominator_value) or denominator_value <= 0:
        return None
    return numerator_value / denominator_value


@dataclass(frozen=True)
class EngagementRates:
    like_rate: float | None
    comment_rate: float | None
    favorite_rate: float | None
    share_rate: float | None


def engagement_rates(*, plays: int | None, likes: int | None, comments: int | None, favorites: int | None, shares: int | None) -> dict[str, float | None]:
    rates = EngagementRates(
        like_rate=safe_ratio(likes, plays),
        comment_rate=safe_ratio(comments, plays),
        favorite_rate=safe_ratio(favorites, plays),
        share_rate=safe_ratio(shares, plays),
    )
    return {key: round(value, 6) if value is not None else None for key, value in asdict(rates).items()}


def group_performance(values: Iterable[int | float | None], *, minimum_samples: int = 3) -> dict[str, object]:
    ordered = _clean_numbers(values)
    enough = len(ordered) >= minimum_samples
    return {
        "sample_count": len(ordered),
        "minimum_samples": minimum_samples,
        "enough": enough,
        "median": round(float(median(ordered)), 1) if enough else None,
    }
