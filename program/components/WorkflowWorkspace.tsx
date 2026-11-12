"use client";
import { isScopeCancellation } from "../lib/client-scope-request";
import { runScopedAction } from "../lib/client-scope";
import { useWorkspaceInitialization } from "./useWorkspaceInitialization";
import { loadClientProjects } from "../lib/client-scope";
import { readApiError as readError } from "../lib/client-format";


import { FormEvent, useCallback, useMemo, useState } from "react";
import { contentStatusLabels, type ContentStatus } from "../lib/content-workflow";
import { rememberCurrentScope, scopedFetch } from "../lib/client-scope";
import type { ProductionPack } from "../lib/content-production";
import { deliveryPlan } from "../lib/delivery-entitlements";
import "./operations-cleanup.css";

type View = "review" | "calendar" | "publish";
type Organization = { id: string; name: string };
type Project = { id: string; name: string };
type Item = { id: string; title: string; status: ContentStatus; current_version: number; version_id: string; generation_mode: string; pack_json: string; full_script: string; short_script: string; topic_source_type?: string | null; topic_source_ref?: string | null; citation_count?: number; updated_at: string };
type Review = { id: string; content_item_id: string; review_stage: "internal" | "client"; round: number; decision: string; note: string | null; requested_at: string; decided_at: string | null; requested_by_name: string | null; decided_by_name: string | null };
type Comment = { id: string; content_item_id: string; visibility: "internal" | "client"; body: string; anchor_json: string | null; resolved_at: string | null; created_at: string; updated_at:string; author_name: string | null; author_email: string };
type Schedule = { id: string; content_item_id: string; platform: string; scheduled_at: string; timezone: string; status: string; notes: string | null; updated_at: string };
type Publication = { id: string; content_item_id: string; platform: string; status: string; external_url: string | null; published_at: string | null; error_message: string | null; updated_at: string };
type Permissions = { canSubmit: boolean; canInternalReview: boolean; canManagePublishing: boolean; clientOnly: boolean };
type WorkflowBody = { items: Item[]; reviews: Review[]; comments: Comment[]; schedules: Schedule[]; publications: Publication[]; permissions: Permissions };

const platforms: Record<string, string> = { douyin: "抖音", xiaohongshu: "小红书", wechat_channels: "视频号", bilibili: "B站", other: "其他" };
const sourceLabels: Record<string, string> = { manual: "人工策划", knowledge: "品牌知识", video_analysis: "视频分析", performance: "数据复盘", trend: "行业热点", comment: "评论需求" };
const emptyPermissions: Permissions = { canSubmit: false, canInternalReview: false, canManagePublishing: false, clientOnly: false };


function formatTime(value?: string | null) { if (!value) return "—"; return new Intl.DateTimeFormat("zh-CN", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }).format(new Date(value)); }
function localDateTime(value?: string) { const date = value ? new Date(value) : new Date(Date.now() + 24 * 60 * 60 * 1000); const local = new Date(date.getTime() - date.getTimezoneOffset() * 60_000); return local.toISOString().slice(0, 16); }
function readPack(value: string): ProductionPack | null { try { return JSON.parse(value) as ProductionPack; } catch { return null; } }

export function WorkflowWorkspace({ initialView, initialOrganizationId = "", initialProjectId = "", initialContentId = "" }: { initialView: View; initialOrganizationId?: string; initialProjectId?: string; initialContentId?: string }) {
  const [organizations, setOrganizations] = useState<Organization[]>([]); const [organizationId, setOrganizationId] = useState("");
  const [projects, setProjects] = useState<Project[]>([]); const [projectId, setProjectId] = useState("");
  const [data, setData] = useState<WorkflowBody>({ items: [], reviews: [], comments: [], schedules: [], publications: [], permissions: emptyPermissions });
  const [selectedId, setSelectedId] = useState(initialContentId); const [loading, setLoading] = useState(true); const [busy, setBusy] = useState(""); const [error, setError] = useState(""); const [notice, setNotice] = useState(""); const [decisionNote, setDecisionNote] = useState("");

  const loadWorkspace = useCallback(async (orgId: string, projId: string) => {
    if (!orgId || !projId) return;
    const response = await scopedFetch(`/api/workflow?organizationId=${encodeURIComponent(orgId)}&projectId=${encodeURIComponent(projId)}`);
    if (!response.ok) throw new Error(await readError(response));
    const body = await response.json() as WorkflowBody; setData(body); setSelectedId((current) => body.items.some((item) => item.id === current) ? current : body.items[0]?.id || "");
  }, []);
  const loadProjects = useCallback(async (orgId: string, preferred = "") => {
    const body = await loadClientProjects<Project>(orgId, preferred); setProjects(body.projects); const next = body.selected; setProjectId(next); rememberCurrentScope(orgId, next); await loadWorkspace(orgId, next); }, [loadWorkspace]);
  useWorkspaceInitialization({ initialOrganizationId, initialProjectId, setOrganizations, setOrganizationId, loadProjects, setError, setLoading, failureMessage: "协作工作台加载失败" });

  const selected = data.items.find((item) => item.id === selectedId) || null;
  const selectedPack = useMemo(() => selected ? readPack(selected.pack_json) : null, [selected]);
  const selectedReviews = useMemo(() => data.reviews.filter((review) => review.content_item_id === selectedId), [data.reviews, selectedId]);
  const selectedComments = useMemo(() => data.comments.filter((comment) => comment.content_item_id === selectedId), [data.comments, selectedId]);
  const selectedSchedule = data.schedules.find((schedule) => schedule.content_item_id === selectedId && schedule.status !== "cancelled") || null;
  const selectedPublications = data.publications.filter((publication) => publication.content_item_id === selectedId);

  async function reload() { await loadWorkspace(organizationId, projectId); }
  async function writeAction(name:string,send:()=>Promise<Response>,afterSave?:(body:Record<string,unknown>)=>void) {
    if(busy)return;setBusy(name);setError("");setNotice("");let saved=false;
    try {
      const response=await send();if(!response.ok){setError(await readError(response));return;}
      const body=await response.json() as Record<string,unknown>,key=name.startsWith("transition")?"item":name==="schedule"?"schedule":name==="publication"?"publication":"comment";
      const target=body[key];if(!target||typeof target!=="object"||!("id" in target)||typeof target.id!=="string"||!target.id)throw new Error("保存回执不完整，请刷新当前内容核对，勿连续重复提交。");
      saved=true;await reload();afterSave?.(body);
    } catch(error) {
      if(!isScopeCancellation(error))setError(saved?"操作已保存，但列表刷新失败。请恢复连接并刷新当前内容核对，勿重复提交。":error instanceof TypeError?"连接中断，暂时无法确认操作是否已保存。请刷新当前内容核对，勿连续重复提交。":error instanceof Error?error.message:"保存失败，请刷新核对当前内容。");
    } finally {setBusy("");}
  }
  async function transition(toStatus:ContentStatus) {
    if(!selected)return;
    await writeAction(`transition:${toStatus}`,()=>scopedFetch(`/api/content-items/${selected.id}/transition`,{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({organizationId,projectId,expectedVersion:selected.current_version,toStatus,note:decisionNote||undefined})}),body=>{
      if(body.memoryCandidate)setNotice("退回原因已保存为项目记忆候选，确认后才会用于选题和内容生成。");setDecisionNote("");
    });
  }
  async function addComment(event:FormEvent<HTMLFormElement>) {
    event.preventDefault();if(!selected)return;const formElement=event.currentTarget,form=new FormData(formElement);
    await writeAction("comment",()=>scopedFetch(`/api/content-items/${selected.id}/comments`,{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({organizationId,projectId,expectedVersion:selected.current_version,visibility:data.permissions.clientOnly?"client":form.get("visibility"),body:form.get("body")})}),()=>formElement.reset());
  }
  async function resolveComment(comment:Comment) {
    await writeAction(`comment:${comment.id}`,()=>scopedFetch(`/api/content-comments/${comment.id}`,{method:"PATCH",headers:{"content-type":"application/json"},body:JSON.stringify({organizationId,projectId,resolved:!comment.resolved_at,expectedUpdatedAt:comment.updated_at})}));
  }
  async function saveSchedule(event:FormEvent<HTMLFormElement>) {
    event.preventDefault();if(!selected||busy)return;const form=new FormData(event.currentTarget),date=new Date(String(form.get("scheduledAt")));
    if(!Number.isFinite(date.getTime())){setError("计划时间无效，请重新填写。");return;}
    await writeAction("schedule",()=>scopedFetch(`/api/content-items/${selected.id}/schedule`,{method:"PUT",headers:{"content-type":"application/json"},body:JSON.stringify({organizationId,projectId,expectedVersion:selected.current_version,expectedUpdatedAt:selectedSchedule?.updated_at??null,platform:form.get("platform"),scheduledAt:date.toISOString(),timezone:Intl.DateTimeFormat().resolvedOptions().timeZone,status:form.get("status"),notes:form.get("notes")})}));
  }
  async function savePublication(event:FormEvent<HTMLFormElement>) {
    event.preventDefault();if(!selected)return;const formElement=event.currentTarget,form=new FormData(formElement);
    await writeAction("publication",()=>scopedFetch(`/api/content-items/${selected.id}/publications`,{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({organizationId,projectId,expectedVersion:selected.current_version,platform:form.get("platform"),status:form.get("status"),externalUrl:form.get("externalUrl"),errorMessage:form.get("errorMessage")})}),()=>formElement.reset());
  }

  if (loading) return <div className="management-state" role="status">正在载入协作工作台…</div>;
  if (!organizationId || !projectId) return <div className="empty-panel"><h2>请先创建企业空间</h2><p>审核、排期和发布记录必须归属于明确的企业空间。</p></div>;
  return <div className="workflow-workspace">
    <div className="management-toolbar workflow-toolbar"><label>公司<select value={organizationId} disabled={Boolean(busy)} onChange={(event) => runScopedAction(async () => { setOrganizationId(event.target.value); await loadProjects(event.target.value); }, setError)}>{organizations.map((organization) => <option value={organization.id} key={organization.id}>{organization.name}</option>)}</select></label><label>企业空间<select value={projectId} disabled={Boolean(busy)} onChange={(event) => runScopedAction(async () => { setProjectId(event.target.value); rememberCurrentScope(organizationId, event.target.value); await loadWorkspace(organizationId, event.target.value); }, setError)}>{projects.map((project) => <option value={project.id} key={project.id}>{project.name}</option>)}</select></label><nav aria-label="协作工作台视图"><a className={initialView === "review" ? "active" : ""} href={`/workflow?view=review&organizationId=${organizationId}&projectId=${projectId}`}>审核</a><a className={initialView === "publish" ? "active" : ""} href={`/workflow?view=publish&organizationId=${organizationId}&projectId=${projectId}`}>发布</a></nav></div>
    {error && <div className="inline-alert" role="alert">{error}</div>}{notice && <div className="workflow-memory-notice" role="status"><span>{notice}</span><a href={`/memory?organizationId=${encodeURIComponent(organizationId)}&projectId=${encodeURIComponent(projectId)}`}>查看记忆候选 →</a></div>}
    <div className="workflow-summary"><article><strong>{data.items.filter((item) => item.status === "internal_review" || item.status === "client_review").length}</strong><span>待内部审核</span></article><article><strong>{data.items.filter((item) => item.status === "internal_revision").length}</strong><span>待修改</span></article><article><strong>{data.schedules.filter((schedule) => schedule.status !== "cancelled" && new Date(schedule.scheduled_at) > new Date()).length}</strong><span>未来排期</span></article><article><strong>{data.publications.filter((publication) => publication.status === "published").length}</strong><span>已发布记录</span></article></div>
    <div className="workflow-main">
      <section className="panel workflow-canvas">{initialView === "review" ? <ReviewBoard items={data.items} selectedId={selectedId} onSelect={(id)=>{if(!busy)setSelectedId(id);}} /> : initialView === "calendar" ? <CalendarView items={data.items} schedules={data.schedules} selectedId={selectedId} onSelect={(id)=>{if(!busy)setSelectedId(id);}} /> : <PublicationView items={data.items} schedules={data.schedules} publications={data.publications} selectedId={selectedId} onSelect={(id)=>{if(!busy)setSelectedId(id);}} />}</section>
      <aside className="panel workflow-inspector workflow-inspector-clean">{selected ? <><header><span className={`workflow-status status-${selected.status}`}>{contentStatusLabels[selected.status]}</span><h2>{selected.title}</h2><div className="workflow-version-summary"><small>v{selected.current_version} · {formatTime(selected.updated_at)} 更新</small><details className="workflow-lineage workflow-version-context"><summary>{selected.citation_count ?? 0} 条来源依据</summary><p>选题来源：{sourceLabels[selected.topic_source_type || "manual"] || selected.topic_source_type || "人工策划"}</p><p>来源随当前版本保留，可在审核稿中核对。</p></details></div></header>
        {initialView === "review" && <><WorkflowActions item={selected} permissions={data.permissions} busy={busy} decisionNote={decisionNote} onDecisionNote={setDecisionNote} onTransition={transition} /><ReviewContentPreview item={selected} pack={selectedPack} /><details className="workflow-records"><summary>审核记录 <span>{selectedReviews.length}</span></summary><ReviewHistory reviews={selectedReviews} /></details><details className="workflow-records"><summary>版本评论 <span>{selectedComments.length}{selectedComments.some(comment => !comment.resolved_at) ? ` · ${selectedComments.filter(comment => !comment.resolved_at).length} 条待处理` : ""}</span></summary><CommentPanel comments={selectedComments} permissions={data.permissions} busy={busy} onSubmit={addComment} onResolve={resolveComment} /></details></>}
        {initialView === "calendar" && <SchedulePanel schedule={selectedSchedule} canManage={data.permissions.canManagePublishing} busy={busy} onSubmit={saveSchedule} />}
        {initialView === "publish" && <PublicationPanel publications={selectedPublications} canManage={data.permissions.canManagePublishing} busy={busy} performanceHref={deliveryPlan.features.insights ? `/insights?view=imports&organizationId=${encodeURIComponent(organizationId)}&projectId=${encodeURIComponent(projectId)}` : undefined} onSubmit={savePublication} />}
      </> : <div className="workflow-empty"><h2>选择一条内容</h2><p>查看审核记录或发布结果。</p></div>}</aside>
    </div>
  </div>;
}

function ReviewContentPreview({ item, pack }: { item: Item; pack: ProductionPack | null }) {
  const fullScript = item.full_script || pack?.fullScript || "当前版本还没有完整口播稿。";
  const shortScript = item.short_script || pack?.shortScript || "当前版本还没有精简稿。";
  return <section className="review-content-preview">
    <header><div><h3>审核稿</h3></div><span>只读</span></header>
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
  return <section className="workflow-actions workflow-actions-compact"><header><h3>审核操作</h3><small>审核记录绑定当前 v{item.current_version}</small></header><textarea value={decisionNote} onChange={(event) => onDecisionNote(event.target.value)} placeholder={item.status.includes("review") ? "退回修改时请填写具体原因" : "提交审核说明（可选）"} /><div>
    {(item.status === "draft" || item.status === "internal_revision") && permissions.canSubmit && action("internal_review", "提交内部审核")}
    {item.status === "internal_review" && permissions.canInternalReview && <>{action("publish_ready", "审核通过，待发布")}{action("internal_revision", "退回修改", true)}</>}
    {item.status === "client_review" && permissions.canInternalReview && <>{action("publish_ready", "审核通过，待发布")}{action("internal_revision", "退回修改", true)}</>}
  </div></section>;
}

function ReviewBoard({ items, selectedId, onSelect }: { items: Item[]; selectedId: string; onSelect: (id: string) => void }) {
  const columns: Array<{ title: string; statuses: ContentStatus[] }> = [{ title: "创作与修改", statuses: ["draft", "internal_revision"] }, { title: "内部审核", statuses: ["internal_review", "client_review"] }, { title: "发布", statuses: ["publish_ready", "published"] }];
  return <div className="review-board">{columns.map((column) => <section key={column.title}><header><h3>{column.title}</h3><span>{items.filter((item) => column.statuses.includes(item.status)).length}</span></header>{items.filter((item) => column.statuses.includes(item.status)).map((item) => <button className={selectedId === item.id ? "active" : ""} onClick={() => onSelect(item.id)} key={item.id}><strong>{item.title}</strong><small>{contentStatusLabels[item.status]} · v{item.current_version}</small></button>)}</section>)}</div>;
}
function CalendarView({ items, schedules, selectedId, onSelect }: { items: Item[]; schedules: Schedule[]; selectedId: string; onSelect: (id: string) => void }) {
  const active = schedules.filter((schedule) => schedule.status !== "cancelled"); const unscheduled = items.filter((item) => !active.some((schedule) => schedule.content_item_id === item.id) && item.status !== "published");
  return <div className="calendar-view"><h2>已安排内容</h2>{active.length ? active.map((schedule) => { const item = items.find((entry) => entry.id === schedule.content_item_id); return item ? <button className={selectedId === item.id ? "active" : ""} onClick={() => onSelect(item.id)} key={schedule.id}><time>{formatTime(schedule.scheduled_at)}</time><span><strong>{item.title}</strong><small>{platforms[schedule.platform] || schedule.platform} · {schedule.status === "ready" ? "已就绪" : "已计划"}</small></span></button> : null; }) : <p>还没有内容排期。</p>}<h2>待安排</h2>{unscheduled.map((item) => <button className={selectedId === item.id ? "active unscheduled" : "unscheduled"} onClick={() => onSelect(item.id)} key={item.id}><time>未排期</time><span><strong>{item.title}</strong><small>{contentStatusLabels[item.status]}</small></span></button>)}</div>;
}
function PublicationView({ items, schedules, publications, selectedId, onSelect }: { items: Item[]; schedules: Schedule[]; publications: Publication[]; selectedId: string; onSelect: (id: string) => void }) {
  return <div className="publication-view"><div className="publication-row heading"><span>内容</span><span>平台与排期</span><span>发布结果</span></div>{items.map((item) => { const schedule = schedules.find((entry) => entry.content_item_id === item.id && entry.status !== "cancelled"); const publication = publications.find((entry) => entry.content_item_id === item.id); return <button className={selectedId === item.id ? "publication-row active" : "publication-row"} onClick={() => onSelect(item.id)} key={item.id}><span><strong>{item.title}</strong><small>{contentStatusLabels[item.status]}</small></span><span>{schedule ? `${platforms[schedule.platform] || schedule.platform} · ${formatTime(schedule.scheduled_at)}` : "未排期"}</span><span>{publication ? publication.status : "暂无记录"}</span></button>; })}</div>;
}
function ReviewHistory({ reviews }: { reviews: Review[] }) { return <section className="review-history"><h3>审核记录</h3>{reviews.length ? reviews.map((review) => <article key={review.id}><span>内部第 {review.round} 轮</span><strong>{review.decision === "pending" ? "待处理" : review.decision === "approved" ? "已通过" : review.decision === "cancelled" ? "已取消" : "要求修改"}</strong><small>{formatTime(review.decided_at || review.requested_at)} · {review.decided_by_name || review.requested_by_name || "项目成员"}</small>{review.note && <p>{review.note}</p>}</article>) : <p>还没有审核记录。</p>}</section>; }
function CommentPanel({ comments, permissions, busy, onSubmit, onResolve }: { comments: Comment[]; permissions: Permissions; busy: string; onSubmit: (event: FormEvent<HTMLFormElement>) => void; onResolve: (comment: Comment) => void }) { return <section className="comment-panel"><h3>版本评论</h3>{comments.map((comment) => { const pending = busy === `comment:${comment.id}`; return <article className={comment.resolved_at ? "resolved" : ""} key={comment.id}><header><strong>{comment.author_name || comment.author_email}</strong><span>{comment.visibility === "internal" ? "内部" : "客户可见"}</span></header><p>{comment.body}</p><small>{formatTime(comment.created_at)}</small><button onClick={() => onResolve(comment)} disabled={pending} aria-busy={pending}>{pending ? "处理中…" : comment.resolved_at ? "重新打开" : "标记解决"}</button></article>; })}<form onSubmit={onSubmit}>{!permissions.clientOnly && <select name="visibility" defaultValue="internal"><option value="internal">仅内部可见</option><option value="client">客户可见</option></select>}<textarea name="body" required maxLength={4000} placeholder="写下明确、可执行的修改意见" /><button disabled={Boolean(busy)} aria-busy={busy === "comment"}>{busy === "comment" ? "发表中…" : "发表评论"}</button></form></section>; }
function SchedulePanel({ schedule, canManage, busy, onSubmit }: { schedule: Schedule | null; canManage: boolean; busy: string; onSubmit: (event: FormEvent<HTMLFormElement>) => void }) { return <section className="schedule-panel"><h3>内容排期</h3>{schedule && <div className="schedule-current"><strong>{formatTime(schedule.scheduled_at)}</strong><span>{platforms[schedule.platform] || schedule.platform} · {schedule.status}</span>{schedule.notes && <p>{schedule.notes}</p>}</div>}{canManage && <form key={schedule?.updated_at || "new"} onSubmit={onSubmit}><label>发布平台<select name="platform" defaultValue={schedule?.platform || "douyin"}>{Object.entries(platforms).map(([value, label]) => <option value={value} key={value}>{label}</option>)}</select></label><label>计划时间（本机时区）<input name="scheduledAt" type="datetime-local" required defaultValue={localDateTime(schedule?.scheduled_at)} /></label><label>排期状态<select name="status" defaultValue={schedule?.status === "ready" ? "ready" : "planned"}><option value="planned">已计划</option><option value="ready">已就绪</option><option value="cancelled">取消排期</option></select></label><label>备注<textarea name="notes" maxLength={1000} defaultValue={schedule?.notes || ""} /></label><button disabled={Boolean(busy)} aria-busy={busy === "schedule"}>{busy === "schedule" ? "保存中…" : "保存排期"}</button></form>}</section>; }
function PublicationPanel({ publications, canManage, busy, performanceHref, onSubmit }: { publications: Publication[]; canManage: boolean; busy: string; performanceHref?: string; onSubmit: (event: FormEvent<HTMLFormElement>) => void }) { const hasPublished = publications.some((publication) => publication.status === "published"); return <section className="publication-panel"><h3>发布记录</h3>{publications.map((publication) => <article key={publication.id}><header><strong>{platforms[publication.platform] || publication.platform}</strong><span>{publication.status}</span></header><small>{formatTime(publication.published_at || publication.updated_at)}</small>{publication.external_url && <a href={publication.external_url} target="_blank" rel="noreferrer">查看线上作品 ↗</a>}{publication.error_message && <p>{publication.error_message}</p>}</article>)}{hasPublished && performanceHref && <div className="publication-next-step"><strong>作品已进入数据复盘范围</strong><span>导入平台累计数据后，会自动关联这条发布记录。</span><a href={performanceHref}>进入数据复盘 →</a></div>}{canManage && <form onSubmit={onSubmit}><label>平台<select name="platform" defaultValue="douyin">{Object.entries(platforms).map(([value, label]) => <option value={value} key={value}>{label}</option>)}</select></label><label>结果<select name="status" defaultValue="published"><option value="published">已发布</option><option value="publishing">发布中</option><option value="scheduled">已预约</option><option value="failed">发布失败</option><option value="cancelled">已取消</option></select></label><label>线上作品链接<input type="url" name="externalUrl" placeholder="标记已发布时必填" /></label><label>失败原因<textarea name="errorMessage" maxLength={1000} /></label><button disabled={Boolean(busy)} aria-busy={busy === "publication"}>{busy === "publication" ? "保存中…" : "保存发布记录"}</button></form>}</section>; }
