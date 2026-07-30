import { create } from "zustand";
import {
  GhOutput,
  ghAuthCancel,
  ghAuthLogin,
  ghAuthLogout,
  ghAuthReleaseChannel,
  ghAuthStatus,
  openExternal,
} from "../lib/github";

/** GitHub device-code shape, e.g. `ABCD-1234`. */
const CODE_RE = /\b[A-Z0-9]{4}-[A-Z0-9]{4}\b/;
const SUCCESS_RE =
  /Authentication complete|Logged in as|Logged in to github\.com/;
/** Sentinel emitted by the Rust monitor when the `gh` child exits. */
const EXIT_RE = /__GH_EXIT__:(-?\d+)/;
const DEVICE_URL = "https://github.com/login/device";

type GithubStore = {
  authenticated: boolean;
  username: string | null;
  /** Initial status check in flight. */
  checking: boolean;
  /** Login flow is running (waiting for browser authorization). */
  connecting: boolean;
  /** One-time device code to show the user, once parsed from gh output. */
  code: string | null;
  /** Logout in flight. */
  disconnecting: boolean;
  error: string | null;
  refresh: () => Promise<void>;
  startLogin: () => Promise<void>;
  cancelLogin: () => Promise<void>;
  logout: () => Promise<void>;
};

function decode(chunk: GhOutput): string {
  const bytes = chunk instanceof Uint8Array ? chunk : new Uint8Array(chunk);
  return new TextDecoder().decode(bytes);
}

// Strip ANSI escape sequences so regex matching sees plain text.
// eslint-disable-next-line no-control-regex
const ANSI_RE = /\x1b\[[0-9;?]*[A-Za-z]/g;

export const useGithubStore = create<GithubStore>((set, get) => {
  // Per-flow mutable state kept outside the store snapshot.
  let buffer = "";
  let pollTimer: ReturnType<typeof setInterval> | null = null;
  let browserOpened = false;
  let finishing = false;

  function stopPolling() {
    if (pollTimer) {
      clearInterval(pollTimer);
      pollTimer = null;
    }
  }

  function resetFlow() {
    stopPolling();
    browserOpened = false;
    buffer = "";
    finishing = false;
    ghAuthReleaseChannel();
  }

  // Called once credentials are known to be persisted. We deliberately do NOT
  // kill the gh process here — it must finish on its own so credentials fully
  // persist. The backend monitor reaps it when it exits.
  async function finish() {
    if (finishing || !get().connecting) return;
    finishing = true;
    stopPolling();
    try {
      const status = await ghAuthStatus();
      set({
        authenticated: status.authenticated,
        username: status.username,
        connecting: false,
        code: null,
        error: status.authenticated
          ? null
          : "GitHub login finished but no credentials were found.",
      });
    } catch (e) {
      set({ connecting: false, code: null, error: String(e) });
    } finally {
      ghAuthReleaseChannel();
      finishing = false;
      browserOpened = false;
      buffer = "";
    }
  }

  return {
    authenticated: false,
    username: null,
    checking: false,
    connecting: false,
    code: null,
    disconnecting: false,
    error: null,

    refresh: async () => {
      set({ checking: true, error: null });
      try {
        const status = await ghAuthStatus();
        set({
          authenticated: status.authenticated,
          username: status.username,
          checking: false,
        });
      } catch (e) {
        set({ error: String(e), checking: false });
      }
    },

    startLogin: async () => {
      if (get().connecting) return;
      resetFlow();
      set({ connecting: true, code: null, error: null });

      const onOutput = (chunk: GhOutput) => {
        if (!get().connecting) return;
        buffer += decode(chunk).replace(ANSI_RE, "");

        if (!get().code) {
          const match = buffer.match(CODE_RE);
          if (match) set({ code: match[0] });
        }

        // Once we have the code, open the device page in the browser and start
        // polling for authorization. gh polls on its own; we poll too so the UI
        // updates promptly. Guard so this only runs once.
        if (get().code && !browserOpened) {
          browserOpened = true;
          void openExternal(DEVICE_URL);
          pollTimer = setInterval(() => {
            void (async () => {
              if (!get().connecting || finishing) return;
              const status = await ghAuthStatus();
              if (status.authenticated) void finish();
            })();
          }, 2000);
        }

        // Fast path: gh printed a success line — check status immediately
        // instead of waiting for the next poll tick.
        if (SUCCESS_RE.test(buffer)) {
          void (async () => {
            if (!get().connecting || finishing) return;
            const status = await ghAuthStatus();
            if (status.authenticated) void finish();
          })();
        }

        // Process exited — if we never authenticated, surface an error (unless
        // the user already cancelled, in which case connecting is false).
        const exitMatch = buffer.match(EXIT_RE);
        if (exitMatch) {
          if (finishing || !get().connecting) return;
          const code = Number(exitMatch[1]);
          // Cancel sends -1; treat as a quiet stop.
          if (code === -1) {
            resetFlow();
            set({ connecting: false, code: null });
            return;
          }
          void (async () => {
            const status = await ghAuthStatus();
            if (status.authenticated) {
              void finish();
              return;
            }
            resetFlow();
            set({
              connecting: false,
              code: null,
              error:
                code === 0
                  ? "GitHub login ended without completing authorization."
                  : `GitHub login failed (exit ${code}). Is the gh CLI installed?`,
            });
          })();
        }
      };

      try {
        await ghAuthLogin(onOutput);
      } catch (e) {
        resetFlow();
        set({ connecting: false, code: null, error: String(e) });
      }
    },

    cancelLogin: async () => {
      resetFlow();
      set({ connecting: false, code: null });
      await ghAuthCancel();
    },

    logout: async () => {
      if (get().disconnecting) return;
      set({ disconnecting: true, error: null });
      try {
        await ghAuthLogout();
        set({ authenticated: false, username: null, disconnecting: false });
      } catch (e) {
        set({ error: String(e), disconnecting: false });
      }
    },
  };
});
