import { create } from "zustand";
import { onOpenUrl } from "@tauri-apps/plugin-deep-link";
import {
  AuthUser,
  authUrl,
  clearToken,
  createLoginSession,
  decodeJwt,
  getToken,
  isExpired,
  pollLoginSession,
  saveToken,
  tokenFromDeepLink,
} from "../lib/auth";
import { openExternal } from "../lib/github";
import { isTauri } from "../lib/git";

type AuthStatus = "loading" | "signedOut" | "signingIn" | "signedIn";

type AuthStore = {
  status: AuthStatus;
  token: string | null;
  user: AuthUser | null;
  error: string | null;
  /** Load the saved token on launch and register the deep-link listener. */
  init: () => Promise<void>;
  /** Begin the browser OAuth flow (deep-link primary, long-poll fallback). */
  startLogin: () => Promise<void>;
  /** Abandon an in-flight login. */
  cancelLogin: () => void;
  /** Sign out and clear the persisted token. */
  logout: () => Promise<void>;
};

export const useAuthStore = create<AuthStore>((set, get) => {
  // Per-flow state kept outside the store snapshot.
  let finishing = false;
  let deepLinkReady = false;

  /** A token arrived (deep link or poll); the first one wins. */
  async function finish(token: string): Promise<void> {
    if (finishing || get().status === "signedIn") return;
    finishing = true;
    try {
      const user = decodeJwt(token);
      if (isExpired(user)) {
        throw new Error("Received an expired token. Please try again.");
      }
      await saveToken(token);
      set({ status: "signedIn", token, user, error: null });
    } catch (e) {
      set({ status: "signedOut", error: String(e) });
    } finally {
      finishing = false;
    }
  }

  /** Register the deep-link callback listener exactly once. */
  async function ensureDeepLink(): Promise<void> {
    if (deepLinkReady || !isTauri()) return;
    deepLinkReady = true;
    try {
      await onOpenUrl((urls) => {
        for (const url of urls) {
          const token = tokenFromDeepLink(url);
          if (token) void finish(token);
        }
      });
    } catch {
      // Deep links unavailable (e.g. unregistered scheme); poll still works.
    }
  }

  return {
    status: "loading",
    token: null,
    user: null,
    error: null,

    init: async () => {
      await ensureDeepLink();
      try {
        const token = await getToken();
        const user = token ? decodeJwt(token) : null;
        if (token && user && !isExpired(user)) {
          set({ status: "signedIn", token, user });
        } else {
          if (token) await clearToken(); // stale/expired
          set({ status: "signedOut", token: null, user: null });
        }
      } catch (e) {
        set({ status: "signedOut", error: String(e) });
      }
    },

    startLogin: async () => {
      if (get().status === "signingIn") return;
      finishing = false;
      set({ status: "signingIn", error: null });
      await ensureDeepLink();

      let sessionId: string;
      try {
        sessionId = await createLoginSession();
      } catch (e) {
        set({ status: "signedOut", error: String(e) });
        return;
      }

      await openExternal(authUrl(sessionId));

      // Long-poll fallback: runs alongside the deep-link listener. Whichever
      // delivers the token first wins (guarded by `finishing` in finish()).
      void (async () => {
        while (get().status === "signingIn" && !finishing) {
          try {
            const token = await pollLoginSession(sessionId);
            if (token) {
              await finish(token);
              return;
            }
          } catch (e) {
            if (get().status === "signingIn") {
              set({ status: "signedOut", error: String(e) });
            }
            return;
          }
        }
      })();
    },

    cancelLogin: () => {
      if (get().status !== "signingIn") return;
      finishing = true; // stop the poll loop and ignore late tokens
      set({ status: "signedOut", error: null });
    },

    logout: async () => {
      try {
        await clearToken();
      } catch {
        // Best effort — still drop local state.
      }
      finishing = false;
      set({ status: "signedOut", token: null, user: null, error: null });
    },
  };
});
