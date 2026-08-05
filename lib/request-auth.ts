import { env } from "cloudflare:workers";

export type RequestIdentity = {
  authSubject: string;
  email: string;
  displayName: string;
};

type LocalAuthEnv = typeof env & {
  LOCAL_DEV_AUTH?: string;
  LOCAL_DEV_USER_ID?: string;
  LOCAL_DEV_USER_EMAIL?: string;
  LOCAL_DEV_USER_NAME?: string;
};

function isLoopbackRequest(request: Request) {
  try {
    const hostname = new URL(request.url).hostname.toLowerCase();
    return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]";
  } catch {
    return false;
  }
}

function readForwardedIdentity(request: Request): RequestIdentity | null {
  const authSubject = request.headers.get("oai-authenticated-user-id")?.trim();
  const email = request.headers.get("oai-authenticated-user-email")?.trim().toLowerCase();
  if (!authSubject || !email) return null;

  const encodedName = request.headers.get("oai-authenticated-user-full-name");
  const encoding = request.headers.get("oai-authenticated-user-full-name-encoding");
  let fullName: string | null = null;
  if (encodedName && encoding === "percent-encoded-utf-8") {
    try { fullName = decodeURIComponent(encodedName); } catch { fullName = null; }
  }

  return { authSubject, email, displayName: fullName?.trim() || email };
}

export function readRequestIdentity(request: Request): RequestIdentity | null {
  const forwarded = readForwardedIdentity(request);
  if (forwarded) return forwarded;

  const runtime = env as LocalAuthEnv;
  if (runtime.LOCAL_DEV_AUTH?.trim() !== "1" || !isLoopbackRequest(request)) return null;

  const authSubject = runtime.LOCAL_DEV_USER_ID?.trim() || "local-owner";
  const email = runtime.LOCAL_DEV_USER_EMAIL?.trim().toLowerCase() || "local-owner@localhost";
  const displayName = runtime.LOCAL_DEV_USER_NAME?.trim() || "本地管理员";
  return { authSubject, email, displayName };
}
