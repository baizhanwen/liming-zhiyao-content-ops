import { z } from "zod";

const question = z.object({
  segmentId: z.string().trim().min(1).max(150),
  question: z.string().trim().min(1).max(300),
}).strict();
const reply = z.object({ materialQuestions: z.array(question).min(1).max(30) }).strict();
export type ReferenceMaterialQuestion = z.infer<typeof question>;
export const referenceMaterialQuestionOutput = z.toJSONSchema(reply);

export const REFERENCE_MATERIAL_QUESTION_GUIDANCE = `先判断本次确认的材料能否支撑本条表达。通常直接交付生产包。只有本条重点或段落补充明确需要讲一件真实发生的事、当事人原话、具体变化或结果，而负责这一内容的段落确实缺少必要依据，才改为只输出 {"materialQuestions":[{"segmentId":"该段实际标识","question":"一条可直接回答的具体问题"}]}。只问完成该段所缺、且允许公开的事实，避免引导用户认领某个答案。可合在一问的缺口一起问，按骨架顺序列出，每段最多一问。
已选材料或该段补充有依据时就用已有事实；缺乏可选修饰、未选品牌资料、参考片有某个场面，都不构成追问理由。明确选择假设演示或只呈现已确认画面时，按该选择写完，不再追问被放弃的事实，也不把演示写成本人经历。如果一个普通视角能用已确认画面直接表达，无须让用户补经历。切勿把重点本身当事实来源。`;

/** A normal production pack has no materialQuestions property. A clarification must stand alone. */
export function readReferenceMaterialQuestions(output: unknown, segments: ReadonlyArray<{ segmentId: string }>): ReferenceMaterialQuestion[] | null {
  if (!output || typeof output !== "object" || !("materialQuestions" in output)) return null;
  const parsed = reply.safeParse(output);
  if (!parsed.success) throw new Error("材料追问应单独返回，每项只含已确认的 segmentId 和具体问题。");
  const pending = new Map(parsed.data.materialQuestions.map(row => [row.segmentId, row]));
  const ordered = segments.flatMap(({ segmentId }) => pending.has(segmentId) ? [pending.get(segmentId)!] : []);
  if (ordered.length !== parsed.data.materialQuestions.length)
    throw new Error("材料追问只能指向本次已确认的段落，每段最多一问。");
  return ordered;
}
