import assert from "node:assert/strict";
import { createProductionScaffold } from "../lib/content-production.ts";

// Called by the isolated built Worker harness, using real HTTP/D1 sessions.
export async function runContentLifecycleChecks({ db, http, expect, users }) {
  const user = users[0], now = new Date().toISOString();
  const scope = { organizationId: user.org, projectId: user.project };
  const topicId = "runtime-content-topic";
  await db.prepare("INSERT INTO topic_ideas (id, organization_id, project_id, title, source_type, created_by, updated_by, created_at, updated_at) VALUES (?, ?, ?, '隔离内容流程验收', 'manual', ?, ?, ?, ?)")
    .bind(topicId, user.org, user.project, user.id, user.id, now, now).run();
  await db.prepare("INSERT INTO content_strategies (id, organization_id, project_id, version, name, positioning, target_audience, status, pain_points_json, pillars_json, topic_mix_json, objectives_json, created_by, updated_by, created_at, updated_at) VALUES ('runtime-content-strategy', ?, ?, 1, '隔离策略', '清楚交代任务的具体目标', '初学者', 'active', '[]', '[]', '{}', '[]', ?, ?, ?, ?)")
    .bind(user.org, user.project, user.id, user.id, now, now).run();
  const item = expect(await http("/api/content-items", { user, method: "POST", body: { ...scope, topicId } }), 201).item;
  const route = `/api/content-items/${item.id}`;
  const pack = { ...createProductionScaffold({ id: topicId, title: item.title }),
    fullScript: "交代一项任务时，先说明背景，再说清目标。最后约定交付时间和格式，双方复述一遍要求，才能减少来回修改。",
    shortScript: "交代任务时说明背景、目标和交付标准，再约定时间与格式。" };
  pack.citations.push({ sourceType: "strategy", sourceId: "runtime-content-strategy", quote: "清楚交代任务的具体目标" });
  const save = (expectedVersion, extra = {}) => http(route, { user, method: "PATCH", body: { ...scope, expectedVersion, pack, ...extra } });
  const transition = (expectedVersion, toStatus) => http(`${route}/transition`, { user, method: "POST", body: { ...scope, expectedVersion, toStatus } });
  const publish = (expectedVersion, extra = {}) => http(`${route}/publications`, { user, method: "POST", body: { ...scope, expectedVersion, platform: "douyin", status: "published", externalUrl: "https://example.invalid/published", ...extra } });
  const state = () => db.prepare("SELECT current_version, status FROM content_items WHERE id = ?").bind(item.id).first();
  const versions = () => db.prepare("SELECT COUNT(*) AS n FROM content_versions WHERE content_item_id = ?").bind(item.id).first();
  expect(await save(1), 200);
  expect(await transition(2, "internal_review"), 200);
  expect(await save(2), 200);
  assert.deepEqual(await state(), { current_version: 3, status: "internal_revision" });
  assert.equal((await db.prepare("SELECT decision FROM content_reviews WHERE content_item_id = ? AND round = 1").bind(item.id).first()).decision, "cancelled");
  expect(await transition(2, "publish_ready"), 409);
  expect(await transition(3, "internal_review"), 200);
  expect(await transition(3, "publish_ready"), 200);
  const scheduled = expect(await publish(3, { status: "scheduled", externalUrl: "" }), 200).publication;
  expect(await save(3), 200);
  assert.deepEqual(await state(), { current_version: 4, status: "internal_revision" });
  expect(await publish(4), 409);
  expect(await transition(4, "internal_review"), 200);
  expect(await transition(4, "publish_ready"), 200);
  assert.equal(expect(await publish(4, { publicationId: scheduled.id }), 409).error.code, "PUBLICATION_VERSION_MISMATCH");
  const competing = await Promise.all([save(4), save(4)]);
  assert.deepEqual(competing.map(r => r.status).sort(), [200, 409]);
  assert.deepEqual(await state(), { current_version: 5, status: "internal_revision" });
  assert.equal((await versions()).n, 5);
  expect(await transition(5, "internal_review"), 200);
  expect(await transition(5, "publish_ready"), 200);
  // Either publication locks the approved version, or revision requires new approval.
  const race = await Promise.all([save(5), publish(5)]);
  assert.deepEqual(race.map(r => r.status).sort(), [200, 409]);
  let current = await state();
  if (current.status === "internal_revision") {
    expect(await transition(current.current_version, "internal_review"), 200);
    expect(await transition(current.current_version, "publish_ready"), 200);
    expect(await publish(current.current_version), 200);
  }
  current = await state();
  assert.equal(current.status, "published");
  expect(await save(current.current_version), 409);
  expect(await publish(current.current_version - 1), 409);
  const published = await db.prepare("SELECT p.content_version_id, v.version, r.decision FROM publication_records p JOIN content_versions v ON v.id = p.content_version_id JOIN content_reviews r ON r.content_version_id = p.content_version_id WHERE p.content_item_id = ? AND p.status = 'published' AND r.decision = 'approved'").bind(item.id).all();
  assert.equal(published.results.length, 1);
  assert.equal(published.results[0].version, current.current_version);
  const historical = await db.prepare("SELECT content_version_id FROM published_copy_records WHERE content_item_id = ?").bind(item.id).first();
  assert.equal(historical.content_version_id, published.results[0].content_version_id);
  expect(await http(route, { user: users[10], method: "PATCH", body: { ...scope, pack } }), 403);
}
