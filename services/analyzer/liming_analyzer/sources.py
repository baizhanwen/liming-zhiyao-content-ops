from __future__ import annotations

from pathlib import Path
from typing import Protocol
from urllib.parse import urlparse

from .api_client import AnalyzerApiClient, ClaimedJob


class PublicVideoResolver(Protocol):
    def download(self, url: str, destination: Path) -> Path: ...


def is_allowed_douyin_url(value: str) -> bool:
    parsed = urlparse(value); host = (parsed.hostname or "").lower()
    return parsed.scheme == "https" and (host == "douyin.com" or host.endswith(".douyin.com") or host == "iesdouyin.com" or host.endswith(".iesdouyin.com"))


class PlatformSourceProvider:
    def __init__(self, client: AnalyzerApiClient, public_video: PublicVideoResolver) -> None:
        self.client = client
        self.public_video = public_video

    def acquire(self, job: ClaimedJob, destination: Path) -> Path:
        if job.source_type == "upload":
            return self.client.download_upload_source(job, destination)
        source_url = job.source.get("source_url")
        if not isinstance(source_url, str) or not is_allowed_douyin_url(source_url):
            raise ValueError("claimed public source is not an allowed Douyin URL")
        return self.public_video.download(source_url, destination)
