import { runtimeFixture } from "./runtime-fixture.mjs";

export async function ecommerceFixture(t) {
  const f = runtimeFixture(t), installation = await f.initialize();
  const organizationId = installation.organizationId, projectId = "commerce-project";
  f.identity.userId = installation.userId;
  f.identity.allowed = true;
  f.identity.signedIn = true;
  f.mock("lib/request-auth.ts", { readRequestIdentity: async () => f.identity.signedIn ? { authSubject: f.identity.userId } : null });
  f.runtime.getProjectAccess = async (_subject, org, project) => f.identity.allowed && org === organizationId && project === projectId
    ? { userId: f.identity.userId, organizationId, projectId, organizationRole: f.identity.role, projectRole: f.identity.role === "admin" ? null : "member" } : null;
  const seed = (table, values) => {
    const names = new Set(f.sqlite.prepare(`PRAGMA table_info(${table})`).all().map(row => row.name));
    const now = new Date().toISOString();
    const row = Object.fromEntries(Object.entries({ id: crypto.randomUUID(), organization_id: organizationId, project_id: projectId, created_by: installation.userId, updated_by: installation.userId, created_at: now, updated_at: now, ...values }).filter(([key]) => names.has(key)));
    f.sqlite.prepare(`INSERT INTO ${table} (${Object.keys(row).join(",")}) VALUES (${Object.keys(row).map(() => "?").join(",")})`).run(...Object.values(row));
    return row.id;
  };
  seed("projects", { id: projectId, name: "合成电商测试空间", client_name: "合成测试" });
  seed("projects", { id: "foreign-project", name: "Other", client_name: "Other" });
  const scope = { organizationId, projectId };
  const request = (method, body = {}, resource = "settings") => new Request(`http://localhost/api/ecommerce/${resource}?${new URLSearchParams(scope)}`, {
    method, ...(method !== "GET" ? { headers: { "content-type": "application/json" }, body: JSON.stringify({ ...scope, ...body }) } : {}),
  });
  const route = resource => f.load(`app/api/ecommerce/${resource}/route.ts`);
  const enable = async () => {
    const response = await route("settings").PUT(request("PUT", { enabled: true, revision: 0 }));
    if (response.status !== 200) throw new Error(await response.text());
  };
  const productInput = {
    name: "合成测试杯（非真实商品）", sku: "SYNTHETIC-ONLY", status: "draft", revision: 0,
    publicData: { category: "测试日用品", audience: { user: "合成使用者", buyer: "合成购买者" }, scenarios: "合成测试场景", prohibited: "不宣称未证实效果", claims: [] },
    internalData: { costCents: 12345, stock: 987, marginNotes: "PRIVATE_TEST_ONLY", refundReasons: "PRIVATE_REFUNDS" },
  };
  const saveProduct = async (overrides = {}) => {
    const response = await route("products").POST(request("POST", { ...productInput, ...overrides }, "products"));
    if (response.status !== 201 && response.status !== 200) throw new Error(await response.text());
    return (await response.json()).product;
  };
  return { ...f, ...scope, scope, seed, request, route, enable, productInput, saveProduct };
}
