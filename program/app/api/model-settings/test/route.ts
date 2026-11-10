import { z } from "zod";
import { ensureUser, getD1, getOrganizationAccess } from "../../../../db/runtime";
import { apiError, errorResponse } from "../../../../lib/api-response";
import { readRequestIdentity } from "../../../../lib/request-auth";
import { modelRoles, ModelSettingsError, probeSavedModelConfiguration, readModelSettings } from "../../../../lib/model-settings";

const schema = z.object({ organizationId: z.string().uuid(), role: z.enum(modelRoles) }).strict();

export async function POST(request: Request) {
  const identity = await readRequestIdentity(request);
  if (!identity) return apiError("AUTH_REQUIRED", "请先登录。", 401);
  if (request.headers.get("origin") && request.headers.get("origin") !== new URL(request.url).origin) return apiError("INVALID_ORIGIN", "请从当前项目页面测试配置。", 403);
  try {
    const parsed = schema.safeParse(await request.json());
    if (!parsed.success) return apiError("INVALID_MODEL_TEST", "模型测试范围无效。", 400);
    const { organizationId, role } = parsed.data;
    const access = await getOrganizationAccess(identity.authSubject, organizationId);
    if (!access || access.organizationRole !== "admin") return apiError("ADMIN_REQUIRED", "只有公司管理员可以测试模型。", 403);
    const user = await ensureUser(identity);
    const db = getD1();
    const previous = await db.prepare("SELECT created_at FROM audit_logs WHERE organization_id = ? AND action = 'model.connection_test' AND target_id = ? ORDER BY created_at DESC LIMIT 1").bind(organizationId, role).first<{ created_at: string }>();
    if (previous && Date.now() - Date.parse(previous.created_at) < 15_000) return apiError("MODEL_TEST_COOLDOWN", "请稍后再测试同一个模型。", 429);
    const result = await probeSavedModelConfiguration(organizationId, role);
    await db.prepare("INSERT INTO audit_logs (id, organization_id, project_id, actor_user_id, action, target_type, target_id, metadata_json, created_at) VALUES (?, ?, NULL, ?, 'model.connection_test', 'model_service', ?, ?, ?)").bind(crypto.randomUUID(), organizationId, user.id, role, JSON.stringify(result), new Date().toISOString()).run();
    if (role === "visualUnderstanding") {
      const configuration = (await readModelSettings(organizationId)).roles.visualUnderstanding;
      const probe = { ...result, provider: configuration.provider, model: configuration.model,
        adapter: "adapter" in result ? result.adapter : "openai_compatible_image_preflight", endpointConnected: result.httpStatus === 200,
        imageTestPassed: result.status === "passed", observationCount: result.status === "passed" ? 1 : 0,
        httpStatus: result.httpStatus || null, responseType: "chat_completion", requestId: null, providerCode: null,
      };
      await db.prepare("INSERT INTO audit_logs (id, organization_id, project_id, actor_user_id, action, target_type, target_id, metadata_json, created_at) VALUES (?, ?, NULL, ?, 'model.vision_probe', 'model_service', 'visualUnderstanding', ?, ?)").bind(crypto.randomUUID(), organizationId, user.id, JSON.stringify(probe), new Date().toISOString()).run();
    }
    return Response.json({ result }, { headers: { "cache-control": "no-store" } });
  } catch (error) {
    if (error instanceof ModelSettingsError) return apiError(error.code, error.message, error.status);
    return errorResponse(error);
  }
}
