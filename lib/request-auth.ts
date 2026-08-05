export type RequestIdentity = {
  authSubject: string;
  email: string;
  displayName: string;
};

export function readRequestIdentity(request: Request): RequestIdentity | null {
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
