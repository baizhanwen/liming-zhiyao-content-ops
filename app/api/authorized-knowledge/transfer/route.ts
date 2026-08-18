import { ensureUser, getD1, getOrganizationAccess, sha256Hex } from "../../../../db/runtime";
import { apiError, errorResponse } from "../../../../lib/api-response";
import { AUTHORIZED_KNOWLEDGE_SOURCE_ID, LEGACY_AUTHORIZED_KNOWLEDGE_SOURCE_IDS, normalizeAuthorizedKnowledgeSkillTags } from "../../../../lib/authorized-knowledge";
import { readRequestIdentity } from "../../../../lib/request-auth";

const SOURCE_NAME = "利明智耀授权方法库";
const FORMAT = "liming-authorized-method-library";
const MAX_ATOMS = 20_000;

type TransferAtom = {
  id: string;
  knowledge: string;
  original: string;
  url: string | null;
  publishedAt: string | null;
  topics: string[];
  skills: string[];
  type: string;
  confidence: string;
};

function cleanText(value: unknown, maximum: number, required = false) {
  const text = typeof value === "string" ? value.replaceAll("\0", "").trim().slice(0, maximum) : "";
  return required && !text ? null : text;
}

function cleanList(value: unknown, maximum = 30) {
  return Array.isArray(value)
    ? [...new Set(value.flatMap((item) => typeof item === "string" && item.trim() ? [item.trim().slice(0, 100)] : []))].slice(0, maximum)
    : [];
}

function parseStoredList(value: unknown) {
  try { return cleanList(JSON.parse(String(value || "[]"))); }
  catch { return []; }
}

function parseAtom(value: unknown, index: number): TransferAtom {
  if (!value || typeof value !== "object") throw new Error(`第 ${index + 1} 条方法原子格式不正确。`);
  const row = value as Record<string, unknown>;
  const id = cleanText(row.id, 120, true); const knowledge = cleanText(row.knowledge, 20_000, true); const original = cleanText(row.original, 100_000, true);
  const type = cleanText(row.type, 40, true); const confidence = cleanText(row.confidence, 20, true);
  if (!id || !knowledge || !original || !type || !confidence) throw new Error(`第 ${index + 1} 条方法原子缺少必填字段。`);
  return {
    id, knowledge, original,
    url: cleanText(row.url, 2_000) || null,
    publishedAt: cleanText(row.publishedAt ?? row.published_at, 40) || null,
    topics: cleanList(row.topics), skills: normalizeAuthorizedKnowledgeSkillTags(cleanList(row.skills)), type, confidence,
  };
}

async function requireAdministrator(request: Request, organizationId: string) {
  const identity = await readRequestIdentity(request);
  if (!identity) return { response: apiError("AUTH_REQUIRED", "请先登录后再迁移授权方法库。", 401) };
  const access = await getOrganizationAccess(identity.authSubject, organizationId);
  if (!access || access.organizationRole !== "admin") return { response: apiError("ADMIN_REQUIRED", "只有公司管理员可以导入或导出授权方法库。", 403) };
  return { identity, access };
}

export async function GET(request: Request) {
  const url = new URL(request.url); const organizationId = url.searchParams.get("organizationId")?.trim() ?? "";
  if (!organizationId) return apiError("ORGANIZATION_REQUIRED", "缺少公司范围。", 400);
  const authorization = await requireAdministrator(request, organizationId); if (authorization.response) return authorization.response;
  try {
    const db = getD1();
    const [source, atoms] = await Promise.all([
      db.prepare("SELECT id, name, revision, item_count, synced_at FROM authorized_knowledge_sources WHERE id = ? LIMIT 1").bind(AUTHORIZED_KNOWLEDGE_SOURCE_ID).first<Record<string, unknown>>(),
      db.prepare("SELECT id, knowledge, original, url, published_at, topics_json, skills_json, atom_type, confidence FROM authorized_knowledge_atoms WHERE source_id = ? ORDER BY id").bind(AUTHORIZED_KNOWLEDGE_SOURCE_ID).all<Record<string, unknown>>(),
    ]);
    if (!source) return apiError("METHOD_LIBRARY_EMPTY", "当前没有可导出的方法库，请先导入方法包。", 404);
    const payload = {
      format: FORMAT, version: 1, exportedAt: new Date().toISOString(),
      source: { name: SOURCE_NAME, revision: source.revision, itemCount: source.item_count },
      atoms: atoms.results.map((atom) => ({
        id: atom.id, knowledge: atom.knowledge, original: atom.original, url: atom.url, publishedAt: atom.published_at,
        topics: parseStoredList(atom.topics_json), skills: normalizeAuthorizedKnowledgeSkillTags(parseStoredList(atom.skills_json)), type: atom.atom_type, confidence: atom.confidence,
      })),
    };
    return new Response(JSON.stringify(payload), { headers: { "content-type": "application/json; charset=utf-8", "content-disposition": `attachment; filename="liming-authorized-methods-${new Date().toISOString().slice(0, 10)}.json"`, "cache-control": "private, no-store" } });
  } catch (error) { return errorResponse(error); }
}

export async function POST(request: Request) {
  try {
    const payload = await request.json() as Record<string, unknown>;
    const organizationId = cleanText(payload.organizationId, 100, true);
    if (!organizationId) return apiError("ORGANIZATION_REQUIRED", "缺少公司范围。", 400);
    const authorization = await requireAdministrator(request, organizationId); if (authorization.response) return authorization.response;
    if (payload.format !== FORMAT || payload.version !== 1 || !Array.isArray(payload.atoms)) return apiError("INVALID_METHOD_PACKAGE", "请选择由本系统导出的授权方法库 JSON 文件。", 400);
    if (!payload.atoms.length || payload.atoms.length > MAX_ATOMS) return apiError("INVALID_METHOD_COUNT", `方法原子数量必须在 1 到 ${MAX_ATOMS.toLocaleString()} 条之间。`, 400);
    const atoms = payload.atoms.map(parseAtom);
    if (new Set(atoms.map((atom) => atom.id)).size !== atoms.length) return apiError("DUPLICATE_METHOD_IDS", "方法包中存在重复的知识原子 ID。", 400);
    const revision = await sha256Hex(new TextEncoder().encode(JSON.stringify(atoms)));
    const user = await ensureUser(authorization.identity!); const db = getD1(); const now = new Date().toISOString();
    const removableSourceIds = [AUTHORIZED_KNOWLEDGE_SOURCE_ID, ...LEGACY_AUTHORIZED_KNOWLEDGE_SOURCE_IDS];
    const sourcePlaceholders = removableSourceIds.map(() => "?").join(", ");
    await db.batch([
      db.prepare(`DELETE FROM authorized_knowledge_atoms WHERE source_id IN (${sourcePlaceholders})`).bind(...removableSourceIds),
      db.prepare(`DELETE FROM authorized_knowledge_sources WHERE id IN (${sourcePlaceholders})`).bind(...removableSourceIds),
      db.prepare("INSERT INTO authorized_knowledge_sources (id, name, revision, item_count, synced_at) VALUES (?, ?, ?, ?, ?)").bind(AUTHORIZED_KNOWLEDGE_SOURCE_ID, SOURCE_NAME, revision, atoms.length, now),
    ]);
    for (let index = 0; index < atoms.length; index += 80) {
      await db.batch(atoms.slice(index, index + 80).map((atom) => db.prepare("INSERT INTO authorized_knowledge_atoms (id, source_id, knowledge, original, url, published_at, topics_json, skills_json, atom_type, confidence) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").bind(atom.id, AUTHORIZED_KNOWLEDGE_SOURCE_ID, atom.knowledge, atom.original, atom.url, atom.publishedAt, JSON.stringify(atom.topics), JSON.stringify(atom.skills), atom.type, atom.confidence)));
    }
    await db.prepare("INSERT INTO audit_logs (id, organization_id, project_id, actor_user_id, action, target_type, target_id, metadata_json, created_at) VALUES (?, ?, NULL, ?, 'authorized_knowledge.imported', 'authorized_knowledge_source', ?, ?, ?)").bind(crypto.randomUUID(), organizationId, user.id, AUTHORIZED_KNOWLEDGE_SOURCE_ID, JSON.stringify({ atomCount: atoms.length, revision }), now).run();
    return Response.json({ source: { id: AUTHORIZED_KNOWLEDGE_SOURCE_ID, name: SOURCE_NAME, revision, item_count: atoms.length, synced_at: now } });
  } catch (error) { return errorResponse(error); }
}
