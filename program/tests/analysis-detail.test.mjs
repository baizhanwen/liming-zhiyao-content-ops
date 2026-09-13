import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";

test("analysis detail re-checks project access and scopes every result query", async () => {
  const route = await readFile(new URL("../app/api/videos/[videoId]/route.ts", import.meta.url), "utf8");
  assert.match(route, /getProjectAccess/);
  assert.match(route, /v\.id = \? AND v\.organization_id = \? AND v\.project_id = \?/);
  assert.match(route, /video_transcripts WHERE organization_id = \? AND project_id = \? AND video_id = \?/);
  assert.match(route, /video_analyses WHERE organization_id = \? AND project_id = \? AND video_id = \?/);
  assert.match(route, /SELECT id, analysis_job_id, schema_version/);
  assert.match(route, /SELECT id, analysis_job_id, kind/);
  assert.match(route, /ORDER BY created_at DESC LIMIT 8/);
  assert.match(route, /analyses: analysisVersions/);
  assert.match(route, /analysis_job_events WHERE organization_id = \? AND project_id = \? AND video_id = \?/);
});

test("private media endpoints protect both user and worker reads", async () => {
  const [browserMedia, workerSource] = await Promise.all([
    readFile(new URL("../app/api/videos/[videoId]/media/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/api/internal/analysis-jobs/[jobId]/source/route.ts", import.meta.url), "utf8"),
  ]);
  assert.match(browserMedia, /readRequestIdentity/);
  assert.match(browserMedia, /getProjectAccess/);
  assert.match(browserMedia, /a\.organization_id = v\.organization_id AND a\.project_id = v\.project_id/);
  assert.match(workerSource, /requireAnalyzerService/);
  assert.match(workerSource, /j\.lease_owner = \?/);
  assert.match(workerSource, /j\.lease_expires_at > \?/);
});

test("detail UI keeps protected media review while evidence locating stays hidden", async () => {
  const [workspace, detail] = await Promise.all([
    readFile(new URL("../components/AnalysisWorkspace.tsx", import.meta.url), "utf8"),
    readFile(new URL("../components/AnalysisDetail.tsx", import.meta.url), "utf8"),
  ]);
  assert.match(workspace, /查看结果/);
  assert.match(detail, /currentTime = startMs \/ 1000/);
  assert.match(detail, /结构化分析/);
  assert.match(detail, /作品数据表现/);
  assert.match(detail, /公开互动/);
  assert.match(detail, /企业后台数据/);
  assert.match(detail, /visibleOwnedMetrics/);
  assert.match(detail, /const coverFrame = keyframes\[0\]/);
  assert.match(detail, /asset\.analysis_job_id === analysis\.analysis_job_id/);
  assert.match(detail, /本地分析封面/);
  assert.match(detail, /打开原始抖音链接/);
  assert.match(detail, /analysisVersions/);
  assert.match(detail, /对比版本/);
  assert.doesNotMatch(detail, /evidenceForInsight/);
  assert.doesNotMatch(detail, /定位证据/);
  assert.match(detail, /打开原视频核对/);
  assert.match(detail, /window\.open\(detail\.video\.source_url/);
  assert.match(detail, /detail\.video\.media_url \|\| detail\.video\.source_url/);
  assert.match(detail, /normalizeSpokenScript\(report, analysis\?\.schema_version/);
  assert.match(detail, /原版口播文案/);
  assert.match(detail, /未通过验收的口播候选稿/);
  assert.match(detail, /候选稿未通过验收，内容已保留供核对/);
  assert.doesNotMatch(detail, /单独重试这一版/);
  assert.match(detail, /这份报告是“部分完成”/);
  assert.match(detail, /item\.key !== "depth"/);
  assert.match(detail, /detail\.job\?\.status === "partial" && qualityStatus !== "passed"/);
  assert.match(detail, /qualityAudit\.score \+ \(removedDepthCheck\?\.passed === false \? 12 : 0\)/);
  assert.doesNotMatch(detail, /dangerouslySetInnerHTML/);
});
test("analysis detail merges the latest confirmed XLSX work snapshot", async () => {
  const route = await readFile(new URL("../app/api/videos/[videoId]/route.ts", import.meta.url), "utf8");
  assert.match(route, /FROM platform_works w/);
  assert.match(route, /w\.video_id = \? AND w\.match_status = 'confirmed'/);
  assert.match(route, /platform_metric_import_batches latest_batch/);
  assert.match(route, /ownedPerformance/);
});

test("analysis detail renders CTA as an ordinary report-grid section and keeps legacy conversion readable", async () => {
  const [detail, styles] = await Promise.all([
    readFile(new URL("../components/AnalysisDetail.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/globals.css", import.meta.url), "utf8"),
  ]);
  assert.match(detail, /normalizeCtaAnalysis/);
  assert.match(detail, /report\.cta_analysis/);
  assert.match(detail, /report\.ctaAnalysis/);
  assert.match(detail, /report\.cta/);
  assert.match(detail, /report\.conversion_design/);
  assert.match(detail, /structured\.detected, structured\.present, structured\.has_cta/);
  assert.match(detail, /items: detected === false \? \[\] : items/);
  assert.match(detail, /"cta_type", "ctaType", "type", "kind"/);
  assert.match(detail, /"quote", "evidence_text", "evidenceText", "wording"/);
  assert.match(detail, /"conversion_path", "conversionPath", "handoff_path", "handoffPath"/);
  assert.match(detail, /CTA 分析/);
  assert.match(detail, /未识别到明确 CTA/);
  assert.match(detail, /目标动作/);
  assert.match(detail, /承接：/);
  assert.match(detail, /function ctaCompactText/);
  assert.match(detail, /\[\["cta_analysis", ctaAnalysis\]/);
  assert.match(detail, /key === "cta_analysis" && ctaAnalysis/);
  assert.match(detail, /ctaExportText\(ctaAnalysis\)/);
  assert.match(detail, /criticalQualityKeys = \[[^\]]*"cta"/);
  assert.match(detail, /independentReportKeys/);
  assert.match(detail, /reportSectionOrder = \[.*"conversion_design", "cta_analysis"/);
  assert.doesNotMatch(detail, /independentReportKeys = new Set\(\[[^\]]*"conversion_design"/);
  assert.doesNotMatch(detail, /function CtaAnalysisPanel/);
  assert.doesNotMatch(styles, /\.cta-analysis-panel/);
});
