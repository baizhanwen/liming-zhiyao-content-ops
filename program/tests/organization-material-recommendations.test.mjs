import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const read = (path) => readFile(new URL(path, import.meta.url), "utf8");

test("content recommendations only use active benchmark bindings from the current enterprise space", async () => {
  const route = await read("../app/api/video-library/recommendations/route.ts");

  assert.match(route, /getProjectAccess\(identity\.authSubject, organizationId, projectId\)/);
  assert.doesNotMatch(route, /getOrganizationAccess|canAccessOrganizationVideoLibrary|MATERIAL_LIBRARY_ACCESS_DENIED/);
  assert.match(route, /FROM project_video_references refs\s+INNER JOIN video_library_entries library/);
  assert.match(route, /WHERE refs\.organization_id = \? AND refs\.project_id = \? AND refs\.purpose = 'benchmark' AND refs\.status = 'active'/);
  assert.match(route, /\.bind\(organizationId, projectId\)\.all<CandidateRow>/);
});

test("enterprise-space benchmark candidates require their latest completed analysis and keep direct metrics", async () => {
  const route = await read("../app/api/video-library/recommendations/route.ts");

  assert.match(route, /SELECT library\.id, library\.category/);
  assert.match(route, /INNER JOIN video_analyses analysis ON analysis\.id = \(\s+SELECT latest\.id FROM video_analyses latest/);
  assert.match(route, /latest\.organization_id = v\.organization_id AND latest\.video_id = v\.id ORDER BY latest\.created_at DESC LIMIT 1/);
  assert.match(route, /metrics\.plays, metrics\.likes, metrics\.comments, metrics\.favorites, metrics\.shares, metrics\.followers_gained/);
  assert.match(route, /readBenchmarkFeedback/);
  assert.match(await read("../lib/benchmark-feedback.ts"), /WHERE organization_id = \? AND project_id = \? AND citation_type = 'benchmark'/);
  assert.match(route, /materialScope: "project_benchmark"/);
});

test("content workspace explains the current enterprise-space benchmark scope", async () => {
  const workspace = await read("../components/ContentProductionWorkspace.tsx");

  assert.match(workspace, /系统检索当前企业空间已分析对标/);
  assert.match(workspace, /保留每条素材的引用与应用说明/);
  assert.doesNotMatch(workspace, /entry\.source_project_name/);
  assert.match(workspace, /本空间历史反馈/);
  assert.match(workspace, /href="\/analysis\?view=benchmark"/);
  assert.match(workspace, /if \(contentBody\.canWrite\)\s+await loadRecommendations/);
});
