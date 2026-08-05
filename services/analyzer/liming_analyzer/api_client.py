from __future__ import annotations

import json
import urllib.error
import urllib.request
from dataclasses import dataclass, replace
from typing import Any, Callable, Mapping, Protocol


class AnalyzerApiError(RuntimeError):
    def __init__(self, status: int, code: str, message: str) -> None:
        super().__init__(f"{code}: {message}")
        self.status = status
        self.code = code


class Transport(Protocol):
    def __call__(self, method: str, url: str, headers: Mapping[str, str], body: bytes) -> tuple[int, bytes]: ...


@dataclass(frozen=True)
class ClaimedJob:
    id: str
    organization_id: str
    project_id: str
    video_id: str
    source_type: str
    status: str
    progress: int
    version: int
    source: Mapping[str, Any]


@dataclass(frozen=True)
class TranscriptResult:
    language: str
    full_text: str
    segments: list[Mapping[str, Any]]
    confidence: int | None = None


@dataclass(frozen=True)
class AnalysisResult:
    schema_version: str
    report: Mapping[str, Any]
    confidence: int | None = None
    transcript: TranscriptResult | None = None
    model_provider: str | None = None
    model_name: str | None = None
    prompt_version: str | None = None


def _urllib_transport(method: str, url: str, headers: Mapping[str, str], body: bytes) -> tuple[int, bytes]:
    request = urllib.request.Request(url, data=body, headers=dict(headers), method=method)
    try:
        with urllib.request.urlopen(request, timeout=30) as response:
            return response.status, response.read()
    except urllib.error.HTTPError as error:
        return error.code, error.read()


class AnalyzerApiClient:
    def __init__(self, base_url: str, token: str, worker_id: str, transport: Transport | None = None) -> None:
        if not base_url.startswith(("http://", "https://")):
            raise ValueError("base_url must be HTTP or HTTPS")
        if not token.strip() or not worker_id.strip():
            raise ValueError("token and worker_id are required")
        self.base_url = base_url.rstrip("/")
        self.worker_id = worker_id
        self._token = token
        self._transport = transport or _urllib_transport

    def _post(self, path: str, payload: Mapping[str, Any], *, allow_empty: bool = False) -> Mapping[str, Any] | None:
        status, raw = self._transport(
            "POST",
            f"{self.base_url}{path}",
            {"Authorization": f"Bearer {self._token}", "Content-Type": "application/json", "Accept": "application/json"},
            json.dumps(payload, ensure_ascii=False, separators=(",", ":")).encode("utf-8"),
        )
        if status == 204 and allow_empty:
            return None
        data = json.loads(raw.decode("utf-8")) if raw else {}
        if not 200 <= status < 300:
            error = data.get("error", {}) if isinstance(data, dict) else {}
            raise AnalyzerApiError(status, str(error.get("code", "API_ERROR")), str(error.get("message", "request failed")))
        if not isinstance(data, dict):
            raise AnalyzerApiError(status, "INVALID_RESPONSE", "response must be an object")
        return data

    def claim(self, lease_seconds: int = 120) -> ClaimedJob | None:
        response = self._post("/api/internal/analysis-jobs/claim", {"workerId": self.worker_id, "leaseSeconds": lease_seconds}, allow_empty=True)
        if response is None:
            return None
        job = response.get("job")
        if not isinstance(job, dict) or not isinstance(job.get("source"), dict):
            raise AnalyzerApiError(200, "INVALID_RESPONSE", "claim response is malformed")
        return ClaimedJob(
            id=str(job["id"]), organization_id=str(job["organization_id"]), project_id=str(job["project_id"]),
            video_id=str(job["video_id"]), source_type=str(job["source_type"]), status=str(job["status"]),
            progress=int(job["progress"]), version=int(job["version"]), source=job["source"],
        )

    def heartbeat(self, job: ClaimedJob, status: str, progress: int, stage: str, lease_seconds: int = 120) -> ClaimedJob:
        response = self._post(f"/api/internal/analysis-jobs/{job.id}/heartbeat", {
            "workerId": self.worker_id, "version": job.version, "status": status, "progress": progress,
            "stage": stage, "leaseSeconds": lease_seconds,
        })
        assert response is not None
        updated = response["job"]
        return replace(job, status=str(updated["status"]), progress=int(updated["progress"]), version=int(updated["version"]))

    def complete(self, job: ClaimedJob, result_key: str, result: AnalysisResult) -> Mapping[str, Any]:
        payload: dict[str, Any] = {
            "workerId": self.worker_id, "version": job.version, "resultKey": result_key,
            "analysis": {"schemaVersion": result.schema_version, "report": result.report, "confidence": result.confidence,
                         "modelProvider": result.model_provider, "modelName": result.model_name, "promptVersion": result.prompt_version},
        }
        if result.transcript is not None:
            payload["transcript"] = {"language": result.transcript.language, "fullText": result.transcript.full_text,
                                     "segments": result.transcript.segments, "confidence": result.transcript.confidence}
        response = self._post(f"/api/internal/analysis-jobs/{job.id}/complete", payload)
        assert response is not None
        return response

    def fail(self, job: ClaimedJob, result_key: str, error_code: str, error_message: str, stage: str, progress: int) -> Mapping[str, Any]:
        response = self._post(f"/api/internal/analysis-jobs/{job.id}/fail", {
            "workerId": self.worker_id, "version": job.version, "resultKey": result_key, "errorCode": error_code,
            "errorMessage": error_message, "stage": stage, "progress": progress,
        })
        assert response is not None
        return response


Processor = Callable[[ClaimedJob, Callable[[str, int, str], ClaimedJob]], AnalysisResult]
