// D1 wraps SQLite constraint failures in a cause. Only classify the two
// source/idempotency constraints; unrelated storage failures must stay errors.
export function isAnalysisSubmissionConflict(error: unknown): boolean {
  const seen = new Set<unknown>();
  let current = error;
  while (current instanceof Error && !seen.has(current)) {
    seen.add(current);
    if (/UNIQUE constraint failed:\s*(?:videos\.organization_id, videos\.project_id, videos\.source_hash|analysis_jobs\.organization_id, analysis_jobs\.idempotency_key)/i.test(current.message)) return true;
    current = current.cause;
  }
  return false;
}
