import { invoke } from "@tauri-apps/api/core";
import { fetch } from "@tauri-apps/plugin-http";
import { isTauri } from "./git";

/** Base URL of the Fold backend that owns the GitHub OAuth flow. */
export const API_BASE = "https://fold.optulus.com";

/** Decoded payload of the backend-issued JWT. */
export interface AuthUser {
  /** User id (JWT `sub`). */
  id: string;
  email: string | null;
  githubUsername: string | null;
  /** Profile photo URL saved at login (GitHub OAuth `profile.photos[0]`). */
  avatarUrl: string | null;
  /** Expiry, seconds since epoch. */
  exp: number | null;
}

/** Best avatar URL for a signed-in user: saved photo, then GitHub username. */
export function resolveUserAvatarUrl(user: AuthUser): string | null {
  const saved = user.avatarUrl?.trim();
  if (saved) return saved;
  if (user.githubUsername) {
    return `https://avatars.githubusercontent.com/${encodeURIComponent(user.githubUsername)}?s=64`;
  }
  return null;
}

/**
 * Create a login session on the backend and return its id. The id is passed to
 * `/auth/github` as `?session_id=` so the token can be retrieved by long-poll
 * (fallback for when the deep-link callback doesn't reach the app).
 */
export async function createLoginSession(): Promise<string> {
  const res = await fetch(`${API_BASE}/auth/github/session`, { method: "POST" });
  if (!res.ok) {
    throw new Error(`Failed to start login session (HTTP ${res.status}).`);
  }
  const data = (await res.json()) as { session_id?: string };
  if (!data.session_id) throw new Error("Login session response missing session_id.");
  return data.session_id;
}

/**
 * Long-poll for the token belonging to `sessionId`. Resolves with the token
 * once the OAuth callback completes, `null` on a `pending` timeout (caller
 * re-polls), and throws if the session is unknown/expired (HTTP 404).
 */
export async function pollLoginSession(
  sessionId: string,
  timeoutMs = 25_000,
): Promise<string | null> {
  const res = await fetch(
    `${API_BASE}/auth/github/session/${encodeURIComponent(sessionId)}/poll?timeout_ms=${timeoutMs}`,
    { method: "GET" },
  );
  if (res.status === 404) {
    throw new Error("Login session expired. Please try again.");
  }
  if (!res.ok) {
    throw new Error(`Login poll failed (HTTP ${res.status}).`);
  }
  const data = (await res.json()) as { access_token?: string; status?: string };
  return data.access_token ?? null;
}

/** Browser URL that starts the GitHub OAuth flow for a given session. */
export function authUrl(sessionId: string): string {
  return `${API_BASE}/auth/github?session_id=${encodeURIComponent(sessionId)}`;
}

/** Extract the `access_token` from a `com.fold.dev://auth/callback?...` deep link. */
export function tokenFromDeepLink(url: string): string | null {
  try {
    const parsed = new URL(url);
    return parsed.searchParams.get("access_token");
  } catch {
    return null;
  }
}

/** Decode the JWT payload (no signature check — display only). */
export function decodeJwt(token: string): AuthUser | null {
  const parts = token.split(".");
  if (parts.length < 2) return null;
  try {
    const base64 = parts[1].replace(/-/g, "+").replace(/_/g, "/");
    const json = decodeURIComponent(
      atob(base64)
        .split("")
        .map((c) => "%" + c.charCodeAt(0).toString(16).padStart(2, "0"))
        .join(""),
    );
    const payload = JSON.parse(json) as {
      sub?: string;
      email?: string;
      githubUsername?: string;
      github_username?: string;
      avatarUrl?: string;
      avatar_url?: string;
      exp?: number;
    };
    return {
      id: payload.sub ?? "",
      email: payload.email ?? null,
      githubUsername: payload.githubUsername ?? payload.github_username ?? null,
      avatarUrl: payload.avatarUrl ?? payload.avatar_url ?? null,
      exp: payload.exp ?? null,
    };
  } catch {
    return null;
  }
}

/** True when the token has an `exp` in the past. */
export function isExpired(user: AuthUser | null): boolean {
  return !!user?.exp && user.exp * 1000 <= Date.now();
}

// --- Persistence (Rust-backed) ----------------------------------------------

export async function saveToken(token: string): Promise<void> {
  if (!isTauri()) return;
  await invoke("auth_save_token", { token });
}

export async function getToken(): Promise<string | null> {
  if (!isTauri()) return null;
  return invoke<string | null>("auth_get_token");
}

export async function clearToken(): Promise<void> {
  if (!isTauri()) return;
  await invoke("auth_clear_token");
}
