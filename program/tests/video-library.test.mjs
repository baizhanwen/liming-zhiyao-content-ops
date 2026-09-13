import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const read = (path) => readFile(new URL(path, import.meta.url), "utf8");

test("company video library migration preserves canonical videos and project references", async () => {
  const [schema, migration] = await Promise.all([read("../db/schema.ts"), read("../drizzle/0011_company_video_library.sql")]);
  assert.match(schema, /videoLibraryEntries = sqliteTable\("video_library_entries"/);
  assert.match(schema, /projectVideoReferences = sqliteTable\("project_video_references"/);
  assert.match(migration, /CREATE UNIQUE INDEX `idx_video_library_org_source`/);
  assert.match(migration, /INSERT INTO `video_library_entries`/);
  assert.match(migration, /INSERT OR IGNORE INTO `project_video_references`/);
  assert.match(migration, /'benchmark'/);
});

test("library access is available to every employee assigned to a space", async () => {
  const [runtime, helper, references] = await Promise.all([
    read("../db/runtime.ts"), read("../lib/video-library.ts"), read("../app/api/video-library/references/route.ts"),
  ]);
  assert.match(runtime, /pm\.status = 'active'/);
  assert.doesNotMatch(runtime, /pm\.role IN \('owner', 'planner', 'creator', 'reviewer'\)/);
  assert.match(helper, /getProjectAccess\(authSubject, organizationId, projectId\)/);
  assert.match(helper, /project_video_references/);
  assert.match(references, /canWriteProjectAccess/);
  assert.match(references, /purpose = 'benchmark'/);
  assert.match(references, /enqueueBenchmarkVideoAnalysisMemoryEventsWithDb/);
  assert.match(references, /targetProjectId: projectId/);
});

test("material center supports search, classification, tags, import and removal", async () => {
  const [component, libraryRoute, referencesRoute] = await Promise.all([
    read("../components/VideoLibraryWorkspace.tsx"), read("../app/api/video-library/route.ts"), read("../app/api/video-library/references/route.ts"),
  ]);
  assert.match(component, /搜索标题、作者、账号、标签或来源项目/);
  assert.match(component, /\["published", "已发布的视频"\]/);
  assert.match(libraryRoute, /"published", "benchmark"/);
  assert.match(component, /导入当前项目/);
  assert.match(component, /移出项目/);
  assert.match(component, /library-grid/);
  assert.match(component, /cover_url/);
  assert.match(libraryRoute, /tags_json/);
  assert.match(libraryRoute, /video_library\.updated/);
  assert.match(referencesRoute, /video_library\.imported/);
  assert.match(referencesRoute, /video_library\.removed/);
  assert.match(component, /封面读取失败/);
  assert.match(libraryRoute, /frame\.is_cover DESC/);
});

test("company-level library detail does not require a target project", async () => {
  const [detailRoute, migration] = await Promise.all([
    read("../app/api/video-library/[entryId]/route.ts"), read("../drizzle/0021_material_library_cover_integrity.sql"),
  ]);
  assert.match(detailRoute, /canAccessOrganizationVideoLibrary/);
  assert.match(detailRoute, /WHERE library\.id = \? AND library\.organization_id = \?/);
  assert.match(detailRoute, /video_analyses/);
  assert.match(migration, /is_cover/);
  assert.match(migration, /quality_score/);
});

test("video ingestion reuses organization canonical analysis before consuming quota", async () => {
  const [urlRoute, uploadRoute, listingRoute] = await Promise.all([
    read("../app/api/videos/from-url/route.ts"), read("../app/api/videos/upload/route.ts"), read("../app/api/videos/route.ts"),
  ]);
  assert.match(urlRoute, /hashInvitationToken\(`\$\{organizationId\}:\$\{sourceUrl\}`\)/);
  const shared = await read("../lib/video-submission.ts");
  for (const route of [urlRoute, uploadRoute]) {
    assert.match(route, /resolveVideoSubmission\(db, submission, \(\) => checkNewAnalysisAvailability/);
    assert.match(route, /newVideoSubmissionStatements/);
  }
  assert.match(shared, /if \(!canonical\) return validateNew\(\)/);
  assert.match(shared, /video.analysis_reused/);
  assert.match(shared, /INSERT INTO video_library_entries/);
  assert.match(listingRoute, /refs\.purpose = 'analysis'/);
});

test("shared project references can read analysis artifacts without gaining edit access", async () => {
  const [detailRoute, detailComponent] = await Promise.all([
    read("../app/api/videos/[videoId]/route.ts"), read("../components/AnalysisDetail.tsx"),
  ]);
  assert.match(detailRoute, /sharedReference = true/);
  assert.match(detailRoute, /\/api\/video-library\/\$\{libraryEntryId\}\/assets/);
  assert.match(detailRoute, /canWrite: !sharedReference && canWriteProjectAccess/);
  assert.match(detailComponent, /共享素材 · 原分析只读/);
});

test("material-center detail keeps same-space enterprise performance data", async () => {
  const detailRoute = await read("../app/api/videos/[videoId]/route.ts");
  assert.match(detailRoute, /Boolean\(requestedLibraryEntryId\) && projectId === sourceProjectId/);
  assert.match(detailRoute, /canReadOwnedPerformance \? db\.prepare\(`/);
  assert.match(detailRoute, /platform_metric_snapshots/);
  assert.match(detailRoute, /w\.match_status = 'confirmed'/);
});
