from liming_analyzer.gpu_diagnostics import gpu_failure_details


def test_cuda_error_keeps_library_evidence_without_credentials_or_username():
    error = RuntimeError(r"Unable to load cudnn_ops64_9.dll C:\Users\Alice\secret.dll https://example.com/?token=abc api_key=secretvalue Bearer abcdef sk-foo")
    detail = gpu_failure_details(error)
    assert detail["code"] == "CUDA_LIBRARY_UNAVAILABLE"
    assert "cudnn_ops64_9.dll" in detail["detail"]
    assert all(value not in detail["detail"] for value in ("Alice", "example.com", "secretvalue", "abcdef", "sk-foo"))
    assert len(gpu_failure_details(RuntimeError("x" * 10000))["detail"]) <= 600
