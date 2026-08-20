import { getD1 } from "../../../db/runtime";
import { buildInfo } from "../../../lib/build-info";

export async function GET() {
  try {
    await getD1().prepare("SELECT 1 AS ready").first();
    return Response.json(
      { status: "ok", database: "ready", service: "liming-zhiyao", ...buildInfo },
      { headers: { "cache-control": "no-store" } },
    );
  } catch {
    return Response.json(
      { status: "degraded", database: "unavailable", service: "liming-zhiyao", ...buildInfo },
      { status: 503, headers: { "cache-control": "no-store" } },
    );
  }
}
