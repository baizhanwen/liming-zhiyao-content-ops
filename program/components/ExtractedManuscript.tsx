"use client";

import { useEffect, useState, type ReactNode } from "react";
import { scopedFetch } from "../lib/client-scope";
import { readApiError } from "../lib/client-format";
import { parseManuscript, type Manuscript } from "../lib/manuscript-view";

export function useManuscriptAsset(url?: string) {
  const [result, setResult] = useState<{ url: string; data?: Manuscript; error?: string } | null>(null);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    if (!url) return;
    const controller = new AbortController();
    scopedFetch(url, { signal: controller.signal }).then(async response => {
      if (!response.ok) throw new Error(await readApiError(response));
      const data = parseManuscript(await response.json());
      if (!controller.signal.aborted) setResult({ url, data });
    }).catch(reason => {
      if (!controller.signal.aborted) setResult({ url, error: reason instanceof Error ? reason.message : "口播稿暂时无法读取。" });
    });
    return () => controller.abort();
  }, [url, attempt]);
  return { result: result?.url === url ? result : null, retry: () => { setResult(null); setAttempt(n => n + 1); } };
}

export function ManuscriptCard({ children, onCopy, canCopy }: { children: ReactNode; onCopy: () => void; canCopy: boolean }) {
  return <section className="report-script" id="report-script"><header><div><span className="section-kicker">可复制文案</span><h2>完整口播稿</h2></div><button className="primary-button" type="button" disabled={!canCopy} onClick={onCopy}>复制口播稿</button></header>{children}</section>;
}
