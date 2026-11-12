import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

// Compile the supplied method documents into a portable, reviewable runtime
// catalog. Product facts and illustrative case sentences are never compiled.
const repository = fileURLToPath(new URL("../..", import.meta.url));
const prefix = "内容生产方法论/02_短视频/";
const sha = value => createHash("sha256").update(value).digest("hex");
const documents = new Map();
function document(name) {
  if (!documents.has(name)) {
    const path = prefix + name, raw = readFileSync(repository + "/" + path, "utf8");
    documents.set(name, { path, raw, text: raw.replaceAll("\r\n", "\n").replaceAll("\r", "\n"), sha256: sha(raw) });
  }
  return documents.get(name);
}
function excerpt(name, start, end) {
  const d = document(name), from = d.text.indexOf(start);
  if (from < 0) throw new Error(`Missing source section: ${name} ${start}`);
  const to = end ? d.text.indexOf(end, from + start.length) : d.text.length;
  if (end && to < 0) throw new Error(`Missing section end: ${name} ${end}`);
  const value = d.text.slice(from, to).trim();
  return { document: d.path, section: start.replace(/^#+\s*/, ""), sha256: d.sha256,
    line: d.text.slice(0, from).split("\n").length, excerpt: value };
}

const hookMetadata = [
  ["audience", [], ["点出任务中的具体人群或处境", "立刻给出该人群的一个问题", "正文兑现问题"]],
  ["pain", [], ["直接指出一个具体麻烦", "提出选择或解决判断", "用本商品细节解释"]],
  ["identity", ["identity"], ["使用有来源的真实身份", "说明这一身份的选购标准", "回到本商品事实"]],
  ["dialogue", [], ["用假设式问答建立冲突", "给出清楚的观点", "用事实回答，不冒充真实对话"]],
  ["question", [], ["提出用户真正需要回答的问题", "给出有辨识度的回答方向", "正文给具体答案"]],
  ["unboxing", ["demonstration"], ["介绍已记录的开箱细节", "指出一个可观察的产品特点", "说明选择意义"]],
  ["origin", ["origin"], ["使用已确认产地或生产过程", "给出可核对细节", "回到一个品质判断"]],
  ["experiment", ["demonstration"], ["说明已有演示的条件", "陈述被记录的过程和结果", "保留适用限制"]],
  ["emotion", [], ["用任务场景建立共鸣", "点出一个具体困扰", "把情绪接到有依据的商品价值"]],
  ["result", ["demonstration"], ["前置已有证据支持的结果", "交代条件或过程", "解释结果与本次卖点的关系"]],
  ["comparison", ["comparison"], ["明确可核对的比较维度", "展示双方已确认的差异", "解释本商品适用情况"]],
  ["curiosity", [], ["用已知信息制造认知差", "尽快给出明确观点", "不拖延兑现到结尾"]],
  ["reverse", [], ["给出可理解的反向观点", "用具体事实解释取舍", "避免反话变成未证实承诺"]],
  ["season", ["season"], ["使用任务明确的节日或季节场景", "连接一个真实需求", "不自动制造限时优惠"]],
  ["offer", ["offer"], ["陈述有效且有依据的权益", "交代条件与限制", "给一个指定行动"]],
  ["insider", ["comparison"], ["提出有来源的选购误区", "解释差别或判断标准", "不给同行造假或成本下断言"]],
  ["feedback", ["feedback"], ["引用已授权的真实问题", "直接回答问题", "不用编造评论制造热闹"]],
  ["metaphor", [], ["用比喻解释已有产品机制", "将比喻落回真实细节", "不暗示没有依据的效果"]],
];
const hookRows = document("18种钩子类型.md").text.split("\n").filter(line => /^\|\s*\d+\s*\|/.test(line));
const playbook = document("钩子类型手册.md").text.split("\n");
const hooks = hookRows.map((row, index) => {
  const columns = row.split("|").slice(1, -1).map(value => value.trim());
  const [key, requires, beats] = hookMetadata[index];
  const riskRow = playbook.find(line => line.includes(`| ${columns[1]} |`));
  const risk = riskRow?.split("|").slice(1, -1).at(-1)?.trim() ?? "表达须能被本商品事实兑现";
  return { id: `hook.${key}`, name: columns[1], definition: columns[2], suitable: columns[3], risk, requires, beats,
    source: excerpt("18种钩子类型.md", row, "\n") };
});
if (hooks.length !== 18) throw new Error("Expected the documented 18 hook types");

const families = [
  ["pain", "显性痛点攻坚", [], ["具体问题与明确观点", "问题发生的场景", "商品如何解决：机制与细节", "适用限制与一个行动"]],
  ["upgrade", "隐性痛点挖掘", [], ["具体使用场景", "一个被忽略的选择问题", "产品的细节与升级理由", "真实取舍与行动"]],
  ["trust", "身份背书信任", ["identity"], ["真实身份与选购标准", "可核对的信任依据", "一个主卖点的具体讲解", "适用条件与行动"]],
  ["proof", "真实实测验证", ["demonstration"], ["已记录的测试问题与条件", "关键过程", "证据支持的结果与限制", "产品价值与行动"]],
  ["origin", "产地溯源保真", ["origin"], ["真实产地或生产过程", "可核对的源头细节", "一个品质标准", "产品选择理由与行动"]],
  ["emotion", "情绪共鸣引导", [], ["任务中的具体处境", "相关困扰与共鸣", "商品细节如何回应", "取舍与一个行动"]],
  ["season", "节日借势营销", ["season"], ["任务明确的节日场景", "该场景的真实需求", "产品细节与匹配理由", "有依据的条件与行动"]],
  ["offer", "福利转化冲刺", ["offer"], ["有效权益与适用对象", "有依据的价格或权益解释", "限制与期限（有依据才写）", "指定承接动作"]],
  ["curiosity", "悬念好奇反转", [], ["与商品相关的认知差", "一个具体选择情境", "用商品事实揭示答案", "产品价值与行动"]],
  ["selection", "揭秘对比吐槽", [], ["对选购问题给出鲜明观点", "具体判断维度与场景", "本商品的细节、机制与依据", "真实取舍与行动"]],
];
const frameworks = families.map(([key, name, requires, beats], index) => ({ id: `framework.${key}`, name,
  familyRange: `F${String(index * 10 + 1).padStart(3, "0")}-F${String(index * 10 + 10).padStart(3, "0")}`,
  requires, beats, source: excerpt("100种素材框架.md", `### ${index + 1}. `, "**案例**："),
  adaptation: "原文中的效果承诺、问题放大、库存紧迫、竞品结论均须受商品事实约束；缺依据时改为适用条件、选择理由和真实取舍。只借段落推进，绝不把方法示例写成商品事实。" }));

const categoryNames = ["男女装服饰", "内衣内裤", "鞋靴", "箱包", "食品", "生鲜", "运动户外", "美妆护肤"];
const categoryTerms = [["服装", "服饰", "男装", "女装", "裤", "衣"], ["内衣", "内裤"], ["鞋", "靴"], ["箱包", "背包", "行李", "包袋"], ["食品", "零食", "饼干", "蛋糕"], ["生鲜", "水果", "蔬菜", "海鲜"], ["运动", "户外", "露营"], ["美妆", "护肤", "彩妆"]];
const categories = categoryNames.map((name, index) => ({ id: `category.${index + 1}`, name, terms: categoryTerms[index],
  source: excerpt("25类目卖点可视化.md", `## ${index + 1}. `, "\n---"),
  application: "只把与所选事实对应的一个细节转成可理解的口播描述，不生成镜头，不复制示例次数、实验结果、认证或效果。" }));
categories.push({ id: "category.other-documented", name: "其余17类通用细节表达", terms: ["茶叶", "酒类", "文玩", "配饰", "母婴", "玩具", "乐器", "厨具", "厨电", "数码", "家电", "个护", "家清", "家居", "家纺", "家具", "图书", "教辅", "宠物", "滋补", "保健", "汽车", "五金", "园艺"],
  source: excerpt("25类目卖点可视化.md", "## 9-25. "),
  application: "此段只有通用建议，不能声称是该品类专属方案；只从已有产品事实选择一个材质、操作、做工、适用场景或证据细节，用口播解释，不复制任何测试结论。" });
const materialRules = [
  excerpt("七大素材库.md", "### 痛点描述模板", "### 痛点库示例"),
  excerpt("七大素材库.md", "### 卖点描述模板", "### 卖点库示例"),
  excerpt("七大素材库.md", "### 场景描述模板", "### 场景库示例"),
  excerpt("100种素材框架.md", "## 三、素材结尾点到即可"),
  excerpt("抖音千川钩子脚本Skill.md", "## 6. 核心执行原则", "## 7. 执行流程"),
  excerpt("短视频爆款仿写Skill.md", "### 5.4 缺失时的处理规则", "### 5.5 何时必须补读资料库"),
];
const output = { version: "ecommerce-methodology.v2", sourceDigest: sha(JSON.stringify([...documents.values()].map(d => [d.path, d.sha256]))),
  coverage: { hooks: 18, frameworkFamilies: 10, individualFrameworks: 0, detailedCategories: 8,
    note: "原始文件名含100种框架和25类目，但当前资料只提供10族结构、前8类详细方法，其余17类为通用建议；不声称已提供100张独立框架。" },
  hooks, frameworks, categories, materialRules,
  documents: [...documents.values()].map(({ path, sha256 }) => ({ path, sha256 })),
};
const serialized = JSON.stringify(output, null, 2) + "\n";
const destination = new URL("../resources/ecommerce-methodology.v2.json", import.meta.url);
if (process.argv.includes("--check")) {
  if (readFileSync(destination, "utf8") !== serialized) throw new Error("Method catalog differs from source documents; run this compiler.");
} else writeFileSync(destination, serialized);
console.log(JSON.stringify({ version: output.version, digest: output.sourceDigest, hooks: hooks.length, frameworks: frameworks.length, categories: categories.length }));
