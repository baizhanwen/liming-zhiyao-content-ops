import { AppShell } from "../../components/AppShell";
import { MemberManager } from "../../components/MemberManager";

export default function MembersPage() {
  return <AppShell activePath="/members"><section className="page-heading management-heading"><div><p>平台地基 · 服务端鉴权</p><h1>成员与权限</h1><span>公司角色控制全局范围，项目角色控制具体客户空间。</span></div><a className="secondary-link" href="/projects">返回客户项目 →</a></section><MemberManager /></AppShell>;
}
