export const analysisJobStatuses = ["pending", "queued", "downloading", "processing", "transcribing", "extracting", "analyzing", "completed", "partial", "failed", "cancelled"] as const;
export type AnalysisJobStatus = (typeof analysisJobStatuses)[number];

// Pending jobs block another submission, but do not yet own a worker lease.
export const leasedAnalysisStatuses = ["queued", "downloading", "processing", "transcribing", "extracting", "analyzing"] as const satisfies readonly AnalysisJobStatus[];
export const activeAnalysisStatuses = ["pending", ...leasedAnalysisStatuses] as const;
const leasedStatusSet: ReadonlySet<string> = new Set(leasedAnalysisStatuses);
const activeStatusSet: ReadonlySet<string> = new Set(activeAnalysisStatuses);
export const isLeasedAnalysisStatus = (status: string) => leasedStatusSet.has(status);
export const isActiveAnalysisStatus = (status: string) => activeStatusSet.has(status);
// SQL fragments contain only the fixed, internal enum above, never request input.
export const ACTIVE_ANALYSIS_STATUSES_SQL = activeAnalysisStatuses.map((status) => `'${status}'`).join(",");
export const LEASED_ANALYSIS_STATUSES_SQL = leasedAnalysisStatuses.map((status) => `'${status}'`).join(",");

const transitions: Record<AnalysisJobStatus, readonly AnalysisJobStatus[]> = {
  pending: ["queued", "cancelled"], queued: ["downloading", "processing", "analyzing", "cancelled", "failed"], downloading: ["processing", "failed", "cancelled"],
  processing: ["transcribing", "extracting", "failed", "cancelled"], transcribing: ["extracting", "analyzing", "failed", "cancelled"],
  extracting: ["analyzing", "failed", "cancelled"], analyzing: ["completed", "partial", "failed", "cancelled"], completed: [], partial: ["pending"], failed: ["pending"], cancelled: ["pending"],
};

export function canTransitionAnalysisJob(from: AnalysisJobStatus, to: AnalysisJobStatus) { return transitions[from].includes(to); }
export function canRetryAnalysisJob(status: AnalysisJobStatus) { return status === "partial" || status === "failed" || status === "cancelled"; }
