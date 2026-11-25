import { ModuleHeader } from "../../components/ModuleHeader";
import { AppShell } from "../../components/AppShell";
import { MemberManager } from "../../components/MemberManager";

export default function MembersPage() {
  return <AppShell activePath="/members"><ModuleHeader title="成员与权限" actions={<a className="secondary-link" href="/projects">返回企业空间 →</a>} /><MemberManager /></AppShell>;
}
