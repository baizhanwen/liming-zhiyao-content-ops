from __future__ import annotations

import argparse
import io
import json
import sqlite3
import sys
import urllib.error
import urllib.parse
import urllib.request
from collections import Counter
from pathlib import Path

from PIL import Image


def fetch_bytes(url: str) -> tuple[bytes, dict[str, str]]:
    request = urllib.request.Request(url, headers={"accept": "*/*"})
    with urllib.request.urlopen(request, timeout=30) as response:
        return response.read(), {key.lower(): value for key, value in response.headers.items()}


def decode_image(data: bytes) -> tuple[int, int, str]:
    with Image.open(io.BytesIO(data)) as image:
        image.load()
        return image.width, image.height, image.format or "unknown"


def validate_subtitle(data: bytes, content_type: str) -> None:
    text = data.decode("utf-8-sig").strip()
    if not text:
        raise ValueError("字幕内容为空")
    if "json" in content_type:
        json.loads(text)


def asset_url(base_url: str, row: sqlite3.Row) -> str:
    query = urllib.parse.urlencode({"organizationId": row["organization_id"]})
    return (
        base_url
        + "/api/video-library/"
        + urllib.parse.quote(row["library_entry_id"])
        + "/assets/"
        + urllib.parse.quote(row["id"])
        + "?"
        + query
    )


def cover_url(base_url: str, row: sqlite3.Row) -> str:
    query = urllib.parse.urlencode({"organizationId": row["organization_id"]})
    return (
        base_url
        + "/api/video-library/"
        + urllib.parse.quote(row["id"])
        + "/cover?"
        + query
    )


def main() -> int:
    parser = argparse.ArgumentParser(description="通过应用 API 逐个读取并解码本地关键帧、字幕和素材封面。")
    parser.add_argument("--database", required=True, help="本地 D1 SQLite 文件")
    parser.add_argument("--base-url", default="http://127.0.0.1:3000")
    args = parser.parse_args()

    database = Path(args.database).resolve()
    if not database.is_file():
        raise SystemExit(f"数据库不存在：{database}")
    base_url = args.base_url.rstrip("/")

    connection = sqlite3.connect(f"file:{database.as_posix()}?mode=ro", uri=True)
    connection.row_factory = sqlite3.Row
    assets = connection.execute(
        """
        SELECT asset.id, asset.organization_id, asset.project_id, asset.video_id,
               asset.kind, asset.filename, asset.content_type, asset.size_bytes,
               (
                 SELECT library.id
                 FROM video_library_entries library
                 WHERE library.organization_id = asset.organization_id
                   AND library.source_video_id = asset.video_id
                 ORDER BY library.created_at
                 LIMIT 1
               ) AS library_entry_id
        FROM media_assets asset
        WHERE asset.status = 'active'
          AND asset.kind IN ('keyframe', 'subtitle')
          AND EXISTS (SELECT 1 FROM video_library_entries library WHERE library.organization_id = asset.organization_id AND library.source_video_id = asset.video_id)
        ORDER BY asset.kind, asset.id
        """
    ).fetchall()
    covers = connection.execute(
        """
        SELECT library.id, library.organization_id
        FROM video_library_entries library
        INNER JOIN videos video
          ON video.id = library.source_video_id
         AND video.organization_id = library.organization_id
         AND video.deleted_at IS NULL
        WHERE EXISTS (
          SELECT 1
          FROM media_assets asset
          WHERE asset.organization_id = video.organization_id
            AND asset.project_id = video.project_id
            AND asset.video_id = video.id
            AND asset.kind = 'keyframe'
            AND asset.status = 'active'
        )
        ORDER BY library.id
        """
    ).fetchall()
    connection.close()

    failures: list[dict[str, str]] = []
    counts: Counter[str] = Counter()
    storage_sources: Counter[str] = Counter()

    for row in assets:
        try:
            data, headers = fetch_bytes(asset_url(base_url, row))
            if len(data) != row["size_bytes"]:
                raise ValueError(f"响应大小 {len(data)} 与数据库 {row['size_bytes']} 不一致")
            storage_sources[headers.get("x-media-storage-source", "unknown")] += 1
            if row["kind"] == "keyframe":
                width, height, image_format = decode_image(data)
                if width <= 0 or height <= 0:
                    raise ValueError("图片尺寸无效")
                counts["keyframe"] += 1
                counts["decoded_" + image_format.lower()] += 1
            else:
                validate_subtitle(data, row["content_type"] or "")
                counts["subtitle"] += 1
        except (OSError, ValueError, json.JSONDecodeError, urllib.error.URLError) as error:
            failures.append({
                "type": row["kind"],
                "id": row["id"],
                "filename": row["filename"],
                "error": str(error),
            })

    for row in covers:
        try:
            data, headers = fetch_bytes(cover_url(base_url, row))
            width, height, _ = decode_image(data)
            if width <= 0 or height <= 0:
                raise ValueError("封面尺寸无效")
            storage_sources["cover:" + headers.get("x-media-storage-source", "unknown")] += 1
            counts["cover"] += 1
        except (OSError, ValueError, urllib.error.URLError) as error:
            failures.append({
                "type": "cover",
                "id": row["id"],
                "filename": "",
                "error": str(error),
            })

    report = {
        "ok": not failures,
        "database": str(database),
        "assetRows": len(assets),
        "coverRows": len(covers),
        "counts": dict(sorted(counts.items())),
        "storageSources": dict(sorted(storage_sources.items())),
        "failureCount": len(failures),
        "failures": failures,
    }
    print(json.dumps(report, ensure_ascii=False, indent=2))
    return 0 if not failures else 1


if __name__ == "__main__":
    sys.exit(main())
