import { contentAnalysisReportSchemas, contentTaxonomy } from "./video-content-analysis.ts";

const dimensions = new Map(contentTaxonomy.dimensions.map(row => [row.id, row]));
const tagDimensions = ["topic.category", "topic.purpose", "content.form", "structure.type", "audience.role", "audience.need", "cta.action"];
const durationLabels: Record<string, string> = { under_15s: "不足15秒", "15_to_under_30s": "15–不足30秒", "30_to_under_60s": "30–不足60秒", "60_to_under_180s": "60–不足180秒", "180s_and_above": "180秒及以上" };
const record = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === "object" && !Array.isArray(value);
const parse = (value: unknown): unknown => { if (typeof value !== "string") return value; try { return JSON.parse(value); } catch { return null; } };
const strings = (value: unknown): string[] => Array.isArray(value) ? [...new Set(value.filter((item): item is string => typeof item === "string" && Boolean(item.trim())).map(item => item.trim()))] : [];

// Listing projections stay small even when a report contains long OCR sources.
export const libraryContentColumns = `
  CASE WHEN json_valid(latest_analysis.report_json) THEN json_extract(latest_analysis.report_json,'$.content_analysis.classifications') END AS content_classifications_json,
  CASE WHEN json_valid(latest_analysis.report_json) THEN json_extract(latest_analysis.report_json,'$.content_analysis.taxonomy_version') END AS content_taxonomy_version,
  CASE WHEN json_valid(latest_analysis.report_json) THEN json_extract(latest_analysis.report_json,'$.content_analysis.schema_version') END AS content_schema_version,
  CASE WHEN json_valid(latest_analysis.report_json) THEN json_extract(latest_analysis.report_json,'$.content_analysis.validation.passed') END AS content_validation_passed,
  CASE WHEN json_valid(latest_analysis.report_json) THEN json_extract(latest_analysis.report_json,'$.content_analysis.module_status') END AS content_modules_json,
  CASE WHEN json_valid(latest_analysis.report_json) THEN json_extract(latest_analysis.report_json,'$.content_analysis.metrics.media.duration_bucket') END AS content_duration_bucket,
  (SELECT state.status FROM analysis_jobs state WHERE state.id=latest_analysis.analysis_job_id) AS content_report_job_status`;

export type LibraryContentFilters = { topicCategory: string; contentForm: string; durationBucket: string; tag: string };
export function readLibraryContentFilters(url: URL): LibraryContentFilters | null {
  const filters = { topicCategory: url.searchParams.get("topicCategory")?.trim() || "", contentForm: url.searchParams.get("contentForm")?.trim() || "", durationBucket: url.searchParams.get("durationBucket")?.trim() || "", tag: url.searchParams.get("tag")?.trim() || "" };
  if ((filters.topicCategory && !dimensions.get("topic.category")?.tags.some(row => row.id === filters.topicCategory))
      || (filters.contentForm && !dimensions.get("content.form")?.tags.some(row => row.id === filters.contentForm))
      || (filters.durationBucket && !Object.hasOwn(durationLabels, filters.durationBucket)) || filters.tag.length > 100) return null;
  return filters;
}

function durationBucket(value: unknown): string | null {
  const seconds = typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
  if (seconds === null) return null;
  return seconds < 15 ? "under_15s" : seconds < 30 ? "15_to_under_30s" : seconds < 60 ? "30_to_under_60s" : seconds < 180 ? "60_to_under_180s" : "180s_and_above";
}

export function libraryContentMetadata(row: Record<string, unknown>) {
  const manualTags = strings(parse(row.tags_json));
  const source = parse(row.content_classifications_json), modules = parse(row.content_modules_json);
  const trusted = contentAnalysisReportSchemas.some(schema => row.analysis_schema_version === schema)
    && row.content_schema_version === "content-analysis.v1" && row.content_taxonomy_version === contentTaxonomy.version;
  const classifications = new Map<string, { id: string; label: string }[]>();
  if (trusted && Array.isArray(source) && record(modules)) for (const value of source) {
    if (!record(value) || typeof value.dimension_id !== "string" || value.state !== "known") continue;
    const definition = dimensions.get(value.dimension_id), selected = strings(value.tags), evidence = strings(value.evidence_ids);
    if (!Array.isArray(value.tags) || selected.length !== value.tags.length || value.tags.some(tag => typeof tag !== "string" || tag !== tag.trim())
        || !Array.isArray(value.evidence_ids) || evidence.length !== value.evidence_ids.length || evidence.length > 24) continue;
    const module = definition ? modules[definition.module] : null;
    if (!definition || !selected.length || !evidence.length || !record(module) || module.status !== "completed") continue;
    const validation = module.validation;
    if ((definition.cardinality === "single" && selected.length !== 1)
        || (selected.includes(definition.none_tag_id || "") && selected.length !== 1)
        || (definition.primary_required && !selected.includes(String(value.primary_tag)))
        || (value.primary_tag !== null && value.primary_tag !== undefined && !selected.includes(String(value.primary_tag)))) continue;
    if (!record(validation) || validation.passed !== true || selected.some(id => !definition.tags.some(tag => tag.id === id))) continue;
    classifications.set(definition.id, selected.flatMap(id => {
      const tag = definition.tags.find(tag => tag.id === id);
      return tag && tag.id !== definition.none_tag_id && !tag.disabled ? [{ id: tag.id, label: tag.label }] : [];
    }));
  }
  const categories = classifications.get("topic.category") || [], forms = classifications.get("content.form") || [];
  const automaticTags = [...new Set(tagDimensions.flatMap(id => (classifications.get(id) || []).map(tag => tag.label)))];
  const bucket = typeof row.content_duration_bucket === "string" && Object.hasOwn(durationLabels, row.content_duration_bucket) ? row.content_duration_bucket : durationBucket(row.duration_sec);
  return { content_category: categories[0]?.id ?? null, content_category_label: categories[0]?.label ?? null,
    content_categories: categories, content_forms: forms, duration_bucket: bucket,
    content_tags: automaticTags, manual_tags: manualTags, tags: [...new Set([...manualTags, ...automaticTags])] };
}

export function serializeLibraryContent(row: Record<string, unknown>): Record<string, unknown> & ReturnType<typeof libraryContentMetadata> {
  const { tags_json: _tags, content_classifications_json: _classes, content_taxonomy_version: _taxonomy, content_schema_version: _schema,
    content_validation_passed: _valid, content_modules_json: _modules, content_duration_bucket: _duration,
    content_report_job_status: _job, ...publicRow } = row;
  return { ...publicRow, ...libraryContentMetadata(row) };
}

export function libraryContentFilterOptions(entries: Array<ReturnType<typeof libraryContentMetadata>>) {
  return {
    topicCategories: dimensions.get("topic.category")!.tags.filter(tag => !tag.disabled).map(({ id, label }) => ({ id, label })),
    contentForms: dimensions.get("content.form")!.tags.filter(tag => !tag.disabled).map(({ id, label }) => ({ id, label })),
    durationBuckets: Object.entries(durationLabels).map(([id, label]) => ({ id, label })),
    tags: [...new Set(entries.flatMap(row => row.tags))].sort((a, b) => a.localeCompare(b, "zh-CN")),
  };
}

export function matchesLibraryContentFilters(entry: ReturnType<typeof libraryContentMetadata>, filters: LibraryContentFilters) {
  return (!filters.topicCategory || entry.content_categories.some(row => row.id === filters.topicCategory))
    && (!filters.contentForm || entry.content_forms.some(row => row.id === filters.contentForm))
    && (!filters.durationBucket || entry.duration_bucket === filters.durationBucket)
    && (!filters.tag || entry.tags.includes(filters.tag));
}

// Apply semantic filters in SQL before the listing limit, then verify the small
// decoded projection with the same taxonomy before sending it to the browser.
export function libraryContentSqlFilters(filters: LibraryContentFilters) {
  const clauses: string[] = [], bindings: unknown[] = [];
  const report = "CASE WHEN json_valid(latest_analysis.report_json) THEN latest_analysis.report_json ELSE '{}' END";
  const trusted = `json_extract(${report},'$.content_analysis.taxonomy_version')=?
    AND json_extract(${report},'$.content_analysis.schema_version')='content-analysis.v1'`;
  function classification(dimensionId: string, ids: string[]) {
    const definition = dimensions.get(dimensionId)!;
    return {
      sql: `(${trusted} AND json_extract(${report},'$.content_analysis.module_status.${definition.module}.status')='completed'
        AND json_extract(${report},'$.content_analysis.module_status.${definition.module}.validation.passed')=1
        AND EXISTS(SELECT 1 FROM json_each(CASE WHEN json_valid(latest_analysis.report_json) THEN json_extract(latest_analysis.report_json,'$.content_analysis.classifications') ELSE '[]' END) category_row
          WHERE json_extract(category_row.value,'$.dimension_id')=? AND json_extract(category_row.value,'$.state')='known'
          AND json_array_length(category_row.value,'$.evidence_ids')>0
          AND EXISTS(SELECT 1 FROM json_each(category_row.value,'$.tags') chosen WHERE chosen.value IN (${ids.map(() => '?').join(',')}))))`,
      bindings: [contentTaxonomy.version, dimensionId, ...ids],
    };
  }
  for (const [dimension, tag] of [["topic.category", filters.topicCategory], ["content.form", filters.contentForm]]) {
    if (!tag) continue;
    const condition = classification(dimension, [tag]); clauses.push(condition.sql); bindings.push(...condition.bindings);
  }
  if (filters.durationBucket) {
    const measured = `json_extract(${report},'$.content_analysis.metrics.media.duration_bucket')`;
    clauses.push(`CASE WHEN ${measured} IN ('under_15s','15_to_under_30s','30_to_under_60s','60_to_under_180s','180s_and_above') THEN ${measured}
      WHEN v.duration_sec IS NULL THEN NULL WHEN v.duration_sec<15 THEN 'under_15s' WHEN v.duration_sec<30 THEN '15_to_under_30s' WHEN v.duration_sec<60 THEN '30_to_under_60s'
      WHEN v.duration_sec<180 THEN '60_to_under_180s' ELSE '180s_and_above' END = ?`);
    bindings.push(filters.durationBucket);
  }
  if (filters.tag) {
    const alternatives = [`EXISTS(SELECT 1 FROM json_each(CASE WHEN json_valid(library.tags_json) THEN library.tags_json ELSE '[]' END) manual_tag WHERE manual_tag.value=?)`];
    const tagBindings: unknown[] = [filters.tag];
    for (const id of tagDimensions) {
      const ids = dimensions.get(id)?.tags.filter(tag => tag.label === filters.tag && tag.id !== dimensions.get(id)?.none_tag_id && !tag.disabled).map(tag => tag.id) || [];
      if (!ids.length) continue;
      const condition = classification(id, ids); alternatives.push(condition.sql); tagBindings.push(...condition.bindings);
    }
    clauses.push(`(${alternatives.join(' OR ')})`); bindings.push(...tagBindings);
  }
  return { clauses, bindings };
}

export function libraryContentSearchSql(search: string) {
  const term = search.toLocaleLowerCase();
  const labels = [...new Set(tagDimensions.flatMap(id => (dimensions.get(id)?.tags || [])
    .filter(tag => !tag.disabled && tag.id !== dimensions.get(id)?.none_tag_id && tag.label.toLocaleLowerCase().includes(term)).map(tag => tag.label)))];
  const conditions = labels.map(tag => libraryContentSqlFilters({ topicCategory: "", contentForm: "", durationBucket: "", tag }));
  return { sql: conditions.length ? conditions.map(condition => condition.clauses.join(' AND ')).join(' OR ') : '0',
    bindings: conditions.flatMap(condition => condition.bindings) };
}
