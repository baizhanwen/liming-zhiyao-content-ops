import { AppShell } from "../../components/AppShell";
import { MemberManager } from "../../components/MemberManager";

export default function MembersPage() {
  return <AppShell activePath="/members"><section className="page-heading management-heading"><div><p>平台地基 · 服务端鉴权</p><h1>成员与权限</h1><span>公司只有管理员和员工；员工只能进入已分配的企业空间。</span></div><a className="secondary-link" href="/projects">返回企业空间 →</a></section><MemberManager /></AppShell>;
}
