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
    if isinstance(value, (int, float)) and value >= 0:
        return {"totalTokens": int(value)}
    return {"inputTokens": read("prompt_tokens"), "outputTokens": read("completion_tokens"), "totalTokens": read("total_tokens")}


class ModelCalls:
    def __init__(self, job, recorder=None):
        self.job = job
        self.recorder = recorder
        self.summary = None

    def invoke(self, task, output_budget, operation):
        record = {"id": f"call:{uuid.uuid4().hex}", "task": task, "outputBudget": output_budget}
        if self.recorder:
            # Fail before spending money if ownership/accounting cannot be
            # confirmed. A crash after this point leaves an explicit unknown.
            self.summary = self.recorder(self.job, {**record, "status": "started"})
        try:
            response, raw = operation()
        except Exception as error:
            usage = getattr(error, "total_usage", None)
            if usage is None:
                usage = getattr(getattr(error, "last_completion", None), "usage", None)
            self.finish(record, "failed", usage)
            raise
        self.finish(record, "completed", getattr(raw, "usage", None))
        return response, raw

    def finish(self, record, status, usage):
        if self.recorder:
            try:
                self.summary = self.recorder(self.job, {**record, "status": status, **usage_counts(usage)})
            except Exception:
                # The durable start is retained. Never turn missing usage into
                # zero cost or send another paid request just to obtain an ACK.
                logger.warning("Model call final acknowledgement unavailable: job=%s call=%s", self.job.id, record["id"])
