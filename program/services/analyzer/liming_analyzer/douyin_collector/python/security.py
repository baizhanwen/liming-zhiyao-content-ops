# Adapted from Skill Collect, MIT Copyright (c) 2026 baizhanwen.
import ipaddress
import json
import re
import socket
import threading
import time
from urllib.parse import urlsplit, urljoin

import httpx


class AppError(Exception):
    def __init__(self, code, message, retryable=False, status=400):
        super().__init__(message)
        self.code, self.message, self.retryable, self.status = code, message, retryable, status


_FAKE_IP = ipaddress.ip_network('198.18.0.0/15')
_DNS_CACHE = {}
_DNS_LOCK = threading.RLock()


def _resolve_fakeip(hostname, transport=None):
    """Resolve a FakeIP-only answer with a fixed, TLS-verified public DoH server.

    This never accepts the FakeIP itself, follows resolver redirects, reads proxy
    settings, or makes a second system DNS lookup for the resolver hostname.
    An injected transport is only for explicit offline service contracts.
    """
    try:
        hostname = hostname.rstrip('.').lower().encode('idna').decode('ascii')
    except (UnicodeError, ValueError):
        raise AppError('dns', '来源域名格式不合法') from None
    with _DNS_LOCK:
        cached = _DNS_CACHE.get(hostname) if transport is None else None
        if cached and cached[0] > time.monotonic():
            return list(cached[1])
    try:
        deadline = time.monotonic() + 8
        with httpx.Client(transport=transport or httpx.HTTPTransport(retries=0),
                          timeout=httpx.Timeout(5), trust_env=False, follow_redirects=False) as client:
            with client.stream('GET', 'https://8.8.8.8/resolve',
                               params={'name': hostname, 'type': 'A'},
                               headers={'Host': 'dns.google', 'Accept': 'application/dns-json'},
                               extensions={'sni_hostname': 'dns.google'}) as response:
                if response.status_code != 200:
                    raise ValueError('resolver HTTP failure')
                raw = bytearray()
                for chunk in response.iter_bytes():
                    if time.monotonic() > deadline:
                        raise ValueError('resolver deadline')
                    raw.extend(chunk)
                    if len(raw) > 65536:
                        raise ValueError('resolver size limit')
        data = json.loads(raw)
        if data.get('Status') != 0 or data.get('TC') or data.get('CD'):
            raise ValueError('resolver failure')
        if not any(q.get('name', '').rstrip('.').lower() == hostname and q.get('type') == 1
                   for q in data.get('Question', [])):
            raise ValueError('resolver question mismatch')
        answers = data.get('Answer', [])
        if not isinstance(answers, list) or len(answers) > 64:
            raise ValueError('resolver answer limit')
        aliases = {}
        for row in answers:
            if row.get('type') == 5:
                name, target = row['name'].rstrip('.').lower(), row['data'].rstrip('.').lower()
                if name in aliases and aliases[name] != target:
                    raise ValueError('conflicting CNAME')
                aliases[name] = target
        names, current = {hostname}, hostname
        while current in aliases:
            current = aliases[current]
            if current in names or len(names) >= 10:
                raise ValueError('CNAME cycle or limit')
            names.add(current)
        ips, ttls = [], []
        for row in answers:
            if row.get('type') == 1:
                address = ipaddress.ip_address(row['data'])
                if address.version != 4 or not address.is_global or row['name'].rstrip('.').lower() not in names:
                    raise ValueError('unsafe or unrelated DNS answer')
                ips.append(str(address))
                ttls.append(max(0, int(row.get('TTL', 0))))
        ips = list(dict.fromkeys(ips))
        if not ips:
            raise ValueError('no public A records')
        # Include CNAME TTLs; never keep a substituted answer longer than 30s.
        ttls.extend(max(0, int(row.get('TTL', 0))) for row in answers if row.get('type') == 5)
        lifetime = min([30, *ttls])
        if transport is None and lifetime:
            with _DNS_LOCK:
                if len(_DNS_CACHE) >= 128:
                    _DNS_CACHE.pop(next(iter(_DNS_CACHE)))
                _DNS_CACHE[hostname] = (time.monotonic() + lifetime, tuple(ips))
        return ips
    except Exception:
        # Resolver response bodies, URLs and exception text can contain private data.
        raise AppError('dns', '公共 DNS 解析未完成，请检查网络后重试', True) from None


def public_url(url):
    p = urlsplit(url)
    try:
        port=p.port
    except ValueError:
        raise AppError('unsafe_url','链接端口不合法')
    if p.scheme != 'https' or not p.hostname or p.username or p.password or port not in (None,443):
        raise AppError('unsafe_url', '只允许无凭证的公共 HTTPS 链接')
    try:
        addresses = socket.getaddrinfo(p.hostname, port or (443 if p.scheme == 'https' else 80), type=socket.SOCK_STREAM)
    except socket.gaierror:
        raise AppError('dns', '无法解析来源地址', True)
    ips = list(dict.fromkeys(a[4][0] for a in addresses))
    # Only the dedicated FakeIP range is eligible. Mixed loopback/private answers
    # and user-supplied IP literals remain rejected without contacting a resolver.
    try:
        ipaddress.ip_address(p.hostname)
        literal = True
    except ValueError:
        literal = False
    if not literal and ips and all(ipaddress.ip_address(ip) in _FAKE_IP for ip in ips):
        ips = _resolve_fakeip(p.hostname)
    if not ips or any(not ipaddress.ip_address(ip).is_global for ip in ips):
        raise AppError('unsafe_url','来源链接不能访问本机、内网或保留地址')
    return ips


class PublicTransport(httpx.BaseTransport):
    """Resolve, validate and pin each connection; redirect targets go through the same check."""
    def __init__(self):
        # The pool sees pinned IP URLs. Reusing an IP connection for a different
        # original hostname could skip the second hostname's TLS verification.
        self.transport = httpx.HTTPTransport(retries=0, limits=httpx.Limits(max_keepalive_connections=0))

    def handle_request(self, request):
        ips = public_url(str(request.url))
        hostname = request.url.host
        headers=request.headers.copy();headers['host']=request.url.netloc.decode()
        extensions={**request.extensions,'sni_hostname':hostname}
        pinned=httpx.Request(request.method,request.url.copy_with(host=ips[0]),headers=headers,stream=request.stream,extensions=extensions)
        return self.transport.handle_request(pinned)

    def close(self):
        self.transport.close()


def fetch_public(url, max_bytes=2_000_000, *, headers=None, cancelled=None,
                 progress_callback=None, official_only=False):
    def no_cookies(request):
        request.headers.pop('cookie', None)
    identities = set()
    def check_url(value):
        try:
            parsed = urlsplit(value)
            port = parsed.port
        except ValueError:
            raise AppError('unsafe_url', '来源地址格式不合法') from None
        if (parsed.scheme != 'https' or parsed.username or parsed.password or
                port not in (None, 443)):
            raise AppError('unsafe_url', '来源及跳转必须使用公共 HTTPS')
        if official_only and not any(parsed.hostname == domain or (parsed.hostname or '').endswith('.'+domain)
                                     for domain in ('douyin.com', 'iesdouyin.com')):
            raise AppError('douyin_browser_identity', '分享跳转必须保持在抖音官方域名')
        if official_only:
            identity = re.search(r'/(?:share/)?video/([0-9]{1,32})(?:/|$)', parsed.path)
            if identity:
                identities.add(identity[1])
            if len(identities) > 1:
                raise AppError('douyin_browser_identity', '分享跳转包含不同视频标识')
    def check_cancel():
        if cancelled and cancelled():
            raise AppError('cancelled', '任务已取消')
    with httpx.Client(transport=PublicTransport(), timeout=25, follow_redirects=False, trust_env=False) as client:
        client.event_hooks['request'] = [no_cookies]
        deadline = time.monotonic() + (120 if max_bytes > 2_000_000 else 30)
        for hop in range(6):
            check_cancel(); check_url(url)
            with client.stream('GET', url, headers={'User-Agent':'Zhixu/1.0 (public media acquisition)',
                               'Accept-Encoding':'identity', **(headers or {})}) as r:
                if r.is_redirect:
                    if hop == 5 or not r.headers.get('location'):
                        raise AppError('source_redirect', '来源跳转过多或无效')
                    url = urljoin(str(r.url), r.headers['location'])
                    check_url(url)
                    continue
                r.raise_for_status()
                chunks, size = [], 0
                for chunk in r.iter_bytes():
                    check_cancel()
                    if time.monotonic() > deadline:
                        raise AppError('source_timeout','来源下载超过等待时限，请稍后重试',True)
                    size += len(chunk)
                    if size > max_bytes:
                        raise AppError('too_large','来源下载超过大小限制')
                    chunks.append(chunk)
                    if progress_callback:
                        progress_callback({'phase':'public_page', 'downloaded_bytes':size})
                result_headers = dict(r.headers)
                result_headers['x-collector-http-status'] = str(r.status_code)
                return b''.join(chunks), str(r.url), result_headers
        raise AppError('source_redirect', '来源跳转过多')
