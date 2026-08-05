import { getD1 } from "../../../db/runtime";

export async function GET() {
  try {
    await getD1().prepare("SELECT 1 AS ready").first();
    return Response.json(
      { status: "ok", database: "ready", service: "liming-zhiyao" },
      { headers: { "cache-control": "no-store" } },
    );
  } catch {
    return Response.json(
      { status: "degraded", database: "unavailable", service: "liming-zhiyao" },
      { status: 503, headers: { "cache-control": "no-store" } },
    );
  }
}
