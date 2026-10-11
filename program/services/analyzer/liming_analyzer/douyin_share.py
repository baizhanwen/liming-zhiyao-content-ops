from __future__ import annotations

import json
import logging
import re
from collections.abc import Mapping
from typing import Any

from yt_dlp import YoutubeDL
from yt_dlp.extractor.tiktok import DouyinIE
from yt_dlp.utils import ExtractorError

logger = logging.getLogger(__name__)

# The public mobile share page embeds the video already served to its player.
# This fallback neither generates request signatures nor solves login challenges.
SHARE_USER_AGENT = (
    "Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X) "
    "AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.0 Mobile/15E148 Safari/604.1"
)


def share_video_detail(webpage: str, video_id: str) -> dict[str, Any] | None:
    marker = re.search(r"window\._ROUTER_DATA\s*=\s*", webpage)
    if marker is None or len(webpage) > 5_000_000:
        return None
    try:
        data, _ = json.JSONDecoder().raw_decode(webpage[marker.end():].lstrip())
    except (ValueError, RecursionError):
        return None
    loaders = data.get("loaderData") if isinstance(data, dict) else None
    if not isinstance(loaders, dict):
        return None
    for loader in loaders.values():
        response = loader.get("videoInfoRes") if isinstance(loader, dict) else None
        if not isinstance(response, dict) or response.get("status_code", 0) != 0:
            continue
        items = response.get("item_list")
        if not isinstance(items, list):
            continue
        for item in items:
            if isinstance(item, dict) and str(item.get("aweme_id")) == video_id and isinstance(item.get("video"), dict):
                # Share pages use null for absent alternate bitrates; yt-dlp expects a list.
                video = item["video"]
                return {**item, "video": {**video, "bit_rate": video.get("bit_rate") or []}}
    return None


class DouyinShareFallbackIE(DouyinIE):
    def _real_extract(self, url: str) -> dict[str, Any]:
        try:
            return super()._real_extract(url)
        except ExtractorError as primary:
            # Do not turn deleted/private videos or unrelated extractor errors into retries.
            if "Fresh cookies" not in str(primary):
                raise
            video_id = self._match_id(url)
            logger.info("Douyin detail API rejected metadata; trying public share page")
            try:
                detail = None
                for attempt in range(2):
                    webpage = self._download_webpage(
                        f"https://www.iesdouyin.com/share/video/{video_id}/", video_id,
                        note="Downloading public share page", headers={"User-Agent": SHARE_USER_AGENT},
                    )
                    detail = share_video_detail(webpage, video_id)
                    if detail is not None:
                        break
                    if attempt == 0:
                        self._sleep(1, video_id)
                if detail is None:
                    raise primary
                result = self._parse_aweme_video_app(detail)
                if not result.get("formats"):
                    raise primary
                logger.info("Douyin public share page returned playable metadata")
                return result
            except (ValueError, KeyError, TypeError):
                # Preserve the safe access-error guidance if the site's page schema changes.
                raise primary from None


def create_public_video_downloader(options: Mapping[str, Any]) -> YoutubeDL:
    # Register before built-in extractors so short-link redirects select this adapter too.
    downloader = YoutubeDL(dict(options), auto_init=False)
    downloader.add_info_extractor(DouyinShareFallbackIE(downloader))
    downloader.add_default_info_extractors()
    return downloader
