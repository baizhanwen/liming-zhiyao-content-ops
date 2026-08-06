from __future__ import annotations

import argparse
import copy
import os
import tempfile
from collections.abc import Callable, Mapping
from http.cookiejar import Cookie, MozillaCookieJar
from pathlib import Path
from typing import Any

from .sources import parse_browser_cookie_spec


def is_douyin_cookie(cookie: Cookie) -> bool:
    domain = cookie.domain.lstrip(".").lower()
    return domain in {"douyin.com", "iesdouyin.com"} or domain.endswith(
        (".douyin.com", ".iesdouyin.com")
    )


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

    output = output.expanduser().resolve()
    output.parent.mkdir(parents=True, exist_ok=True)
    descriptor, temporary_name = tempfile.mkstemp(
        prefix="douyin-cookies-", suffix=".txt", dir=output.parent
    )
    os.close(descriptor)
    temporary = Path(temporary_name)
    try:
        with factory({"cookiesfrombrowser": browser_spec, "quiet": True}) as downloader:
            cookies = [copy.copy(cookie) for cookie in downloader.cookiejar if is_douyin_cookie(cookie)]
        if not cookies:
            raise RuntimeError(
                "No Douyin cookies were found. Open douyin.com in the selected browser first."
            )
        jar = MozillaCookieJar(str(temporary))
        for cookie in cookies:
            jar.set_cookie(cookie)
        jar.save(ignore_discard=True, ignore_expires=True)
        os.replace(temporary, output)
        return len(cookies)
    finally:
        temporary.unlink(missing_ok=True)


def main() -> None:
    parser = argparse.ArgumentParser(description="Create a local Douyin-only cookie snapshot")
    parser.add_argument("--browser", default="edge")
    parser.add_argument("--output", default=".local/douyin-cookies.txt")
    arguments = parser.parse_args()
    count = snapshot_browser_cookies(arguments.browser, Path(arguments.output))
    print(f"Saved {count} Douyin cookies to the local snapshot.")


if __name__ == "__main__":
    main()
