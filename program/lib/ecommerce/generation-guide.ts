import type { EcommerceContext } from "./context";
import type { EcommercePack } from "./contracts";
import type { EcommercePlan } from "./generation-contract";

const fields = { component: "componentIds", claim: "claimIds", evidence: "evidenceIds", knowledge: "knowledgeIds", case: "caseIds" } as const;
export const scriptCharacterCount = (script: string) => Array.from(script.replace(/\s+/g, "")).length;
export const scriptBudget = (durationSec: number) => ({
  durationSec, minCharacters: durationSec, maxCharacters: durationSec * 7,
  suggestedMinCharacters: durationSec * 4, suggestedMaxCharacters: durationSec * 5,
  countingRule: "只计口播 script，含标点、不含空白。不能只改 durationSec 数字假装压缩了文案。",
});

/** Give the writer the same limits and reference contract the validator uses. */
export function ecommerceGenerationGuide(context: EcommerceContext, plan?: EcommercePlan, previous?: EcommercePack) {
  const budget = scriptBudget(context.input.task.brief.durationSec);
  const totalSeconds = plan?.outline.reduce((sum, s) => sum + s.durationSec, 0) || budget.durationSec;
  return {
    scriptBudget: budget,
    segmentBudgets: plan?.outline.map(s => ({ segmentId: s.id, role: s.role, durationSec: s.durationSec,
      suggestedCharacters: Math.max(1, Math.floor(budget.suggestedMaxCharacters * s.durationSec / totalSeconds)),
    })) ?? [],
    selectedMethods: plan?.choices.map(choice => ({ ...choice,
      name: context.input.candidates.find(c => c.id === choice.componentId)?.card.name,
      binding: "把本方法 ID 写进实际应用段落的 componentIds。开头与文案结构都要绑定；不能只在 applications 声称采用。同一段落可同时使用多个方法。",
    })) ?? [],
    sourceRegister: context.input.sources.map(source => ({ sourceType: source.type, sourceId: source.id, title: source.title,
      segmentField: fields[source.type],
      selectedMethod: source.type === "component" && plan ? plan.choices.some(c => c.componentId === source.id) : undefined,
    })),
    applicationRules: [
      "每个 sourceRegister 来源都输出一条应用记录。先完成段落内的来源 ID，再从这些 ID 汇总应用报告。",
      "application.segmentIds 必须恰好等于携带该 sourceId 的段落 ID 集合；有段落时 used=true，没有时 used=false。",
      "文案结构用于哪些段落，就把其 ID 写进那些段落；不要只声明采用而没有实际关联。",
      "sourceQuote 从对应 sources.text 连续复制；draftQuote 从一个关联段落的 script 连续复制一句即可。即使方法跨段使用，也禁止拼接多个句子、加省略号或改写引用。",
      "未采用来源：used=false、segmentIds=[]、sourceQuote=''、draftQuote=''，reason 说明未选原因。未选定的方法不能写成已采用。",
      "不要删除商品条件来缩短口播；只讲本次主卖点的一个具体例子，其余非必要背景省略。只输出文案；未解决事实放入 pendingConfirmations，不输出分镜、画面设计或拍摄清单。",
    ],
    ...(previous ? { observed: {
      totalCharacters: previous.segments.reduce((sum, s) => sum + scriptCharacterCount(s.script), 0),
      segments: previous.segments.map(s => ({ segmentId: s.id, characters: scriptCharacterCount(s.script) })),
      referenceBindings: previous.applications.filter(a => a.used).map(a => ({ sourceId: a.sourceId,
        reportedSegmentIds: a.segmentIds,
        actualSegmentIds: previous.segments.filter(s => s[fields[a.sourceType]].includes(a.sourceId)).map(s => s.id),
      })),
    } } : {}),
  };
}
