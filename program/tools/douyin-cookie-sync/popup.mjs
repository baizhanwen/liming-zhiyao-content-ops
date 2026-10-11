/* global chrome */
const byId = id => document.getElementById(id);
let preview = null;
let current = { enabled: false };
let busy = false;
async function request(message) {
  const reply = await chrome.runtime.sendMessage(message);
  if (!reply?.ok) throw new Error(reply?.message || "扩展暂时没有响应。");
  return reply;
}
function render() {
  byId("status").textContent = current.enabled ? current.error ? "自动同步需要处理" : "自动同步已开启" : "尚未开启自动同步";
  byId("bound").textContent = current.binding ? `绑定：${current.binding.organizationName} / ${current.binding.projectName}` : "";
  byId("updated").textContent = current.lastUpdatedAt ? `最近同步：${new Date(current.lastUpdatedAt).toLocaleString("zh-CN")} · ${current.cookieCount} 条` : "";
  byId("preview").textContent = preview ? `当前页面：${preview.organizationName} / ${preview.projectName}` : "";
  byId("bind").disabled = busy || !preview;
  byId("sync").disabled = busy || !current.enabled;
  byId("unbind").disabled = busy || !current.enabled;
  byId("message").textContent = current.error || "";
}
async function act(type) {
  busy = true; render();
  try { current = (await request({ type, binding: preview })).state; }
  catch (error) { current = { ...current, error: error.message }; }
  finally { busy = false; render(); }
}
byId("bind").addEventListener("click", () => { void act("BIND"); });
byId("sync").addEventListener("click", () => { void act("SYNC"); });
byId("unbind").addEventListener("click", () => { void act("UNBIND"); });
try {
  current = (await request({ type: "STATUS" })).state;
  try { preview = (await request({ type: "PREVIEW" })).binding; }
  catch (error) { if (!current.enabled) current.error = error.message; }
} catch (error) { current.error = error.message; }
render();
