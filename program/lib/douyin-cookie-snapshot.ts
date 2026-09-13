export const MAX_DOUYIN_COOKIE_BYTES = 1024 * 1024;

export function douyinCookieObjectKey(organizationId: string) {
  return `organizations/${organizationId}/private/analyzer/douyin-cookies.txt`;
}

function isDouyinCookieDomain(value: string) {
  const domain = value.replace(/^#HttpOnly_/i, "").replace(/^\./, "").toLowerCase();
  return domain === "douyin.com" || domain.endsWith(".douyin.com") || domain === "iesdouyin.com" || domain.endsWith(".iesdouyin.com");
}

export function sanitizeDouyinCookieSnapshot(value: string) {
  if (!value || value.includes("\0")) throw new Error("Cookie 文件内容无效。");
  const lines = value.replace(/^\uFEFF/, "").split(/\r?\n/);
  if (!lines.some((line) => /Netscape HTTP Cookie File/i.test(line))) {
    throw new Error("请选择 Netscape 格式导出的 cookies.txt。");
  }

  const cookies: string[] = [];
  for (const rawLine of lines) {
    const line = rawLine.trimEnd();
    if (!line || (line.startsWith("#") && !line.startsWith("#HttpOnly_"))) continue;
    const columns = line.split("\t");
    if (columns.length !== 7 || !isDouyinCookieDomain(columns[0]) || !columns[5]) continue;
    cookies.push(columns.join("\t"));
  }
  if (!cookies.length) throw new Error("文件中没有找到抖音 Cookie，请在 douyin.com 页面重新导出。");

  return {
    contents: `# Netscape HTTP Cookie File\n# Saved by Liming Zhiyao local analyzer\n${cookies.join("\n")}\n`,
    count: cookies.length,
  };
}
