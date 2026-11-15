"""A task may finish while its owner must retire an uncertain processing child."""
from __future__ import annotations

import re
from threading import Lock

_lock = Lock()
_reasons: set[str] = set()


def request_processor_retirement(reason: str) -> None:
    # Only fixed diagnostic codes cross the process boundary, never source data.
    safe = reason if isinstance(reason, str) and re.fullmatch(r"[a-z][a-z0-9_]{0,63}", reason) else "resource_cleanup_unconfirmed"
    with _lock:
        if len(_reasons) < 16:
            _reasons.add(safe)


def processor_retirement_reasons() -> tuple[str, ...]:
    with _lock:
        return tuple(sorted(_reasons))


def reset_processor_health() -> None:
    with _lock:
        _reasons.clear()
