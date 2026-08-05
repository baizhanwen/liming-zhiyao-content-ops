import { LoginForm } from "../../components/LoginForm";

export default async function LoginPage({ searchParams }: { searchParams: Promise<{ returnTo?: string }> }) {
  const query = await searchParams;
  const returnTo = query.returnTo?.startsWith("/") && !query.returnTo.startsWith("//") ? query.returnTo : "/";
  return <main className="login-page"><LoginForm returnTo={returnTo} /></main>;
}
