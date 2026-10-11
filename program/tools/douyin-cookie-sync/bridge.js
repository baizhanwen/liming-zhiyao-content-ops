/* global chrome */
// Runs in the isolated extension world. Cookie contents never enter page messages or the DOM.
if (!globalThis.limingDouyinSyncBridge) {
  globalThis.limingDouyinSyncBridge = true;
  const bindingFromPage = () => {
    const selects = document.querySelectorAll(".analysis-toolbar select");
    if (selects.length !== 2 || !selects[0].value || !selects[1].value) {
      throw new Error("请打开视频分析页面，等待公司和企业空间加载完成。");
    }
    return {
      origin: location.origin,
      organizationId: selects[0].value, projectId: selects[1].value,
      organizationName: selects[0].selectedOptions[0]?.textContent || selects[0].value,
      projectName: selects[1].selectedOptions[0]?.textContent || selects[1].value,
    };
  };
  const matches = (first, second) => ["origin", "organizationId", "projectId", "userId"].every(key => first[key] === second[key]);
  const fetchJson = async (path, init = {}) => {
    const response = await fetch(path, { ...init, credentials: "same-origin", cache: "no-store", redirect: "error", signal: AbortSignal.timeout(15000) });
    const body = await response.json();
    if (!response.ok) throw new Error(response.status === 401 ? "请重新登录利明智耀，再点“立即同步”。" : response.status === 403 ? "当前账号没有更新该公司 Cookie 的权限。" : "利明智耀暂时无法同步，请稍后重试。");
    return body;
  };
  const currentBinding = async () => {
    const scope = bindingFromPage();
    const { user } = await fetchJson("/api/auth/session");
    const data = await fetchJson(`/api/videos?organizationId=${encodeURIComponent(scope.organizationId)}&projectId=${encodeURIComponent(scope.projectId)}`);
    if (!data.service?.canManageCookies || !user?.id) throw new Error("当前账号没有更新抖音 Cookie 的权限。");
    const latest = bindingFromPage();
    if (latest.organizationId !== scope.organizationId || latest.projectId !== scope.projectId) throw new Error("公司或企业空间正在切换，请稍后重试。");
    return { ...scope, userId: user.id, cookieUpdatedAt: data.service.cookieUpdatedAt || null };
  };
  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (sender.id !== chrome.runtime.id || !["LIMING_SYNC_BINDING", "LIMING_SYNC_UPLOAD"].includes(message?.type)) return false;
    (async () => {
      if (location.protocol !== "http:" || !["localhost", "127.0.0.1"].includes(location.hostname) || !/^\/analysis\/?$/.test(location.pathname)) throw new Error("请在分析主机上打开本机视频分析页面。");
      const binding = await currentBinding();
      if (message.type === "LIMING_SYNC_BINDING") return { ok: true, binding };
      if (!matches(binding, message.binding || {})) throw new Error("页面账号或企业空间与绑定不一致，请切回绑定空间或重新绑定。");
      if (typeof message.contents !== "string" || !message.contents.startsWith("# Netscape HTTP Cookie File\n") || message.contents.length > 1024 * 1024) throw new Error("同步内容格式异常。");
      const form = new FormData();
      form.set("file", new File([message.contents], "douyin-auto-sync.txt", { type: "text/plain" }));
      const result = await fetchJson("/api/analyzer/cookies", {
        method: "POST", headers: { "x-organization-id": binding.organizationId, "x-project-id": binding.projectId }, body: form,
      });
      return { ok: true, updatedAt: result.updatedAt, cookieCount: result.cookieCount };
    })().then(sendResponse, error => sendResponse({ ok: false, message: error.message || "同步失败，请稍后重试。" }));
    return true;
  });
}
