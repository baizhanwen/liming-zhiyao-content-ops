import { getD1, sha256Hex } from "../db/runtime";
import type { RequestIdentity } from "./request-auth";

const sessionCookieName = "liming_session";
const passwordIterations = 210_000;
const sessionLifetimeSeconds = 7 * 24 * 60 * 60;
const loginFailureLimit = 5;
const loginLockSeconds = 15 * 60;

type CredentialRow = {
  user_id: string;
  email: string;
  display_name: string | null;
  password_salt: string;
  password_hash: string;
  iterations: number;
};

function bytesToBase64Url(bytes: Uint8Array) {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
}

function base64UrlToBytes(value: string) {
  const padded = value.replaceAll("-", "+").replaceAll("_", "/").padEnd(Math.ceil(value.length / 4) * 4, "=");
  const binary = atob(padded);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

function randomToken(size = 32) {
  const bytes = new Uint8Array(size);
  crypto.getRandomValues(bytes);
  return bytesToBase64Url(bytes);
}

async function derivePassword(password: string, salt: Uint8Array, iterations: number) {
  const keyMaterial = await crypto.subtle.importKey("raw", new TextEncoder().encode(password), "PBKDF2", false, ["deriveBits"]);
  const saltBuffer = Uint8Array.from(salt).buffer;
  const bits = await crypto.subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt: saltBuffer, iterations }, keyMaterial, 256);
  return bytesToBase64Url(new Uint8Array(bits));
}

export async function createLocalCredential(userId: string, password: string, now = new Date().toISOString()) {
  const salt = new Uint8Array(16);
  crypto.getRandomValues(salt);
  return {
    userId,
    passwordSalt: bytesToBase64Url(salt),
    passwordHash: await derivePassword(password, salt, passwordIterations),
    iterations: passwordIterations,
    now,
  };
}

async function passwordMatches(row: Pick<CredentialRow, "password_salt" | "password_hash" | "iterations">, password: string) {
  const candidate = await derivePassword(password, base64UrlToBytes(row.password_salt), row.iterations);
  if (candidate.length !== row.password_hash.length) return false;
  let mismatch = 0;
  for (let index = 0; index < candidate.length; index += 1) mismatch |= candidate.charCodeAt(index) ^ row.password_hash.charCodeAt(index);
  return mismatch === 0;
}

export function validateLocalPassword(password: string) {
  if (password.length < 10) return "密码至少需要 10 个字符。";
  if (password.length > 128) return "密码不能超过 128 个字符。";
  return null;
}

export async function setLocalPassword(userId: string, password: string) {
  const credential = await createLocalCredential(userId, password);
  await getD1().prepare(`
    INSERT INTO local_credentials (user_id, password_salt, password_hash, iterations, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(user_id) DO UPDATE SET password_salt = excluded.password_salt, password_hash = excluded.password_hash,
      iterations = excluded.iterations, updated_at = excluded.updated_at
  `).bind(credential.userId, credential.passwordSalt, credential.passwordHash, credential.iterations, credential.now, credential.now).run();
}

export async function verifyLocalLogin(email: string, password: string) {
  const row = await getD1().prepare(`
    SELECT u.id AS user_id, u.email, u.display_name, c.password_salt, c.password_hash, c.iterations
    FROM users u INNER JOIN local_credentials c ON c.user_id = u.id
    WHERE lower(u.email) = ? AND u.status = 'active'
  `).bind(email.toLowerCase()).first<CredentialRow>();
  if (!row) return null;
  return await passwordMatches(row, password) ? row : null;
}

export async function hasLocalPassword(userId: string) {
  const row = await getD1().prepare("SELECT 1 AS configured FROM local_credentials WHERE user_id = ?").bind(userId).first<{ configured: number }>();
  return Boolean(row?.configured);
}

export async function verifyLocalPasswordForUser(userId: string, password: string) {
  const row = await getD1().prepare("SELECT password_salt, password_hash, iterations FROM local_credentials WHERE user_id = ?")
    .bind(userId).first<Pick<CredentialRow, "password_salt" | "password_hash" | "iterations">>();
  return row ? passwordMatches(row, password) : false;
}

export async function readLocalLoginLock(email: string) {
  const row = await getD1().prepare("SELECT locked_until FROM local_login_attempts WHERE email = ?").bind(email.toLowerCase()).first<{ locked_until: string | null }>();
  if (!row?.locked_until) return null;
  const remainingSeconds = Math.ceil((new Date(row.locked_until).getTime() - Date.now()) / 1000);
  return remainingSeconds > 0 ? remainingSeconds : null;
}

export async function recordLocalLoginFailure(email: string) {
  const normalizedEmail = email.toLowerCase();
  const now = new Date();
  const lockedUntil = new Date(now.getTime() + loginLockSeconds * 1000).toISOString();
  // Count in SQLite rather than overwriting a value read before other requests.
  // Attempts already in flight cannot extend an existing lock indefinitely.
  const row = await getD1().prepare(`
    INSERT INTO local_login_attempts (email, failed_count, locked_until, updated_at) VALUES (?, ?, ?, ?)
    ON CONFLICT(email) DO UPDATE SET
      failed_count = CASE
        WHEN local_login_attempts.locked_until > excluded.updated_at THEN local_login_attempts.failed_count + 1
        WHEN local_login_attempts.locked_until IS NOT NULL THEN 1
        ELSE local_login_attempts.failed_count + 1 END,
      locked_until = CASE
        WHEN local_login_attempts.locked_until > excluded.updated_at THEN local_login_attempts.locked_until
        WHEN local_login_attempts.locked_until IS NOT NULL THEN NULL
        WHEN local_login_attempts.failed_count + 1 >= ? THEN ?
        ELSE NULL END,
      updated_at = excluded.updated_at
    RETURNING locked_until
  `).bind(normalizedEmail, 1, null, now.toISOString(), loginFailureLimit, lockedUntil).first<{ locked_until: string | null }>();
  return row?.locked_until ? Math.max(1, Math.ceil((Date.parse(row.locked_until) - Date.now()) / 1000)) : null;
}

export async function clearLocalLoginFailures(email: string, attemptStartedAt = new Date().toISOString()) {
  // A successful, older request must not erase failures recorded while it was
  // verifying a password, or clear a lock established by those requests.
  await getD1().prepare("DELETE FROM local_login_attempts WHERE email = ? AND updated_at < ? AND (locked_until IS NULL OR locked_until <= ?)")
    .bind(email.toLowerCase(), attemptStartedAt, attemptStartedAt).run();
}

export async function revokeAllLocalSessions(userId: string) {
  await getD1().prepare("DELETE FROM local_sessions WHERE user_id = ?").bind(userId).run();
}

export async function createLocalSession(userId: string, request: Request) {
  const token = randomToken();
  const tokenHash = await sha256Hex(new TextEncoder().encode(token));
  const now = new Date();
  const expiresAt = new Date(now.getTime() + sessionLifetimeSeconds * 1000);
  await getD1().batch([
    getD1().prepare("DELETE FROM local_sessions WHERE expires_at <= ?").bind(now.toISOString()),
    getD1().prepare("INSERT INTO local_sessions (id, user_id, token_hash, expires_at, last_seen_at, created_at) VALUES (?, ?, ?, ?, ?, ?)")
      .bind(crypto.randomUUID(), userId, tokenHash, expiresAt.toISOString(), now.toISOString(), now.toISOString()),
  ]);
  const secure = new URL(request.url).protocol === "https:" ? "; Secure" : "";
  return `${sessionCookieName}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${sessionLifetimeSeconds}${secure}`;
}

export function readSessionToken(request: Request) {
  const cookie = request.headers.get("cookie") ?? "";
  for (const part of cookie.split(";")) {
    const [name, ...value] = part.trim().split("=");
    if (name === sessionCookieName) return value.join("=").trim();
  }
  return "";
}

export async function readLocalSessionIdentity(request: Request): Promise<RequestIdentity | null> {
  const token = readSessionToken(request);
  if (!token) return null;
  const tokenHash = await sha256Hex(new TextEncoder().encode(token));
  const row = await getD1().prepare(`
    SELECT u.auth_subject, u.email, u.display_name
    FROM local_sessions s INNER JOIN users u ON u.id = s.user_id
    WHERE s.token_hash = ? AND s.expires_at > ? AND u.status = 'active'
  `).bind(tokenHash, new Date().toISOString()).first<{ auth_subject: string; email: string; display_name: string | null }>();
  return row ? { authSubject: row.auth_subject, email: row.email, displayName: row.display_name || row.email } : null;
}

export async function revokeLocalSession(request: Request) {
  const token = readSessionToken(request);
  if (token) await getD1().prepare("DELETE FROM local_sessions WHERE token_hash = ?").bind(await sha256Hex(new TextEncoder().encode(token))).run();
  const secure = new URL(request.url).protocol === "https:" ? "; Secure" : "";
  return `${sessionCookieName}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${secure}`;
}
