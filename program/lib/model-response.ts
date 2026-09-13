type TextOptions = { trim?: boolean; toolArguments?: boolean };

/** Provider envelopes are shared; each caller keeps its existing whitespace and tool-call policy. */
export function responseContentText(value: unknown, options: TextOptions = {}): string | null {
  if (typeof value === "string") return value.trim() ? (options.trim ? value.trim() : value) : null;
  if (Array.isArray(value)) {
    const joined = value.map((part) => responseContentText(part, options)).filter(Boolean).join("");
    return joined.trim() ? (options.trim ? joined.trim() : joined) : null;
  }
  if (!value || typeof value !== "object") return null;
  const row = value as Record<string, unknown>;
  return responseContentText(row.text, options) || responseContentText(row.content, options) || responseContentText(row.value, options);
}

export function extractResponseText(payload: unknown, options: TextOptions = {}): string | null {
  if (!payload || typeof payload !== "object") return null;
  const root = payload as Record<string, unknown>;
  const text = (value: unknown) => responseContentText(value, options);
  const direct = text(root.output_text) || text(root.content);
  if (direct) return direct;
  if (!Array.isArray(root.choices) || !root.choices[0] || typeof root.choices[0] !== "object") return null;
  const choice = root.choices[0] as Record<string, unknown>;
  const message = choice.message && typeof choice.message === "object" ? choice.message as Record<string, unknown> : null;
  const content = text(message?.content) || text(choice.text);
  if (content) return content;
  if (!options.toolArguments || !Array.isArray(message?.tool_calls)) return null;
  for (const call of message.tool_calls) {
    if (!call || typeof call !== "object") continue;
    const fn = (call as Record<string, unknown>).function;
    if (!fn || typeof fn !== "object") continue;
    const argumentsText = text((fn as Record<string, unknown>).arguments);
    if (argumentsText) return argumentsText;
  }
  return null;
}
