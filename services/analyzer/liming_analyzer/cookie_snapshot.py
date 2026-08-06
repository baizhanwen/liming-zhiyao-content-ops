from __future__ import annotations

import argparse
import copy
import os
import sys
import tempfile
from collections.abc import Callable, Mapping
from http.cookiejar import Cookie, LoadError, MozillaCookieJar
from pathlib import Path
from typing import Any

from yt_dlp.utils import DownloadError

from .sources import parse_browser_cookie_spec


def is_douyin_cookie(cookie: Cookie) -> bool:
    domain = cookie.domain.lstrip(".").lower()
    return domain in {"douyin.com", "iesdouyin.com"} or domain.endswith(
        (".douyin.com", ".iesdouyin.com")
    )


def _write_snapshot(cookies: list[Cookie], output: Path) -> int:
    output = output.expanduser().resolve()
    output.parent.mkdir(parents=True, exist_ok=True)
    descriptor, temporary_name = tempfile.mkstemp(
        prefix="douyin-cookies-", suffix=".txt", dir=output.parent
    )
    os.close(descriptor)
    temporary = Path(temporary_name)
    try:
        jar = MozillaCookieJar(str(temporary))
        for cookie in cookies:
            jar.set_cookie(copy.copy(cookie))
        jar.save(ignore_discard=True, ignore_expires=True)
        os.replace(temporary, output)
        return len(cookies)
    finally:
        temporary.unlink(missing_ok=True)


def import_cookie_file(source: Path, output: Path) -> int:
    source = source.expanduser().resolve()
    if not source.is_file():
        raise FileNotFoundError("The selected cookies.txt file does not exist.")
    if source.stat().st_size > 5_000_000:
        raise ValueError("The selected cookies.txt file is unexpectedly large.")
    jar = MozillaCookieJar(str(source))
    try:
        jar.load(ignore_discard=True, ignore_expires=True)
    except (OSError, ValueError, LoadError) as error:
        raise ValueError(
            "The selected file is not a valid Netscape cookies.txt export."
        ) from error
    cookies = [cookie for cookie in jar if is_douyin_cookie(cookie)]
    if not cookies:
        raise ValueError("The selected file does not contain Douyin cookies.")
    return _write_snapshot(cookies, output)


def snapshot_browser_cookies(
    browser: str,
    output: Path,
    factory: Callable[[Mapping[str, Any]], Any] | None = None,
) -> int:
    if factory is None:
        from yt_dlp import YoutubeDL

        factory = YoutubeDL
    browser_spec = parse_browser_cookie_spec(browser)
    if browser_spec is None:
        raise ValueError("browser cookie configuration is required")

    with factory(
        {"cookiesfrombrowser": browser_spec, "quiet": True, "no_warnings": True}
    ) as downloader:
        cookies = [cookie for cookie in downloader.cookiejar if is_douyin_cookie(cookie)]
    if not cookies:
        raise RuntimeError(
            "No Douyin cookies were found. Open douyin.com in the selected browser first."
        )
    return _write_snapshot(cookies, output)


def main() -> None:
    parser = argparse.ArgumentParser(description="Create a local Douyin-only cookie snapshot")
    source = parser.add_mutually_exclusive_group(required=True)
    source.add_argument("--browser")
    source.add_argument("--import-file")
    parser.add_argument("--output", default=".local/douyin-cookies.txt")
    arguments = parser.parse_args()
    try:
        if arguments.import_file:
            count = import_cookie_file(Path(arguments.import_file), Path(arguments.output))
        else:
            count = snapshot_browser_cookies(arguments.browser, Path(arguments.output))
    except (OSError, ValueError, RuntimeError, DownloadError) as error:
        message = str(error)
        if "DPAPI" in message:
            message = (
                "Edge uses Windows app-bound cookie encryption. Export cookies.txt from "
                "inside Edge, then run refresh-douyin-cookies.bat again."
            )
        print(f"[ERROR] {message}", file=sys.stderr)
        raise SystemExit(1) from None
    print(f"Saved {count} Douyin cookies to the protected local snapshot.")


if __name__ == "__main__":
    main()
