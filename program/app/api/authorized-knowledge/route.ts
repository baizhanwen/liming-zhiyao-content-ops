import { getD1, getProjectAccess } from "../../../db/runtime";
import { apiError, errorResponse } from "../../../lib/api-response";
import { AUTHORIZED_KNOWLEDGE_SOURCE_ID, retrieveAuthorizedKnowledge } from "../../../lib/authorized-knowledge";
import { readRequestIdentity } from "../../../lib/request-auth";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const identity = await readRequestIdentity(request);
  if (!identity) return apiError("AUTH_REQUIRED", "请先登录后再查看授权方法知识库。", 401);
  try {
    const url = new URL(request.url); const organizationId = url.searchParams.get("organizationId")?.trim() || ""; const projectId = url.searchParams.get("projectId")?.trim() || "";
    if (!organizationId || !projectId) return apiError("PROJECT_SCOPE_REQUIRED", "缺少公司或项目范围。", 400);
    const access = await getProjectAccess(identity.authSubject, organizationId, projectId);
    if (!access) return apiError("PROJECT_ACCESS_REQUIRED", "你无权查看当前项目的授权方法知识库。", 403);
    const db = getD1(); const metadataOnly = url.searchParams.get("metadataOnly") === "1"; const query = url.searchParams.get("q")?.trim().slice(0, 500) || "内容创作 选题 开头 对标 口播";
    const [source, atoms] = await Promise.all([
      db.prepare("SELECT id, name, revision, item_count, synced_at FROM authorized_knowledge_sources WHERE id = ? LIMIT 1").bind(AUTHORIZED_KNOWLEDGE_SOURCE_ID).first<{ id: string; name: string; revision: string; item_count: number; synced_at: string }>(),
      metadataOnly ? Promise.resolve([]) : retrieveAuthorizedKnowledge(db, query, { task: "content", limit: 20 }),
    ]);
    return Response.json({ source, query, canTransfer: access.organizationRole === "admin", atoms: atoms.map((atom) => ({ id: atom.id, knowledge: atom.knowledge, original: atom.original, url: atom.url, published_at: atom.published_at, topics: atom.topics, skills: atom.skills, type: atom.atom_type, confidence: atom.confidence, matchedTerms: atom.matchedTerms })) });
  } catch (error) { return errorResponse(error); }
}
