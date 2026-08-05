"use client";

import { FormEvent, useEffect, useState } from "react";

type Organization = { id: string; name: string; role: string };
type Project = { id: string; name: string };
type Member = { id: string; email: string; display_name: string | null; role: string; status: string; created_at: string };
type Invitation = { id: string; email: string; organization_role: string; project_role: string | null; status: string; expires_at: string };

async function responseMessage(response: Response) { const body = await response.json().catch(() => null) as { error?: { message?: string } } | null; return body?.error?.message ?? "请求没有完成，请稍后重试。"; }

export function MemberManager() {
  const [organizations, setOrganizations] = useState<Organization[]>([]);
  const [organizationId, setOrganizationId] = useState("");
  const [role, setRole] = useState("");
  const [members, setMembers] = useState<Member[]>([]);
  const [invitations, setInvitations] = useState<Invitation[]>([]);
  const [projects, setProjects] = useState<Project[]>([]);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [inviteUrl, setInviteUrl] = useState("");
  const [currentUserId, setCurrentUserId] = useState("");
  const [savingId, setSavingId] = useState("");

  async function loadScope(id: string) {
    const [membersResponse, projectsResponse] = await Promise.all([fetch(`/api/members?organizationId=${encodeURIComponent(id)}`), fetch(`/api/projects?organizationId=${encodeURIComponent(id)}`)]);
    if (!membersResponse.ok) throw new Error(await responseMessage(membersResponse));
    const memberBody = await membersResponse.json() as { members: Member[]; invitations: Invitation[]; organizationRole: string; currentUserId: string };
    setMembers(memberBody.members); setInvitations(memberBody.invitations); setRole(memberBody.organizationRole); setCurrentUserId(memberBody.currentUserId);
    if (projectsResponse.ok) { const body = await projectsResponse.json() as { projects: Project[] }; setProjects(body.projects); }
  }

  useEffect(() => { let active = true; (async () => { try { const response = await fetch("/api/organizations"); if (!response.ok) throw new Error(await responseMessage(response)); const body = await response.json() as { organizations: Organization[] }; if (!active) return; setOrganizations(body.organizations); const first = body.organizations[0]?.id ?? ""; setOrganizationId(first); if (first) await loadScope(first); } catch (reason) { if (active) setError(reason instanceof Error ? reason.message : "加载失败"); } finally { if (active) setLoading(false); } })(); return () => { active = false; }; }, []);

  async function invite(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setError(""); setInviteUrl("");
    const formElement = event.currentTarget; const form = new FormData(formElement);
    const response = await fetch("/api/members", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ organizationId, email: form.get("email"), organizationRole: form.get("organizationRole"), projectId: form.get("projectId") || undefined, projectRole: form.get("projectRole") || undefined }) });
    if (!response.ok) { setError(await responseMessage(response)); return; }
    const body = await response.json() as { invitation: Invitation & { accept_url: string } };
    setInvitations((current) => [body.invitation, ...current]); setInviteUrl(`${window.location.origin}${body.invitation.accept_url}`); formElement.reset();
  }

  async function updateMember(member: Member, next: { role?: string; status?: string }) {
    setSavingId(member.id); setError("");
    const response = await fetch("/api/members", { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ organizationId, memberId: member.id, role: next.role || member.role, status: next.status || member.status }) });
    if (!response.ok) setError(await responseMessage(response)); else setMembers((items) => items.map((item) => item.id === member.id ? { ...item, role: next.role || item.role, status: next.status || item.status } : item).filter((item) => item.status !== "removed"));
    setSavingId("");
  }

  async function revokeInvitation(invitationId: string) {
    setSavingId(invitationId); setError(""); const response = await fetch("/api/members", { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ organizationId, invitationId }) });
    if (!response.ok) setError(await responseMessage(response)); else setInvitations((items) => items.filter((item) => item.id !== invitationId)); setSavingId("");
  }

  if (loading) return <div className="management-state" role="status">正在载入成员与权限…</div>;
  if (error && organizations.length === 0) return <div className="management-state error-state"><strong>暂时无法进入成员空间</strong><p>{error}</p><small>请确认本地身份已启用，并先完成公司初始化。</small></div>;
  if (!organizationId) return <div className="empty-panel"><h2>请先创建公司空间</h2><p>进入客户项目页面完成公司初始化后，即可邀请成员。</p><a className="primary-button link-button" href="/projects">前往客户项目</a></div>;

  return <div className="management-layout members-layout"><section className="management-main"><div className="management-toolbar"><label>公司空间<select value={organizationId} onChange={async (event) => { const id = event.target.value; setOrganizationId(id); await loadScope(id); }}>{organizations.map((organization) => <option value={organization.id} key={organization.id}>{organization.name}</option>)}</select></label><span>{members.filter((member) => member.status === "active").length} 位有效成员</span></div>{error && <div className="inline-alert" role="alert">{error}</div>}<article className="panel member-table"><table><caption className="sr-only">公司成员列表</caption><thead><tr><th>成员</th><th>公司角色</th><th>状态</th><th>加入时间</th></tr></thead><tbody>{members.map((member) => <tr key={member.id}><td><div className="member-cell"><span className="member-avatar">{(member.display_name || member.email).slice(0, 1).toUpperCase()}</span><span><strong>{member.display_name || member.email}</strong><small>{member.email}</small></span></div></td><td>{role === "admin" ? <select className="inline-select" value={member.role} disabled={savingId === member.id} onChange={(event) => updateMember(member, { role: event.target.value })}><option value="admin">公司管理员</option><option value="member">公司成员</option><option value="readonly">只读成员</option></select> : member.role}</td><td>{role === "admin" ? <select className="inline-select" value={member.status} disabled={savingId === member.id || member.id === currentUserId} onChange={(event) => updateMember(member, { status: event.target.value })}><option value="active">有效</option><option value="suspended">已暂停</option><option value="removed">移除</option></select> : <span className={`status ${member.status === "active" ? "success" : "warning"}`}>{member.status === "active" ? "有效" : "已暂停"}</span>}</td><td>{new Date(member.created_at).toLocaleDateString("zh-CN")}</td></tr>)}</tbody></table></article>{invitations.length > 0 && <article className="panel pending-panel"><div className="panel-heading"><div><p className="section-kicker">待接受邀请</p><h2>{invitations.length} 份邀请尚未完成</h2></div></div>{invitations.map((invitation) => <div className="pending-row pending-actions" key={invitation.id}><span>{invitation.email}</span><small>{invitation.organization_role} · {invitation.project_role || "未分配项目"}</small><em>{new Date(invitation.expires_at).toLocaleDateString("zh-CN")} 到期</em><button type="button" disabled={savingId === invitation.id} onClick={() => revokeInvitation(invitation.id)}>撤销</button></div>)}</article>}</section>{role === "admin" && <aside className="create-panel"><p className="section-kicker">邀请成员</p><h2>分配固定角色</h2><p>邀请链接仅能使用一次，7 天后自动失效。客户角色只能访问被分配的项目。</p><form className="stack-form" onSubmit={invite}><label>邮箱<input name="email" type="email" required placeholder="name@company.com" /></label><label>公司角色<select name="organizationRole" defaultValue="member"><option value="member">公司成员</option><option value="readonly">只读成员</option><option value="admin">公司管理员</option></select></label><label>分配项目<select name="projectId" defaultValue=""><option value="">暂不分配</option>{projects.map((project) => <option key={project.id} value={project.id}>{project.name}</option>)}</select></label><label>项目角色<select name="projectRole" defaultValue="planner"><option value="owner">项目负责人</option><option value="planner">策划 / 文案</option><option value="creator">内容制作</option><option value="reviewer">内部审核</option><option value="client">客户成员</option><option value="readonly">项目只读</option></select></label><button className="primary-button">生成邀请链接</button></form>{inviteUrl && <div className="invite-result" role="status"><strong>邀请已创建</strong><input readOnly value={inviteUrl} aria-label="邀请链接" /><button type="button" onClick={() => navigator.clipboard.writeText(inviteUrl)}>复制链接</button></div>}</aside>}</div>;
}
