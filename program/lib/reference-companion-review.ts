import { productionPackSchema, type ProductionPack } from "./content-production.ts";
import type { ReferenceCreationReport } from "./structure-creation.ts";

type CompanionText = { fieldId: string; text: string; segmentId?: string };
type EditableText = CompanionText & { write: (text: string) => void };

// Expose editorial text only. IDs point to existing entries, never arbitrary model-supplied paths.
function editableTexts(pack: ProductionPack): EditableText[] {
  const fields: EditableText[] = [];
  function add(fieldId: string, text: string, write: (text: string) => void, segmentId?: string) {
    fields.push({ fieldId, text, write, ...(segmentId ? { segmentId } : {}) });
  }
  add("shortScript", pack.shortScript, text => { pack.shortScript = text; });
  if (pack.commentPrompt) add("commentPrompt", pack.commentPrompt, text => { pack.commentPrompt = text; });
  for (const name of ["hooks", "subtitleHighlights", "performanceNotes", "brollSuggestions", "coverCopy", "publishTitles", "hashtags"] as const) {
    pack[name].forEach((value, index) => add(`${name}.${index}`, value, text => { pack[name][index] = text; }));
  }
  pack.storyboard.forEach((shot, index) => {
    for (const key of ["shot", "visual", "script", "performance"] as const) {
      add(`storyboard.${index}.${key}`, shot[key], text => { shot[key] = text; }, shot.segmentId);
    }
  });
  pack.adaptations.forEach((entry, index) => add(`adaptations.${index}.copy`, entry.copy, text => { entry.copy = text; }));
  return fields;
}

export function buildReferenceCompanionTexts(pack: ProductionPack): CompanionText[] {
  return editableTexts(pack).map(({ fieldId, text, segmentId }) => segmentId ? { fieldId, text, segmentId } : { fieldId, text });
}

// Sync verbatim lines only. The reviewer handles paraphrases and lines shared by differently edited scenes.
function changedLines(previous: ReferenceCreationReport, reviewed: ReferenceCreationReport) {
  if (previous.segments.length !== reviewed.segments.length) throw new Error("复核改变了段落数量。");
  type DeliveryChannel = "spokenText" | "screenText" | "originalSound";
  const replacements = new Map<string, string | null>();
  const byChannel: Record<DeliveryChannel, Map<string, string | null>> = {
    spokenText: new Map(), screenText: new Map(), originalSound: new Map(),
  };
  function record(map: Map<string, string | null>, before: string, after: string) {
    if (before) map.set(before, map.has(before) && map.get(before) !== after ? null : after);
  }
  for (const [index, row] of previous.segments.entries()) {
    const revision = reviewed.segments[index];
    if (revision?.segmentId !== row.segmentId) throw new Error("复核稿与原稿的段落标识不匹配。");
    for (const key of ["spokenText", "screenText", "originalSound"] as const) {
      record(byChannel[key], row[key], revision[key]);
      if (!row.spokenText || key === "spokenText") record(replacements, row[key], revision[key]);
    }
  }
  return (text: string, wasExplicitlyEdited: boolean) => {
    // A single shot may contain separate, multiline speech and caption blocks.
    const blocks = text.split(/(?=^[ \t]*(?:【(?:口播|旁白|台词|上屏|字幕|保留原声|原声)】|(?:口播|旁白|台词|上屏|字幕|保留原声|原声)[：:]))/mu);
    return blocks.map(block => {
      const label = /^[ \t]*(?:【(口播|旁白|台词|上屏|字幕|保留原声|原声)】|(口播|旁白|台词|上屏|字幕|保留原声|原声)[：:])[ \t]*/u.exec(block);
      if (!label && wasExplicitlyEdited) return block;
      const name = label?.[1] ?? label?.[2];
      const channel: DeliveryChannel = name === "上屏" || name === "字幕" ? "screenText" : name?.includes("原声") ? "originalSound" : "spokenText";
      const matches = name ? byChannel[channel] : replacements;
      const body = block.slice(label?.[0].length ?? 0);
      const whole = body.trimEnd();
      const revised = matches.get(whole) ?? whole.split("\n").map(line => matches.get(line) ?? line).join("\n");
      return (label?.[0] ?? "") + revised + body.slice(whole.length);
    }).join("");
  };
}

export function applyReferenceCompanionEdits(pack: ProductionPack, previous: ReferenceCreationReport, reviewed: ReferenceCreationReport, edits: readonly CompanionText[]): ProductionPack {
  const revised = structuredClone(pack);
  const fields = new Map(editableTexts(revised).map(field => [field.fieldId, field]));
  const explicitlyEdited = new Map<string, string>();
  for (const edit of edits) {
    const field = fields.get(edit.fieldId);
    if (!field || explicitlyEdited.has(edit.fieldId) || typeof edit.text !== "string") {
      throw new Error(`无效或重复的配套文案位置：${edit.fieldId}`);
    }
    field.write(edit.text.trim());
    explicitlyEdited.set(edit.fieldId, edit.text.trim());
  }
  const replace = changedLines(previous, reviewed);
  for (const field of fields.values()) {
    if (field.fieldId === "shortScript" || /^storyboard\.\d+\.script$/.test(field.fieldId)) {
      field.write(replace(explicitlyEdited.get(field.fieldId) ?? field.text, explicitlyEdited.has(field.fieldId)));
    }
  }
  // Reuse the delivery contract, including optional silent-shot scripts and per-field length limits.
  const validated = productionPackSchema.safeParse(revised);
  if (!validated.success) throw new Error(`复核后的配套文案无效：${validated.error.issues[0]?.path.join(".")}`);
  return revised;
}
