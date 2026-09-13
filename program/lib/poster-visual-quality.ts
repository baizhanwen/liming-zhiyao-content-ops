export type PosterQualityIssue = {
  code: "TEXT_OVERFLOW" | "OUT_OF_BOUNDS" | "TITLE_TOO_SMALL" | "CONTENT_TOO_SPARSE";
  message: string;
};

export type PosterQualityReport = {
  passed: boolean;
  issues: PosterQualityIssue[];
};

function visible(element: HTMLElement) {
  const style = window.getComputedStyle(element);
  return style.display !== "none" && style.visibility !== "hidden" && Number(style.opacity || 1) > 0;
}

export function auditPosterElement(root: HTMLElement): PosterQualityReport {
  const issues: PosterQualityIssue[] = [];
  const editable = Array.from(root.querySelectorAll<HTMLElement>('[contenteditable="true"]')).filter(visible);
  if (editable.some((element) => element.scrollWidth > element.clientWidth + 2 || element.scrollHeight > element.clientHeight + 2)) {
    issues.push({ code: "TEXT_OVERFLOW", message: "部分文字超出安全排版区域" });
  }

  const rootBox = root.getBoundingClientRect();
  const critical = Array.from(root.querySelectorAll<HTMLElement>(".wechat-poster-hero, .wechat-poster-items, .wechat-poster-quote")).filter(visible);
  if (critical.some((element) => {
    const box = element.getBoundingClientRect();
    return box.left < rootBox.left - 1 || box.right > rootBox.right + 1 || box.top < rootBox.top - 1 || box.bottom > rootBox.bottom + 1;
  })) issues.push({ code: "OUT_OF_BOUNDS", message: "主要内容超出画布边界" });

  const title = root.querySelector<HTMLElement>(".wechat-poster-hero h1");
  if (title && Number.parseFloat(window.getComputedStyle(title).fontSize) < 32) {
    issues.push({ code: "TITLE_TOO_SMALL", message: "标题字号不足以形成移动端视觉焦点" });
  }

  const content = root.querySelector<HTMLElement>(".wechat-poster-items");
  if (content && content.getBoundingClientRect().height < rootBox.height * .42) {
    issues.push({ code: "CONTENT_TOO_SPARSE", message: "主体信息密度偏低，画面留白过多" });
  }

  return { passed: issues.length === 0, issues };
}
