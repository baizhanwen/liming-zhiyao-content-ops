/** Keep absent or invalid usage unknown rather than manufacturing zero cost. */
export function readModelUsage(raw: unknown) {
  const usage = raw && typeof raw === "object" ? (raw as { usage?: Record<string, unknown> }).usage : undefined;
  const number = (name: string) => typeof usage?.[name] === "number" && Number.isSafeInteger(usage[name]) && usage[name] >= 0 ? usage[name] as number : null;
  const inputTokens = number("prompt_tokens") ?? number("input_tokens"), outputTokens = number("completion_tokens") ?? number("output_tokens"), totalTokens = number("total_tokens");
  return { inputTokens, outputTokens, totalTokens, usageKnown: totalTokens !== null || (inputTokens !== null && outputTokens !== null) };
}

/** Only the validated numeric receipt crosses an adapter error boundary. */
export function readModelFailureUsage(error: unknown) {
  const value = error && typeof error === "object" && "modelUsage" in error ? error.modelUsage : null;
  const usage = value && typeof value === "object" ? value as Record<string, unknown> : {};
  return readModelUsage({ usage: { input_tokens: usage.inputTokens,output_tokens: usage.outputTokens,total_tokens: usage.totalTokens } });
}

/** Clarify a recovered request's cost without reopening it or replacing its reason. */
export async function preserveInterruptedModelUsage(db: D1Database, scope: { id: string; organizationId: string; projectId: string }, record: ReturnType<typeof readModelUsage> & { latencyMs: number }) {
  if (record.inputTokens === null && record.outputTokens === null && record.totalTokens === null) return;
  await db.prepare(`UPDATE model_calls SET output_json=json_set(
    CASE WHEN output_json IS NULL THEN '{}' WHEN json_valid(output_json) THEN
      CASE WHEN json_type(output_json)='object' THEN output_json ELSE json_object('legacyOutput',output_json) END
      ELSE json_object('legacyOutput',output_json) END,'$.usage',json(?),'$.modelRequests',json(?)),latency_ms=?
    WHERE id=? AND organization_id=? AND project_id=? AND status='failed'
      AND error_code IN ('ECOMMERCE_CALL_RECOVERED','WEB_PROCESS_INTERRUPTED')`)
    .bind(JSON.stringify({inputTokens:record.inputTokens,outputTokens:record.outputTokens,totalTokens:record.totalTokens}),JSON.stringify([record]),record.latencyMs,scope.id,scope.organizationId,scope.projectId).run();
}
