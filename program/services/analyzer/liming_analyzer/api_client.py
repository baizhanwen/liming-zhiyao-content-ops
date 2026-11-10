from __future__ import annotations

import json
import logging
import time
import urllib.error
import urllib.request
from collections.abc import Callable, Mapping
from dataclasses import dataclass, replace
from pathlib import Path
from typing import TYPE_CHECKING, Any, Protocol

if TYPE_CHECKING:
    from .adapters import SourceMetadata

logger = logging.getLogger(__name__)


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
    analysis_profile: str = "standard"
    checkpoint_stage: str | None = None
    checkpoint: Mapping[str, Any] | None = None
    resume_count: int = 0


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
    source_metadata: SourceMetadata | None = None


def _urllib_transport(method: str, url: str, headers: Mapping[str, str], body: bytes) -> tuple[int, bytes]:
    request = urllib.request.Request(url, data=body, headers=dict(headers), method=method)
    try:
        with urllib.request.urlopen(request, timeout=30) as response:
            return response.status, response.read()
    except urllib.error.HTTPError as error:
        return error.code, error.read()


class AnalyzerApiClient:
    def __init__(self, base_url: str, token: str, worker_id: str, transport: Transport | None = None, *, browser_auth_probe: Callable[[], Mapping[str, Any]] | None = None, browser_auth_interval_seconds: float = 60.0) -> None:
        if not base_url.startswith(("http://", "https://")):
            raise ValueError("base_url must be HTTP or HTTPS")
        if not token.strip() or not worker_id.strip():
            raise ValueError("token and worker_id are required")
        self.base_url = base_url.rstrip("/")
        self.worker_id = worker_id
        self._token = token
        self._transport = transport or _urllib_transport
        self._browser_auth_probe = browser_auth_probe
        self._browser_auth_interval_seconds = max(5.0, browser_auth_interval_seconds)
        self._last_browser_auth: Mapping[str, Any] | None = None
        self._last_browser_auth_at = 0.0

    def _browser_auth(self) -> Mapping[str, Any] | None:
        if self._browser_auth_probe is None:
            return None
        now = time.monotonic()
        if self._last_browser_auth is not None and now - self._last_browser_auth_at < self._browser_auth_interval_seconds:
            return self._last_browser_auth
        try:
            status = dict(self._browser_auth_probe())
        except Exception:
            status = {"status": "unavailable", "message": "暂时无法检测分析主机浏览器登录状态。"}
        previous_status = self._last_browser_auth.get("status") if self._last_browser_auth else None
        if status.get("status") != previous_status:
            safe_status = status.get("status") if status.get("status") in {"logged_in", "not_logged_in", "unavailable", "disabled", "unknown"} else "unknown"
            logger.info("Browser probe state changed: status=%s", safe_status)
        self._last_browser_auth = status
        self._last_browser_auth_at = now
        return status
    def _post(self, path: str, payload: Mapping[str, Any], *, allow_empty: bool = False) -> Mapping[str, Any] | None:
        status, raw = self._transport(
            "POST",
            f"{self.base_url}{path}",
            {"Authorization": f"Bearer {self._token}", "Content-Type": "application/json", "Accept": "application/json"},
            json.dumps(payload, ensure_ascii=False, separators=(",", ":")).encode("utf-8"),
        )
        if status == 204 and allow_empty:
            return None
        try:
            data = json.loads(raw.decode("utf-8")) if raw else {}
        except (UnicodeDecodeError, json.JSONDecodeError) as error:
            raise AnalyzerApiError(status, "INVALID_RESPONSE", "response is not valid JSON") from error
        if not 200 <= status < 300:
            error = data.get("error", {}) if isinstance(data, dict) else {}
            raise AnalyzerApiError(status, str(error.get("code", "API_ERROR")), str(error.get("message", "request failed")))
        if not isinstance(data, dict):
            raise AnalyzerApiError(status, "INVALID_RESPONSE", "response must be an object")
        return data

    def claim(self, lease_seconds: int = 300) -> ClaimedJob | None:
        payload: dict[str, Any] = {"workerId": self.worker_id, "leaseSeconds": lease_seconds}
        browser_auth = self._browser_auth()
        if browser_auth is not None:
            payload["browserAuth"] = browser_auth
        response = self._post("/api/internal/analysis-jobs/claim", payload, allow_empty=True)
        if response is None:
            return None
        job = response.get("job")
        if not isinstance(job, dict) or not isinstance(job.get("source"), dict):
            raise AnalyzerApiError(200, "INVALID_RESPONSE", "claim response is malformed")
        return ClaimedJob(
            id=str(job["id"]), organization_id=str(job["organization_id"]), project_id=str(job["project_id"]),
            video_id=str(job["video_id"]), source_type=str(job["source_type"]), status=str(job["status"]),
            progress=int(job["progress"]), version=int(job["version"]), source=job["source"],
            analysis_profile=str(job.get("analysis_profile") or "standard"),
            checkpoint_stage=str(job["checkpoint_stage"]) if job.get("checkpoint_stage") else None,
            checkpoint=job["checkpoint"] if isinstance(job.get("checkpoint"), dict) else None,
            resume_count=int(job.get("resume_count") or 0),
        )

    def heartbeat(self, job: ClaimedJob, status: str, progress: int, stage: str, lease_seconds: int = 300, observation: Mapping[str, Any] | None = None) -> ClaimedJob:
        payload: dict[str, Any] = {
            "workerId": self.worker_id, "version": job.version, "status": status, "progress": progress,
            "stage": stage, "leaseSeconds": lease_seconds,
        }
        if observation is not None:
            from .task_progress import safe_observation
            safe = safe_observation(observation)
            if safe is not None:
                payload["observation"] = safe
        browser_auth = self._browser_auth()
        if browser_auth is not None:
            payload["browserAuth"] = browser_auth
        response = self._post(f"/api/internal/analysis-jobs/{job.id}/heartbeat", payload)
        assert response is not None
        updated = response["job"]
        return replace(job, status=str(updated["status"]), progress=int(updated["progress"]), version=int(updated["version"]))

    def model_configuration(self, job: ClaimedJob) -> Mapping[str, str]:
        """Retrieve only this leased job's organization model snapshot."""
        response = self._post(f"/api/internal/analysis-jobs/{job.id}/model-settings", {
            "workerId": self.worker_id, "version": job.version,
        })
        configuration = response.get("configuration") if response else None
        allowed = {"llm_provider", "llm_base_url", "llm_model", "llm_api_key",
                   "vision_provider", "vision_base_url", "vision_model", "vision_api_key"}
        if not isinstance(configuration, dict) or any(
            key not in allowed or not isinstance(value, str) for key, value in configuration.items()
        ):
            raise AnalyzerApiError(200, "INVALID_RESPONSE", "model configuration response is malformed")
        if not all(configuration.get(key) for key in ("llm_provider", "llm_base_url", "llm_model", "llm_api_key")):
            raise AnalyzerApiError(409, "ANALYZER_MODEL_REQUIRED", "请在设置页保存完整的分析文本模型配置。")
        return configuration

    def save_checkpoint(self, job: ClaimedJob, stage: str, checkpoint: Mapping[str, Any]) -> Mapping[str, Any]:
        if stage not in {"evidence_ready", "segment_progress"}:
            raise ValueError("unsupported analysis checkpoint stage")
        response = self._post(f"/api/internal/analysis-jobs/{job.id}/checkpoint", {
            "workerId": self.worker_id, "version": job.version, "stage": stage, "checkpoint": checkpoint,
        })
        assert response is not None
        return response

    def complete(self, job: ClaimedJob, result_key: str, result: AnalysisResult) -> Mapping[str, Any]:
        payload: dict[str, Any] = {
            "workerId": self.worker_id, "version": job.version, "resultKey": result_key,
            "analysis": {"schemaVersion": result.schema_version, "report": result.report, "confidence": result.confidence,
                         "modelProvider": result.model_provider, "modelName": result.model_name, "promptVersion": result.prompt_version},
        }
        if result.transcript is not None:
            payload["transcript"] = {"language": result.transcript.language, "fullText": result.transcript.full_text,
                                     "segments": result.transcript.segments, "confidence": result.transcript.confidence}
        if result.source_metadata is not None:
            payload["sourceMetadata"] = {
                "platformWorkId": result.source_metadata.platform_work_id,
                "title": result.source_metadata.title,
                "authorName": result.source_metadata.author_name,
                "publishedAt": result.source_metadata.published_at,
                "durationSec": result.source_metadata.duration_sec,
                "metrics": {
                    "plays": result.source_metadata.plays,
                    "likes": result.source_metadata.likes,
                    "comments": result.source_metadata.comments,
                    "favorites": result.source_metadata.favorites,
                    "shares": result.source_metadata.shares,
                },
            }
        response = self._post(f"/api/internal/analysis-jobs/{job.id}/complete", payload)
        assert response is not None
        return response

    def upload_artifact(
        self,
        job: ClaimedJob,
        *,
        kind: str,
        path: Path,
        content_type: str,
        timestamp_ms: int | None = None,
        ocr_text: str | None = None,
        confidence: int | None = None,
    ) -> Mapping[str, Any]:
        if kind not in {"keyframe", "subtitle", "report"}:
            raise ValueError("unsupported analysis artifact kind")
        body = path.read_bytes()
        headers = {
            "Authorization": f"Bearer {self._token}",
            "Content-Type": content_type,
            "Accept": "application/json",
            "X-Worker-Id": self.worker_id,
            "X-Job-Version": str(job.version),
            "X-Artifact-Kind": kind,
            "X-Artifact-Filename": path.name,
        }
        if timestamp_ms is not None:
            headers["X-Artifact-Timestamp-Ms"] = str(timestamp_ms)
        if confidence is not None:
            headers["X-Artifact-Confidence"] = str(confidence)
        status, raw = self._transport(
            "POST",
            f"{self.base_url}/api/internal/analysis-jobs/{job.id}/artifacts",
            headers,
            body,
        )
        data = json.loads(raw.decode("utf-8")) if raw else {}
        if not 200 <= status < 300:
            error = data.get("error", {}) if isinstance(data, dict) else {}
            raise AnalyzerApiError(status, str(error.get("code", "ARTIFACT_UPLOAD_FAILED")), str(error.get("message", "artifact upload failed")))
        if not isinstance(data, dict) or not isinstance(data.get("asset"), dict):
            raise AnalyzerApiError(status, "INVALID_RESPONSE", "artifact response is malformed")
        return data["asset"]

    def fail(self, job: ClaimedJob, result_key: str, error_code: str, error_message: str, stage: str, progress: int) -> Mapping[str, Any]:
        response = self._post(f"/api/internal/analysis-jobs/{job.id}/fail", {
            "workerId": self.worker_id, "version": job.version, "resultKey": result_key, "errorCode": error_code,
            "errorMessage": error_message, "stage": stage, "progress": progress,
        })
        assert response is not None
        return response

    def download_upload_source(self, job: ClaimedJob, destination: Path, max_bytes: int = 2_000_000_000) -> Path:
        if job.source_type != "upload":
            raise ValueError("only uploaded jobs use the private source endpoint")
        request = urllib.request.Request(
            f"{self.base_url}/api/internal/analysis-jobs/{job.id}/source",
            headers={"Authorization": f"Bearer {self._token}", "X-Worker-Id": self.worker_id, "Accept": "application/octet-stream"},
            method="GET",
        )
        destination.parent.mkdir(parents=True, exist_ok=True); partial = destination.with_name(f"{destination.name}.part"); written = 0
        try:
            with urllib.request.urlopen(request, timeout=120) as response, partial.open("wb") as output:
                content_length = response.headers.get("Content-Length")
                if content_length and int(content_length) > max_bytes:
                    raise AnalyzerApiError(413, "SOURCE_TOO_LARGE", "source exceeds worker limit")
                while chunk := response.read(1024 * 1024):
                    written += len(chunk)
                    if written > max_bytes:
                        raise AnalyzerApiError(413, "SOURCE_TOO_LARGE", "source exceeds worker limit")
                    output.write(chunk)
        except urllib.error.HTTPError as error:
            partial.unlink(missing_ok=True)
            payload = json.loads(error.read().decode("utf-8")) if error.fp else {}
            detail = payload.get("error", {}) if isinstance(payload, dict) else {}
            raise AnalyzerApiError(error.code, str(detail.get("code", "SOURCE_DOWNLOAD_FAILED")), str(detail.get("message", "source download failed"))) from error
        except Exception:
            partial.unlink(missing_ok=True)
            raise
        if written == 0:
            partial.unlink(missing_ok=True)
            raise AnalyzerApiError(502, "EMPTY_SOURCE", "source media is empty")
        partial.replace(destination)
        return destination

    def download_cookie_snapshot(self, job: ClaimedJob, destination: Path, max_bytes: int = 1024 * 1024) -> bool:
        if job.source_type != "url":
            raise ValueError("only public URL jobs use the cookie snapshot endpoint")
        request = urllib.request.Request(
            f"{self.base_url}/api/internal/analysis-jobs/{job.id}/cookies",
            headers={"Authorization": f"Bearer {self._token}", "X-Worker-Id": self.worker_id, "Accept": "text/plain"},
            method="GET",
        )
        destination = destination.expanduser().resolve(); destination.parent.mkdir(parents=True, exist_ok=True)
        partial = destination.with_name(f"{destination.name}.part"); written = 0
        try:
            with urllib.request.urlopen(request, timeout=30) as response, partial.open("wb") as output:
                content_length = response.headers.get("Content-Length")
                if content_length and int(content_length) > max_bytes:
                    raise AnalyzerApiError(413, "COOKIE_SNAPSHOT_TOO_LARGE", "cookie snapshot exceeds worker limit")
                while chunk := response.read(64 * 1024):
                    written += len(chunk)
                    if written > max_bytes:
                        raise AnalyzerApiError(413, "COOKIE_SNAPSHOT_TOO_LARGE", "cookie snapshot exceeds worker limit")
                    output.write(chunk)
        except urllib.error.HTTPError as error:
            partial.unlink(missing_ok=True)
            if error.code == 404:
                destination.unlink(missing_ok=True)
                return False
            payload = json.loads(error.read().decode("utf-8")) if error.fp else {}
            detail = payload.get("error", {}) if isinstance(payload, dict) else {}
            raise AnalyzerApiError(error.code, str(detail.get("code", "COOKIE_DOWNLOAD_FAILED")), str(detail.get("message", "cookie snapshot download failed"))) from error
        except Exception:
            partial.unlink(missing_ok=True)
            raise
        if written == 0:
            partial.unlink(missing_ok=True)
            raise AnalyzerApiError(502, "EMPTY_COOKIE_SNAPSHOT", "cookie snapshot is empty")
        partial.replace(destination)
        return True


Processor = Callable[[ClaimedJob, Callable[[str, int, str], ClaimedJob]], AnalysisResult]
