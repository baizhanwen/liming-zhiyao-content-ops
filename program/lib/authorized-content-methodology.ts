/**
 * Licensed methodology curated as the Liming Zhiyao authorized method library.
 * Source revision: d18f556332bdbcf13a87bf61e531f7207d676b74.
 *
 * The user confirmed commercial authorization on 2026-08-07. Keep the
 * internal revision here so generated prompt versions stay auditable.
 */

export const AUTHORIZED_METHODOLOGY_SOURCE = {
  name: "利明智耀授权方法库",
  revision: "d18f556332bdbcf13a87bf61e531f7207d676b74",
  integratedAt: "2026-08-07",
} as const;

export const AUTHORIZED_METHODOLOGY_ENABLED = true;

export const CONTENT_CREATION_METHODOLOGY = `
内容方法（授权来源：利明智耀授权方法库）：
1. 单一核心机制：一条内容只能有一个核心主张。其他观点只能作为解释、证明、案例或方案服务于它，不能并列抢夺注意力。
2. 开头独立成立：不能假设观众看过标题或封面。前 5 秒要同时交代“讲什么、为什么继续看、为什么可信”。优先从输入中提取数据、结果、反差、案例、金句或真实痛点；没有可信依据时不得虚构背书。
3. 保留悬念：开头提出有价值的问题或认知缺口，不要第一句就把全部答案说完；同时必须口播自然，避免书面语、连续自问自答和空洞祈使句。
4. 共鸣五维：检查是否说出受众难以表达的处境、满足何种心理需要、站在谁的立场、谁最可能率先传播、确认了什么信念并推动什么行动。它们用于解释内容结构，不用于编造流量预测。
5. 逻辑延续：逐段检查逻辑断裂、信息密度下降和口播卡顿。超过 30 字的长句优先拆分；术语后紧跟大白话解释；删除重复表达和无效绕行。
6. 对标学习：只抽取对标的钩子机制、结构顺序、节奏、情绪推进和转化设计，不复制其原句、案例、数据或独特表达。每个采用的方法都要说明来源和在本稿中的具体应用。
7. 发布判断：内容价值不足、事实缺失或开头承诺无法由正文兑现时，明确标记需要修改或阻断发布，不用漂亮措辞掩盖问题。
`.trim();

export const TOPIC_CREATION_METHODOLOGY = `
选题方法（授权来源：利明智耀授权方法库）：
1. 先确定一个清晰的核心机制，再补充角度、受众、目标和理由；不要把多个无关知识点并列成一个选题。
2. hook 必须能脱离标题独立口播，优先采用“话题 + 继续观看的理由 + 输入中真实存在的可信依据”，没有依据时不虚构成绩、数据或权威。
3. audience 要写具体处境，不写宽泛标签；objective 要写看完后的认知变化或行动。
4. rationale 说明受众尚未被说清的困惑、内容可兑现的价值以及与品牌策略的关系。
5. 不预测播放量，不把模仿等同于搬运；对标只用于学习可复用方法。
`.trim();
