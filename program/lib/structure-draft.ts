import { readCoreContentStrategy } from "./content-strategy-policy.ts";
import type { ProjectAssistantDatabase } from "./project-memory-events.ts";
import type { ReferenceCreationInput } from "./structure-creation.ts";
import { readBenchmarkRewriteSource } from "./single-benchmark-rewrite.ts";
import { readUnifiedReport } from "./unified-report.ts";
import { getTagLabel, readContentAnalysis } from "./video-content-analysis.ts";

export class StructureDraftError extends Error {
  code: string;
  status: number;
  constructor(code: string, message: string, status: number) {
    super(message);
    this.code = code;
    this.status = status;
  }
}
type Presentation = ReferenceCreationInput["segments"][number]["presentation"];
type Unit = { text: string; evidenceId?: string; startMs?: number; endMs?: number };
type Beat = { role: string; sourceRole: string; presentation: Presentation };
type Material = { id: string; title: string; body: string; category: string; version: number };
type Scope = { organizationId: string; projectId: string; videoId: string; analysisId?: string; libraryEntryId?: string };

function object(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
function records(value: unknown) {
  return Array.isArray(value) ? value.map(object) : [];
}
const string = (value: unknown) => typeof value === "string" ? value.trim() : "";
const compact = (value: string) => value.replace(/\s+/gu, "");
const tablePromise = /(?:最后|后面|结尾|一会儿?|稍后|待会儿?).{0,14}(?:张表|表格|对照表|速查表|分工表|清单.{0,4}截图)|(?:这张|这份|这幅)(?:表格?|对照表|速查表).{0,12}截图/u;

function plainUnits(script: string): Unit[] {
  // Prefer authored paragraphs. Old ASR exports can consist of a single line.
  const paragraphs = script.split(/\n+/u).map(text => text.trim()).filter(Boolean);
  const lines = paragraphs.length > 1 ? paragraphs : (script.match(/[^。！？!?]+[。！？!?]*|[。！？!?]+/gu) ?? paragraphs);
  return lines.map(text => ({ text }));
}

const roleDescriptions: Record<string, string> = {
  background: "交代背景", pain: "点出困扰", question: "提出问题", reason: "解释原因", opinion: "提出判断",
  method: "说明方法", step: "分步讲解", example: "举例说明", evidence: "给出依据", conflict: "呈现冲突",
  turn: "转入新的判断", result: "呈现结果", summary: "归纳要点", cta: "给出下一步行动建议",
};

function transferableRole(segment: Record<string, unknown>, hookTypes: string[], evidenceText: string) {
  const tags = Array.isArray(segment.tags) ? segment.tags.filter((t): t is string => typeof t === "string" && t.startsWith("structure.role.")).map(t => t.slice("structure.role.".length)) : [];
  if (tags.includes("hook")) {
    const methods = hookTypes.filter(tag => tag !== "hook.type.none").map(tag => getTagLabel("hook.type", tag)).filter(label => !label.startsWith("hook.type."));
    const opening = methods.length ? `用${methods.join("和")}开场` : "引出核心问题";
    return /[？?]/u.test(evidenceText) && !methods.includes("提问") ? opening + "，留下待回答的问题" : opening;
  }
  if (tags.includes("method") && tags.includes("step") && (tags.includes("cta") || tags.includes("summary"))) {
    return tags.includes("summary") ? "归纳方法，给出可执行的分步建议" : "说明方法，引导观众按步骤行动";
  }
  return tags.map(tag => roleDescriptions[tag]).filter(Boolean).join("，");
}

function buildBeats(units: Unit[], analysis: Record<string, unknown>) {
  const anchors = new Map<number, Beat>();
  const set = (index: number, role: string, presentation: Presentation = "spoken", sourceRole = role) => {
    if (index >= 0 && index < units.length) anchors.set(index, { role, sourceRole, presentation });
  };
  const template = string(records(analysis.segments).find(segment => segment.kind === "content_template")?.text);
  const body = /(?:逐项|逐个|逐一|依次).{0,18}(?:说明|介绍|评测|对比|比较)|(?:横向|逐个)评测/u.test(template)
    ? "按对象逐项比较，用本次材料说明适用场景、依据与限制" : "展开正文，用本次选定的材料讲清这一部分";
  set(0, "引出本条内容");
  const positions = new Map(units.map((unit, index) => [unit.evidenceId, index]));
  const hookClassification = records(analysis.classifications).find(row => row.dimension_id === "hook.type" && row.state === "known");
  const hookTypes = Array.isArray(hookClassification?.tags) ? hookClassification.tags.filter((t): t is string => typeof t === "string") : [];
  const timed = records(analysis.segments).filter(segment => segment.kind === "structure" && string(segment.text));
  for (const segment of timed) {
    const evidence = Array.isArray(segment.evidence_ids) ? segment.evidence_ids.map(id => positions.get(string(id))).filter((i): i is number => i !== undefined) : [];
    const first = typeof segment.start_ms === "number" ? units.findIndex(unit => unit.startMs !== undefined && unit.startMs >= Number(segment.start_ms)) : -1;
    const start = first >= 0 ? first : evidence[0];
    if (start === undefined) continue;
    const sourceRole = string(segment.text).slice(0, 200);
    const role = transferableRole(segment, hookTypes, evidence.map(i => units[i].text).join(""));
    set(start, role || sourceRole, "spoken", sourceRole);
    if (typeof segment.end_ms === "number") {
      const end = units.findIndex((unit, i) => i > start && unit.startMs !== undefined && unit.startMs >= Number(segment.end_ms));
      if (!anchors.has(end) && end > 0 && /[。？！!?…]$/u.test(units[end - 1].text)) set(end, body);
    }
  }
  const promise = units.findIndex(unit => tablePromise.test(unit.text));
  let promiseStart = -1;
  if (promise >= 0) {
    // A preview of the choices often starts immediately before the spoken promise.
    const lastAnchor = [...anchors.keys()].filter(i => i <= promise).sort((a, b) => b - a)[0];
    promiseStart = lastAnchor !== undefined && anchors.get(lastAnchor)?.role === body && promise - lastAnchor <= 3 ? lastAnchor : promise;
    set(promiseStart, "交代内容安排，预告稍后可截图的表格");
    const screenshot = units.slice(promise, promise + 4).findIndex(unit => /截图/u.test(unit.text));
    const after = promise + Math.max(0, screenshot) + 1;
    if (!anchors.has(after)) set(after, body);
  }
  // Concept and summary sections are supported by original evidence IDs; don't use a
  // free-floating suggestion in a report as proof that a screen/claim occurred.
  const concept = records(analysis.information_units).find(unit => unit.type_tag === "value.information_type.concept" && Array.isArray(unit.evidence_ids));
  const conceptIndex = concept && Array.isArray(concept.evidence_ids) ? positions.get(string(concept.evidence_ids[0])) : undefined;
  if (conceptIndex !== undefined && conceptIndex > 0 && !anchors.has(conceptIndex)) set(conceptIndex, "解释理解前文所需的概念或区别");
  for (let i = 1; i < units.length; i++) {
    const text = units[i].text;
    if (i > units.length / 2 && /^(?:下一条|下条视频|下一期|下期|下集).{0,8}(?:讲|说|看|再|聊|见)/u.test(text)) set(i, "留下可继续探索的问题，有已确认的安排时再预告后续内容", "spoken", "原片下一条内容预告");
    else if (i > units.length / 2 && /^(?:开头说|前面提到).{0,36}(?:那个|就是|答案)/u.test(text)) set(i, "揭晓开头留下的问题");
    else if (i > units.length / 2 && /^(?:最后|总结一下|回到开头|所以还是开头).{0,12}(?:建议|提醒|那句|问题|总结|说一下)/u.test(text) && !anchors.has(i)) set(i, "收束前文，给出判断或行动建议");
  }
  if (anchors.size < 3 && units.length >= 3) {
    if (!anchors.has(1)) set(1, body);
    if (!anchors.has(units.length - 1)) set(units.length - 1, "用原片最后一段收尾");
  } else if (anchors.size === 1 && units.length === 2) {
    set(1, "承接上一段并收尾");
  }
  // Confirmation edits consume at most 24 contiguous runs. Every character remains
  // in a run, including long bodies without any timed classifications.
  const starts = [...anchors.keys()].sort((a, b) => a - b);
  const selected = starts.length <= 24 ? starts : [...starts.slice(0, 21), ...starts.slice(-3)];
  const beats = selected.map((start, i) => {
    const slice = units.slice(start, selected[i + 1]);
    const beat = anchors.get(start)!;
    return { segmentId: `part-${i + 1}`, role: beat.role, presentation: beat.presentation, excerpt: slice.map(unit => unit.text).join(""),
      startMs: slice[0].startMs ?? null, endMs: slice[slice.length - 1].endMs ?? null };
  });
  // Only a frame-level observation can establish that a table was shown.
  const visualStatus = object(object(analysis.module_status).visual);
  let tableFrame: { time: number; end: number; excerpt: string } | undefined;
  if (visualStatus.status === "completed" && object(visualStatus.validation).passed === true) {
    for (const row of records(analysis.evidence_registry)) {
      if (row.source !== "vision" || typeof row.start_ms !== "number" || row.start_ms < (units[promise]?.endMs ?? 0)) continue;
      const excerpt = string(row.text).split(/[；;。]/u).find(part => !/建议|可考虑|应该|未出现|未观察到/u.test(part)
        && /(?:画面|屏幕)(?:中|上|中央|右侧|左侧)?(?:出现|显示|呈现|展示).{0,10}(?:表格|对照表|分工表|速查表)|(?:对比表|分工表|速查表|表格)(?:占据|铺满|居中显示)/u.test(part));
      if (excerpt) {
        tableFrame = { time: row.start_ms, end: typeof row.end_ms === "number" ? row.end_ms : row.start_ms, excerpt };
        break;
      }
    }
  }
  if (tableFrame || promiseStart >= 0) {
    const time = tableFrame?.time ?? null;
    const closing = time === null || beats.every(beat => beat.startMs === null)
      ? selected.findIndex(start => start > promiseStart && /收束|建议|结尾|下一条/u.test(anchors.get(start)!.sourceRole))
      : beats.findIndex(beat => beat.startMs !== null && beat.startMs >= time);
    beats.splice(closing < 0 ? beats.length : closing, 0, {
      segmentId: "promised-table", role: tableFrame ? "用上屏表格集中呈现信息（原片画面取样）" : "兑现前文的口播承诺，制作可截图的表格（新稿拟用画面）",
      presentation: "screen_table", excerpt: tableFrame?.excerpt.slice(0, 600) ?? units[promise].text,
      startMs: time, endMs: tableFrame?.end ?? null,
    });
  }
  return beats;
}

function visualBeats(report: Record<string, unknown>) {
  const content = readContentAnalysis(report);
  if (!content?.module_status.visual.validation.passed || content.module_status.visual.status !== "completed") return [];
  const { media, shot_detection: shots } = content.metrics;
  const duration = media.duration_ms;
  if (duration === null || duration <= 0) return [];
  const observations = content.evidence_registry.filter(row =>
    row.source === "vision" && row.start_ms !== null && row.start_ms >= 0 && row.start_ms <= duration && row.text.trim()
  ).sort((a, b) => a.start_ms! - b.start_ms!);
  const groups = new Map<number, { role: string; excerpt: string; startMs: number; endMs: number }>();
  for (const row of observations) {
    const time = row.start_ms!;
    const observed = row.text.split(/[；;\n]/u).map(text => text.trim()).filter(text => text && !/建议|推荐|可以考虑|或许可以/u.test(text));
    const action = observed.find(text => /^(?:人物动作|主体动作|场景|画面内容|可见内容)[：:]/u.test(text));
    const purpose = observed.find(text => /^视觉作用[：:]/u.test(text))?.replace(/^视觉作用[：:]/u, "").trim();
    // Raw observations vary with analyzer versions. Ignore purely technical coverage
    // metadata, verdicts about an unobserved shot, and free-standing recommendations.
    const description = action || observed.find(text => !/^(?:证据范围|时序组|运动|限制|不确定|无法判断|未取得|未观察到)/u.test(text));
    if (!description) continue;
    const shot = shots.status === "measured" ? shots.segments.find(s => s.start_ms <= time && time < s.end_ms) : undefined;
    const bin = shot?.start_ms ?? Math.floor(time / Math.max(1, duration / 10));
    if (groups.size === 1 && groups.has(bin)) continue;
    groups.set(bin, { role: (purpose || "呈现原片这一处可见的动作或场景").slice(0, 150), excerpt: description.slice(0, 600), startMs: time, endMs: row.end_ms ?? time });
  }
  const rows = [...groups.values()];
  // A cluster of opening frames is insufficient evidence for the shape of a whole vlog.
  if (rows.length < 2 || rows[0].startMs > duration * 0.25 ||
      rows.at(-1)!.endMs < duration * 0.75 || new Set(rows.map(row => row.excerpt)).size < 2) return [];
  const selected = rows.length <= 12 ? rows : Array.from({ length: 12 }, (_, i) => rows[Math.round(i * (rows.length - 1) / 11)]);
  return selected.map((row, index) => ({ ...row, segmentId: `visual-${index + 1}`, role: `画面取样 · ${row.role}`, presentation: "screen" as Presentation }));
}

export function structureFromAnalysis(reportJson: string, videoTitle: string | null, legacyTranscript?: string | null) {
  let report: Record<string, unknown> = {};
  try { report = object(JSON.parse(reportJson)); } catch { /* A valid version-bound transcript can still be used on older videos. */ }
  const unified = readUnifiedReport(report);
  const v1 = unified?.version === "unified-report.v1" && unified.canonical.status === "completed" && unified.canonical.validation.passed ? unified.canonical : null;
  const source = readBenchmarkRewriteSource(reportJson, v1?.segments.map(s => s.text).join("\n") || legacyTranscript);
  const analysis = object(report.content_analysis);
  const segments = records(analysis.segments);
  const problem = string(segments.find(s => s.kind === "topic_problem")?.text).split(/，(?:内容主张|作者认为|本片认为|视频主张)/u)[0];
  const referenceTopic = (problem || string(segments.find(s => s.kind === "topic_subject")?.text) || string(videoTitle) || string(unified?.summary)).slice(0, 200);
  if (!source) {
    const canonical = object(object(report.unified_report).canonical);
    const needsReview = canonical.status === "needs_review" || object(object(report.unified_report).outcome).manuscript === "needs_review";
    // Do not silently bypass the manuscript review gate on a speech-led video.
    const hadSpeech = records(analysis.evidence_registry).some(row => row.source === "transcript" && string(row.text))
      || records(canonical.segments).some(row => string(row.text));
    if (!needsReview && !hadSpeech && (!report.unified_report || unified)) {
      const visual = visualBeats(report);
      if (visual.length) return { referenceTopic, segments: visual };
    }
    throw new StructureDraftError("REFERENCE_MANUSCRIPT_REQUIRED", needsReview
      ? "这版口播有待核对的段落。请先核对原稿或选择已核对的分析版本。"
      : "这版分析缺少可核对的完整口播，也没有足以覆盖前后的带时码画面观察。请先补全分析或更换参考片。", 422);
  }
  const timed = unified?.canonical.segments.map(segment => ({ text: segment.text, startMs: segment.start_ms, endMs: segment.end_ms, evidenceId: segment.source_segment_id })) ?? [];
  const units = timed.length && compact(timed.map(s => s.text).join("")) === compact(source.sourceScript) ? timed : plainUnits(source.sourceScript);
  if (units.length < 2) throw new StructureDraftError("REFERENCE_SEGMENTS_REQUIRED", "这版原稿不足以区分前后两个功能段，请选择有完整段落的分析版本。", 422);
  return { referenceTopic, segments: buildBeats(units, analysis) };
}

// The outer query binds organization and video. A library entry alone never
// grants the destination project permission to reuse another project's video.
export const structureVideoScopeSql = `(v.project_id=? OR EXISTS (
  SELECT 1 FROM project_video_references r JOIN video_library_entries l ON l.id=r.library_entry_id AND l.organization_id=r.organization_id
  WHERE r.organization_id=v.organization_id AND r.project_id=? AND l.source_video_id=v.id AND r.status='active' AND r.purpose='benchmark'))`;

export async function readReferenceStructure(db: ProjectAssistantDatabase, scope: Scope) {
  const { organizationId, projectId, videoId } = scope;
  const row = await db.prepare(`SELECT v.title, a.id AS analysisId, a.report_json AS reportJson, l.id AS referenceEntryId,
    (SELECT t.full_text FROM video_transcripts t WHERE t.organization_id=v.organization_id AND t.project_id=v.project_id AND t.video_id=v.id
      AND t.updated_at<=a.created_at ORDER BY t.version DESC LIMIT 1) AS legacyTranscript
    FROM videos v JOIN video_analyses a ON a.video_id=v.id AND a.organization_id=v.organization_id AND a.project_id=v.project_id
    LEFT JOIN video_library_entries l ON l.organization_id=v.organization_id AND l.source_video_id=v.id
    WHERE v.organization_id=? AND v.id=? AND v.deleted_at IS NULL AND ${structureVideoScopeSql}
    AND (?='' OR a.id=?) AND (?='' OR l.id=?) ORDER BY a.created_at DESC, a.rowid DESC LIMIT 1`)
    .bind(organizationId, videoId, projectId, projectId, scope.analysisId || "", scope.analysisId || "", scope.libraryEntryId || "", scope.libraryEntryId || "")
    .first<{ title: string | null; analysisId: string; reportJson: string; legacyTranscript: string | null; referenceEntryId: string | null }>();
  if (!row) throw new StructureDraftError("REFERENCE_ANALYSIS_NOT_FOUND", "当前空间无法使用这版分析。共享视频请先从公司素材库添加为本空间的对标参考。", 404);
  const skeleton = structureFromAnalysis(row.reportJson, row.title, row.legacyTranscript);
  return { videoId, analysisId: row.analysisId, referenceTitle: row.title || "未命名参考视频", referenceEntryId: row.referenceEntryId, ...skeleton };
}

export async function readStructureDraftPreview(db: ProjectAssistantDatabase, scope: Scope) {
  const { organizationId, projectId } = scope;
  const skeleton = await readReferenceStructure(db, scope);
  const [knowledge, strategy] = await Promise.all([
    db.prepare(`SELECT k.id,k.title,k.category,k.current_version AS version,b.body FROM knowledge_items k JOIN knowledge_item_versions b
      ON b.item_id=k.id AND b.version=k.current_version AND b.organization_id=k.organization_id AND b.project_id=k.project_id
      WHERE k.organization_id=? AND k.project_id=? AND k.status='confirmed' AND k.deleted_at IS NULL ORDER BY k.title,k.id`)
      .bind(organizationId, projectId).all<Material>(),
    readCoreContentStrategy(db, scope),
  ]);
  return { ...skeleton, materials: knowledge.results, strategy };
}

export type StructureDraftPreview = Awaited<ReturnType<typeof readStructureDraftPreview>>;

export function confirmStructureDraft(preview: StructureDraftPreview, input: ReferenceCreationInput) {
  if (input.videoId !== preview.videoId || input.analysisId !== preview.analysisId ||
      input.segments.length !== preview.segments.length || input.segments.some((s, i) => s.segmentId !== preview.segments[i].segmentId)) {
    throw new StructureDraftError("REFERENCE_STRUCTURE_CHANGED", "原片版本或段落已变化，请重新打开预览并确认。", 409);
  }
  const topic = (input.topicMode === "reference" ? preview.referenceTopic : input.customTopic || "").trim();
  if (!topic) throw new StructureDraftError("REFERENCE_TOPIC_REQUIRED", input.topicMode === "reference" ? "这版分析未提取到选题，请选择使用我的选题。" : "请填写本次创作的选题。", 400);
  const ids = new Set(input.segments.flatMap(s => s.materialIds));
  const materials = preview.materials.filter(m => ids.has(m.id));
  if (ids.size !== materials.length) throw new StructureDraftError("INVALID_REFERENCE_MATERIAL", "所选材料已变更，或不属于当前空间已确认的品牌知识。请重新选择。", 409);
  return { videoId: preview.videoId, analysisId: preview.analysisId, referenceTitle: preview.referenceTitle, referenceTopic: preview.referenceTopic,
    topic, topicMode: input.topicMode, focus: input.focus, materials, strategy: preview.strategy,
    segments: preview.segments.map((source, i) => ({ ...source, presentation: input.segments[i].presentation,
      note: input.segments[i].note, materialIds: [...new Set(input.segments[i].materialIds)] })) };
}
