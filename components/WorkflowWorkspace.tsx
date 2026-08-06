"use client";

import { FormEvent, useCallback, useEffect, useMemo, useState } from "react";
import { contentStatusLabels, type ContentStatus } from "../lib/content-workflow";
import { preferredOrganizationId, preferredProjectId, rememberCurrentScope } from "../lib/client-scope";
import type { ProductionPack } from "../lib/content-production";

type View = "review" | "calendar" | "publish";
type Organization = { id: string; name: string };
type Project = { id: string; name: string };
type Item = { id: string; title: string; status: ContentStatus; current_version: number; version_id: string; generation_mode: string; pack_json: string; full_script: string; short_script: string; topic_source_type?: string | null; topic_source_ref?: string | null; citation_count?: number; updated_at: string };
type Review = { id: string; content_item_id: string; review_stage: "internal" | "client"; round: number; decision: string; note: string | null; requested_at: string; decided_at: string | null; requested_by_name: string | null; decided_by_name: string | null };
type Comment = { id: string; content_item_id: string; visibility: "internal" | "client"; body: string; anchor_json: string | null; resolved_at: string | null; created_at: string; author_name: string | null; author_email: string };
type Schedule = { id: string; content_item_id: string; platform: string; scheduled_at: string; timezone: string; status: string; notes: string | null; updated_at: string };
type Publication = { id: string; content_item_id: string; platform: string; status: string; external_url: string | null; published_at: string | null; error_message: string | null; updated_at: string };
type Permissions = { canSubmit: boolean; canInternalReview: boolean; canClientReview: boolean; canManagePublishing: boolean; clientOnly: boolean };
type WorkflowBody = { items: Item[]; reviews: Review[]; comments: Comment[]; schedules: Schedule[]; publications: Publication[]; permissions: Permissions };

const platforms: Record<string, string> = { douyin: "抖音", xiaohongshu: "小红书", wechat_channels: "视频号", bilibili: "B站", other: "其他" };
const sourceLabels: Record<string, string> = { manual: "人工策划", knowledge: "品牌知识", video_analysis: "视频分析", performance: "数据复盘", trend: "行业热点", comment: "评论需求" };
const emptyPermissions: Permissions = { canSubmit: false, canInternalReview: false, canClientReview: false, canManagePublishing: false, clientOnly: false };

async function readError(response: Response) { const body = await response.json().catch(() => null) as { error?: { message?: string } } | null; return body?.error?.message || "请求没有完成，请稍后重试。"; }
function formatTime(value?: string | null) { if (!value) return "—"; return new Intl.DateTimeFormat("zh-CN", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }).format(new Date(value)); }
function localDateTime(value?: string) { const date = value ? new Date(value) : new Date(Date.now() + 24 * 60 * 60 * 1000); const local = new Date(date.getTime() - date.getTimezoneOffset() * 60_000); return local.toISOString().slice(0, 16); }
function readPack(value: string): ProductionPack | null { try { return JSON.parse(value) as ProductionPack; } catch { return null; } }

export function WorkflowWorkspace({ initialView, initialOrganizationId = "", initialProjectId = "", initialContentId = "" }: { initialView: View; initialOrganizationId?: string; initialProjectId?: string; initialContentId?: string }) {
  const [organizations, setOrganizations] = useState<Organization[]>([]); const [organizationId, setOrganizationId] = useState("");
  const [projects, setProjects] = useState<Project[]>([]); const [projectId, setProjectId] = useState("");
  const [data, setData] = useState<WorkflowBody>({ items: [], reviews: [], comments: [], schedules: [], publications: [], permissions: emptyPermissions });
  const [selectedId, setSelectedId] = useState(initialContentId); const [loading, setLoading] = useState(true); const [busy, setBusy] = useState(""); const [error, setError] = useState(""); const [decisionNote, setDecisionNote] = useState("");

  const loadWorkspace = useCallback(async (orgId: string, projId: string) => {
    if (!orgId || !projId) return;
    const response = await fetch(`/api/workflow?organizationId=${encodeURIComponent(orgId)}&projectId=${encodeURIComponent(projId)}`);
    if (!response.ok) throw new Error(await readError(response));
    const body = await response.json() as WorkflowBody; setData(body); setSelectedId((current) => body.items.some((item) => item.id === current) ? current : body.items[0]?.id || "");
  }, []);
  const loadProjects = useCallback(async (orgId: string, preferred = "") => { const response = await fetch(`/api/projects?organizationId=${encodeURIComponent(orgId)}`); if (!response.ok) throw new Error(await readError(response)); const body = await response.json() as { projects: Project[] }; setProjects(body.projects); const next = preferredProjectId(body.projects, preferred); setProjectId(next); rememberCurrentScope(orgId, next); await loadWorkspace(orgId, next); }, [loadWorkspace]);
  useEffect(() => { let active = true; void (async () => { try { const response = await fetch("/api/organizations"); if (!response.ok) throw new Error(await readError(response)); const body = await response.json() as { organizations: Organization[] }; if (!active) return; setOrganizations(body.organizations); const next = preferredOrganizationId(body.organizations, initialOrganizationId); setOrganizationId(next); if (next) await loadProjects(next, initialProjectId); } catch (reason) { if (active) setError(reason instanceof Error ? reason.message : "协作工作台加载失败"); } finally { if (active) setLoading(false); } })(); return () => { active = false; }; }, [initialOrganizationId, initialProjectId, loadProjects]);

  const selected = data.items.find((item) => item.id === selectedId) || null;
  const selectedPack = useMemo(() => selected ? readPack(selected.pack_json) : null, [selected]);
  const selectedReviews = useMemo(() => data.reviews.filter((review) => review.content_item_id === selectedId), [data.reviews, selectedId]);
  const selectedComments = useMemo(() => data.comments.filter((comment) => comment.content_item_id === selectedId), [data.comments, selectedId]);
  const selectedSchedule = data.schedules.find((schedule) => schedule.content_item_id === selectedId && schedule.status !== "cancelled") || null;
  const selectedPublications = data.publications.filter((publication) => publication.content_item_id === selectedId);

  async function reload() { await loadWorkspace(organizationId, projectId); }
  async function transition(toStatus: ContentStatus) {
    if (!selected) return; setBusy(`transition:${toStatus}`); setError("");
    const response = await fetch(`/api/content-items/${selected.id}/transition`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ organizationId, projectId, toStatus, note: decisionNote || undefined }) });
    if (!response.ok) setError(await readError(response)); else { setDecisionNote(""); await reload(); } setBusy("");
  }
  async function addComment(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); if (!selected) return; setBusy("comment"); setError(""); const formElement = event.currentTarget; const form = new FormData(formElement);
    const response = await fetch(`/api/content-items/${selected.id}/comments`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ organizationId, projectId, visibility: data.permissions.clientOnly ? "client" : form.get("visibility"), body: form.get("body") }) });
    if (!response.ok) setError(await readError(response)); else { formElement.reset(); await reload(); } setBusy("");
  }
  async function resolveComment(comment: Comment) {
    setBusy(`comment:${comment.id}`); const response = await fetch(`/api/content-comments/${comment.id}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ organizationId, projectId, resolved: !comment.resolved_at }) });
    if (!response.ok) setError(await readError(response)); else await reload(); setBusy("");
  }
  async function saveSchedule(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); if (!selected) return; setBusy("schedule"); setError(""); const form = new FormData(event.currentTarget); const scheduledAt = new Date(String(form.get("scheduledAt"))).toISOString();
    const response = await fetch(`/api/content-items/${selected.id}/schedule`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ organizationId, projectId, platform: form.get("platform"), scheduledAt, timezone: "Asia/Shanghai", status: form.get("status"), notes: form.get("notes") }) });
    if (!response.ok) setError(await readError(response)); else await reload(); setBusy("");
  }
  async function savePublication(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); if (!selected) return; setBusy("publication"); setError(""); const formElement = event.currentTarget; const form = new FormData(formElement);
    const response = await fetch(`/api/content-items/${selected.id}/publications`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ organizationId, projectId, platform: form.get("platform"), status: form.get("status"), externalUrl: form.get("externalUrl"), errorMessage: form.get("errorMessage") }) });
    if (!response.ok) setError(await readError(response)); else { formElement.reset(); await reload(); } setBusy("");
  }

  if (loading) return <div className="management-state" role="status">正在载入协作工作台…</div>;
  if (!organizationId || !projectId) return <div className="empty-panel"><h2>请先创建客户项目</h2><p>审核、排期和发布记录必须归属于明确项目。</p></div>;
  return <div className="workflow-workspace">
    <div className="management-toolbar workflow-toolbar"><label>公司<select value={organizationId} onChange={async (event) => { setOrganizationId(event.target.value); await loadProjects(event.target.value); }}>{organizations.map((organization) => <option value={organization.id} key={organization.id}>{organization.name}</option>)}</select></label><label>客户项目<select value={projectId} onChange={async (event) => { setProjectId(event.target.value); rememberCurrentScope(organizationId, event.target.value); await loadWorkspace(organizationId, event.target.value); }}>{projects.map((project) => <option value={project.id} key={project.id}>{project.name}</option>)}</select></label><nav aria-label="协作工作台视图"><a className={initialView === "review" ? "active" : ""} href={`/workflow?view=review&organizationId=${organizationId}&projectId=${projectId}`}>审核</a><a className={initialView === "calendar" ? "active" : ""} href={`/workflow?view=calendar&organizationId=${organizationId}&projectId=${projectId}`}>日历</a><a className={initialView === "publish" ? "active" : ""} href={`/workflow?view=publish&organizationId=${organizationId}&projectId=${projectId}`}>发布</a></nav></div>
    {error && <div className="inline-alert" role="alert">{error}</div>}
    <div className="workflow-summary"><article><strong>{data.items.filter((item) => item.status === "internal_review").length}</strong><span>待内部审核</span></article><article><strong>{data.items.filter((item) => item.status === "client_review").length}</strong><span>待客户确认</span></article><article><strong>{data.schedules.filter((schedule) => schedule.status !== "cancelled" && new Date(schedule.scheduled_at) > new Date()).length}</strong><span>未来排期</span></article><article><strong>{data.publications.filter((publication) => publication.status === "published").length}</strong><span>已发布记录</span></article></div>
    <div className="workflow-main">
      <section className="panel workflow-canvas">{initialView === "review" ? <ReviewBoard items={data.items} selectedId={selectedId} onSelect={setSelectedId} /> : initialView === "calendar" ? <CalendarView items={data.items} schedules={data.schedules} selectedId={selectedId} onSelect={setSelectedId} /> : <PublicationView items={data.items} schedules={data.schedules} publications={data.publications} selectedId={selectedId} onSelect={setSelectedId} />}</section>
      <aside className="panel workflow-inspector">{selected ? <><header><span className={`workflow-status status-${selected.status}`}>{contentStatusLabels[selected.status]}</span><h2>{selected.title}</h2><small>当前稿件 v{selected.current_version} · {formatTime(selected.updated_at)} 更新</small></header><div className="workflow-lineage"><span>{sourceLabels[selected.topic_source_type || "manual"] || selected.topic_source_type || "人工策划"}</span><strong>分析 / 知识 → 选题 → 内容 → 审核 → 发布</strong><small>{selected.citation_count ?? 0} 条来源证据绑定当前版本</small></div>
        {initialView === "review" && <><ReviewContentPreview item={selected} pack={selectedPack} /><WorkflowActions item={selected} permissions={data.permissions} busy={busy} decisionNote={decisionNote} onDecisionNote={setDecisionNote} onTransition={transition} /><ReviewHistory reviews={selectedReviews} /><CommentPanel comments={selectedComments} permissions={data.permissions} busy={busy} onSubmit={addComment} onResolve={resolveComment} /></>}
        {initialView === "calendar" && <SchedulePanel schedule={selectedSchedule} canManage={data.permissions.canManagePublishing} busy={busy} onSubmit={saveSchedule} />}
        {initialView === "publish" && <PublicationPanel publications={selectedPublications} canManage={data.permissions.canManagePublishing} busy={busy} performanceHref={`/insights?view=imports&organizationId=${encodeURIComponent(organizationId)}&projectId=${encodeURIComponent(projectId)}`} onSubmit={savePublication} />}
      </> : <div className="workflow-empty"><h2>选择一条内容</h2><p>查看审核记录、日历排期或发布结果。</p></div>}</aside>
    </div>
  </div>;
}

function ReviewContentPreview({ item, pack }: { item: Item; pack: ProductionPack | null }) {
  const fullScript = item.full_script || pack?.fullScript || "当前版本还没有完整口播稿。";
  const shortScript = item.short_script || pack?.shortScript || "当前版本还没有精简稿。";
  return <section className="review-content-preview">
    <header><div><h3>本版本审核稿</h3><small>以下内容来自 v{item.current_version}，审核记录将绑定这一版本。</small></div><span>只读</span></header>
    <details open><summary>完整口播稿</summary><div className="review-script-copy">{fullScript}</div></details>
    <details><summary>精简版</summary><div className="review-script-copy compact">{shortScript}</div></details>
    {pack?.storyboard?.length ? <details><summary>分镜脚本 <em>{pack.storyboard.length}</em></summary><div className="review-storyboard">{pack.storyboard.map((shot, index) => <article key={`${shot.shot}:${index}`}><header><strong>{shot.shot}</strong><span>{shot.durationSec} 秒</span></header><p>{shot.script}</p><small>{shot.visual}{shot.performance ? ` · ${shot.performance}` : ""}</small></article>)}</div></details> : null}
    {pack && (pack.publishTitles.length || pack.coverCopy.length || pack.hashtags.length || pack.adaptations.length) ? <details><summary>封面与发布文案</summary><div className="review-publish-copy">{pack.publishTitles.map((value) => <p key={`title:${value}`}><strong>标题</strong>{value}</p>)}{pack.coverCopy.map((value) => <p key={`cover:${value}`}><strong>封面</strong>{value}</p>)}{pack.adaptations.map((value) => <p key={`adaptation:${value.platform}`}><strong>{value.platform}</strong>{value.copy}</p>)}{pack.hashtags.length > 0 && <div>{pack.hashtags.map((value) => <span key={value}>#{value.replace(/^#/, "")}</span>)}</div>}</div></details> : null}
  </section>;
}

function WorkflowActions({ item, permissions, busy, decisionNote, onDecisionNote, onTransition }: { item: Item; permissions: Permissions; busy: string; decisionNote: string; onDecisionNote: (value: string) => void; onTransition: (status: ContentStatus) => void }) {
  function action(status: ContentStatus, label: string, secondary = false) {
    const pending = busy === `transition:${status}`;
    return <button className={secondary ? "secondary" : undefined} onClick={() => onTransition(status)} disabled={Boolean(busy)} aria-busy={pending}>{pending ? "处理中…" : label}</button>;
  }
  return <section className="workflow-actions"><h3>审核操作</h3><textarea value={decisionNote} onChange={(event) => onDecisionNote(event.target.value)} placeholder={item.status.includes("review") ? "退回修改时请填写具体原因" : "提交审核说明（可选）"} /><div>
    {(item.status === "draft" || item.status === "internal_revision") && permissions.canSubmit && action("internal_review", "提交内部审核")}
    {item.status === "internal_review" && permissions.canInternalReview && <>{action("client_review", "内部通过")}{action("internal_revision", "退回修改", true)}</>}
    {item.status === "client_review" && permissions.canClientReview && <>{action("shooting_ready", "客户通过")}{action("internal_revision", "要求修改", true)}</>}
    {item.status === "shooting_ready" && permissions.canManagePublishing && action("shot", "标记已拍摄")}
    {item.status === "shot" && permissions.canManagePublishing && action("editing", "进入剪辑")}
    {item.status === "editing" && permissions.canManagePublishing && action("publish_ready", "标记待发布")}
  </div></section>;
}

function ReviewBoard({ items, selectedId, onSelect }: { items: Item[]; selectedId: string; onSelect: (id: string) => void }) {
  const columns: Array<{ title: string; statuses: ContentStatus[] }> = [{ title: "创作与修改", statuses: ["draft", "internal_revision"] }, { title: "内部审核", statuses: ["internal_review"] }, { title: "客户审核", statuses: ["client_review"] }, { title: "制作与发布", statuses: ["shooting_ready", "shot", "editing", "publish_ready", "published"] }];
  return <div className="review-board">{columns.map((column) => <section key={column.title}><header><h3>{column.title}</h3><span>{items.filter((item) => column.statuses.includes(item.status)).length}</span></header>{items.filter((item) => column.statuses.includes(item.status)).map((item) => <button className={selectedId === item.id ? "active" : ""} onClick={() => onSelect(item.id)} key={item.id}><strong>{item.title}</strong><small>{contentStatusLabels[item.status]} · v{item.current_version}</small></button>)}</section>)}</div>;
}
function CalendarView({ items, schedules, selectedId, onSelect }: { items: Item[]; schedules: Schedule[]; selectedId: string; onSelect: (id: string) => void }) {
  const active = schedules.filter((schedule) => schedule.status !== "cancelled"); const unscheduled = items.filter((item) => !active.some((schedule) => schedule.content_item_id === item.id) && item.status !== "published");
  return <div className="calendar-view"><h2>已安排内容</h2>{active.length ? active.map((schedule) => { const item = items.find((entry) => entry.id === schedule.content_item_id); return item ? <button className={selectedId === item.id ? "active" : ""} onClick={() => onSelect(item.id)} key={schedule.id}><time>{formatTime(schedule.scheduled_at)}</time><span><strong>{item.title}</strong><small>{platforms[schedule.platform] || schedule.platform} · {schedule.status === "ready" ? "已就绪" : "已计划"}</small></span></button> : null; }) : <p>还没有内容排期。</p>}<h2>待安排</h2>{unscheduled.map((item) => <button className={selectedId === item.id ? "active unscheduled" : "unscheduled"} onClick={() => onSelect(item.id)} key={item.id}><time>未排期</time><span><strong>{item.title}</strong><small>{contentStatusLabels[item.status]}</small></span></button>)}</div>;
}
function PublicationView({ items, schedules, publications, selectedId, onSelect }: { items: Item[]; schedules: Schedule[]; publications: Publication[]; selectedId: string; onSelect: (id: string) => void }) {
  return <div className="publication-view"><div className="publication-row heading"><span>内容</span><span>平台与排期</span><span>发布结果</span></div>{items.map((item) => { const schedule = schedules.find((entry) => entry.content_item_id === item.id && entry.status !== "cancelled"); const publication = publications.find((entry) => entry.content_item_id === item.id); return <button className={selectedId === item.id ? "publication-row active" : "publication-row"} onClick={() => onSelect(item.id)} key={item.id}><span><strong>{item.title}</strong><small>{contentStatusLabels[item.status]}</small></span><span>{schedule ? `${platforms[schedule.platform] || schedule.platform} · ${formatTime(schedule.scheduled_at)}` : "未排期"}</span><span>{publication ? publication.status : "暂无记录"}</span></button>; })}</div>;
}
function ReviewHistory({ reviews }: { reviews: Review[] }) { return <section className="review-history"><h3>审核记录</h3>{reviews.length ? reviews.map((review) => <article key={review.id}><span>{review.review_stage === "internal" ? "内部" : "客户"}第 {review.round} 轮</span><strong>{review.decision === "pending" ? "待处理" : review.decision === "approved" ? "已通过" : "要求修改"}</strong><small>{formatTime(review.decided_at || review.requested_at)} · {review.decided_by_name || review.requested_by_name || "项目成员"}</small>{review.note && <p>{review.note}</p>}</article>) : <p>还没有审核记录。</p>}</section>; }
function CommentPanel({ comments, permissions, busy, onSubmit, onResolve }: { comments: Comment[]; permissions: Permissions; busy: string; onSubmit: (event: FormEvent<HTMLFormElement>) => void; onResolve: (comment: Comment) => void }) { return <section className="comment-panel"><h3>版本评论</h3>{comments.map((comment) => { const pending = busy === `comment:${comment.id}`; return <article className={comment.resolved_at ? "resolved" : ""} key={comment.id}><header><strong>{comment.author_name || comment.author_email}</strong><span>{comment.visibility === "internal" ? "内部" : "客户可见"}</span></header><p>{comment.body}</p><small>{formatTime(comment.created_at)}</small><button onClick={() => onResolve(comment)} disabled={pending} aria-busy={pending}>{pending ? "处理中…" : comment.resolved_at ? "重新打开" : "标记解决"}</button></article>; })}<form onSubmit={onSubmit}>{!permissions.clientOnly && <select name="visibility" defaultValue="internal"><option value="internal">仅内部可见</option><option value="client">客户可见</option></select>}<textarea name="body" required maxLength={4000} placeholder="写下明确、可执行的修改意见" /><button disabled={Boolean(busy)} aria-busy={busy === "comment"}>{busy === "comment" ? "发表中…" : "发表评论"}</button></form></section>; }
function SchedulePanel({ schedule, canManage, busy, onSubmit }: { schedule: Schedule | null; canManage: boolean; busy: string; onSubmit: (event: FormEvent<HTMLFormElement>) => void }) { return <section className="schedule-panel"><h3>内容排期</h3>{schedule && <div className="schedule-current"><strong>{formatTime(schedule.scheduled_at)}</strong><span>{platforms[schedule.platform] || schedule.platform} · {schedule.status}</span>{schedule.notes && <p>{schedule.notes}</p>}</div>}{canManage && <form key={schedule?.updated_at || "new"} onSubmit={onSubmit}><label>发布平台<select name="platform" defaultValue={schedule?.platform || "douyin"}>{Object.entries(platforms).map(([value, label]) => <option value={value} key={value}>{label}</option>)}</select></label><label>计划时间<input name="scheduledAt" type="datetime-local" required defaultValue={localDateTime(schedule?.scheduled_at)} /></label><label>排期状态<select name="status" defaultValue={schedule?.status === "ready" ? "ready" : "planned"}><option value="planned">已计划</option><option value="ready">已就绪</option><option value="cancelled">取消排期</option></select></label><label>备注<textarea name="notes" maxLength={1000} defaultValue={schedule?.notes || ""} /></label><button disabled={busy === "schedule"} aria-busy={busy === "schedule"}>{busy === "schedule" ? "保存中…" : "保存排期"}</button></form>}</section>; }
function PublicationPanel({ publications, canManage, busy, performanceHref, onSubmit }: { publications: Publication[]; canManage: boolean; busy: string; performanceHref: string; onSubmit: (event: FormEvent<HTMLFormElement>) => void }) { const hasPublished = publications.some((publication) => publication.status === "published"); return <section className="publication-panel"><h3>发布记录</h3>{publications.map((publication) => <article key={publication.id}><header><strong>{platforms[publication.platform] || publication.platform}</strong><span>{publication.status}</span></header><small>{formatTime(publication.published_at || publication.updated_at)}</small>{publication.external_url && <a href={publication.external_url} target="_blank" rel="noreferrer">查看线上作品 ↗</a>}{publication.error_message && <p>{publication.error_message}</p>}</article>)}{hasPublished && <div className="publication-next-step"><strong>作品已进入数据复盘范围</strong><span>导入平台累计数据后，会自动关联这条发布记录。</span><a href={performanceHref}>进入数据复盘 →</a></div>}{canManage && <form onSubmit={onSubmit}><label>平台<select name="platform" defaultValue="douyin">{Object.entries(platforms).map(([value, label]) => <option value={value} key={value}>{label}</option>)}</select></label><label>结果<select name="status" defaultValue="published"><option value="published">已发布</option><option value="publishing">发布中</option><option value="scheduled">已预约</option><option value="failed">发布失败</option><option value="cancelled">已取消</option></select></label><label>线上作品链接<input type="url" name="externalUrl" placeholder="标记已发布时必填" /></label><label>失败原因<textarea name="errorMessage" maxLength={1000} /></label><button disabled={busy === "publication"} aria-busy={busy === "publication"}>{busy === "publication" ? "保存中…" : "保存发布记录"}</button></form>}</section>; }
