import { AcceptInvitation } from "../../components/AcceptInvitation";

export default async function AcceptInvitationPage({ searchParams }: { searchParams: Promise<{ token?: string }> }) {
  const { token = "" } = await searchParams;
  return <main className="invitation-page"><AcceptInvitation token={token} /></main>;
}
