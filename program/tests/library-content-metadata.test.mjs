import assert from 'node:assert/strict';
import test from 'node:test';
import { runtimeFixture } from './helpers/runtime-fixture.mjs';

async function fixture(t) {
  const f = runtimeFixture(t), owner = await f.initialize(); f.identity.userId = owner.userId;
  const now = '2026-11-12T00:00:00.000Z';
  const seed = (table, values) => {
    const columns = new Set(f.sqlite.prepare(`PRAGMA table_info(${table})`).all().map(row => row.name));
    const row = Object.fromEntries(Object.entries({ id: crypto.randomUUID(), organization_id: owner.organizationId, created_by: owner.userId, updated_by: owner.userId, created_at: now, updated_at: now, ...values }).filter(([key]) => columns.has(key)));
    f.sqlite.prepare(`INSERT INTO ${table}(${Object.keys(row).join(',')}) VALUES(${Object.keys(row).map(() => '?').join(',')})`).run(...Object.values(row)); return row.id;
  };
  const source = seed('projects', { name: 'Source', client_name: 'Synthetic' }), target = seed('projects', { name: 'Target', client_name: 'Synthetic' });
  let writable = true;
  f.runtime.getProjectAccess = async (_subject, org, project) => org === owner.organizationId && project === target ? { allowed: true } : null;
  f.runtime.canWriteProjectAccess = () => writable;
  f.runtime.getOrganizationAccess = async () => ({ organizationId: owner.organizationId, userId: owner.userId, organizationRole: 'admin' });
  f.runtime.canAccessOrganizationVideoLibrary = async () => true; f.runtime.canManageOrganizationVideoLibrary = async () => true;
  const create = (report, values = {}) => {
    const video = seed('videos', { project_id: source, platform: 'douyin', source_type: 'url', source_hash: crypto.randomUUID(), status: 'ready', duration_sec: 80, title: 'Synthetic AI clip' });
    const entry = seed('video_library_entries', { source_video_id: video, category: 'benchmark', tags_json: '["人工标签","AI工具"]', ...values });
    seed('project_video_references', { project_id: target, library_entry_id: entry, purpose: 'benchmark' });
    const analysis = report ? seed('video_analyses', { project_id: source, video_id: video, schema_version: 'analysis.v12', report_json: JSON.stringify(report) }) : null;
    return { entry, video, analysis };
  };
  const list = async (mode = 'assets', extra = '') => {
    const params = new URLSearchParams({ organizationId: owner.organizationId, projectId: target });
    const route = f.load(mode === 'assets' ? 'app/api/video-library/route.ts' : 'app/api/video-library/references/route.ts');
    const response = await route.GET(new Request('http://localhost/library?' + params + extra));
    assert.equal(response.status, 200, await response.clone().text()); return response.json();
  };
  return { ...f, owner, source, target, seed, create, list, setWritable: value => { writable = value; } };
}

const classification = (dimension_id, tags, evidence_ids = ['transcript:0001']) => ({ dimension_id, state: 'known', tags, primary_tag: tags[0], reason: null, evidence_ids });
function report() {
  const completed = { status: 'completed', reason: null, validation: { passed: true, issues: [] } };
  return { analysis_meta: { quality_audit: { status: 'partial', acceptance_passed: false, completion_status: 'partial' } },
    content_analysis: { schema_version: 'content-analysis.v1', taxonomy_version: 'video-taxonomy.v1', validation: { passed: false, issues: ['unrelated_module_failed'] },
      module_status: { text_topic_structure_audience: structuredClone(completed), visual: structuredClone(completed), text_expression_value: { status: 'failed', validation: { passed: false, issues: ['timeout'] } } },
      metrics: { media: { duration_bucket: '30_to_under_60s' } }, classifications: [
        classification('topic.category', ['topic.category.ai_tools']), classification('structure.type', ['structure.type.product']),
        classification('content.form', ['content.form.screen_recording']),
      ] } };
}

test('both lists derive the same accepted module category and tags without changing manual metadata', async t => {
  const f = await fixture(t), item = f.create(report());
  const original = f.sqlite.prepare('SELECT category,tags_json FROM video_library_entries WHERE id=?').get(item.entry);
  const a = await f.list(), b = await f.list('benchmark');
  assert.equal(a.entries[0].content_category_label, 'AI工具');
  assert.deepEqual(a.entries[0].content_categories, b.entries[0].content_categories);
  assert.deepEqual(a.entries[0].tags, b.entries[0].tags);
  assert.deepEqual(a.entries[0].manual_tags, ['人工标签','AI工具']);
  assert.ok(a.entries[0].tags.includes('人工标签')); assert.ok(a.entries[0].tags.includes('AI工具'));
  assert.equal(a.entries[0].tags.filter(x => x === 'AI工具').length, 1);
  assert.deepEqual(f.sqlite.prepare('SELECT category,tags_json FROM video_library_entries WHERE id=?').get(item.entry), original);
  assert.equal(a.entries[0].category, 'benchmark');
  assert.equal(b.canManage, true);assert.equal(typeof b.entries[0].updated_at, 'string');
  assert.equal('content_classifications_json' in a.entries[0], false);
  assert.equal('report_json' in a.entries[0], false);
});

test('actual category, form, measured duration and automatic tag filters apply in both list routes', async t => {
  const f = await fixture(t); f.create(report()); f.create(null, { tags_json: '[]' });
  for (const mode of ['assets','benchmark']) {
    for (const query of ['&topicCategory=topic.category.ai_tools','&contentForm=content.form.screen_recording','&durationBucket=30_to_under_60s','&tag='+encodeURIComponent('AI工具'),'&tag='+encodeURIComponent('人工标签'),'&q='+encodeURIComponent('屏幕录制')]) {
      const result = await f.list(mode, query); assert.equal(result.entries.length, 1, mode + query);
    }
    const empty = await f.list(mode, '&topicCategory=topic.category.food'); assert.equal(empty.entries.length, 0);
    assert.ok(empty.filterOptions.topicCategories.some(row => row.id === 'topic.category.ai_tools'));
  }
});

test('new reports update automatic labels while manual labels survive', async t => {
  const f = await fixture(t), item = f.create(report()); const next = report();
  next.content_analysis.classifications[0] = classification('topic.category', ['topic.category.technology']);
  f.sqlite.prepare('UPDATE video_analyses SET report_json=? WHERE id=?').run(JSON.stringify(next), item.analysis);
  const current = (await f.list()).entries[0];
  assert.equal(current.category, 'benchmark'); assert.deepEqual(current.manual_tags, ['人工标签','AI工具']);
  assert.equal(current.content_category_label, '科技数码');
});

test('unknown, failed, invalid and unsupported classification projections do not manufacture labels', async t => {
  const f = await fixture(t), helper = f.load('lib/library-content-metadata.ts');
  const content = report().content_analysis;
  const base = { analysis_schema_version: 'analysis.v12', tags_json: '["人工标签"]', content_schema_version: content.schema_version, content_taxonomy_version: content.taxonomy_version,
    content_classifications_json: JSON.stringify(content.classifications), content_modules_json: JSON.stringify(content.module_status), duration_sec: 15 };
  const variants = [ { content_taxonomy_version: 'unknown' }, { content_schema_version: 'unknown' },
    { content_classifications_json: JSON.stringify([{ ...content.classifications[0], state: 'unknown' }]) },
    { content_classifications_json: JSON.stringify([classification('topic.category',['not-a-real-tag'])]) },
    { content_classifications_json: JSON.stringify([classification('topic.category',['topic.category.ai_tools'],[])]) },
    { content_modules_json: JSON.stringify({ ...content.module_status, text_topic_structure_audience: { status: 'failed', validation: { passed: false } } }) },
  ];
  for (const variation of variants) {
    const value = helper.libraryContentMetadata({ ...base, ...variation }); assert.equal(value.content_category, null); assert.ok(value.tags.includes('人工标签'));
  }
});

test('company management does not imply permission to sync into a read-only target project', async t => {
  const f = await fixture(t); f.create(report()); f.setWritable(false);
  const list = await f.list(); assert.equal(list.canManage, true); assert.equal(list.canImportToProject, false);
  f.setWritable(true); assert.equal((await f.list()).canImportToProject, true);
});
