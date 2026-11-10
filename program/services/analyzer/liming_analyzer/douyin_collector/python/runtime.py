"""Task-local media executable paths supplied by the host analyzer."""
from contextlib import contextmanager
from contextvars import ContextVar

_TOOLS = ContextVar("collector_media_tools", default=None)


def media_executable(name):
    return (_TOOLS.get() or {}).get(name, name)


@contextmanager
def media_tools(ffmpeg="ffmpeg", ffprobe="ffprobe"):
    token = _TOOLS.set({"ffmpeg": str(ffmpeg), "ffprobe": str(ffprobe)})
    try:
        yield
    finally:
        _TOOLS.reset(token)
