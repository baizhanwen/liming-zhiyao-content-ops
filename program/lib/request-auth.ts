import { env } from "cloudflare:workers";
import { readLocalSessionIdentity } from "./local-auth";

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
  TRUST_FORWARDED_IDENTITY?: string;
  DELIVERY_MODE?: string;
  LAN_MODE?: string;
  LAN_ACCESS_ORIGIN?: string;
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

export async function readRequestIdentity(request: Request): Promise<RequestIdentity | null> {
  const localSession = await readLocalSessionIdentity(request);
  if (localSession) return localSession;

  const runtime = env as LocalAuthEnv;
  // A client controls the URL/Host; a loopback hostname does not prove that a
  // request reached a LAN listener from the host machine. LAN always requires
  // a database-backed session, including when old development/proxy flags remain.
  if (runtime.LAN_MODE?.trim() === "1" || runtime.LAN_ACCESS_ORIGIN?.trim()) return null;
  // Platform identity headers are safe only behind a trusted proxy that strips
  // client-supplied values. LAN mode talks to this worker directly, so accepting
  // them by default would allow another device to impersonate any account.
  if (runtime.TRUST_FORWARDED_IDENTITY?.trim() === "1") {
    const forwarded = readForwardedIdentity(request);
    if (forwarded) return forwarded;
  }

  if (runtime.DELIVERY_MODE?.trim() === "1") return null;
  if (runtime.LOCAL_DEV_AUTH?.trim() !== "1" || !isLoopbackRequest(request)) return null;

  const authSubject = runtime.LOCAL_DEV_USER_ID?.trim() || "local-owner";
  const email = runtime.LOCAL_DEV_USER_EMAIL?.trim().toLowerCase() || "local-owner@localhost";
  const displayName = runtime.LOCAL_DEV_USER_NAME?.trim() || "本地管理员";
  return { authSubject, email, displayName };
}
