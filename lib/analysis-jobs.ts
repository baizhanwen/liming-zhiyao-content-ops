export const analysisJobStatuses = ["pending", "queued", "downloading", "processing", "transcribing", "extracting", "analyzing", "completed", "failed", "cancelled"] as const;
export type AnalysisJobStatus = (typeof analysisJobStatuses)[number];

const transitions: Record<AnalysisJobStatus, readonly AnalysisJobStatus[]> = {
  pending: ["queued", "cancelled"], queued: ["downloading", "processing", "cancelled", "failed"], downloading: ["processing", "failed", "cancelled"],
  processing: ["transcribing", "extracting", "failed", "cancelled"], transcribing: ["extracting", "analyzing", "failed", "cancelled"],
  extracting: ["analyzing", "failed", "cancelled"], analyzing: ["completed", "failed", "cancelled"], completed: [], failed: ["pending"], cancelled: ["pending"],
};

export function canTransitionAnalysisJob(from: AnalysisJobStatus, to: AnalysisJobStatus) { return transitions[from].includes(to); }
export function canRetryAnalysisJob(status: AnalysisJobStatus) { return status === "failed" || status === "cancelled"; }
