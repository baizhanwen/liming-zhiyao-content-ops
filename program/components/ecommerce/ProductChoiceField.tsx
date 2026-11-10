"use client";

import { useId, useRef, useState } from "react";
import { productAnswerSelection, productAnswerTransition } from "../../lib/ecommerce/product-question-options";

/** Compact choice question with a lossless free-text answer for specific cases. */
export function ProductChoiceField({ label, value, options, onChange, maxLength = 2000, multiline = false, hint }: {
  label: string; value: string; options: readonly string[]; onChange: (value: string) => void;
  maxLength?: number; multiline?: boolean; hint?: string;
}) {
  const id = useId(), customAnswer = useRef(options.includes(value) ? "" : value);
  const [editingCustom, setEditingCustom] = useState(false);
  const selected = productAnswerSelection(value, options, editingCustom);
  const changeChoice = (next: string) => {
    const answer = productAnswerTransition(value, customAnswer.current, next, options);
    customAnswer.current = answer.custom; setEditingCustom(answer.editingCustom); onChange(answer.value);
  };
  const changeText = (next: string) => { customAnswer.current = next; setEditingCustom(true); onChange(next); };
  return <div className="ec-field">
    <label htmlFor={id}>{label}</label>
    <select id={id} value={selected} onChange={event => changeChoice(event.target.value)} aria-describedby={hint ? `${id}-hint` : undefined}>
      <option value="">请选择或自行填写</option>
      {options.map(option => <option key={option} value={option}>{option}</option>)}
      <option value="__custom__">自行填写具体内容</option>
    </select>
    {selected === "__custom__" && (multiline
      ? <textarea aria-label={`${label}具体内容`} rows={2} maxLength={maxLength} value={value} onChange={event => changeText(event.target.value)} />
      : <input aria-label={`${label}具体内容`} maxLength={maxLength} value={value} onChange={event => changeText(event.target.value)} />)}
    {hint && <small id={`${id}-hint`}>{hint}</small>}
  </div>;
}
