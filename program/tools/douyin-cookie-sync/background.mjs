/* global chrome */
import { isDouyinDomain, isLocalAnalysisUrl, sameBinding, serializeCookies, snapshotHash } from "./sync-core.mjs";

const periodicAlarm = "liming-cookie-check";
const changedAlarm = "liming-cookie-changed";
let pendingSync = null;
let configurationQueue = Promise.resolve();

async function state() { return (await chrome.storage.local.get("syncState")).syncState || { enabled: false }; }
async function save(value) { await chrome.storage.local.set({ syncState: value }); }
async function bridge(tabId, message) {
  await chrome.scripting.executeScript({ target: { tabId }, files: ["bridge.js"] });
  const reply = await chrome.tabs.sendMessage(tabId, message);
  if (!reply?.ok) throw new Error(reply?.message || "页面没有响应，请刷新视频分析页面。");
  return reply;
}
async function activeBinding() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab || !isLocalAnalysisUrl(tab.url)) throw new Error("请先切到本机利明智耀的视频分析页面，再打开此扩展。");
  const { binding } = await bridge(tab.id, { type: "LIMING_SYNC_BINDING" });
  return binding;
}
async function boundTab(binding) {
  const tabs = await chrome.tabs.query({ url: `${binding.origin}/*` });
  let pageError = null;
  for (const tab of tabs) {
    if (!isLocalAnalysisUrl(tab.url)) continue;
    try {
      const result = await bridge(tab.id, { type: "LIMING_SYNC_BINDING" });
      if (sameBinding(binding, result.binding)) return { id: tab.id, binding: result.binding };
    } catch (error) { pageError = error; /* Another tab may still have the bound login and space. */ }
  }
  if (pageError) throw pageError;
  throw new Error("请保持本机视频分析页面打开，并登录绑定账号、选中绑定的企业空间。");
}
async function ensurePeriodicAlarm() {
  if (!await chrome.alarms.get(periodicAlarm)) await chrome.alarms.create(periodicAlarm, { periodInMinutes: 5 });
}
async function sync(force = false) {
  if (pendingSync) return pendingSync;
  pendingSync = (async () => {
    const current = await state();
    if (!current.enabled || !current.binding) return current;
    try {
      const tab = await boundTab(current.binding);
      const stores = await chrome.cookies.getAllCookieStores();
      const store = stores.find(item => item.tabIds.includes(tab.id));
      if (!store) throw new Error("无法读取当前浏览器的登录信息，请刷新页面后重试。");
      const groups = await Promise.all(["douyin.com", "iesdouyin.com"].map(domain => chrome.cookies.getAll({ domain, storeId: store.id })));
      const snapshot = serializeCookies(groups.flat());
      const hash = await snapshotHash(snapshot.contents);
      // Check server metadata too, so manual clearing/replacement is not hidden by a local hash.
      if (!force && hash === current.lastHash && tab.binding.cookieUpdatedAt === current.lastUpdatedAt) {
        const latest = await state();
        if (!latest.enabled || latest.generation !== current.generation) return latest;
        const recovered = { ...latest, error: "" };
        await save(recovered);
        await chrome.action.setBadgeText({ text: "" });
        return recovered;
      }
      const latest = await state();
      if (!latest.enabled || latest.generation !== current.generation) return latest;
      const result = await bridge(tab.id, { type: "LIMING_SYNC_UPLOAD", binding: current.binding, contents: snapshot.contents });
      const after = await state();
      if (!after.enabled || after.generation !== current.generation) return after;
      const next = { ...after, lastHash: hash, lastUpdatedAt: result.updatedAt, cookieCount: result.cookieCount, error: "" };
      await save(next);
      await chrome.action.setBadgeText({ text: "" });
      return next;
    } catch (error) {
      const after = await state();
      if (!after.enabled || after.generation !== current.generation) return after;
      const next = { ...after, error: error.message || "同步失败，请稍后重试。" };
      await save(next);
      await chrome.action.setBadgeText({ text: "!" });
      await chrome.action.setBadgeBackgroundColor({ color: "#b45309" });
      return next;
    }
  })();
  try { return await pendingSync; }
  finally { pendingSync = null; }
}

async function handle(message) {
  if (message.type === "STATUS") return { state: await state() };
  if (message.type === "PREVIEW") return { binding: await activeBinding() };
  if (message.type === "SYNC") return { state: await sync(true) };
  if (message.type === "BIND") {
    const binding = await activeBinding();
    if (!sameBinding(binding, message.binding)) throw new Error("页面账号或企业空间已变化，请重新打开扩展确认后绑定。");
    const next = { enabled: true, binding, generation: crypto.randomUUID(), error: "" };
    await save(next);
    await ensurePeriodicAlarm();
    // Complete any old upload before starting the new binding's first sync.
    if (pendingSync) await pendingSync;
    return { state: await sync(true) };
  }
  if (message.type === "UNBIND") {
    await save({ enabled: false, generation: crypto.randomUUID() });
    await chrome.alarms.clear(periodicAlarm);
    await chrome.alarms.clear(changedAlarm);
    // Once this returns, an older upload cannot restore a snapshot the user clears next.
    if (pendingSync) await pendingSync;
    await chrome.action.setBadgeText({ text: "" });
    return { state: await state() };
  }
  throw new Error("未知操作。");
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (sender.id !== chrome.runtime.id || sender.url?.split("?")[0] !== chrome.runtime.getURL("popup.html")) return false;
  // Serialize binding changes with manual sync so pausing also waits for outstanding writes.
  configurationQueue = configurationQueue.catch(() => undefined).then(() => handle(message));
  configurationQueue.then(result => sendResponse({ ok: true, ...result }), error => sendResponse({ ok: false, message: error.message || "操作失败。" }));
  return true;
});
chrome.cookies.onChanged.addListener(async ({ cookie }) => {
  if (!isDouyinDomain(cookie.domain) || !(await state()).enabled) return;
  // A persistent alarm debounces cookie rotation without relying on service-worker timers.
  if (!await chrome.alarms.get(changedAlarm)) await chrome.alarms.create(changedAlarm, { delayInMinutes: 1 });
});
chrome.alarms.onAlarm.addListener(alarm => {
  if ([periodicAlarm, changedAlarm].includes(alarm.name)) void sync();
});
chrome.runtime.onStartup.addListener(async () => {
  if ((await state()).enabled) { await ensurePeriodicAlarm(); void sync(); }
});
chrome.runtime.onInstalled.addListener(async () => {
  if ((await state()).enabled) await ensurePeriodicAlarm();
});
