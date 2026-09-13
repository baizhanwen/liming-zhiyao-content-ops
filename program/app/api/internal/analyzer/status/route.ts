import { getD1 } from "../../../../../db/runtime";
import { apiError, errorResponse } from "../../../../../lib/api-response";
import { normalizeWorkerId, requireAnalyzerService } from "../../../../../lib/service-auth";

export const dynamic = "force-dynamic";

const ONLINE_WINDOW_MS = 45_000;

export async function GET(request: Request) {
  const service = await requireAnalyzerService(request); if ("error" in service) return service.error;
  try {
    const workerId = normalizeWorkerId(new URL(request.url).searchParams.get("workerId"));
    if (!workerId) return apiError("INVALID_WORKER_ID", "workerId 格式无效。", 400);
    const worker = await getD1().prepare(
      "SELECT worker_id, status, last_seen_at, last_error FROM analyzer_workers WHERE worker_id = ? LIMIT 1",
    ).bind(workerId).first<{ worker_id: string; status: string; last_seen_at: string; last_error: string | null }>();
    const lastSeenAt = worker?.last_seen_at ?? null;
    const online = Boolean(
      worker?.status === "online" && lastSeenAt && new Date(lastSeenAt).getTime() >= Date.now() - ONLINE_WINDOW_MS,
    );
    return Response.json({ workerId, online, status: worker?.status ?? "missing", lastSeenAt, lastError: worker?.last_error ?? null });
  } catch (error) { return errorResponse(error); }
}
