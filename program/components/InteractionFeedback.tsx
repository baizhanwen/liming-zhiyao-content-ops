"use client";

import { useEffect, useState } from "react";

export function InteractionFeedback() {
  const [feedback, setFeedback] = useState<{ id: number; message: string } | null>(null);
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    function show(message: string) { if (timer) clearTimeout(timer); setFeedback({ id: Date.now(), message }); timer = setTimeout(() => setFeedback(null), 1400); }
    function label(element: Element) { return (element.getAttribute("aria-label") || element.textContent || "").replace(/\s+/g, " ").trim().slice(0, 20); }
    function onClick(event: Event) {
      if (!(event.target instanceof Element)) return;
      const control = event.target.closest("button, a[href], [role='button']");
      if (!control || control instanceof HTMLButtonElement && control.disabled) return;
      const name = label(control);
      show(control.matches("a[href]") ? `正在打开${name ? `“${name}”` : "页面"}…` : `${name || "操作"}：已响应`);
    }
    function onSubmit() { show("正在提交，请稍候…"); }
    function onChange(event: Event) { if (event.target instanceof HTMLSelectElement) show("正在切换，请稍候…"); }
    document.addEventListener("click", onClick, true); document.addEventListener("submit", onSubmit, true); document.addEventListener("change", onChange, true);
    return () => { if (timer) clearTimeout(timer); document.removeEventListener("click", onClick, true); document.removeEventListener("submit", onSubmit, true); document.removeEventListener("change", onChange, true); };
  }, []);
  return feedback ? <div className="interaction-feedback" key={feedback.id} role="status" aria-live="polite"><span aria-hidden="true" />{feedback.message}</div> : null;
}
