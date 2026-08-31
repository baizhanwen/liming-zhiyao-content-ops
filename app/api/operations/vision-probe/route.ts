import { env } from "cloudflare:workers";
import { z } from "zod";
import { ensureUser, getD1, getOrganizationAccess } from "../../../../db/runtime";
import { apiError, errorResponse } from "../../../../lib/api-response";
import { probeMiniMaxTokenPlanVision } from "../../../../lib/minimax-vision";
import { readRequestIdentity } from "../../../../lib/request-auth";

const requestSchema = z.object({ organizationId: z.string().uuid() });

export async function POST(request: Request) {
  const identity = await readRequestIdentity(request);
  if (!identity) return apiError("AUTH_REQUIRED", "请先登录后再测试视觉模型。", 401);
  try {
    const parsed = requestSchema.safeParse(await request.json());
    if (!parsed.success) return apiError("INVALID_SCOPE", "缺少有效的公司范围。", 400);
    const { organizationId } = parsed.data;
    const access = await getOrganizationAccess(identity.authSubject, organizationId);
    if (!access || access.organizationRole !== "admin") return apiError("ADMIN_REQUIRED", "只有公司管理员可以发起付费图片预检。", 403);
    const user = await ensureUser(identity);
    const db = getD1();
    const latest = await db.prepare("SELECT created_at FROM audit_logs WHERE organization_id = ? AND action = 'model.vision_probe' AND target_id = 'visualUnderstanding' ORDER BY created_at DESC LIMIT 1").bind(organizationId).first<{ created_at: string }>();
    if (latest?.created_at && Date.now() - new Date(latest.created_at).getTime() < 60_000) {
      return apiError("VISION_PROBE_COOLDOWN", "图片预检每分钟最多执行一次，请稍后再试。", 429);
    }
    const runtime = env as unknown as Record<string, unknown>;
    const probe = await probeMiniMaxTokenPlanVision(runtime);
    const now = new Date().toISOString();
    await db.prepare("INSERT INTO audit_logs (id, organization_id, project_id, actor_user_id, action, target_type, target_id, metadata_json, created_at) VALUES (?, ?, NULL, ?, 'model.vision_probe', 'model_service', 'visualUnderstanding', ?, ?)")
      .bind(crypto.randomUUID(), organizationId, user.id, JSON.stringify(probe), now).run();
    return Response.json({ probe });
  } catch (error) {
    return errorResponse(error);
  }
}
