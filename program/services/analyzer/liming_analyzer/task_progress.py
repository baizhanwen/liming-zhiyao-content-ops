"""Bounded, safe observations; liveness alone never creates new work progress."""
from collections.abc import Mapping
from threading import Lock

PHASES = frozenset({"loading_models", "queued", "public_page", "resolving_share", "browser", "validating_media", "merging_media", "audio_chunks", "frames", "model_transcription", "transcription_complete", "model_vision", "vision_complete", "model_analysis", "retry_wait", "saving", "complete"})
METRICS = frozenset({"completed", "total", "requests", "downloaded_bytes", "proxy_connections", "proxy_bytes", "media_responses", "complete_bound_media", "transcribed_chunks", "total_chunks", "sampled_frames", "total_frames", "files_read", "files_total", "retry_attempt", "max_attempts", "ocr_completed", "ocr_total", "vision_batches_completed", "vision_batches_total", "candidates_checked", "candidates_total"})


def safe_observation(event):
    if not isinstance(event, Mapping) or not isinstance(event.get("phase"), str) or event["phase"] not in PHASES:
        return None
    raw = event.get("metrics") if isinstance(event.get("metrics"), Mapping) else event
    return {"phase": event["phase"], "metrics": {key: value for key, value in raw.items() if key in METRICS and type(value) is int and 0 <= value <= 2**53 - 1}}


class ProgressObservations:
    """Media threads publish facts; only the worker thread performs lease writes."""
    def __init__(self):
        self._lock = Lock()
        self._value = None

    def update(self, event):
        value = safe_observation(event)
        if value is not None:
            with self._lock:
                self._value = value

    def snapshot(self):
        with self._lock:
            return {"phase": self._value["phase"], "metrics": dict(self._value["metrics"])} if self._value else None


def observe(heartbeat, phase, **metrics):
    callback = getattr(heartbeat, "observe", None)
    if callable(callback):
        try:
            callback({"phase": phase, **metrics})
        except Exception:  # noqa: BLE001 - optional telemetry must not repeat paid work
            pass
