const DOUYIN_HOSTS = ["douyin.com", "iesdouyin.com"];

function isDouyinHost(hostname: string) {
  const host = hostname.toLowerCase();
  return DOUYIN_HOSTS.some((domain) => host === domain || host.endsWith(`.${domain}`));
}

/**
 * Extract the first valid Douyin HTTPS URL from either a bare URL or the full
 * share copy produced by the Douyin app.
 */
export function extractDouyinUrl(value: string) {
  const candidates = value.match(/https:\/\/[^\s<>"'`，。！？、；：）】}]+/gi) ?? [];

  for (const candidate of candidates) {
    const cleaned = candidate.replace(/[\])}>.,!?;:，。！？、；：]+$/g, "");
    try {
      const url = new URL(cleaned);
      if (url.protocol !== "https:" || !isDouyinHost(url.hostname)) continue;
      url.hash = "";
      return url.toString();
    } catch {
      // Keep looking when a share message contains another malformed link.
    }
  }

  return null;
}
