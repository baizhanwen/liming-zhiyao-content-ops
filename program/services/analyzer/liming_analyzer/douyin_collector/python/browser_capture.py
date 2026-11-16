# Adapted from Skill Collect, MIT Copyright (c) 2026 baizhanwen.
"""Isolated anonymous product browser with a pinned, bounded Python HTTP broker.

Browser IPC carries transient visitor cookies/URLs in memory. Neither those
headers nor signed URLs are logged, persisted as diagnostics, or returned to API
callers. Only complete, identity-bound binary media is retained.
"""
from __future__ import annotations

import base64
import hashlib
import json
import logging
import math
import os
import queue
import re
import shutil
import signal
import select
import socket
import socketserver
import subprocess
from contextvars import copy_context
import threading
import time
import uuid
from http.cookies import SimpleCookie
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from urllib.parse import parse_qs, urljoin, urlsplit, urlunsplit

import httpx

from ...processing_health import request_processor_retirement
from .security import AppError, PublicTransport, public_url
from .limits import BROWSER_TIMEOUT_SECONDS, MAX_DURATION_SECONDS, MAX_MEDIA_BYTES

PROJECT = Path(__file__).resolve().parents[1]
SCRIPT = PROJECT / 'node/capture-douyin.mjs'
MAX_MEDIA = MAX_MEDIA_BYTES
MAX_RESOURCE = 16 * 1024 * 1024
MAX_TOTAL = 4 * MAX_MEDIA_BYTES
MAX_REQUESTS = 1536
MEDIA_CHUNK_BYTES = 8 * 1024 * 1024
COPY_CHUNK_BYTES = 1024 * 1024
# A bounded 1 MiB-origin Range response can still complete the maximum file.
MAX_RANGE_REQUESTS = math.ceil(MAX_MEDIA_BYTES / COPY_CHUNK_BYTES) + 8
HOP_HEADERS = {'connection', 'keep-alive', 'transfer-encoding', 'content-encoding',
               'content-length', 'proxy-authenticate', 'proxy-authorization', 'upgrade'}


def _identity(url):
    try:
        parsed = urlsplit(url)
        found = re.search(r'/(?:share/)?video/(\d+)(?:/|$)', parsed.path)
        return found[1] if found else parse_qs(parsed.query).get('modal_id', [None])[0]
    except ValueError:
        return None


def _clean_url(url):
    parsed = urlsplit(url)
    return urlunsplit((parsed.scheme, parsed.netloc, parsed.path, '', ''))


def _platform_page(url):
    try:
        parsed = urlsplit(url)
        return parsed.scheme == 'https' and not parsed.username and not parsed.password and parsed.port in (None, 443) and any(
            parsed.hostname == domain or (parsed.hostname or '').endswith('.' + domain)
            for domain in ('douyin.com', 'iesdouyin.com'))
    except ValueError:
        return False


class _Guard(socketserver.ThreadingTCPServer):
    """Fail closed for Chromium traffic that is not intercepted by a route."""
    allow_reuse_address = False
    daemon_threads = True


class _DenyConnection(socketserver.BaseRequestHandler):
    def handle(self):
        # This local sink never reads, forwards, resolves or logs any browser data.
        self.request.close()


def _dial_pinned(ip, port, timeout):
    # A numeric socket connect avoids a second hostname resolution/rebinding gap.
    remote = socket.socket(socket.AF_INET6 if ':' in ip else socket.AF_INET, socket.SOCK_STREAM)
    remote.settimeout(timeout)
    try:
        remote.connect((ip, port))
        return remote
    except Exception:
        remote.close()
        raise


def _inspect_media(path):
    """Check actual local streams; a misleading video/mp4 MIME proves nothing."""
    try:
        from .runtime import media_executable
        result = subprocess.run([media_executable('ffprobe'), '-v', 'error', '-protocol_whitelist', 'file,pipe',
            '-format_whitelist', 'mov,matroska,webm,wav,mp3', '-show_format', '-show_streams',
            '-of', 'json', str(path)], capture_output=True, check=True, timeout=10)
        data = json.loads(result.stdout)
        duration = float(data['format']['duration'])
        if not math.isfinite(duration) or not 0 < duration <= MAX_DURATION_SECONDS:
            raise ValueError('duration')
        return {'video': any(stream.get('codec_type') == 'video' for stream in data['streams']),
                'audio': any(stream.get('codec_type') == 'audio' for stream in data['streams']),
                'duration': duration}
    except Exception:
        raise AppError('media_processing', '原视频媒体轨道检查未通过') from None


class _PinnedProxy(_Guard):
    """Opaque TLS tunnel: Chromium verifies the origin certificate itself."""
    request_queue_size = 32
    # A tunnel can be idle while Chromium keeps it alive for a whole origin.
    # Real target acquisition needed 45 such tunnels; 32 starved later media
    # requests. Keep a bounded pool without changing TLS, IP or byte checks.
    max_active = 64

    def __init__(self, address, broker, resolver=None, dialer=None):
        self.broker, self.resolver, self.dialer = broker, resolver or public_url, dialer or _dial_pinned
        self.proxy_lock = threading.RLock()
        self.connections = self.active = self.bytes = self.denied = 0
        self.stopping = threading.Event()
        self.sockets = set()
        super().__init__(address, _ConnectHandler)

    def verify_request(self, request, address):
        with self.proxy_lock:
            self.connections += 1
            if self.connections > 256 or self.active >= self.max_active or self.stopping.is_set():
                self.denied += 1
                return False
            self.active += 1
            return True

    def process_request_thread(self, request, address):
        try:
            super().process_request_thread(request, address)
        finally:
            with self.proxy_lock:
                self.active -= 1

    def count(self, amount):
        with self.proxy_lock:
            self.bytes += amount
            if self.bytes > MAX_TOTAL:
                raise AppError('douyin_browser_budget', '浏览器网络超过采集预算')

    def stop_tunnels(self):
        self.stopping.set()
        with self.proxy_lock:
            for connection in list(self.sockets):
                try:
                    connection.shutdown(socket.SHUT_RDWR)
                except OSError:
                    pass
                connection.close()

    def handle_error(self, request, client_address):
        # socketserver's default traceback could include untrusted request data.
        pass


class _ConnectHandler(socketserver.BaseRequestHandler):
    def handle(self):
        server, remote = self.server, None
        try:
            server.broker._check()
            self.request.settimeout(5)
            header = bytearray()
            while b'\r\n\r\n' not in header:
                part = self.request.recv(4096)
                if not part:
                    return
                header.extend(part)
                if len(header) > 8192:
                    raise ValueError('header limit')
            first = bytes(header).split(b'\r\n', 1)[0].decode('ascii').split()
            if len(first) != 3 or first[0] != 'CONNECT' or first[2] not in ('HTTP/1.0', 'HTTP/1.1'):
                raise ValueError('only CONNECT is supported')
            authority = first[1]
            if not re.fullmatch(r'(?:\[[0-9a-fA-F:]+\]|[A-Za-z0-9.-]+):443', authority):
                raise ValueError('invalid CONNECT authority')
            ips = server.resolver('https://' + authority)
            # Validate injected resolvers too; production resolution already checks
            # every result through public_url/FakeIP DoH validation.
            import ipaddress
            if not ips or any(not ipaddress.ip_address(ip).is_global for ip in ips):
                raise ValueError('nonpublic CONNECT destination')
            server.broker._check()
            remote = server.dialer(ips[0], 443, min(10, max(.1, server.broker.deadline - time.monotonic())))
            self.request.sendall(b'HTTP/1.1 200 Connection Established\r\n\r\n')
            remote.settimeout(1); self.request.settimeout(1)
            with server.proxy_lock:
                server.sockets.update((self.request, remote))
            while not server.stopping.is_set():
                server.broker._check()
                readable, _, _ = select.select([self.request, remote], [], [], .2)
                for source in readable:
                    data = source.recv(65536)
                    if not data:
                        return
                    server.count(len(data))
                    (remote if source is self.request else self.request).sendall(data)
        except Exception:
            with server.proxy_lock:
                server.denied += 1
            if remote is None:
                try:
                    self.request.sendall(b'HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\nConnection: close\r\n\r\n')
                except OSError:
                    pass
        finally:
            with server.proxy_lock:
                server.sockets.discard(self.request)
                if remote:
                    server.sockets.discard(remote)
            if remote:
                remote.close()


class _Broker:
    def __init__(self, folder, video_id, deadline, max_bytes=MAX_MEDIA, transport_factory=None, cancelled=None,
                 media_inspector=None):
        self.folder, self.video_id, self.deadline = Path(folder), str(video_id), deadline
        self.max_bytes, self.cancelled = min(max_bytes, MAX_MEDIA), cancelled or (lambda: False)
        self.folder.mkdir(parents=True, exist_ok=True)
        self.client = httpx.Client(transport=(transport_factory or PublicTransport)(), trust_env=False,
                                  follow_redirects=False, timeout=httpx.Timeout(20, connect=10))
        self.lock = threading.RLock()
        self.requests = self.total = self.blocked = 0
        self.statuses, self.errors = {}, {}
        self.urls, self.uris, self.entries = set(), set(), {}
        self.metadata_hashes = set()
        self.cookie_values = set()
        self.observed_media = {}
        self.observed_redirects = {}
        self.metadata_diagnostics = []
        self.metadata_durations = set()
        self.expected_audio = False
        self.media_inspector = media_inspector or _inspect_media

    def close(self):
        self.client.close()

    def _check(self):
        if self.cancelled():
            raise AppError('cancelled', '任务已取消')
        if time.monotonic() > self.deadline:
            raise AppError('douyin_browser_timeout', '匿名浏览器采集超过等待时限', True)

    def _bound(self, url):
        try:
            parsed = urlsplit(url)
            query = parse_qs(parsed.query, keep_blank_values=True)
            if parsed.scheme != 'https' or parsed.username or parsed.password or parsed.port not in (None, 443):
                return False
            if url in self.urls:
                return True
            for known in self.urls:
                published = urlsplit(known)
                if (published.scheme, published.hostname, published.port or 443, published.path) != (
                        parsed.scheme, parsed.hostname, parsed.port or 443, parsed.path):
                    continue
                expected = parse_qs(published.query, keep_blank_values=True)
                # Observed public-player variants add `temp`, sometimes with
                # `__vid` exactly naming the requested video. These additions
                # never establish identity without matching official metadata.
                # Every published parameter/value, duplicate and blank remains
                # mandatory; the complete observed URL is used unchanged for GET.
                if not all(query.get(key) == values for key, values in expected.items()):
                    continue
                additions = set(query) - set(expected)
                if additions <= {'temp'} or (additions == {'temp', '__vid'} and query['__vid'] == [self.video_id]):
                    return True
        except ValueError:
            return False
        return False

    def _bind_json(self, body, source_url):
        # Advertising/analytics origins cannot attest the identity of a Douyin video.
        if not _platform_page(source_url):
            return
        try:
            data = json.loads(body)
        except (ValueError, UnicodeError, RecursionError):
            return
        diagnostic = {'source_host': urlsplit(source_url).hostname, 'source_path': urlsplit(source_url).path,
                      'root_keys': list(data)[:50] if isinstance(data, dict) else ['array'], 'matching_nodes': []}
        stack, checked, matched = [data], 0, False
        while stack and checked < 20000:
            node = stack.pop(); checked += 1
            if isinstance(node, dict):
                identity = next((str(node[k]) for k in ('aweme_id', 'awemeId', 'item_id', 'itemId', 'id') if k in node), None)
                video = node.get('video')
                if any(str(value) == self.video_id for value in node.values() if isinstance(value, (str, int))):
                    if len(diagnostic['matching_nodes']) < 5:
                        diagnostic['matching_nodes'].append({'keys': list(node)[:80], 'video_type': type(video).__name__,
                            'video_keys': list(video)[:60] if isinstance(video, dict) else []})
                if identity == self.video_id and isinstance(video, dict):
                    matched = True
                    self.expected_audio = self.expected_audio or bool(video.get('audio') or video.get('bit_rate_audio'))
                    # Published item video.duration is milliseconds. Browser
                    # HTMLVideoElement.duration arrives separately in seconds.
                    durations = []
                    duration_valid = True
                    for field in ('duration_seconds', 'duration_ms', 'duration'):
                        if field not in video:
                            continue
                        value = video[field]
                        if not isinstance(value, (int, float)) or isinstance(value, bool) or not math.isfinite(value):
                            duration_valid = False
                            break
                        seconds = value if field == 'duration_seconds' else value / 1000
                        if not 0 < seconds <= MAX_DURATION_SECONDS:
                            duration_valid = False
                            break
                        durations.append(seconds)
                    if duration_valid and durations and max(durations) - min(durations) < 1:
                        self.metadata_durations.add(min(durations))
                    children, visited, parsed_strings = [video], 0, 0
                    while children and visited < 20000:
                        visited += 1
                        child = children.pop()
                        if isinstance(child, dict):
                            for key, value in child.items():
                                if key == 'uri' and isinstance(value, str) and value:
                                    self.uris.add(value)
                                if isinstance(value, (dict, list)):
                                    children.append(value)
                                elif isinstance(value, str) and value.startswith(('https://', 'http://', '//')):
                                    published = 'https:' + value if value.startswith('//') else value
                                    self.urls.add(published)
                                    if published.startswith('http://'):
                                        self.urls.add('https://' + published[len('http://'):])
                                elif isinstance(value, str) and value[:1] in ('{', '[') and parsed_strings < 8:
                                    try:
                                        children.append(json.loads(value)); parsed_strings += 1
                                    except (ValueError, RecursionError):
                                        pass
                        elif isinstance(child, list):
                            children.extend(child)
                        elif isinstance(child, str) and child.startswith(('https://', 'http://', '//')):
                            published = 'https:' + child if child.startswith('//') else child
                            self.urls.add(published)
                            if published.startswith('http://'):
                                self.urls.add('https://' + published[len('http://'):])
                stack.extend(v for v in node.values() if isinstance(v, (dict, list)))
            elif isinstance(node, list):
                stack.extend(node)
        if matched:
            self.metadata_hashes.add(hashlib.sha256(body).hexdigest())
        if len(self.metadata_diagnostics) < 40:
            self.metadata_diagnostics.append(diagnostic)

    def _bind_html(self, body, source_url):
        if not _platform_page(source_url):
            return
        # Reuse the static, ID-matching public page parser; no JavaScript eval or
        # reading private renderer application state is involved.
        from .media import _published_media
        candidates = _published_media(body.decode('utf-8', 'replace'), self.video_id)
        if len(self.metadata_diagnostics) < 40:
            text = body.decode('utf-8', 'replace')
            self.metadata_diagnostics.append({'source_host': urlsplit(source_url).hostname,
                'source_path': urlsplit(source_url).path, 'html_bytes': len(body),
                'assignments': sorted(set(re.findall(r'window\.([A-Za-z_][A-Za-z_0-9]*)\s*=', text)))[:30],
                'hydration_calls': sorted(set(re.findall(r'(?:self|window)\.([A-Za-z_][A-Za-z_0-9]*)\.(?:push|set)\(', text)))[:20],
                'script_ids': re.findall(r'<script[^>]*\bid=["\']([A-Za-z_][A-Za-z_0-9.-]{0,79})["\']', text)[:20],
                'markers': {term: text.count(term) for term in ('aweme_id', 'awemeId', 'item_id', 'itemId',
                    'play_addr', 'playAddr', 'url_list', 'urlList', '_ROUTER_DATA', 'JSON.parse', self.video_id)},
                'matching_public_media': len(candidates)})
        if candidates:
            self.urls.update(url for url, _ in candidates)
            self.metadata_hashes.add(hashlib.sha256(body).hexdigest())

    def _headers(self, supplied):
        headers = {str(k): str(v) for k, v in supplied.items()
                   if str(k).lower() not in {'host', 'content-length', 'authorization', 'proxy-authorization',
                                            'connection', 'accept-encoding'} and not str(k).startswith(':')}
        # No dependency on optional Brotli/Zstd decoders in the Python runtime.
        headers['accept-encoding'] = 'gzip, deflate'
        with self.lock:
            for key, value in supplied.items():
                if key.lower() == 'cookie':
                    self._remember_cookies(value)
        return headers

    def _remember_cookies(self, value):
        try:
            cookie = SimpleCookie(); cookie.load(value)
            self.cookie_values.update(item.value for item in cookie.values() if len(item.value) >= 4)
        except Exception:
            pass

    def public_title(self, value):
        text = re.sub(r'https?://\S+', '[链接]', str(value))
        with self.lock:
            for secret in self.cookie_values:
                text = text.replace(secret, '[REDACTED]')
        return text[:500]

    def _request(self, url, method, headers, body=b'', resource_type='', supplement=False):
        self._check()
        if method not in ('GET', 'HEAD', 'POST', 'OPTIONS') or len(body) > 1024 * 1024:
            raise AppError('unsafe_url', '页面请求不在允许范围')
        with self.lock:
            self.requests += 1
            if self.requests > MAX_REQUESTS:
                raise AppError('douyin_browser_budget', '页面请求超过采集预算')
        response_path, retained = None, False
        try:
            with self.client.stream(method, url, headers=self._headers(headers), content=body) as response:
                content_type = response.headers.get('content-type', '').split(';')[0].lower()
                media_type = content_type.startswith(('video/', 'audio/')) or resource_type == 'media'
                chunks, size, prefix = [], 0, b''
                output = None
                try:
                    for chunk in response.iter_bytes(chunk_size=COPY_CHUNK_BYTES):
                        self._check()
                        size += len(chunk)
                        prefix += chunk[:max(0, 8 - len(prefix))]
                        media_type = media_type or (content_type == 'application/octet-stream' and prefix[4:8] == b'ftyp')
                        limit = self.max_bytes if media_type or supplement else MAX_RESOURCE
                        with self.lock:
                            self.total += len(chunk)
                            if self.total > MAX_TOTAL:
                                raise AppError('douyin_browser_budget', '页面总下载量超过采集预算')
                        if size > limit:
                            raise AppError('douyin_browser_budget', '页面资源超过采集大小限制')
                        if media_type or supplement:
                            if output is None:
                                response_path = self.folder / ('response-' + uuid.uuid4().hex + '.bin')
                                output = response_path.open('xb')
                                for previous in chunks:
                                    output.write(previous)
                                chunks.clear()
                            output.write(chunk)
                        else:
                            chunks.append(chunk)
                finally:
                    if output is not None:
                        output.close()
                payload = b'' if response_path is not None else b''.join(chunks)
                status = response.status_code
                length = response.headers.get('content-length')
                if media_type and method != 'HEAD' and length is not None and not response.headers.get('content-encoding'):
                    if not length.isdigit() or int(length) != size:
                        raise AppError('douyin_browser_range', '媒体响应长度与声明不一致')
                with self.lock:
                    self.statuses[status] = self.statuses.get(status, 0) + 1
                raw_headers = list(response.headers.multi_items())
            mapped = {}
            for key, value in raw_headers:
                if key.lower() == 'set-cookie':
                    with self.lock:
                        self._remember_cookies(value)
                if key.lower() not in HOP_HEADERS:
                    separator = '\n' if key.lower() == 'set-cookie' else ', '
                    mapped[key] = mapped[key] + separator + value if key in mapped else value
            with self.lock:
                if 300 <= status < 400 and self._bound(url) and response.headers.get('location'):
                    self.urls.add(urljoin(url, response.headers['location']))
                if response_path is None and (content_type.endswith('json') or (len(payload) < MAX_RESOURCE and payload[:1] in (b'{', b'['))):
                    self._bind_json(payload, url)
                elif response_path is None and content_type == 'text/html':
                    self._bind_html(payload, url)
            path = self._record_file(url, headers, status, response.headers, response_path, size, content_type,
                                     retain_response=not supplement) if media_type and response_path is not None else None
            retained = path is not None and path == response_path
            if path and not supplement:
                self._complete(url)
            return status, mapped, payload, path
        finally:
            if response_path is not None and not retained:
                response_path.unlink(missing_ok=True)

    def _record(self, url, request_headers, status, headers, payload, mime):
        """Small in-memory compatibility entry point; downloads use _record_file."""
        if status not in (200, 206) or not payload:
            return None
        response_path = self.folder / ('response-' + uuid.uuid4().hex + '.bin')
        response_path.write_bytes(payload)
        try:
            path = self._record_file(url, request_headers, status, headers, response_path, len(payload), mime)
        except BaseException:
            response_path.unlink(missing_ok=True)
            raise
        if path != response_path:
            response_path.unlink(missing_ok=True)
        return path

    def _record_file(self, url, request_headers, status, headers, response_path, size, mime, *, retain_response=True):
        if status not in (200, 206) or size <= 0:
            return None
        total, start, end = size, 0, size - 1
        if status == 206:
            match = re.fullmatch(r'bytes (\d+)-(\d+)/(\d+)', headers.get('content-range', ''))
            if not match:
                return None
            start, end, total = map(int, match.groups())
            if end < start or end >= total or size != end - start + 1:
                raise AppError('douyin_browser_range', '媒体分段响应不完整')
        if total > self.max_bytes:
            raise AppError('douyin_browser_budget', '原视频超过大小限制')
        key = hashlib.sha256(url.encode()).hexdigest()
        with self.lock:
            entry = self.entries.get(url)
            if entry is None:
                entry = self.entries[url] = {'path': self.folder / (key + '.mp4'), 'total': total,
                    'ranges': [], 'headers': dict(request_headers), 'mime': mime, 'invalid': False, 'completing': False}
            if total != entry['total']:
                entry['invalid'] = True
                raise AppError('douyin_browser_range', '媒体总长度在采集中发生变化')
            # A fresh complete response can become the final candidate directly.
            if not entry['ranges'] and start == 0 and size == total:
                response_path.replace(entry['path'])
                entry['ranges'] = [(0, total)]
                return entry['path']
            with response_path.open('rb') as incoming, entry['path'].open('r+b' if entry['path'].exists() else 'w+b') as file:
                for left, right in entry['ranges']:
                    overlap_start, overlap_end = max(start, left), min(end + 1, right)
                    if overlap_end > overlap_start:
                        incoming.seek(overlap_start - start)
                        file.seek(overlap_start)
                        remaining = overlap_end - overlap_start
                        while remaining:
                            self._check()
                            amount = min(COPY_CHUNK_BYTES, remaining)
                            if file.read(amount) != incoming.read(amount):
                                entry['invalid'] = True
                                raise AppError('douyin_browser_range', '媒体分段内容发生变化')
                            remaining -= amount
                file.seek(start)
                incoming.seek(0)
                while chunk := incoming.read(COPY_CHUNK_BYTES):
                    self._check()
                    file.write(chunk)
            ranges = sorted([*entry['ranges'], (start, end + 1)])
            merged = []
            for left, right in ranges:
                if merged and left <= merged[-1][1]:
                    merged[-1] = (merged[-1][0], max(right, merged[-1][1]))
                else:
                    merged.append((left, right))
            entry['ranges'] = merged
            # A supplement is internal only; no duplicate response file is retained.
            return response_path if retain_response else entry['path']

    def _complete(self, url):
        with self.lock:
            entry = self.entries[url]
            if entry['completing'] or entry['invalid'] or not self._bound(url):
                return
            entry['completing'] = True
            original = {k: v for k, v in entry['headers'].items() if k.lower() != 'range'}
        try:
            # Same observed URL and current anonymous session; no query rewriting.
            for attempt in range(MAX_RANGE_REQUESTS):
                self._check()
                with self.lock:
                    ranges = entry['ranges']
                    if ranges == [(0, entry['total'])] or entry['invalid']:
                        return
                    start = 0
                    for left, right in ranges:
                        if left > start:
                            break
                        start = max(start, right)
                    end = min(start + MEDIA_CHUNK_BYTES - 1, entry['total'] - 1)
                    previous_ranges = list(ranges)
                headers = dict(original)
                if attempt:
                    headers['range'] = f'bytes={start}-{end}'
                status, _, _, _ = self._request(url, 'GET', headers, resource_type='media', supplement=True)
                if status not in (200, 206):
                    return
                with self.lock:
                    if attempt and entry['ranges'] == previous_ranges:
                        return  # A stalled server must not consume the entire range budget.
        except AppError:
            return  # Partial coverage is never returned as successful acquisition.
        finally:
            with self.lock:
                entry['completing'] = False

    def handle(self, message):
        try:
            if message.get('type') == 'observed_redirect':
                destination = urljoin(message['url'], message['location'])
                if urlsplit(destination).scheme != 'https':
                    raise AppError('unsafe_url', '媒体重定向必须使用 HTTPS')
                with self.lock:
                    if len(self.observed_redirects) < 64:
                        self.observed_redirects[message['url']] = destination
                    self._bind_redirects()
                    waiting = [url for url in self.observed_media if self._bound(url)]
                for url in waiting:
                    self._download_observed(url)
                return {'type': 'reply', 'id': message['id'], 'capture_ready': bool(self.ready())}
            if message.get('type') == 'observed_metadata':
                path = Path(message['path'])
                if path.is_symlink() or path.resolve().parent != self.folder.resolve() or path.stat().st_size > MAX_RESOURCE:
                    raise AppError('unsafe_path', '浏览器临时资源路径不合法')
                try:
                    payload = path.read_bytes()
                finally:
                    path.unlink(missing_ok=True)
                with self.lock:
                    if message.get('content_type') == 'text/html':
                        self._bind_html(payload, message['url'])
                    else:
                        self._bind_json(payload, message['url'])
                    self._bind_redirects()
                    waiting = [url for url in self.observed_media if self._bound(url)]
                for url in waiting:
                    self._download_observed(url)
                return {'type': 'reply', 'id': message['id'], 'capture_ready': bool(self.ready())}
            if message.get('type') == 'observed_media':
                with self.lock:
                    if len(self.observed_media) < 32 or message['url'] in self.observed_media:
                        self.observed_media.setdefault(message['url'], {'headers': message.get('headers', {}),
                            'attempts': 0, 'downloading': False})
                self._download_observed(message['url'])
                return {'type': 'reply', 'id': message['id'], 'capture_ready': bool(self.ready())}
            if message.get('type') == 'observe':
                if str(message.get('video_id')) != self.video_id:
                    raise AppError('douyin_browser_identity', '视频标识不一致')
                with self.lock:
                    candidates = [url for url in self.entries if self._bound(url)]
                for url in candidates:
                    self._complete(url)
                return {'type': 'reply', 'id': message['id'], 'capture_ready': bool(self.ready())}
            body = base64.b64decode(message.get('body', ''), validate=True)
            url, method, outgoing = message['url'], message['method'], message.get('headers', {})
            for hop in range(6):
                status, headers, payload, path = self._request(url, method, outgoing, body, message.get('resource_type', ''))
                location = headers.get('location')
                if not (300 <= status < 400 and location):
                    break
                destination = urljoin(url, location)
                if urlsplit(destination).scheme not in ('http', 'https'):
                    raise AppError('unsafe_url', '页面重定向协议不合法')
                if message.get('navigation'):
                    return {'type': 'reply', 'id': message['id'], 'status': 200,
                            'headers': {key: value for key, value in headers.items() if key != 'location'},
                            'body': '', 'redirect': destination, 'capture_ready': False}
                if hop >= 5:
                    raise AppError('douyin_browser_redirect', '页面重定向次数超限')
                if urlsplit(url).netloc != urlsplit(destination).netloc:
                    outgoing = {key: value for key, value in outgoing.items() if key.lower() != 'cookie'}
                if status == 303 or (status in (301, 302) and method == 'POST'):
                    method, body = 'GET', b''
                url = destination
            return {'type': 'reply', 'id': message['id'], 'status': status, 'headers': headers,
                    **({'path': str(path)} if path else {'body': base64.b64encode(payload).decode()}),
                    'capture_ready': bool(self.ready())}
        except Exception as exc:
            with self.lock:
                self.blocked += 1
                code = exc.code if isinstance(exc, AppError) else 'request_failed'
                self.errors[code] = self.errors.get(code, 0) + 1
            return {'type': 'reply', 'id': message.get('id'), 'abort': True}

    def _bind_redirects(self):
        # These edges come only from real Chromium HTTP response headers through
        # the validating proxy, not guessed CDN rewrites or page text.
        for _ in range(5):
            added = False
            for source, destination in self.observed_redirects.items():
                if self._bound(source) and destination not in self.urls:
                    self.urls.add(destination); added = True
            if not added:
                break

    def _download_observed(self, url):
        with self.lock:
            entry = self.observed_media.get(url)
            if not entry or not self._bound(url) or entry['downloading'] or entry['attempts'] >= 2:
                return
            if url in self.entries and self.entries[url]['ranges'] == [(0, self.entries[url]['total'])]:
                return
            entry['attempts'] += 1
            entry['downloading'] = True
            headers = {key: value for key, value in entry['headers'].items() if key.lower() != 'range'}
        try:
            self.handle({'id': 0, 'url': url, 'method': 'GET', 'headers': headers, 'resource_type': 'media'})
        finally:
            with self.lock:
                entry['downloading'] = False

    def complete(self):
        with self.lock:
            return [entry for url, entry in self.entries.items()
                    if not entry['invalid'] and self._bound(url) and entry['ranges'] == [(0, entry['total'])]]

    def ready(self):
        complete = self.complete()
        for entry in complete:
            with self.lock:
                if entry.get('probe_attempted'):
                    continue
                entry['probe_attempted'] = True
            try:
                probe = self.media_inspector(entry['path'])
            except Exception:
                probe = {'video': False, 'audio': False}
            with self.lock:
                entry['probe'] = probe
        # Real DASH audio has been observed with MIME video/mp4. Require actual
        # video streams and, when the official target metadata declares audio,
        # wait for that stream too rather than terminating on the first response.
        video = [entry for entry in complete if entry.get('probe', {}).get('video')]
        audio = any(entry.get('probe', {}).get('audio') for entry in complete)
        return video if video and (not self.expected_audio or audio) else []

    def binding_diagnostic(self):
        def summarize(url):
            parsed = urlsplit(url)
            params = parse_qs(parsed.query, keep_blank_values=True)
            return {'scheme': parsed.scheme, 'host': parsed.hostname,
                    'path_sha256': hashlib.sha256(parsed.path.encode()).hexdigest(),
                    'query_keys': sorted(params),
                    'video_uri_sha256': [hashlib.sha256(value.encode()).hexdigest()
                        for key in ('video_id', 'vid') for value in params.get(key, [])],
                    'bound': self._bound(url)}
        with self.lock:
            ordered = sorted(self.urls, key=lambda url: (not (urlsplit(url).hostname or '').startswith('v'), url))
            differences = []
            for observed in list(self.observed_media)[:20]:
                actual = urlsplit(observed); actual_query = parse_qs(actual.query, keep_blank_values=True)
                same_path = [url for url in self.urls if (urlsplit(url).hostname, urlsplit(url).path) == (actual.hostname, actual.path)]
                options = []
                for known in same_path:
                    expected = parse_qs(urlsplit(known).query, keep_blank_values=True)
                    option = {'added': sorted(set(actual_query) - set(expected)),
                              'removed': sorted(set(expected) - set(actual_query)),
                              'changed': sorted(key for key in expected if key in actual_query and expected[key] != actual_query[key])}
                    options.append(option)
                if options:
                    differences.append(min(options, key=lambda option: sum(len(value) for value in option.values())))
            return {'published': [summarize(url) for url in ordered[:20]],
                    'observed': [summarize(url) for url in list(self.observed_media)[:20]],
                    'uri_sha256': [hashlib.sha256(value.encode()).hexdigest() for value in sorted(self.uris)[:20]],
                    'redirects': [{'source': summarize(source), 'destination': summarize(destination)}
                                  for source, destination in list(self.observed_redirects.items())[:10]],
                    'query_differences': differences}

    def _file_digest(self, path):
        digest = hashlib.sha256()
        with path.open('rb') as stream:
            while chunk := stream.read(COPY_CHUNK_BYTES):
                self._check()
                digest.update(chunk)
        return digest.hexdigest()

    def finish(self, observations, observed_id):
        if observed_id != self.video_id:
            raise AppError('douyin_browser_identity', '浏览器页面已离开指定视频，未接受其他视频')
        with self.lock:
            candidates = [url for url in self.entries if self._bound(url)]
        for url in candidates:
            self._complete(url)
        output = []
        if not self.ready():
            return output
        for entry in self.complete():
            if not any(entry.get('probe', {}).get(key) for key in ('video', 'audio')):
                continue
            path = entry['path']
            if path.stat().st_size != entry['total']:
                continue
            output.append({'path': str(path), 'size': entry['total'],
                           'sha256': self._file_digest(path),
                           'coverage': [list(pair) for pair in entry['ranges']],
                           'complete': True, 'mime': entry['mime'], 'video_id': self.video_id,
                           'probe': entry['probe']})
        return output


def _kill(process):
    if os.name == 'nt':
        if process.poll() is not None:
            return
        subprocess.run(['taskkill', '/pid', str(process.pid), '/T', '/F'], capture_output=True, timeout=10)
    else:
        try:
            os.killpg(process.pid, signal.SIGKILL)
        except ProcessLookupError:
            pass
    if process.poll() is None:
        process.wait(timeout=10)


def _capture_cleanup_issue(action, error=None, stream=None):
    diagnostic = {'action': action, 'type': type(error).__name__ if error else 'CleanupIncomplete'}
    if stream:
        diagnostic['stream'] = stream
    number = getattr(error, 'errno', None)
    if type(number) is int:
        diagnostic['errno'] = number
    # Neither diagnostics nor the health signal may hide the original outcome.
    try:
        request_processor_retirement('collector_cleanup_' + action)
    except Exception:  # noqa: BLE001, S110 - cleanup must preserve a pending return/AppError.
        pass
    try:
        logging.getLogger(__name__).warning('Browser capture cleanup: %s', json.dumps(diagnostic, ensure_ascii=True))
    except Exception:  # noqa: BLE001, S110 - logging itself can fail on a Windows pipe.
        pass


def _cleanup_capture(*, process, reader, stop_reader, stop_writes, write_lock,
                     send, messages, guard, guard_thread, native_proxy, executor,
                     broker, work, keep, timeout=12):
    """Bound every independent cleanup action without replacing a business result.

    A close can block on buffered I/O's lock even after a timed-out reader join.
    Cleanup therefore never closes a live reader's stream on the caller thread.
    Unconfirmed resources retire the existing isolated processor before reuse.
    """
    deadline = time.monotonic() + timeout

    report = _capture_cleanup_issue

    def step(action, operation, *, stream=None, seconds=1):
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            report(action, TimeoutError(), stream)
            return False
        completed = threading.Event()
        errors = []

        def run():
            try:
                operation()
            except Exception as error:  # noqa: BLE001 - retain each cleanup failure independently.
                errors.append(error)
            finally:
                completed.set()

        try:
            worker = threading.Thread(target=run, daemon=True, name='capture-cleanup-' + action)
            worker.start()
        except Exception as error:  # noqa: BLE001 - thread startup must not replace a business result.
            report(action, error, stream)
            return False
        if not completed.wait(min(seconds, remaining)):
            report(action, TimeoutError(), stream)
            return False
        if errors:
            report(action, errors[0], stream)
            return False
        return True

    stop_reader.set()
    stop_writes.set()
    if process:
        step('cancel_driver', lambda: send({'type': 'cancel'}, _cleanup=True), seconds=.25)
        exited = step('wait_driver', lambda: process.wait(timeout=2), seconds=2.25)
        if not exited or os.name != 'nt':
            step('kill_driver_tree', lambda: _kill(process), seconds=6)
    reader_stopped = True
    if reader:
        step('join_reader', lambda: reader.join(timeout=1), seconds=1.1)
        reader_stopped = not reader.is_alive()
        if not reader_stopped:
            report('reader_still_running', stream='stdout')
    if process:
        def close_stdin():
            with write_lock:
                process.stdin.close()
        if process.stdin:
            step('close_stream', close_stdin, stream='stdin', seconds=.5)
        if process.stdout and reader_stopped:
            step('close_stream', process.stdout.close, stream='stdout', seconds=.5)

    def drain_messages():
        while True:
            try:
                messages.get_nowait()
            except queue.Empty:
                return
    step('drain_messages', drain_messages, seconds=.25)
    if native_proxy:
        step('stop_tunnels', guard.stop_tunnels)
    step('shutdown_executor', lambda: executor.shutdown(wait=True, cancel_futures=True))
    step('close_broker', broker.close, seconds=.5)
    step('shutdown_guard', guard.shutdown)
    step('close_guard', guard.server_close, seconds=.5)
    step('join_guard', lambda: guard_thread.join(timeout=.5), seconds=.6)
    if guard_thread.is_alive():
        report('guard_still_running')

    def clean_files():
        for path in work.glob('*'):
            if path.is_file() and path not in keep:
                try:
                    path.unlink(missing_ok=True)
                except OSError as error:
                    report('unlink_work_file', error)
        if not keep:
            work.rmdir()
    step('clean_work_directory', clean_files)


def _renderer_env():
    # A public webpage renderer has no reason to inherit model/service keys,
    # Codex settings, shell hooks, TLS key logging or another app's credentials.
    allowed={'PATH','HOME','USERPROFILE','APPDATA','LOCALAPPDATA','SYSTEMROOT','SYSTEMDRIVE',
        'WINDIR','TEMP','TMP','TMPDIR','LANG','LC_ALL','LC_CTYPE','XDG_CACHE_HOME',
        'XDG_CONFIG_HOME','XDG_RUNTIME_DIR','DISPLAY','WAYLAND_DISPLAY','PLAYWRIGHT_BROWSERS_PATH'}
    return {key:value for key,value in os.environ.items() if key.upper() in allowed}


def _resolved_redirect(result, initial):
    """Validate the renderer's initial HTTP navigation chain, never page content."""
    chain = result.get('redirect_chain') if isinstance(result, dict) else None
    if not isinstance(chain, list) or not 1 <= len(chain) <= 6 or not all(isinstance(u, str) and _platform_page(u) for u in chain):
        raise AppError('douyin_resolve_identity', '未取得可信的官方视频跳转链')
    if not isinstance(result.get('resolved_url'), str) or not _platform_page(result['resolved_url']):
        raise AppError('douyin_resolve_identity', '分享页跳转来源不一致')
    def comparable(url):
        p = urlsplit(url)
        return p.scheme, p.hostname, p.port or 443, p.path or '/', p.query
    if comparable(chain[0]) != comparable(initial) or comparable(chain[-1]) != comparable(result.get('resolved_url', '')):
        raise AppError('douyin_resolve_identity', '分享页跳转来源不一致')
    # Only the already-supported numeric video path is accepted. modal_id,
    # recommendations, DOM links and titles cannot establish a target here.
    identities = [re.search(r'/(?:share/)?video/([0-9]{1,32})(?:/|$)', urlsplit(u).path) for u in chain]
    identities = [m[1] for m in identities if m]
    final = re.search(r'/(?:share/)?video/([0-9]{1,32})(?:/|$)', urlsplit(chain[-1]).path)
    if not final or set(identities) != {final[1]} or str(result.get('video_id')) != final[1]:
        raise AppError('douyin_resolve_identity', '未确认分享链接的唯一视频标识')
    return {'video_id': final[1], 'resolved_url': _clean_url(chain[-1]),
            'method': 'official_browser_redirect', 'redirect_count': len(chain) - 1}


def resolve_douyin_url(url, folder, timeout=30, cancelled=None,
                       progress_callback=None, *, transport_factory=None):
    """Resolve only the initial official HTTP redirect chain; acquire no media."""
    if cancelled and cancelled():
        raise AppError('cancelled', '任务已取消')
    return capture_douyin(url, folder, video_id='0', timeout=min(float(timeout), 45),
        cancelled=cancelled, transport_factory=transport_factory,
        progress_callback=progress_callback, _resolve_only=True)


def capture_douyin(url, folder, *, video_id, timeout=BROWSER_TIMEOUT_SECONDS, max_bytes=MAX_MEDIA,
                   cancelled=None, transport_factory=None, progress_callback=None, _resolve_only=False):
    """Return complete media candidates for one explicit video; otherwise raise.

    Caller must FFprobe/validate the resulting AV streams and duration before
    claiming acquisition or starting provider analysis. This function never calls
    models, user browser profiles, the application vault, or external parsers.
    """
    if not _platform_page(url):
        raise AppError('unsupported_source', '匿名浏览器仅支持抖音公开分享页')
    if not _resolve_only and (not str(video_id).isdigit() or (_identity(url) and _identity(url) != str(video_id))):
        raise AppError('douyin_browser_identity', '分享链接与指定视频标识不一致')
    node = shutil.which('node')
    if not node or not SCRIPT.is_file():
        raise AppError('douyin_browser_runtime', '匿名浏览器未安装，请重新运行项目安装脚本')
    timeout = min(max(float(timeout), 3), BROWSER_TIMEOUT_SECONDS)
    work = Path(folder).resolve() / ('browser-' + uuid.uuid4().hex)
    broker = _Broker(work, video_id, time.monotonic() + timeout, max_bytes, transport_factory, cancelled)
    # The explicit injected transport selects offline fulfillment contracts only.
    # Production uses native Chromium TLS through the validating CONNECT proxy.
    native_proxy = transport_factory is None
    guard = _PinnedProxy(('127.0.0.1', 0), broker) if native_proxy else _Guard(('127.0.0.1', 0), _DenyConnection)
    guard_thread = threading.Thread(target=guard.serve_forever, daemon=True); guard_thread.start()
    env = _renderer_env()
    process = None
    write_lock = threading.Lock()
    messages = queue.Queue(maxsize=64)
    inflight = threading.BoundedSemaphore(32)
    stop_reader = threading.Event()
    stop_writes = threading.Event()
    reader = None
    result, progress, keep = None, {}, set()
    executor = ThreadPoolExecutor(max_workers=8, thread_name_prefix='capture-http')

    def send(message, *, _cleanup=False):
        with write_lock:
            if stop_writes.is_set() and not _cleanup:
                return
            if process and process.poll() is None:
                try:
                    process.stdin.write(json.dumps(message) + '\n'); process.stdin.flush()
                except (BrokenPipeError, OSError, ValueError):
                    if _cleanup:
                        raise  # The bounded cleanup step records this without replacing the result.

    def read_messages():
        def enqueue(message):
            while not stop_reader.is_set():
                try:
                    messages.put(message, timeout=.2)
                    return
                except queue.Full:
                    continue
        while not stop_reader.is_set():
            try:
                line = process.stdout.readline(2 * 1024 * 1024)
            except (OSError, ValueError):
                return
            if not line:
                enqueue(None); return
            if not line.endswith('\n'):
                enqueue(None); return
            try:
                enqueue(json.loads(line))
            except ValueError:
                enqueue(None); return

    try:
        process = subprocess.Popen([node, str(SCRIPT)], cwd=PROJECT, stdin=subprocess.PIPE,
            stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, text=True, encoding='utf-8',
            env=env, start_new_session=(os.name != 'nt'))
        reader = threading.Thread(target=read_messages, daemon=True); reader.start()
        send({'type': 'start', 'url': url, 'video_id': str(video_id), 'timeout_ms': int(timeout * 1000),
              'guard_proxy': f'http://127.0.0.1:{guard.server_address[1]}',
              'native_proxy': native_proxy, 'work_dir': str(work), 'resolve_only': bool(_resolve_only),
              'max_bytes': broker.max_bytes, 'max_total_bytes': MAX_TOTAL, 'max_requests': MAX_REQUESTS})
        while result is None:
            broker._check()
            try:
                message = messages.get(timeout=.2)
            except queue.Empty:
                if process.poll() is not None:
                    break
                continue
            if message is None:
                break
            if message.get('type') in ('fetch', 'observe', 'observed_metadata', 'observed_media', 'observed_redirect'):
                if _resolve_only:
                    send({'type': 'reply', 'id': message.get('id'), 'abort': True})
                    continue
                if not inflight.acquire(blocking=False):
                    send({'type': 'reply', 'id': message.get('id'), 'abort': True})
                    continue
                future = executor.submit(copy_context().run, broker.handle, message)
                def reply(completed):
                    try:
                        if not completed.cancelled():
                            send(completed.result())
                    finally:
                        inflight.release()
                future.add_done_callback(reply)
            elif message.get('type') == 'result':
                result = message
                if isinstance(result.get('cleanup'), dict) and result['cleanup'].get('browser_closed') is False:
                    # A driver exiting does not prove its browser descendants
                    # have exited; the owner's existing Job Object is the fallback.
                    _capture_cleanup_issue('browser_close_unconfirmed')
            elif message.get('type') == 'progress':
                progress = {key: message.get(key) for key in ('observed_video_id', 'page_errors', 'failed_requests',
                            'durations', 'response_status_counts', 'response_types', 'failed_reasons',
                            'metadata_bodies', 'metadata_body_errors', 'observed_media')}
                if progress_callback:
                    try:
                        if _resolve_only:
                            counts = progress.get('response_status_counts') or {}
                            progress_callback({'phase': 'resolving_share', 'requests': sum(v for v in counts.values() if type(v) is int and v >= 0)})
                        else:
                            progress_callback({**progress, 'proxy_connections': getattr(guard, 'connections', 0),
                            'proxy_bytes': getattr(guard, 'bytes', 0), 'proxy_denied': getattr(guard, 'denied', 0),
                            'bound_media': len(broker.entries), 'complete_media': len(broker.ready()),
                            'metadata_diagnostics': broker.metadata_diagnostics,
                            'binding_diagnostic': broker.binding_diagnostic()})
                    except AppError as exc:
                        if exc.code == 'cancelled':
                            raise
                    except Exception:
                        pass
        if not result or not result.get('ok'):
            code = (result or {}).get('code', 'douyin_browser_runtime')
            terminal = {
                'douyin_not_found':'抖音官方页面报告视频不存在或已删除，请核对链接或上传有权使用的原片。',
                'douyin_access_restricted':'抖音官方页面拒绝匿名访问，请上传有权使用的原片。',
                'douyin_login_required':'此视频需要登录；本期不采集登录态，请使用视频上传。',
                'douyin_verification_required':'此页面要求验证；采集已停止，请稍后重试或上传原片。',
                'douyin_rate_limited':'抖音官方页面限制访问频率，请稍后重试或使用上传。',
            }
            if code in terminal:
                raise AppError(code,terminal[code],code=='douyin_rate_limited')
            if code not in ('douyin_browser_identity', 'douyin_browser_runtime', 'douyin_browser_budget', 'douyin_resolve_identity', 'douyin_resolve_failed', 'cancelled'):
                code = 'douyin_browser_material'
            raise AppError(code, '匿名公开页面未取得指定原视频；未绕过登录、验证码或访问限制')
        if _resolve_only:
            resolved = _resolved_redirect(result, url)
            status = result.get('http_status')
            if type(status) is int and 100 <= status <= 599:
                resolved['http_status'] = status
            return resolved
        # Freeze completed transfers before hashing/returning the selected files.
        executor.shutdown(wait=True, cancel_futures=True)
        if not _platform_page(result.get('page_url', '')) or _identity(result['page_url']) != str(video_id):
            raise AppError('douyin_browser_identity', '浏览器未停留在指定抖音原视频')
        candidates = broker.finish(result.get('observations', []), result.get('observed_video_id'))
        if not candidates:
            raise AppError('douyin_browser_material', '匿名公开页面未返回可归属到指定视频的完整媒体；未分析摘要或其他视频')
        keep = {Path(item['path']) for item in candidates}
        durations = [item['duration'] for item in result.get('observations', [])
                     if isinstance(item.get('duration'), (int, float)) and item['duration'] > 0]
        metadata_duration = (min(broker.metadata_durations) if broker.metadata_durations and
                             max(broker.metadata_durations) - min(broker.metadata_durations) < 1 else None)
        acquisition = {'method': 'project_browser', 'identity_metadata_sha256': sorted(broker.metadata_hashes),
                       'requests': broker.requests, 'downloaded_bytes': broker.total,
                       'blocked_requests': broker.blocked, 'renderer_version': result.get('renderer_version'),
                       'native_origin_tls': native_proxy,
                       'proxy_connections': getattr(guard, 'connections', 0),
                       'proxy_bytes': getattr(guard, 'bytes', 0)}
        return {'media_paths': [item['path'] for item in candidates], 'media_files': candidates, 'video_id': str(video_id),
                'observed_video_id': result['observed_video_id'], 'resolved_url': _clean_url(result['page_url']),
                'title': broker.public_title(result.get('title', '')), 'method': 'isolated_public_browser_broker',
                'reported_duration': metadata_duration if metadata_duration is not None else (
                    durations[0] if len(result.get('observations', [])) == 1 and len(durations) == 1 else None),
                'reported_durations': durations, 'acquisition': acquisition, **acquisition}
    except AppError as exc:
        exc.capture_diagnostic = {'requests': broker.requests, 'downloaded_bytes': broker.total,
            'blocked_requests': broker.blocked, 'http_status_counts': dict(broker.statuses),
            'error_counts': dict(broker.errors), 'media_responses': len(broker.entries),
            'complete_bound_media': len(broker.complete()),
            'observed_video_id': (result or progress).get('observed_video_id'),
            'reported_durations': [x.get('duration') for x in (result or {}).get('observations', [])],
            'renderer_progress': progress, 'native_origin_tls': native_proxy,
            'proxy_connections': getattr(guard, 'connections', 0), 'proxy_bytes': getattr(guard, 'bytes', 0),
            'proxy_denied': getattr(guard, 'denied', 0), 'metadata_diagnostics': broker.metadata_diagnostics,
            'observed_media_responses': len(broker.observed_media), 'binding_diagnostic': broker.binding_diagnostic()}
        raise
    finally:
        _cleanup_capture(process=process, reader=reader, stop_reader=stop_reader,
            stop_writes=stop_writes, write_lock=write_lock, send=send, messages=messages,
            guard=guard, guard_thread=guard_thread, native_proxy=native_proxy,
            executor=executor, broker=broker, work=work, keep=keep)
