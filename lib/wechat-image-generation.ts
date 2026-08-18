import { z } from "zod";

export const wechatImageTemplateIds = ["executive-dark", "method-warm", "professional-blue"] as const;
export type WechatImageTemplateId = typeof wechatImageTemplateIds[number];
export const wechatImageRatioIds = ["3:4", "4:3", "16:9", "1:1"] as const;
export type WechatImageRatioId = typeof wechatImageRatioIds[number];
export const wechatImageStructures = ["list", "sequence", "pyramid", "quadrant", "hierarchy", "relation"] as const;
export type WechatImageStructure = typeof wechatImageStructures[number];

const sectionSchema = z.object({
  heading: z.string().trim().min(2).max(24),
  body: z.string().trim().min(8).max(110),
  contrast: z.string().trim().min(4).max(90),
  details: z.array(z.string().trim().min(2).max(48)).min(1).max(3),
});

export const wechatImageContentSchema = z.object({
  structure: z.enum(wechatImageStructures),
  eyebrow: z.string().trim().min(2).max(24),
  title: z.string().trim().min(4).max(42),
  subtitle: z.string().trim().min(4).max(64),
  quote: z.string().trim().min(6).max(54),
  sections: z.array(sectionSchema).min(4).max(6),
  conclusion: z.string().trim().min(8).max(90),
  cta: z.string().trim().min(4).max(48),
  footer: z.string().trim().min(2).max(32),
});

export type WechatImageContent = z.infer<typeof wechatImageContentSchema>;

export const WECHAT_IMAGE_PROMPT_VERSION = "wechat-image.v3-structured-infographic";
export const WECHAT_IMAGE_LAYOUT_PROMPT = `
为保证六类成熟信息图都能稳定排版，每个 sections 项除 heading、body 外，还必须包含：
- contrast：与 body 对照的升级做法、结果或核心目标，4 至 90 字；
- details：1 至 3 条可直接放入卡片的短要点，每条 2 至 48 字。
内容将由固定 HTML/CSS 模板渲染，禁止输出 HTML、CSS、Tailwind 类名、FontAwesome 类名和任何代码。
若主题适合对照，body 写常见做法，contrast 写升级做法；若适合流程，contrast 写该阶段产出；若适合矩阵，details 分别提供不同视角；若适合金字塔或漏斗，contrast 写该层目标。
默认优先适配“经营决策路径”编辑长图：尽量生成正好 5 个层层递进的 sections；heading 控制在 8 个汉字内，contrast 是 18 个汉字以内的判断句，body 是 36 个汉字以内的解释。结构必须表达真实逻辑，不要为了凑数制造空泛概念。`;
export const WECHAT_IMAGE_SYSTEM_PROMPT = `你是微信公众号信息长图的资深内容策划。根据选题、品牌知识和内容策略，生成一张信息密度适中、适合手机阅读的中文营销知识图文。

执行规则：
1. 只输出 JSON 对象，不输出 Markdown、HTML、代码围栏或解释；
2. 所有内容必须围绕选题，不虚构数据、案例、客户成绩、资质或效果承诺；
3. selectedBrandKnowledge 是当前客户项目已确认的品牌知识，activeStrategy 是生效中的内容策略；有内容时应自然吸收其定位、语气和观点，但不要在画面中显示“知识库”字样；
4. authorizedMethodKnowledge 是经授权检索的方法参考，只吸收写法和方法，不把其中个案当作客户事实；
5. title 要有明确利益点，subtitle 负责解释读者能得到什么；quote 是整张图最值得记住的一句话；
6. sections 必须生成 4 至 6 项，每项包含简短 heading 和一段可直接阅读的 body，层级清楚，避免重复；
7. conclusion 总结行动路径，cta 是克制、自然的下一步引导；footer 使用品牌名或与主题匹配的栏目名；
8. structure 必须从 list、sequence、pyramid、quadrant、hierarchy、relation 中选择：并列概念用 list；有先后顺序的步骤用 sequence；递进层级或漏斗用 pyramid；恰好四个维度的矩阵用 quadrant；父子分类用 hierarchy；概念相互连接用 relation；
9. structure、eyebrow、title、subtitle、quote、sections、conclusion、cta、footer 九个字段一个都不能缺少；cta 不超过 48 个字符；
10. 字数服从 JSON 字段限制，使用自然、准确、没有机器腔的中文。`;

function parseJson(value: string) {
  const trimmed = value.trim();
  const normalized = trimmed.startsWith("```") ? trimmed.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "") : trimmed;
  return JSON.parse(normalized) as unknown;
}

function record(value: unknown) {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function compact(value: unknown, maximum: number, fallback = "") {
  const source = typeof value === "string" && value.trim() ? value.trim() : fallback;
  return Array.from(source).slice(0, maximum).join("").trim();
}

function inferStructure(value: string): WechatImageStructure {
  if (/(四象限|矩阵|四个维度|SWOT)/i.test(value)) return "quadrant";
  if (/(步骤|流程|阶段|先.*再|路径|路线)/i.test(value)) return "sequence";
  if (/(金字塔|漏斗|递进|层次|等级)/i.test(value)) return "pyramid";
  if (/(体系|架构|分类|组织|上下级|父子)/i.test(value)) return "hierarchy";
  if (/(关系|关联|协同|连接|网络)/i.test(value)) return "relation";
  return "list";
}

export function parseWechatImageContent(value: string, defaults: { topic?: string; brandName?: string } = {}) {
  const parsed = record(parseJson(value));
  const source = record(parsed.generated ?? parsed.content ?? parsed);
  const title = compact(source.title, 42, defaults.topic ?? "");
  const rawSections = Array.isArray(source.sections) ? source.sections : [];
  const structure = wechatImageStructures.includes(source.structure as WechatImageStructure) ? source.structure as WechatImageStructure : inferStructure(`${title} ${compact(source.subtitle, 64)}`);
  const normalized = {
    structure,
    eyebrow: compact(source.eyebrow, 24, "主题知识图解"),
    title,
    subtitle: compact(source.subtitle, 64, title ? `围绕“${title}”拆解值得掌握的关键要点` : ""),
    quote: compact(source.quote, 54, "先理解关键概念，再选择适合自己的行动路径。"),
    sections: rawSections.slice(0, 6).map((section, index) => {
      const item = record(section);
      const body = compact(item.body, 110);
      const rawDetails = Array.isArray(item.details) ? item.details : [];
      const details = rawDetails.map((detail) => compact(detail, 48)).filter(Boolean).slice(0, 3);
      return {
        heading: compact(item.heading, 24, `要点 ${index + 1}`),
        body,
        contrast: compact(item.contrast, 90, body),
        details: details.length ? details : [compact(body, 48)],
      };
    }),
    conclusion: compact(source.conclusion, 90, "从一个真实问题开始，小步验证，再把有效方法沉淀为稳定流程。"),
    cta: compact(source.cta, 48, "收藏这张图，从一个具体行动开始"),
    footer: compact(source.footer, 32, defaults.brandName ?? "品牌知识图解"),
  };
  return wechatImageContentSchema.parse(normalized);
}
