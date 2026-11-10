# Adapted from Skill Collect, MIT Copyright (c) 2026 baizhanwen.
import html
import hashlib
import json
import math
import re
import shutil
import subprocess
import time
from pathlib import Path
from html.parser import HTMLParser
from urllib.parse import unquote, urlsplit, urlunsplit

from .security import AppError, fetch_public
from .runtime import media_executable

MAX_UPLOAD = 100*1024*1024
MAX_DURATION = 1200
_PROGRESS_PHASES = {'public_page', 'resolving_share', 'browser', 'validating_media', 'merging_media', 'audio_chunks', 'frames'}
_PROGRESS_COUNTS = {'completed', 'total', 'requests', 'downloaded_bytes', 'proxy_connections',
                    'proxy_bytes', 'media_responses', 'complete_bound_media'}


def _progress_count(value):
    return type(value) is int and 0 <= value <= 2**63 - 1


def _notify_progress(callback, phase, **counts):
    """Observability is optional; cancellation remains a business control signal."""
    if callback is None or phase not in _PROGRESS_PHASES:
        return
    event = {'phase': phase, **{key: value for key, value in counts.items()
                             if key in _PROGRESS_COUNTS and _progress_count(value)}}
    try:
        callback(event)
    except AppError as exc:
        if exc.code == 'cancelled':
            raise
    except Exception:
        pass


def extract_url(text):
    m=re.search(r'https?://[^\s<>"，。；、]+',text)
    if not m:
        raise AppError('url','请提供单条抖音分享链接，或上传视频')
    return m.group(0).rstrip(').!）]')


def run_media(args,timeout=90, *, cancelled=None):
    args = [media_executable(args[0]), *args[1:]]
    process = None
    try:
        if cancelled is None:
            return subprocess.run(args,check=True,capture_output=True,timeout=timeout).stdout
        process = subprocess.Popen(args, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        deadline = time.monotonic()+timeout
        while True:
            if cancelled():
                raise AppError('cancelled', '任务已取消')
            if time.monotonic()>deadline:
                raise AppError('media_processing','媒体处理超时，请检查文件格式与时长')
            try:
                output, _ = process.communicate(timeout=.2)
                if process.returncode:
                    raise AppError('media_processing','媒体处理失败，请检查文件格式与时长')
                return output
            except subprocess.TimeoutExpired:
                continue
    except FileNotFoundError:
        raise AppError('ffmpeg_missing','未安装 FFmpeg/FFprobe，请在诊断页查看安装说明')
    except (subprocess.CalledProcessError,subprocess.TimeoutExpired):
        raise AppError('media_processing','媒体处理失败或超时，请检查文件格式与时长')
    finally:
        if process is not None:
            if process.poll() is None:
                process.kill()
            process.communicate()


def inspect_video(path):
    info=json.loads(run_media(['ffprobe','-v','error','-protocol_whitelist','file,pipe','-format_whitelist','mov,matroska,webm,wav,mp3','-show_format','-show_streams','-of','json',str(path)]))
    try:
        duration=float(info['format']['duration'])
        if not math.isfinite(duration) or duration<=0 or duration>MAX_DURATION:
            raise ValueError()
    except (KeyError,ValueError):
        raise AppError('duration','媒体时长须在 0—20 分钟范围内')
    return {'duration':duration,'video':any(s['codec_type']=='video' for s in info['streams']),'audio':any(s['codec_type']=='audio' for s in info['streams'])}


_MOBILE_UA = ('Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) '
              'AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1')


def _douyin_host(host):
    return any(host == domain or host.endswith('.' + domain) for domain in ('douyin.com', 'iesdouyin.com'))


def _video_id(url):
    try:
        match = re.search(r'/(?:share/)?video/(\d+)(?:/|$)', urlsplit(url).path)
    except ValueError:
        return None
    return match[1] if match else None


class _PublicPage(HTMLParser):
    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.scripts, self.current, self.metadata, self.videos = [], None, {}, []

    def handle_starttag(self, tag, attrs):
        attrs = dict(attrs)
        if tag == 'script':
            self.current = (attrs, [])
        elif tag == 'meta':
            self.metadata[attrs.get('property', attrs.get('name', ''))] = attrs.get('content', '')
        elif tag in ('video', 'source'):
            self.videos.append(attrs)

    def handle_data(self, data):
        if self.current is not None:
            self.current[1].append(data)

    def handle_endtag(self, tag):
        if tag == 'script' and self.current is not None:
            self.scripts.append((self.current[0], ''.join(self.current[1])))
            self.current = None


def _published_media(page, video_id):
    """Parse static public data only; never execute scripts or solve challenges.

    Only media belonging to an explicit matching item ID is considered. A nearby
    recommendation, cover image, platform AI summary or an invented API URL is
    never a substitute for the requested video's media.
    """
    parser = _PublicPage()
    parser.feed(page)
    documents = []
    for attrs, script in parser.scripts:
        try:
            if attrs.get('id') == 'RENDER_DATA':
                documents.append(json.loads(unquote(script)))
            elif attrs.get('type') == 'application/json' or attrs.get('id') == '__NEXT_DATA__':
                documents.append(json.loads(script))
            else:
                match = re.search(r'(?:window\.)?_ROUTER_DATA\s*=\s*', script)
                if match:
                    documents.append(json.JSONDecoder().raw_decode(script[match.end():])[0])
        except (ValueError, TypeError, RecursionError):
            continue
    candidates = []

    def add(value, method):
        if isinstance(value, dict):
            for key in ('url_list', 'urlList'):
                for item in value.get(key, []) if isinstance(value.get(key), list) else []:
                    add(item, method)
        elif isinstance(value, str):
            # Preserve the published path/query exactly, including watermark and
            # quality parameters. Only an explicitly supplied HTTPS URL is usable.
            try:
                p = urlsplit(value)
            except ValueError:
                return
            if p.scheme == 'https' and p.hostname and not p.username and not p.password:
                if all(value != old[0] for old in candidates):
                    candidates.append((value, method))

    def collect(video):
        if not isinstance(video, dict):
            return
        for key in ('play_addr', 'playAddr', 'download_addr', 'downloadAddr', 'play_api'):
            add(video.get(key), 'public_item_' + key)
        for key in ('bit_rate', 'bitRate'):
            for variant in video.get(key, []) if isinstance(video.get(key), list) else []:
                if isinstance(variant, dict):
                    for address in ('play_addr', 'playAddr'):
                        add(variant.get(address), 'public_item_' + key)

    # Iterative traversal also bounds deeply nested, untrusted JSON documents.
    queue, inspected = list(documents), 0
    while queue and inspected < 20000:
        node = queue.pop()
        inspected += 1
        if isinstance(node, dict):
            identity = next((str(node[k]) for k in ('aweme_id', 'awemeId', 'item_id', 'itemId', 'id') if k in node), None)
            if video_id == identity:
                collect(node.get('video'))
                collect(node)
            queue.extend(v for v in node.values() if isinstance(v, (dict, list)))
        elif isinstance(node, list):
            queue.extend(node)
    # Public HTML media is accepted only when its own identity is explicit.
    for attrs in parser.videos:
        if attrs.get('data-video-id', attrs.get('data-aweme-id')) == video_id:
            add(attrs.get('src'), 'public_video_element')
    if _video_id(parser.metadata.get('og:url', '')) == video_id:
        for key in ('og:video:secure_url', 'og:video:url', 'og:video'):
            add(parser.metadata.get(key), 'public_open_graph')
    return candidates[:4]


def _published_duration(page, video_id):
    """Read duration only from a matching public item; ambiguous values fail closed."""
    parser = _PublicPage(); parser.feed(page)
    durations = set()
    for attrs, script in parser.scripts:
        try:
            if attrs.get('id') == 'RENDER_DATA':
                root = json.loads(unquote(script))
            elif attrs.get('type') == 'application/json' or attrs.get('id') == '__NEXT_DATA__':
                root = json.loads(script)
            else:
                match = re.search(r'(?:window\.)?_ROUTER_DATA\s*=\s*', script)
                if not match: continue
                root = json.JSONDecoder().raw_decode(script[match.end():])[0]
        except (ValueError, TypeError, RecursionError):
            continue
        stack, count = [root], 0
        while stack and count < 20000:
            node = stack.pop(); count += 1
            if isinstance(node, dict):
                identity = next((str(node[k]) for k in ('aweme_id', 'awemeId', 'item_id', 'itemId', 'id') if k in node), None)
                if identity == video_id:
                    value = node.get('video', {}).get('duration') if isinstance(node.get('video'), dict) else node.get('duration')
                    if isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(value):
                        seconds = value/1000 if value > MAX_DURATION else value
                        if 0 < seconds <= MAX_DURATION: durations.add(seconds)
                stack.extend(v for v in node.values() if isinstance(v, (dict, list)))
            elif isinstance(node, list):
                stack.extend(node)
    return min(durations) if durations and max(durations)-min(durations)<1 else None


def _validate_complete_response(headers, size):
    """Reject a single partial HTTP response even if ffprobe can play it."""
    headers = {k.lower(): v for k, v in headers.items()}
    if size <= 0 or size > MAX_UPLOAD:
        raise AppError('douyin_incomplete', '原片为空或超过大小限制')
    length = headers.get('content-length')
    if length is not None and (not length.isdigit() or int(length) != size):
        raise AppError('douyin_incomplete', '下载长度与响应声明不一致')
    extent = headers.get('content-range')
    if headers.get('x-collector-http-status') == '206' and not extent:
        raise AppError('douyin_incomplete', '分段响应缺少完整范围')
    if extent:
        match = re.fullmatch(r'bytes 0-([0-9]+)/([0-9]+)', extent)
        if not match or int(match[1])+1 != size or int(match[2]) != size:
            raise AppError('douyin_incomplete', '仅取得部分媒体，尚未取得完整原片')


def _browser_douyin_source(url, folder, video_id, cancelled=None, *, progress_callback=None, timeout=180):
    """Product-owned rendering fallback; metadata alone can never be a source."""
    from .browser_capture import capture_douyin
    _notify_progress(progress_callback, 'browser')
    last_browser_event = None

    def browser_progress(raw):
        nonlocal last_browser_event
        if not isinstance(raw, dict):
            return
        counters = {key: raw[key] for key in ('requests', 'downloaded_bytes', 'proxy_connections', 'proxy_bytes')
                    if _progress_count(raw.get(key))}
        responses = raw.get('response_status_counts')
        if isinstance(responses, dict) and all(_progress_count(value) for value in responses.values()):
            count = sum(responses.values())
            if _progress_count(count):
                counters['requests'] = count
        for source, target in (('observed_media', 'media_responses'), ('complete_media', 'complete_bound_media')):
            if _progress_count(raw.get(source)):
                counters[target] = raw[source]
        if not counters:
            return
        if counters != last_browser_event:
            _notify_progress(progress_callback, 'browser', **counters)
            last_browser_event = counters

    options = {'video_id': video_id, 'timeout': timeout, 'max_bytes': MAX_UPLOAD, 'cancelled': cancelled}
    if progress_callback is not None:
        options['progress_callback'] = browser_progress
    captured=capture_douyin(f'https://www.douyin.com/video/{video_id}',folder,**options)
    if str(captured.get('observed_video_id'))!=str(video_id):
        raise AppError('douyin_browser_identity','自动采集的视频标识与分享链接不一致')
    resolved=captured.get('resolved_url','')
    if not _douyin_host(urlsplit(resolved).hostname or '') or _video_id(resolved)!=str(video_id):
        raise AppError('douyin_browser_identity','采集器未停留在指定抖音原视频')
    paths=captured.get('media_paths',[])
    if not isinstance(paths,list) or not paths:
        raise AppError('douyin_browser_material','自动采集仅取得页面信息，尚未取得完整原片')
    records={str(Path(item['path']).resolve()):item for item in captured.get('media_files',[])
        if isinstance(item,dict) and isinstance(item.get('path'),str)}
    root=folder.resolve(); assets=[]
    selected_paths=paths[:8]
    _notify_progress(progress_callback, 'validating_media', completed=0, total=len(selected_paths))
    for index,value in enumerate(selected_paths):
        try:
            path=Path(value)
            if path.is_symlink() or not path.resolve().is_relative_to(root) or not path.is_file():continue
            size=path.stat().st_size
            if not 0<size<=MAX_UPLOAD:continue
            record=records.get(str(path.resolve()),{})
            if record.get('complete') is not True or record.get('size')!=size:continue
            if record.get('coverage')!=[[0,size]]:continue
            if str(record.get('video_id'))!=str(video_id):continue
            digest=hashlib.sha256(path.read_bytes()).hexdigest()
            if record.get('sha256')!=digest:continue
            probe=inspect_video(path)
            reported=captured.get('reported_duration')
            if isinstance(reported,(int,float)) and reported>0 and abs(probe['duration']-reported)>max(1,reported*.02):continue
            assets.append({'path':path,'size':size,'sha256':digest,'probe':probe})
        except AppError as exc:
            if exc.code == 'cancelled':
                raise
            continue
        except (OSError,ValueError,TypeError):continue
        finally:
            _notify_progress(progress_callback, 'validating_media', completed=index+1, total=len(selected_paths))
    complete=next((item for item in assets if item['probe']['video'] and item['probe']['audio']),None)
    components=[]
    part=folder/'douyin.mp4.part'
    try:
        if complete:
            _notify_progress(progress_callback, 'merging_media', completed=0, total=1)
            shutil.copyfile(complete['path'],part)
            _notify_progress(progress_callback, 'merging_media', completed=1, total=1)
            components=[complete['sha256']]
        else:
            video=next((item for item in assets if item['probe']['video']),None)
            audio=next((item for item in assets if item['probe']['audio'] and not item['probe']['video']),None)
            if not video:
                raise AppError('douyin_browser_material','自动采集未取得指定原片的完整视频轨')
            if audio:
                if abs(video['probe']['duration']-audio['probe']['duration'])>max(1,video['probe']['duration']*.02):
                    raise AppError('douyin_browser_material','采集音画时长不一致，未合成为原片分析')
                _notify_progress(progress_callback, 'merging_media', completed=0, total=1)
                run_media(['ffmpeg','-nostdin','-v','error','-y','-protocol_whitelist','file,pipe',
                    '-format_whitelist','mov,matroska,webm,wav,mp3','-i',str(video['path']),
                    '-protocol_whitelist','file,pipe','-format_whitelist','mov,matroska,webm,wav,mp3',
                    '-i',str(audio['path']),'-map','0:v:0','-map','1:a:0','-c','copy',
                    '-movflags','+faststart','-f','mp4',str(part)], cancelled=cancelled)
                _notify_progress(progress_callback, 'merging_media', completed=1, total=1)
                components=[video['sha256'],audio['sha256']]
            else:
                _notify_progress(progress_callback, 'merging_media', completed=0, total=1)
                shutil.copyfile(video['path'],part)
                _notify_progress(progress_callback, 'merging_media', completed=1, total=1)
                components=[video['sha256']]
        if part.stat().st_size>MAX_UPLOAD:
            raise AppError('douyin_browser_material','自动取得的原视频超过100MB限制')
        _notify_progress(progress_callback, 'validating_media', completed=0, total=1)
        probe=inspect_video(part)
        if not probe['video']:
            raise AppError('douyin_browser_material','未验证到原视频轨，不以页面信息作为成功')
        _notify_progress(progress_callback, 'validating_media', completed=1, total=1)
        final=folder/'douyin.mp4';part.replace(final)
        # Only explicitly safe counters/digests leave the transient renderer.
        meta=captured.get('acquisition',{})
        acquisition={key:meta[key] for key in ('requests','downloaded_bytes','blocked_requests',
            'renderer_version','identity_metadata_sha256','native_origin_tls','proxy_connections',
            'proxy_bytes') if key in meta}
        acquisition.update(method='project_browser',media_sha256=hashlib.sha256(final.read_bytes()).hexdigest())
        acquisition.update(media_bytes=final.stat().st_size,probe=probe,component_media_sha256=components,
                           reported_duration=captured.get('reported_duration'),
                           coverage=[[0,final.stat().st_size]],complete=True,identity_bound=True)
        result={'platform':'douyin','url':url,'resolved_url':resolved,'video_id':str(video_id),
            'title':str(captured.get('title') or '抖音视频')[:500],'text':'','evidence':[],
            'media_path':str(final),'basis':'video_pending','files':[],'acquisition':acquisition}
        if not probe['audio']:result['limitations']=['采集到的视频未发现音轨，当前不能分析原音']
        return result
    finally:
        part.unlink(missing_ok=True)


def douyin_source(url, folder, *, cancelled=None, progress_callback=None, browser_timeout=180):
    if cancelled and cancelled():
        raise AppError('cancelled', '任务已取消')
    parsed=urlsplit(url)
    if not _douyin_host(parsed.hostname or ''):
        raise AppError('unsupported_source', '当前仅支持抖音官方分享链接和视频上传')
    try:port=parsed.port
    except ValueError:raise AppError('unsafe_url','抖音链接端口无效') from None
    if parsed.scheme != 'https' or parsed.username or parsed.password or port not in (None,443):
        raise AppError('unsafe_url','请提供无认证信息的抖音分享链接')
    folder = Path(folder)
    pages, tried, video_id = [url], set(), _video_id(url)
    last_error = None
    responses = downloaded_bytes = 0
    _notify_progress(progress_callback, 'public_page', completed=0, requests=0, downloaded_bytes=0)
    for page_url in pages:
        if page_url in tried:
            continue
        tried.add(page_url)
        try:
            payload, final, _ = fetch_public(page_url, headers={'User-Agent': _MOBILE_UA}, cancelled=cancelled,
                progress_callback=progress_callback, official_only=True)
            responses += 1
            downloaded_bytes += len(payload)
            _notify_progress(progress_callback, 'public_page', completed=responses,
                             requests=responses, downloaded_bytes=downloaded_bytes)
            if not _douyin_host(urlsplit(final).hostname or ''):
                raise AppError('douyin_material', '抖音分享页跳转到不支持的来源，请补传原视频')
            resolved_id = _video_id(final)
            if video_id and resolved_id and video_id != resolved_id:
                raise AppError('douyin_material', '公开页视频标识与请求不一致，请核对分享链接')
            video_id = video_id or resolved_id
            page = payload.decode('utf-8', 'replace')
            candidates = _published_media(page, video_id) if video_id else []
            published_duration = _published_duration(page, video_id) if video_id else None
            # A playable clip without official duration cannot establish full-film coverage.
            if published_duration is None:
                candidates = []
            if not candidates and video_id and len(pages) == 1:
                share = f'https://www.iesdouyin.com/share/video/{video_id}/'
                if urlsplit(final).hostname != 'www.iesdouyin.com':
                    pages.append(share)
            title = re.search(r'<title[^>]*>(.*?)</title>', page, re.S | re.I)
            title = html.unescape(title[1]).strip()[:500] if title else '抖音视频'
            for media_url, method in candidates:
                path = folder / 'douyin.mp4.part'
                try:
                    media, media_final, media_headers = fetch_public(media_url, MAX_UPLOAD,
                        headers={'User-Agent': _MOBILE_UA}, cancelled=cancelled, progress_callback=progress_callback)
                    _validate_complete_response(media_headers, len(media))
                    responses += 1
                    downloaded_bytes += len(media)
                    _notify_progress(progress_callback, 'public_page', completed=responses,
                                     requests=responses, downloaded_bytes=downloaded_bytes)
                    folder.mkdir(parents=True, exist_ok=True)
                    path.write_bytes(media)
                    _notify_progress(progress_callback, 'validating_media', completed=0, total=1)
                    probe = inspect_video(path)
                    if abs(probe['duration']-published_duration)>max(1,published_duration*.02):
                        raise AppError('douyin_incomplete', '原片时长与官方资料不一致，请重试或上传原片')
                    if not probe['video']:
                        raise AppError('douyin_material', '公开媒体不是视频，不能替代原片分析')
                    _notify_progress(progress_callback, 'validating_media', completed=1, total=1)
                    final_path = folder / 'douyin.mp4'
                    path.replace(final_path)
                    clean_final = urlunsplit((*urlsplit(final)[:3], '', ''))
                    result = {'platform': 'douyin', 'url': url, 'resolved_url': clean_final,
                              'video_id': video_id, 'title': title, 'text': '', 'evidence': [],
                              'media_path': str(final_path), 'basis': 'video_pending', 'files': [],
                              'acquisition': {'method': method, 'page_sha256': hashlib.sha256(payload).hexdigest(),
                                  'media_sha256': hashlib.sha256(media).hexdigest(), 'media_bytes': len(media),
                                  'media_url_sha256': hashlib.sha256(media_url.encode()).hexdigest(),
                                  'media_host': urlsplit(media_final).hostname, 'probe': probe,
                                  'reported_duration':published_duration, 'coverage':[[0,len(media)]],
                                  'complete':True, 'identity_bound':True}}
                    if not probe['audio']:
                        result['limitations'] = ['原视频未发现音轨，不能进行原音转写']
                    return result
                except AppError as exc:
                    if exc.code == 'cancelled':
                        raise
                    last_error = exc
                except Exception:
                    last_error = AppError('douyin_fetch', '公开媒体下载未完成，请补传原视频', True)
                finally:
                    path.unlink(missing_ok=True)
        except AppError as exc:
            if exc.code == 'cancelled':
                raise
            last_error = exc
        except Exception:
            last_error = AppError('douyin_fetch', '抖音公开页获取未完成，请检查网络或补传视频', True)
    if not video_id:
        video_id = _resolve_douyin_source_id(url, folder, cancelled, progress_callback)
    if video_id:
        options = {'cancelled':cancelled}
        if progress_callback is not None: options['progress_callback'] = progress_callback
        if browser_timeout != 180: options['timeout'] = browser_timeout
        return _browser_douyin_source(url,folder,video_id,**options)
    if last_error:
        raise AppError('douyin_fetch', '项目未能解析此抖音原视频，请检查网络或平台访问限制；没有用网页摘要代替原片', last_error.retryable)
    raise AppError('douyin_material', '项目未能取得当前原视频标识；没有用网页标题或摘要代替原片')


def _resolve_douyin_source_id(url, folder, cancelled, progress_callback):
    """Resolve only the original official HTTP redirect with the project browser."""
    from .browser_capture import resolve_douyin_url
    _notify_progress(progress_callback, 'resolving_share', completed=0, total=1)
    resolved = resolve_douyin_url(url, folder, cancelled=cancelled, progress_callback=progress_callback)
    if (not isinstance(resolved, dict) or resolved.get('method') != 'official_browser_redirect'
            or not isinstance(resolved.get('video_id'), str)
            or not re.fullmatch(r'[0-9]{1,32}', resolved['video_id'])):
        raise AppError('douyin_browser_identity', '项目浏览器没有确认原始分享链接的视频标识')
    canonical = resolved.get('resolved_url', '')
    try:
        parsed = urlsplit(canonical)
        valid = (parsed.scheme == 'https' and not parsed.username and not parsed.password
            and parsed.port in (None, 443) and _douyin_host(parsed.hostname or '')
            and _video_id(canonical) == resolved['video_id'])
    except (ValueError, TypeError):
        valid = False
    if not valid:
        raise AppError('douyin_browser_identity', '分享跳转没有指向同一目标的官方视频页')
    _notify_progress(progress_callback, 'resolving_share', completed=1, total=1)
    return resolved['video_id']
