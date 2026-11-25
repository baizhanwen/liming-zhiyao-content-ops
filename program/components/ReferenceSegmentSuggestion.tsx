"use client";

import { useEffect, useRef, useState } from "react";
import { Sparkles } from "lucide-react";
import { readApiError } from "../lib/client-format";
import { scopedFetch } from "../lib/client-scope";
import { isScopeCancellation } from "../lib/client-scope-request";
import type { ReferenceSegmentSuggestionResult } from "../lib/reference-segment-suggestion";
import type { ReferenceCreationInput } from "../lib/structure-creation";

type Props = {
  sourceUrl: string;
  organizationId: string;
  projectId: string;
  libraryEntryId: string;
  referenceCreation: ReferenceCreationInput;
  segment: ReferenceCreationInput["segments"][number];
  materialQuestion?: string;
  disabled: boolean;
  onFocusNote: () => void;
  onApply: (note: string) => void;
};

export function ReferenceSegmentSuggestion({ sourceUrl, organizationId, projectId, libraryEntryId,
  referenceCreation, segment, materialQuestion, disabled, onFocusNote, onApply }: Props) {
  const [result, setResult] = useState<ReferenceSegmentSuggestionResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const trigger = useRef<HTMLButtonElement>(null);
  const pending = useRef<AbortController | null>(null);
  useEffect(() => () => pending.current?.abort(), []);

  async function suggest() {
    if (pending.current || disabled) return;
    const operation = new AbortController();
    pending.current = operation;
    setLoading(true);
    setError("");
    setResult(null);
    try {
      const response = await scopedFetch(sourceUrl + "/segment-suggestion", {
        method: "POST", headers: { "content-type": "application/json" }, signal: operation.signal,
        body: JSON.stringify({ organizationId, projectId, libraryEntryId: libraryEntryId || undefined,
          referenceCreation, segmentId: segment.segmentId, materialQuestion }),
      });
      if (!response.ok) throw new Error(await readApiError(response));
      const data = await response.json() as ReferenceSegmentSuggestionResult | null;
      if (operation.signal.aborted) return;
      if (!(data?.kind === "suggestion" && typeof data.text === "string" && data.text.trim()
        || data?.kind === "missing" && typeof data.question === "string" && data.question.trim())) {
        throw new Error("没有收到可用的段落建议，请重试。");
      }
      setResult(data);
    } catch (reason) {
      if (!operation.signal.aborted && !isScopeCancellation(reason)) setError(reason instanceof Error ? reason.message : "本段建议生成失败，请重试。");
    } finally {
      if (!operation.signal.aborted) setLoading(false);
      pending.current = null;
    }
  }

  const text = result?.kind === "suggestion" ? result.text.trim() : "";
  const hasNote = Boolean(segment.note.trim());
  const nextNote = hasNote ? segment.note + "\n" + text : text;
  const alreadyIncluded = Boolean(text && segment.note.includes(text));

  return <>
    <button ref={trigger} type="button" className="reference-note-generate" data-no-feedback disabled={disabled || loading}
      onClick={() => void suggest()}><Sparkles aria-hidden="true" />{loading ? "生成中…" : "AI 生成"}</button>
    {error && <p className="reference-note-error" role="alert">{error}</p>}
    {result && <div className="reference-note-preview">
      <div role="status">
        <strong>{result.kind === "suggestion" ? "本段建议" : "还需补充材料"}</strong>
        <p>{result.kind === "suggestion" ? text : result.question === materialQuestion
          ? "当前材料还回答不了上面的问题。可以在下方补上可公开的记录，再生成建议。" : result.question}</p>
      </div>
      {text && nextNote.length > 2000 && !alreadyIncluded && <small>追加后会超过 2000 字，可选取需要的内容，或先精简原文。</small>}
      <div className="reference-note-actions">
        {text && <button type="button" className="reference-note-use" data-no-feedback
          disabled={alreadyIncluded || nextNote.length > 2000} onClick={() => onApply(nextNote)}>
          {alreadyIncluded ? "本段已有此内容" : hasNote ? "追加到本段" : "填入本段"}
        </button>}
        {result.kind === "missing" && <button type="button" data-no-feedback onClick={() => { setResult(null); onFocusNote(); }}>填写材料</button>}
        <button type="button" data-no-feedback onClick={() => { setResult(null); trigger.current?.focus(); }}>收起建议</button>
      </div>
    </div>}
  </>;
}
