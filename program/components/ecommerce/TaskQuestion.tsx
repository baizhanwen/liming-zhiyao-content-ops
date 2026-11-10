"use client";

import { useEffect, useId, useRef, useState } from "react";
import { taskQuestionSelection } from "../../lib/ecommerce/task-question-options";

/** A suggested answer is just editable user input, never a confirmed fact. */
export function TaskQuestion({ label, value, options, onChange, multiline = false, maxLength = 1000, hint }: {
  label: string; value: string; options: readonly string[]; onChange: (value: string) => void;
  multiline?: boolean; maxLength?: number; hint?: string;
}) {
  const id = useId(), emitted = useRef<string | null>(null);
  const [custom, setCustom] = useState(taskQuestionSelection(value, options) === "custom");
  const [customDraft, setCustomDraft] = useState(custom ? value : "");
  useEffect(() => {
    if (value === emitted.current) return;
    const selection = taskQuestionSelection(value, options);
    setCustom(selection === "custom");
    setCustomDraft(selection === "custom" ? value : "");
  }, [value, options]);
  const emit = (next: string) => { emitted.current = next; onChange(next); };
  return <fieldset className="ec-question">
    <legend>{label}</legend>
    <div className="ec-question-options">{options.map(option => <label key={option} className="ec-question-option"><input type="radio" name={id} checked={!custom && value === option} onChange={() => { setCustom(false); emit(option); }} />{option}</label>)}
      <label className="ec-question-option"><input type="radio" name={id} checked={custom} onChange={() => { setCustom(true); emit(customDraft); }} />自行填写</label>
    </div>
    {custom && <label className="ec-question-custom" htmlFor={`${id}-custom`}><span>填写{label}</span>{multiline
      ? <textarea id={`${id}-custom`} value={value} maxLength={maxLength} rows={2} onChange={event => { setCustomDraft(event.target.value); emit(event.target.value); }} />
      : <input id={`${id}-custom`} value={value} maxLength={maxLength} onChange={event => { setCustomDraft(event.target.value); emit(event.target.value); }} />}</label>}
    {hint && <p className="ec-muted">{hint}</p>}
  </fieldset>;
}

export function TaskDurationQuestion({ value, onChange }: { value: number; onChange: (value: number) => void }) {
  const id = useId(), presets = [15, 30, 60];
  const [custom, setCustom] = useState(!presets.includes(value));
  const [customDraft, setCustomDraft] = useState(value), customUsed = useRef(custom);
  return <fieldset className="ec-question"><legend>目标时长</legend><div className="ec-question-options">{presets.map(seconds => <label key={seconds} className="ec-question-option"><input type="radio" name={id} checked={!custom && value === seconds} onChange={() => { setCustom(false); onChange(seconds); }} />{seconds} 秒{seconds === 30 ? " · 推荐起步" : ""}</label>)}<label className="ec-question-option"><input type="radio" name={id} checked={custom} onChange={() => { const next = customUsed.current ? customDraft : value; customUsed.current = true; setCustomDraft(next); setCustom(true); onChange(next); }} />自定时长</label></div>{custom && <label className="ec-question-custom" htmlFor={`${id}-seconds`}><span>时长（10–180 秒）</span><input id={`${id}-seconds`} type="number" min={10} max={180} value={value} onChange={event => { const next = Number(event.target.value); setCustomDraft(next); onChange(next); }} /></label>}</fieldset>;
}
