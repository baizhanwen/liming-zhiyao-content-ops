import assert from "node:assert/strict";
import test from "node:test";
import * as rewrite from "../lib/single-benchmark-rewrite.ts";

import { fixture, source, plan, generated, segments } from "./helpers/single-benchmark-fixture.mjs";

test('accepted example keeps whole-reference coverage, ordered stages and close length', () => {
  assert.deepEqual(rewrite.validateBenchmarkRewritePlan(source.sourceScript, plan), plan);
  const aligned = rewrite.validateBenchmarkRewriteDraft(source, plan, generated.join('\n\n'), segments);
  assert.equal(aligned.segments.length, 7);
  assert.equal(aligned.generatedCharacters >= aligned.minCharacters, true);
  assert.throws(() => rewrite.validateBenchmarkRewritePlan(source.sourceScript, { ...plan, segments: [...plan.segments].reverse() }), /顺序/);
  assert.throws(() => rewrite.validateBenchmarkRewritePlan(source.sourceScript, { ...plan, segments: plan.segments.slice(1) }), /完整覆盖/);
  assert.throws(() => rewrite.validateBenchmarkRewriteDraft(source, plan, '完全不同的正文', segments), /完整一致/);
  assert.throws(() => rewrite.validateBenchmarkRewriteDraft(source, plan, '简短'.repeat(7), segments.map(s => ({ ...s, text: '简短' }))), /总字数/);
  assert.throws(() => rewrite.validateBenchmarkRewriteDraft(source, plan, generated.join(''), [...segments].reverse()), /顺序/);
  assert.throws(() => rewrite.validateBenchmarkRewriteDraft(source, plan, generated.join('').replace('社团', 'XX'), segments), /XX|完整一致/);
  assert.throws(() => rewrite.validateBenchmarkRewriteDraft(source, plan, '请帮我完成 XX 任务。', segments), /占位/);
});

test('only an eligible original or complete transcript can supply the template', () => {
  assert.equal(rewrite.readBenchmarkRewriteSource(JSON.stringify({ summary: source.sourceScript })), null);
  assert.equal(rewrite.readBenchmarkRewriteSource(JSON.stringify({ spoken_script_set: { corrected_original: { status: 'completed', text: source.sourceScript, validation: { passed: false } } } })), null);
  assert.deepEqual(rewrite.readBenchmarkRewriteSource('{}', source.sourceScript), { sourceScript: source.sourceScript, sourceKind: 'transcript' });
  assert.equal(rewrite.readBenchmarkRewriteSource(JSON.stringify({ spoken_script_set: { corrected_original: { status: 'completed', text: source.sourceScript } } }), '不同的转写').sourceKind, 'corrected_original');
});


for (const overrides of [{ benchmarkEntryIds: [] }, { benchmarkEntryIds: ['benchmark', 'second'] }]) test(`single-reference rejects ${overrides.benchmarkEntryIds.length} selections before calling AI`, async t => {
  const f = await fixture(t), response = await f.complete(overrides);
  assert.equal(response.status, 400); assert.equal(f.calls.length, 0);
});

for (const condition of ['noScript', 'revoked', 'foreign']) test(`${condition} cannot become a single-reference template`, async t => {
  const f = await fixture(t, { [condition]: true }), response = await f.complete();
  assert.equal(response.status, 409, await response.text()); assert.equal(f.calls.length, 0);
  assert.equal(f.sqlite.prepare('SELECT COUNT(*) AS n FROM content_versions').get().n, 1);
});

for (const options of [{}, { transcript: true }, { shortFirst: true }, { rejectReview: true }]) test(`complete route persists traceable template and corrects deviations ${JSON.stringify(options)}`, async t => {
  const f = await fixture(t, options), response = await f.complete();
  assert.equal(response.status, 200, await response.clone().text());
  const body = await response.json(), pack = JSON.parse(body.item.pack_json);
  assert.equal(pack.benchmarkRewrite.sourceScript, source.sourceScript);
  assert.equal(pack.benchmarkRewrite.sourceKind, options.transcript ? 'transcript' : 'corrected_original');
  assert.equal(pack.benchmarkRewrite.status, 'aligned');
  assert.deepEqual(pack.benchmarkRewrite.segments, segments);
  assert.equal(pack.benchmarkRewriteSegments, undefined);
  assert.equal(f.stats().generations, options.shortFirst || options.rejectReview ? 2 : 1);
  assert.equal(body.item.prompt_version, rewrite.BENCHMARK_REWRITE_VERSION);
  const saved = f.sqlite.prepare('SELECT input_snapshot_json, pack_json FROM content_versions WHERE content_item_id = ? AND version = 2').get(f.contentId);
  assert.equal(JSON.parse(saved.input_snapshot_json).singleBenchmarkTemplate.sourceId, 'benchmark');
  assert.deepEqual(JSON.parse(saved.input_snapshot_json).singleBenchmarkTemplate.plan, plan);
  assert.equal(JSON.parse(saved.pack_json).fullScript, generated.join('\n\n'));
});

for (const options of [{ invalidPlan: true }, { rejectReview: 'always' }]) test(`failed validation preserves the previous version ${JSON.stringify(options)}`, async t => {
  const f = await fixture(t, options), response = await f.complete();
  assert.equal(response.status, 502);
  assert.equal(f.sqlite.prepare('SELECT current_version FROM content_items WHERE id = ?').get(f.contentId).current_version, 1);
  const call = f.sqlite.prepare('SELECT status, output_json FROM model_calls').get();
  assert.equal(call.status, 'failed'); assert.equal(JSON.parse(call.output_json).attempts.length > 0, true);
  assert.equal(f.stats().generations <= 3, true);
});

test('manual edits retain trusted template, ignore client tampering, and mark alignment outdated', async t => {
  const f = await fixture(t, { transcript: true });
  const response = await f.complete(); assert.equal(response.status, 200, await response.clone().text());
  const pack = JSON.parse((await response.json()).item.pack_json);
  const edited = { ...pack, fullScript: pack.fullScript + '\n这是人工补充的一段内容。', benchmarkRewrite: { ...pack.benchmarkRewrite, sourceTitle: '伪造模板标题', sourceScript: '伪造原稿'.repeat(20) } };
  const route = f.load('app/api/content-items/[contentId]/route.ts');
  const saved = await route.PATCH(new Request('http://localhost/api/content-items/test', { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ...f.scope, pack: edited }) }), f.params);
  assert.equal(saved.status, 200, await saved.clone().text());
  const report = JSON.parse((await saved.json()).item.pack_json).benchmarkRewrite;
  assert.equal(report.status, 'edited');
  assert.equal(report.sourceTitle, source.sourceTitle); assert.equal(report.sourceScript, source.sourceScript);
  assert.equal(report.generatedScript, pack.fullScript);
  assert.equal(report.generatedCharacters, rewrite.rewriteCharacterCount(edited.fullScript));
});

test('393-character drafts receive concrete edits with the previous script and per-stage budgets', async t => {
  const f = await fixture(t, { longDrafts: 2 });
  const response = await f.complete();
  assert.equal(response.status, 200, await response.clone().text());
  const revisions = f.calls.map(call => { try { return JSON.parse(call.user.slice(call.user.indexOf('\n') + 1)).rewriteRevision; } catch { return null; } }).filter(Boolean);
  assert.equal(revisions.length, 2);
  for (const revision of revisions) {
    assert.equal(revision.currentCharacters, 393);
    assert.equal(revision.charactersToRemove, 109);
    assert.equal(revision.budget.minCharacters, 242);
    assert.equal(revision.budget.maxCharacters, 326);
    assert.equal(revision.previousDraft.benchmarkRewriteSegments.length, 7);
    assert.equal(revision.previousDraft.citations.length, 3);
  }
  assert.equal(f.stats().generations, 3);
  const pack = JSON.parse((await response.json()).item.pack_json);
  assert.equal(pack.benchmarkRewrite.generatedCharacters <= 326, true);
  assert.match(pack.fullScript, /下一条/);
});

test('persistent overlength remains bounded and never saves a falsely aligned version', async t => {
  const f = await fixture(t, { longDrafts: 99 });
  const response = await f.complete();
  assert.equal(response.status, 502);
  assert.equal(f.stats().generations, 3);
  assert.equal(f.sqlite.prepare('SELECT current_version FROM content_items WHERE id = ?').get(f.contentId).current_version, 1);
  const diagnostic = JSON.parse(f.sqlite.prepare('SELECT output_json FROM model_calls').get().output_json);
  assert.equal(diagnostic.attempts.filter(a => a.kind === 'benchmark_revision').length, 2);
});
