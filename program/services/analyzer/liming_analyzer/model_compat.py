"""Explicit request compatibility for the configured MiniMax multimodal model."""
from typing import Any


def single_attempt_retry() -> Any:
    """One SDK attempt; outer orchestration owns every paid retry and budget.

    Instructor versions disagree on integer max_retries semantics. An explicit
    one-attempt controller is stable across both and keeps the original parse/
    completion exception as the cause for usage and safe-candidate diagnostics.
    Return a fresh controller because content modules may run concurrently.
    """
    from tenacity import Retrying, stop_after_attempt

    return Retrying(stop=stop_after_attempt(1), reraise=True)


def is_minimax_flash(provider: str, model: str) -> bool:
    return provider.strip().lower() == "minimax" and model.strip().lower() == "minimax-m3.1-flash"


def completion_options(provider: str, model: str, output_tokens: int) -> dict[str, Any]:
    """Keep the host's existing per-call budget, including reasoning tokens."""
    if is_minimax_flash(provider, model):
        return {
            "max_completion_tokens": output_tokens,
            "extra_body": {"reasoning_effort": "low"},
        }
    return {"max_tokens": output_tokens}
