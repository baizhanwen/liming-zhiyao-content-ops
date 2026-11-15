"""Bounded, credential-free diagnostics for the independent CT2 CUDA backend."""
from __future__ import annotations

import re


def gpu_failure_details(error: Exception) -> dict:
    message = str(error)
    lowered = message.lower()
    if any(word in lowered for word in ("out of memory", "cuda_error_out_of_memory", "failed to allocate")):
        code = "CUDA_OUT_OF_MEMORY"
    elif any(word in lowered for word in ("cudnn", "cublas", "nvrtc", "nvcuda", "cudart")) and any(
        word in lowered for word in ("not found", "cannot", "could not", "unable", "failed to load", "not available", "unavailable")
    ):
        code = "CUDA_LIBRARY_UNAVAILABLE"
    elif any(word in lowered for word in ("version mismatch", "insufficient driver", "unsupported ptx", "driver version")):
        code = "CUDA_RUNTIME_INCOMPATIBLE"
    elif "float16 compute type" in lowered:
        code = "CUDA_COMPUTE_UNSUPPORTED"
    else:
        code = "CUDA_EXECUTION_FAILED"
    # Native errors may contain URLs, credentials or local usernames. Keep the
    # DLL/error evidence, without copying those unrelated values into logs.
    message = re.sub(r"https?://\S+", "[url]", message, flags=re.IGNORECASE)
    message = re.sub(r"\b(?:Bearer\s+\S+|sk-[A-Za-z0-9_-]+)", "[credential]", message, flags=re.IGNORECASE)
    message = re.sub(r"(?i)(?:api[_-]?key|token|password|secret)\s*[:=]\s*[^\s,;]+", "[credential]", message)
    message = re.sub(r"(?i)[A-Z]:[\\/]Users[\\/][^\\/\s]+", r"C:/Users/[user]", message)
    message = re.sub(r"/(?:Users|home)/[^/\s]+", "/Users/[user]", message)
    return {"code": code, "error_type": type(error).__name__, "detail": " ".join(message.split())[:600]}
