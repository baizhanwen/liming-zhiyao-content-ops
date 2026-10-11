const loginCookieNames = new Set(["sessionid", "sessionid_ss", "sid_tt", "sid_guard"]);

export function isDouyinDomain(domain) {
  const host = String(domain || "").replace(/^\./, "").toLowerCase();
  return ["douyin.com", "iesdouyin.com"].some(base => host === base || host.endsWith(`.${base}`));
}

export function isLocalAnalysisUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === "http:" && ["127.0.0.1", "localhost"].includes(url.hostname)
      && !url.username && !url.password && /^\/analysis\/?$/.test(url.pathname);
  } catch { return false; }
}

export function sameBinding(first, second) {
  return Boolean(first && second && ["origin", "organizationId", "projectId", "userId"]
    .every(key => typeof first[key] === "string" && first[key] && first[key] === second[key]));
}

export function serializeCookies(input, nowSeconds = Date.now() / 1000) {
  const cookies = input.filter(cookie => isDouyinDomain(cookie.domain) && !cookie.partitionKey
    && (cookie.session || cookie.expirationDate > nowSeconds));
  if (!cookies.some(cookie => loginCookieNames.has(cookie.name.toLowerCase()) && cookie.value)) {
    throw new Error("请先在这个浏览器中登录抖音，再点“立即同步”。");
  }
  const rows = cookies.map(cookie => {
    const domain = cookie.hostOnly ? cookie.domain.replace(/^\./, "") : `.${cookie.domain.replace(/^\./, "")}`;
    const fields = [
      `${cookie.httpOnly ? "#HttpOnly_" : ""}${domain}`, cookie.hostOnly ? "FALSE" : "TRUE",
      cookie.path || "/", cookie.secure ? "TRUE" : "FALSE", cookie.session ? "0" : String(Math.floor(cookie.expirationDate)),
      cookie.name, cookie.value,
    ];
    if (fields.some(field => /[\t\r\n\0]/.test(field))) throw new Error("抖音登录信息格式异常，请重新登录后重试。");
    return fields.join("\t");
  }).sort();
  const contents = `# Netscape HTTP Cookie File\n# Synced by Liming Zhiyao browser extension\n${rows.join("\n")}\n`;
  if (new TextEncoder().encode(contents).length > 1024 * 1024) throw new Error("抖音登录信息超过 1 MB，未同步。");
  return { contents, count: rows.length };
}

export async function snapshotHash(contents) {
  const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(contents));
  return Array.from(new Uint8Array(bytes), value => value.toString(16).padStart(2, "0")).join("");
}
