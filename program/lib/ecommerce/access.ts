import type { z } from "zod";
import { getD1, getProjectAccess, type ProjectAccess } from "../../db/runtime";
import { readRequestIdentity } from "../request-auth";
import { apiError, errorResponse } from "../api-response";
import { scopeSchema } from "./contracts";
import { assertProjectWriteAccess, projectWriteAccessBindings, projectWriteAccessCondition, ProjectWriteAccessChangedError } from "../project-write-access";

export class EcommerceError extends Error {
  constructor(public code: string, message: string, public status = 400) { super(message); }
}
export type EcommerceSettings = { enabled: number; revision: number; max_concurrent: number; monthly_call_limit: number };
export type EcommerceAccess = ProjectAccess & { settings: EcommerceSettings };

export async function readSettings(organizationId: string, projectId: string): Promise<EcommerceSettings> {
  return await getD1().prepare("SELECT enabled, revision, max_concurrent, monthly_call_limit FROM ecommerce_project_settings WHERE organization_id = ? AND project_id = ?")
    .bind(organizationId, projectId).first<EcommerceSettings>() ?? { enabled: 0, revision: 0, max_concurrent: 1, monthly_call_limit: 100 };
}

export async function authorize(request: Request, scope: unknown, write = false): Promise<EcommerceAccess> {
  const identity = await readRequestIdentity(request);
  if (!identity) throw new EcommerceError("AUTH_REQUIRED", "请先登录。", 401);
  const parsed = scopeSchema.safeParse(scope);
  if (!parsed.success) throw new EcommerceError("SCOPE_REQUIRED", "请选择公司与企业空间。", 400);
  const access = await getProjectAccess(identity.authSubject, parsed.data.organizationId, parsed.data.projectId);
  if (!access) throw new EcommerceError("ACCESS_DENIED", "无权访问该企业空间。", 403);
  const settings = await readSettings(access.organizationId, access.projectId);
  if (write && !settings.enabled) throw new EcommerceError("ECOMMERCE_DISABLED", "当前空间尚未启用电商素材，或功能已暂停。", 409);
  return { ...access, settings };
}

export function queryScope(request: Request) {
  const query = new URL(request.url).searchParams;
  return { organizationId: query.get("organizationId"), projectId: query.get("projectId") };
}

/** Limit actual streamed bytes as well as declared length; never echo request bodies in errors. */
export async function readInput<T>(request: Request, schema: z.ZodType<T>): Promise<T> {
  const max = 128 * 1024;
  if (Number(request.headers.get("content-length")) > max) throw new EcommerceError("INPUT_TOO_LARGE", "资料过大，请分批保存。", 413);
  if (!request.body) throw new EcommerceError("INVALID_INPUT", "缺少请求内容。", 400);
  const reader = request.body.getReader(), decoder = new TextDecoder();
  let bytes = 0, body = "";
  try {
    while (true) {
      const { value, done } = await reader.read(); if (done) break;
      bytes += value.byteLength;
      if (bytes > max) { await reader.cancel(); throw new EcommerceError("INPUT_TOO_LARGE", "资料过大，请分批保存。", 413); }
      body += decoder.decode(value, { stream: true });
    }
    body += decoder.decode();
  } finally { reader.releaseLock(); }
  let json: unknown;
  try { json = JSON.parse(body); } catch { throw new EcommerceError("INVALID_JSON", "请求内容不是有效 JSON。", 400); }
  const parsed = schema.safeParse(json);
  if (!parsed.success) throw new EcommerceError("INVALID_INPUT", parsed.error.issues[0]?.message || "输入无效。", 400);
  return parsed.data;
}

export async function endpoint(action: () => Promise<Response>) {
  try { return await action(); }
  catch (error) {
    if (error instanceof EcommerceError) return apiError(error.code, error.message, error.status);
    if (error instanceof Error && /UNIQUE constraint failed/.test(error.message)) return apiError("DUPLICATE_RECORD", "记录已存在，请刷新后核对。", 409);
    return errorResponse(error);
  }
}

/** Used inside mutation SQL, so disabling the module between read and write is effective. */
export const enabledGuard = "EXISTS (SELECT 1 FROM ecommerce_project_settings es WHERE es.organization_id = ? AND es.project_id = ? AND es.enabled = 1)";

export const writeGuard = `${enabledGuard} AND ${projectWriteAccessCondition}`;
export const writeBindings = (access: EcommerceAccess) => [access.organizationId, access.projectId, ...projectWriteAccessBindings(access)];
export const adminAccessGuard = `${projectWriteAccessCondition} AND EXISTS(SELECT 1 FROM organization_members WHERE user_id=? AND organization_id=? AND status='active' AND role='admin')`;
export const adminAccessBindings = (access: EcommerceAccess) => [...projectWriteAccessBindings(access), access.userId, access.organizationId];
export const adminWriteGuard = `${enabledGuard} AND ${adminAccessGuard}`;
export const adminWriteBindings = (access: EcommerceAccess) => [access.organizationId, access.projectId, ...adminAccessBindings(access)];

type MutationOptions = { admin?: boolean; enabled?: boolean };
/** Re-read the request after async validation; SQL guards also cover the commit race. */
export async function assertMutationAccess(request: Request, access: EcommerceAccess, options: MutationOptions = {}) {
  const current = await authorize(request, access, options.enabled !== false);
  if (current.userId !== access.userId) throw new EcommerceError("ACCESS_DENIED", "登录用户已改变，请复制未保存内容并刷新后再操作。", 403);
  try { await assertProjectWriteAccess(getD1(), access); }
  catch (error) { if (error instanceof ProjectWriteAccessChangedError) throw new EcommerceError(error.code, "登录状态或空间权限已改变，资料未保存。请复制未保存内容并刷新确认权限。", 403); throw error; }
  if (options.admin && !await getD1().prepare("SELECT 1 FROM organization_members WHERE user_id=? AND organization_id=? AND status='active' AND role='admin'").bind(access.userId, access.organizationId).first())
    throw new EcommerceError("ADMIN_REQUIRED", "管理员权限已改变，操作未执行。请刷新确认当前权限。", 403);
}

export async function commitMutation(request: Request, access: EcommerceAccess, statements: D1PreparedStatement[], options: MutationOptions = {}) {
  await assertMutationAccess(request, access, options);
  const results = await getD1().batch(statements);
  if (!results[0]?.meta.changes) await assertMutationAccess(request, access, options);
  return results;
}

export function auditStatement(access: ProjectAccess, action: string, targetId: string, metadata: Record<string, unknown> = {}) {
  return getD1().prepare("INSERT INTO audit_logs (id, organization_id, project_id, actor_user_id, action, target_type, target_id, metadata_json, created_at) SELECT ?, ?, ?, ?, ?, 'ecommerce', ?, ?, ? WHERE changes() = 1")
    .bind(crypto.randomUUID(), access.organizationId, access.projectId, access.userId, action, targetId, JSON.stringify(metadata), new Date().toISOString());
}

export function requireChanged(results: D1Result[], message = "资料已被修改或功能已暂停，请刷新后重试。") {
  if (!results[0].meta.changes) throw new EcommerceError("STATE_CHANGED", message, 409);
}
