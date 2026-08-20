"use client";

import { ChangeEvent, useRef, useState } from "react";
import Papa from "papaparse";

type ImportRow = {
  title: string;
  body: string;
  platform: string;
  contentFormat: string;
  publishedAt?: string;
  externalUrl?: string;
  monetizationTypes: string[];
  monetizationDetail?: string;
  performance: Record<string, number | undefined>;
};

type ImportResult = { importedCount: number; rejectedCount: number; rejections: Array<{ row: number; title: string; message: string }> };
type Props = { organizationId: string; projectId: string; canWrite: boolean; onImported: () => Promise<void>; onError: (message: string) => void };

const aliases: Record<string, string[]> = {
  title: ["title", "标题", "文案标题"], body: ["body", "正文", "文案", "文案正文"], platform: ["platform", "平台"],
  contentFormat: ["contentformat", "content_format", "内容形式", "文案形式"], publishedAt: ["publishedat", "published_at", "发布时间", "发布日期"],
  externalUrl: ["externalurl", "external_url", "链接", "原文链接"], monetizationTypes: ["monetizationtypes", "monetization_types", "变现形式"],
  monetizationDetail: ["monetizationdetail", "monetization_detail", "变现说明"], views: ["views", "阅读", "播放", "阅读播放"],
  likes: ["likes", "点赞"], saves: ["saves", "收藏"], leads: ["leads", "咨询", "线索"], conversions: ["conversions", "成交", "转化"],
};
const platformValues: Record<string, string> = { 抖音: "douyin", 小红书: "xiaohongshu", 微信公众号: "wechat_official", 公众号: "wechat_official", 视频号: "wechat_channels", 哔哩哔哩: "bilibili", B站: "bilibili", 其他: "other" };
const formatValues: Record<string, string> = { 口播稿: "spoken_script", 长文章: "article", 发布配文: "caption", 公众号推文: "newsletter", 其他: "other" };
const monetizationValues: Record<string, string> = { 无直接变现: "none", 私信引导: "private_message", 咨询转化: "consultation", 课程成交: "course", 社群引流: "community", 产品销售: "product", 资料留资: "lead_magnet", 品牌认知: "brand_awareness", 其他: "other" };

function cell(record: Record<string, unknown>, field: string) {
  const normalized = Object.fromEntries(Object.entries(record).map(([key, value]) => [key.trim().toLocaleLowerCase("zh-CN").replace(/\s+/g, ""), value]));
  for (const name of aliases[field] || [field]) if (normalized[name.toLocaleLowerCase("zh-CN").replace(/\s+/g, "")] !== undefined) return String(normalized[name.toLocaleLowerCase("zh-CN").replace(/\s+/g, "")] ?? "").trim();
  return "";
}

function optionalNumber(value: string) { if (!value) return undefined; const number = Number(value.replace(/,/g, "")); return Number.isFinite(number) && number >= 0 ? Math.round(number) : undefined; }
function normalizedDate(value: string) { if (!value) return ""; const timestamp = new Date(value); return Number.isNaN(timestamp.getTime()) ? value : timestamp.toISOString(); }
function normalizeRow(record: Record<string, unknown>): ImportRow {
  const platform = cell(record, "platform"); const format = cell(record, "contentFormat");
  const monetizationTypes = cell(record, "monetizationTypes").split(/[|、，,;；/]+/).map((value) => monetizationValues[value] || value).filter(Boolean);
  return {
    title: cell(record, "title"), body: cell(record, "body"), platform: platformValues[platform] || platform || "douyin",
    contentFormat: formatValues[format] || format || "spoken_script", publishedAt: normalizedDate(cell(record, "publishedAt")), externalUrl: cell(record, "externalUrl"),
    monetizationTypes, monetizationDetail: cell(record, "monetizationDetail"), performance: {
      views: optionalNumber(cell(record, "views")), likes: optionalNumber(cell(record, "likes")), saves: optionalNumber(cell(record, "saves")),
      leads: optionalNumber(cell(record, "leads")), conversions: optionalNumber(cell(record, "conversions")),
    },
  };
}

function downloadTemplate() {
  const csv = Papa.unparse([{
    title: "企业 AI 落地的三个误区", body: "请将完整历史文案粘贴在这里。至少填写二十个字，单元格内换行会被自动保留。", platform: "抖音", contentFormat: "口播稿",
    publishedAt: "2026-08-01 10:00", externalUrl: "", monetizationTypes: "私信引导|咨询转化", monetizationDetail: "评论区引导私信预约诊断",
    views: 12000, likes: 360, saves: 128, leads: 18, conversions: 3,
  }]);
  const url = URL.createObjectURL(new Blob(["\uFEFF", csv], { type: "text/csv;charset=utf-8" }));
  const anchor = document.createElement("a"); anchor.href = url; anchor.download = "历史发布文案导入模板.csv"; anchor.click(); URL.revokeObjectURL(url);
}

export function PublishedCopyBatchImport({ organizationId, projectId, canWrite, onImported, onError }: Props) {
  const inputRef = useRef<HTMLInputElement>(null); const [rows, setRows] = useState<ImportRow[]>([]); const [fileName, setFileName] = useState("");
  const [parsingMessage, setParsingMessage] = useState(""); const [importing, setImporting] = useState(false); const [result, setResult] = useState<ImportResult | null>(null);

  async function chooseFile(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0]; if (!file) return; setResult(null); setRows([]); setFileName(file.name); setParsingMessage("");
    try {
      const text = await file.text(); let raw: Array<Record<string, unknown>> = [];
      if (file.name.toLocaleLowerCase().endsWith(".json")) {
        const parsed = JSON.parse(text) as unknown; if (!Array.isArray(parsed)) throw new Error("JSON 文件顶层必须是数组。"); raw = parsed as Array<Record<string, unknown>>;
      } else {
        const parsed = Papa.parse<Record<string, unknown>>(text, { header: true, skipEmptyLines: "greedy", transformHeader: (header) => header.trim() });
        const fatal = parsed.errors.find((error) => error.code !== "UndetectableDelimiter"); if (fatal) throw new Error(`第 ${Number(fatal.row || 0) + 2} 行无法解析：${fatal.message}`); raw = parsed.data;
      }
      if (!raw.length) throw new Error("文件中没有可导入的数据行。"); if (raw.length > 200) throw new Error("一次最多导入 200 篇，请拆分文件后再试。");
      const normalized = raw.map(normalizeRow); setRows(normalized); setParsingMessage(`已读取 ${normalized.length} 行，导入前会逐行校验并自动跳过重复文案。`);
    } catch (reason) { const message = reason instanceof Error ? reason.message : "文件无法解析。"; setParsingMessage(message); onError(message); }
  }

  async function startImport() {
    if (!rows.length || importing) return; setImporting(true); setResult(null); onError("");
    try {
      const response = await fetch("/api/published-copy/import", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ organizationId, projectId, records: rows }) });
      if (!response.ok) { const body = await response.json().catch(() => null) as { error?: { message?: string } } | null; throw new Error(body?.error?.message || "批量导入没有完成。"); }
      const body = await response.json() as ImportResult; setResult(body); await onImported();
      if (body.importedCount) { setRows([]); setFileName(""); if (inputRef.current) inputRef.current.value = ""; }
    } catch (reason) { onError(reason instanceof Error ? reason.message : "批量导入没有完成。"); }
    finally { setImporting(false); }
  }

  if (!canWrite) return null;
  return <details className="panel published-copy-import">
    <summary><div><span className="import-mark" aria-hidden="true">↥</span><div><strong>批量导入历来文案</strong><small>CSV / JSON · 自动分析 · 自动去重</small></div></div><span>展开导入</span></summary>
    <div className="published-copy-import-body"><div className="published-copy-import-guide"><p>把历来发布内容一次带进来，系统会逐篇识别字数、开场、语气、行动引导和变现形式。</p><button type="button" onClick={downloadTemplate}>下载 CSV 模板</button></div>
      <label className="published-copy-file"><input ref={inputRef} type="file" accept=".csv,.json,text/csv,application/json" onChange={chooseFile} /><span>{fileName || "选择 CSV 或 JSON 文件"}</span><small>最多 200 篇；标题和正文为必填项</small></label>
      {parsingMessage && <p className="published-copy-import-message">{parsingMessage}</p>}
      {rows.length > 0 && <div className="published-copy-import-preview"><header><strong>导入预览</strong><span>前 {Math.min(3, rows.length)} / {rows.length} 篇</span></header>{rows.slice(0, 3).map((row, index) => <article key={`${row.title}-${index}`}><span>{row.platform}</span><strong>{row.title || "未填写标题"}</strong><small>{row.body ? `${Array.from(row.body.replace(/\s+/g, "")).length} 字` : "未填写正文"}</small></article>)}<button className="primary-button" type="button" onClick={startImport} disabled={importing}>{importing ? "正在校验并导入…" : `开始导入 ${rows.length} 篇`}</button></div>}
      {result && <div className={`published-copy-import-result ${result.rejectedCount ? "has-rejections" : ""}`}><strong>已导入 {result.importedCount} 篇</strong><span>{result.rejectedCount ? `${result.rejectedCount} 行未导入` : "全部导入成功"}</span>{result.rejections.length > 0 && <details><summary>查看未导入原因</summary>{result.rejections.slice(0, 30).map((item) => <p key={`${item.row}-${item.title}`}>第 {item.row} 行{item.title ? `「${item.title}」` : ""}：{item.message}</p>)}</details>}</div>}
    </div>
  </details>;
}
