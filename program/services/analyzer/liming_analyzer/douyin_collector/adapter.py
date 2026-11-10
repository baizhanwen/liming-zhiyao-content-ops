"""The only public collector entry point. Paths are server-owned task folders."""
from __future__ import annotations

import hashlib
import os
import re
import shutil
from pathlib import Path
from uuid import uuid4

from .python import media
from .python.security import AppError
from .python.runtime import media_tools

CollectorError = AppError
MAX_MEDIA_BYTES = media.MAX_UPLOAD
MAX_DURATION_SECONDS = media.MAX_DURATION


def _cancel_check(cancelled):
    if cancelled is None:
        return lambda: False
    if callable(cancelled):
        return cancelled
    if hasattr(cancelled, 'is_set'):
        return cancelled.is_set
    raise TypeError('cancelled must be callable or threading.Event')


def collect(share_text, output_dir, progress=None, cancelled=None, *, browser_timeout=180,
            ffmpeg="ffmpeg", ffprobe="ffprobe"):
    with media_tools(ffmpeg, ffprobe):
        return _collect(share_text, output_dir, progress, cancelled, browser_timeout=browser_timeout)


def _collect(share_text, output_dir, progress=None, cancelled=None, *, browser_timeout=180):
    """Acquire a single original; failures never leave a successful final asset.

    Returns only canonical identity and bounded metadata. Signed CDN URLs,
    visitor cookies and browser diagnostics never cross this interface.
    The caller owns authorization of output_dir; it must never come from HTTP.
    """
    if not isinstance(share_text, str) or len(share_text) > 20000:
        raise CollectorError('invalid_input', '分享内容须为不超过 20000 字符的文字')
    urls = list(dict.fromkeys(m.rstrip(').!）]') for m in re.findall(r'https?://[^\s<>"，。；、]+', share_text)))
    if len(urls) != 1:
        raise CollectorError('single_reference_required', '请一次粘贴一条抖音视频分享链接')
    stopped = _cancel_check(cancelled)
    if stopped():
        raise CollectorError('cancelled', '任务已取消')
    root = Path(output_dir).absolute()
    # Check every existing component, not only the final file.
    if any(p.is_symlink() for p in (root, *root.parents)):
        raise CollectorError('unsafe_storage', '任务目录不能使用符号链接')
    root.mkdir(parents=True, exist_ok=True, mode=0o700)
    work = root / ('.capture-' + uuid4().hex)
    work.mkdir(mode=0o700)
    target = None

    def notify(event):
        if stopped():
            raise CollectorError('cancelled', '任务已取消')
        if progress:
            progress(event)

    try:
        source = media.douyin_source(urls[0], work, cancelled=stopped, progress_callback=notify,
                                    browser_timeout=browser_timeout)
        if stopped():
            raise CollectorError('cancelled', '任务已取消')
        raw = Path(source['media_path'])
        if raw.is_symlink() or not raw.resolve().is_relative_to(work.resolve()) or not raw.is_file():
            raise CollectorError('unsafe_storage', '采集产物未处于当前任务目录')
        size = raw.stat().st_size
        if not 0 < size <= MAX_MEDIA_BYTES:
            raise CollectorError('too_large', '原片为空或超过 100 MiB')
        probe = media.inspect_video(raw)
        if not probe['video']:
            raise CollectorError('invalid_media', '采集产物没有有效视频轨')
        digest = hashlib.sha256(raw.read_bytes()).hexdigest()
        acquisition = source.get('acquisition', {})
        if acquisition.get('media_sha256') != digest:
            raise CollectorError('hash_mismatch', '原片校验值不一致')
        if stopped():
            raise CollectorError('cancelled', '任务已取消')
        target = root / ('video-' + uuid4().hex + '.mp4')
        # Publish only after media/identity/coverage checks; fsync before rename.
        with raw.open('rb') as stream:
            os.fsync(stream.fileno())
        raw.replace(target)
        target.chmod(0o600)
        return {
            'media_path': str(target), 'video_id': source['video_id'],
            'source_url': f"https://www.douyin.com/video/{source['video_id']}",
            'title': re.sub(r'https?://\S+', '[链接]', str(source.get('title', '抖音视频')))[:500],
            'sha256': digest, 'size_bytes': size, 'duration': probe['duration'],
            'has_video': probe['video'], 'has_audio': probe['audio'],
            'limitations': source.get('limitations', []),
            'acquisition_method': acquisition.get('method'),
            'identity_verified': True, 'coverage': [[0, size]],
            'reported_duration': acquisition.get('reported_duration'),
            'evidence': {k: acquisition[k] for k in (
                'identity_metadata_sha256', 'page_sha256', 'media_sha256',
                'component_media_sha256', 'renderer_version', 'native_origin_tls',
                'requests', 'downloaded_bytes', 'media_bytes') if k in acquisition},
        }
    except BaseException as exc:
        if target is not None:
            target.unlink(missing_ok=True)
        if isinstance(exc, CollectorError) and hasattr(exc, 'capture_diagnostic'):
            # Browser-private diagnostic payloads never belong to API error data.
            raw = exc.capture_diagnostic
            exc.diagnostics = {key:raw[key] for key in ('requests','downloaded_bytes',
                'blocked_requests','media_responses','complete_bound_media','proxy_connections')
                if type(raw.get(key)) is int and raw[key] >= 0}
            del exc.capture_diagnostic
        raise
    finally:
        shutil.rmtree(work, ignore_errors=True)


class CollectorAdapter:
    def acquire(self, share_text, output_dir, progress=None, cancelled=None, *, browser_timeout=180,
                ffmpeg="ffmpeg", ffprobe="ffprobe"):
        return collect(share_text, output_dir, progress, cancelled, browser_timeout=browser_timeout,
                       ffmpeg=ffmpeg, ffprobe=ffprobe)
