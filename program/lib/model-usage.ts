/** Keep absent or invalid usage unknown rather than manufacturing zero cost. */
export function readModelUsage(raw: unknown) {
  const usage = raw && typeof raw === "object" ? (raw as { usage?: Record<string, unknown> }).usage : undefined;
  const number = (name: string) => typeof usage?.[name] === "number" && Number.isSafeInteger(usage[name]) && usage[name] >= 0 ? usage[name] as number : null;
  const inputTokens = number("prompt_tokens") ?? number("input_tokens"), outputTokens = number("completion_tokens") ?? number("output_tokens"), totalTokens = number("total_tokens");
  return { inputTokens, outputTokens, totalTokens, usageKnown: totalTokens !== null || (inputTokens !== null && outputTokens !== null) };
}
