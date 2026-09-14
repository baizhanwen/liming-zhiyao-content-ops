/** Display validation failures without exposing internal source identifiers. */
export function generationFeedback(message: string) {
  const reasons: string[] = [];
  if (/组件的实际应用|来源应用与实际段落不一致|缺少来源采用或未采用说明/.test(message)) reasons.push("部分参考方法没有正确关联到文案段落。");
  if (/引文无法定位|引用片段无法定位/.test(message)) reasons.push("引用说明中的文字与来源或实际文案对不上。");
  if (/口播篇幅与目标时长|镜头总时长超出/.test(message)) reasons.push("口播字数或镜头时长超出了本次要求。");
  if (!reasons.length) return null;
  const details = [...new Set(message.split("；").map(text => text
    .replace(/(?:component|claim|evidence|knowledge|case):[\w-]+/g, "对应参考资料")
    .replace(/\bstructure\b/g, "素材结构").replace(/\bsop\b/g, "拍摄方法")
    .replace(/\bhook\b/g, "开头方法").replace(/\bvisual\b/g, "展示方法")))];
  return { summary: "这次生成的稿件未通过检查，未保存为新版本。", reasons, details };
}
