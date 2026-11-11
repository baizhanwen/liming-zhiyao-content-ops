"""Durable accounting around bounded model operations, without prompt logging."""
from __future__ import annotations

import logging
import uuid
from collections.abc import Mapping

logger = logging.getLogger(__name__)


def usage_counts(value):
    if value is None:
        return {}
    def read(name):
        result = value.get(name) if isinstance(value, Mapping) else getattr(value, name, None)
        return result if isinstance(result, int) and not isinstance(result, bool) and result >= 0 else None
    if isinstance(value, (int, float)) and not isinstance(value, bool) and value >= 0:
        return {"totalTokens": int(value)}
    return {"inputTokens": read("prompt_tokens"), "outputTokens": read("completion_tokens"), "totalTokens": read("total_tokens")}


def exception_usage(error):
    """Read known SDK usage, including length errors, without inspecting prompts."""
    pending, seen = [error], set()
    while pending and len(seen) < 8:
        current = pending.pop(0)
        if current is None or id(current) in seen:
            continue
        seen.add(id(current))
        candidates = [getattr(current, "total_usage", None)]
        for name in ("last_completion", "completion"):
            completion = getattr(current, name, None)
            candidates.append(completion.get("usage") if isinstance(completion, Mapping) else getattr(completion, "usage", None))
        for candidate in candidates:
            if any(value is not None for value in usage_counts(candidate).values()):
                return candidate
        pending.extend((getattr(current, "__cause__", None), getattr(current, "__context__", None)))
    return None


class ModelCalls:
    def __init__(self, job, recorder=None):
        self.job = job
        self.recorder = recorder
        self.summary = None

    def invoke(self, task, output_budget, operation):
        if output_budget is None:
            if task != "vision_batch":
                raise ValueError("only an opaque vision provider may have an unknown output budget")
            # Durable legacy column is non-nullable. Zero is an internal unknown
            # sentinel, never a promised provider cap or a displayed budget.
            output_budget = 0
        record = {"id": f"call:{uuid.uuid4().hex}", "task": task, "outputBudget": output_budget}
        if self.recorder:
            # Fail before spending money if ownership/accounting cannot be
            # confirmed. A crash after this point leaves an explicit unknown.
            self.summary = self.recorder(self.job, {**record, "status": "started"})
        try:
            response, raw = operation()
        except Exception as error:
            self.finish(record, "failed", exception_usage(error))
            raise
        self.finish(record, "completed", getattr(raw, "usage", None))
        return response, raw

    def finish(self, record, status, usage):
        if self.recorder:
            try:
                self.summary = self.recorder(self.job, {**record, "status": status, **usage_counts(usage)})
            except Exception:  # noqa: BLE001 - retain the durable start if the ledger is unavailable
                # The durable start is retained. Never turn missing usage into
                # zero cost or send another paid request just to obtain an ACK.
                logger.warning("Model call final acknowledgement unavailable: job=%s call=%s", self.job.id, record["id"])
