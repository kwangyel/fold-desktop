import { create } from "zustand";
import {
  ClaudeOutput,
  claudeLogin,
  claudeLoginCancel,
  claudeLoginWrite,
  claudeReleaseLoginChannel,
  claudeStatus,
} from "../lib/claude";
import { openExternal } from "../lib/github";

export const CLAUDE_INSTALL_URL =
  "https://docs.anthropic.com/en/docs/claude-code/setup";

// Strip ANSI escape sequences so status regex matching sees plain text.
// eslint-disable-next-line no-control-regex
const ANSI_RE = /\x1b\[[0-9;?]*[A-Za-z]/g;

/**
 * Claude Code's Ink TUI is ready for slash commands once the welcome /
 * prompt chrome appears. Cold starts routinely take 1.5–4s; a fixed timer
 * fires into a not-yet-ready readline and the keystroke is swallowed.
 */
const TUI_READY_RE =
  /(?:Welcome to Claude|\/help for help|❯|›|Type a (?:message|command)|What (?:can I|would you like)|Press (?:up|Enter|Ctrl))/i;

/** Signals that `/login` actually started (browser / method picker / OAuth). */
const LOGIN_UI_RE =
  /(?:Select login|Log in with|Sign in|Login method|browser|oauth|authorization|authenticate|console\.anthropic|claude\.ai\/login|Waiting for|Open this URL|Visit (?:this|the) (?:URL|link))/i;

/** One retry if the first `/login` was swallowed by a trust/theme prompt. */
const LOGIN_RETRY_MS = 5_000;
/** Absolute ceiling — never leave the UI on "Waiting for authorization…" forever. */
const LOGIN_HARD_TIMEOUT_MS = 120_000;
/** Fallback kickoff when readiness text never matches (unusual theme / locale). */
const LOGIN_FALLBACK_MS = 4_000;

type ClaudeStore = {
  installed: boolean;
  authenticated: boolean;
  method: string | null;
  /** Initial status check in flight. */
  checking: boolean;
  /** Login PTY flow is running. */
  connecting: boolean;
  error: string | null;
  /** Latest login-terminal output chunk listeners (xterm write). */
  subscribeLoginOutput: (listener: (data: Uint8Array) => void) => () => void;
  refresh: (opts?: { force?: boolean }) => Promise<void>;
  startLogin: () => Promise<void>;
  writeLogin: (data: string) => Promise<void>;
  cancelLogin: () => Promise<void>;
  openInstallDocs: () => Promise<void>;
};

/** Reuse a recent status check unless the user explicitly rechecks. */
const STATUS_TTL_MS = 15_000;

function decode(chunk: ClaudeOutput): Uint8Array {
  return chunk instanceof Uint8Array ? chunk : new Uint8Array(chunk);
}

export const useClaudeStore = create<ClaudeStore>((set, get) => {
  const outputListeners = new Set<(data: Uint8Array) => void>();
  let pollTimer: ReturnType<typeof setInterval> | null = null;
  let finishing = false;
  let loginKickoffTimer: ReturnType<typeof setTimeout> | null = null;
  let loginRetryTimer: ReturnType<typeof setTimeout> | null = null;
  let loginHardTimer: ReturnType<typeof setTimeout> | null = null;
  let inflightRefresh: Promise<void> | null = null;
  let checkedAt = 0;

  function stopPolling() {
    if (pollTimer) {
      clearInterval(pollTimer);
      pollTimer = null;
    }
  }

  function clearLoginTimers() {
    if (loginKickoffTimer) {
      clearTimeout(loginKickoffTimer);
      loginKickoffTimer = null;
    }
    if (loginRetryTimer) {
      clearTimeout(loginRetryTimer);
      loginRetryTimer = null;
    }
    if (loginHardTimer) {
      clearTimeout(loginHardTimer);
      loginHardTimer = null;
    }
  }

  function resetFlow() {
    stopPolling();
    clearLoginTimers();
    finishing = false;
    claudeReleaseLoginChannel();
  }

  function emitOutput(bytes: Uint8Array) {
    for (const listener of outputListeners) {
      listener(bytes);
    }
  }

  async function finish() {
    if (finishing || !get().connecting) return;
    finishing = true;
    stopPolling();
    clearLoginTimers();
    try {
      const status = await claudeStatus();
      checkedAt = Date.now();
      set({
        installed: status.installed,
        authenticated: status.authenticated,
        method: status.method,
        connecting: false,
        error: status.authenticated
          ? null
          : (status.credentialError ??
            "Claude login finished but no credentials were found."),
      });
      // Drop the login PTY once credentials are confirmed.
      await claudeLoginCancel();
    } catch (e) {
      set({ connecting: false, error: String(e) });
    } finally {
      claudeReleaseLoginChannel();
      finishing = false;
    }
  }

  async function failLogin(message: string) {
    if (!get().connecting || finishing) return;
    resetFlow();
    try {
      await claudeLoginCancel();
    } catch {
      // Best-effort — the PTY may already be gone.
    }
    set({ connecting: false, error: message });
  }

  return {
    installed: false,
    authenticated: false,
    method: null,
    checking: false,
    connecting: false,
    error: null,

    subscribeLoginOutput: (listener) => {
      outputListeners.add(listener);
      return () => {
        outputListeners.delete(listener);
      };
    },

    refresh: async (opts) => {
      const force = opts?.force ?? false;
      if (!force && checkedAt && Date.now() - checkedAt < STATUS_TTL_MS) {
        return;
      }
      if (inflightRefresh) return inflightRefresh;

      inflightRefresh = (async () => {
        set({ checking: true, error: null });
        try {
          const status = await claudeStatus(force);
          checkedAt = Date.now();
          set({
            installed: status.installed,
            authenticated: status.authenticated,
            method: status.method,
            checking: false,
            // Surface keychain ACL failures instead of a silent "not connected".
            error:
              !status.authenticated && status.credentialError
                ? status.credentialError
                : null,
          });
        } catch (e) {
          set({ error: String(e), checking: false });
        } finally {
          inflightRefresh = null;
        }
      })();

      return inflightRefresh;
    },

    startLogin: async () => {
      if (get().connecting) return;
      resetFlow();
      set({ connecting: true, error: null });

      let loginSent = false;
      let loginUiSeen = false;
      let outputSoFar = "";

      const sendLogin = () => {
        if (!get().connecting || loginUiSeen) return;
        void claudeLoginWrite("/login\r");
        loginSent = true;
      };

      const onOutput = (chunk: ClaudeOutput) => {
        if (!get().connecting) return;
        const bytes = decode(chunk);
        emitOutput(bytes);

        const text = new TextDecoder().decode(bytes).replace(ANSI_RE, "");
        outputSoFar += text;

        if (LOGIN_UI_RE.test(outputSoFar)) {
          loginUiSeen = true;
          if (loginRetryTimer) {
            clearTimeout(loginRetryTimer);
            loginRetryTimer = null;
          }
        } else if (!loginSent && TUI_READY_RE.test(outputSoFar)) {
          // Prompt is up — type `/login` now, and once more if no login UI
          // appears (first keystroke often lands in a trust/theme dialog).
          sendLogin();
          loginRetryTimer = setTimeout(() => {
            if (!get().connecting || loginUiSeen) return;
            sendLogin();
          }, LOGIN_RETRY_MS);
        }

        // Best-effort success detection from TUI text (polling is the source of truth).
        if (/Logged in|login successful|Authentication successful/i.test(text)) {
          void (async () => {
            if (!get().connecting || finishing) return;
            const status = await claudeStatus();
            if (status.authenticated) void finish();
          })();
        }
      };

      try {
        await claudeLogin(onOutput);

        // If readiness text never matches, still attempt `/login` once.
        loginKickoffTimer = setTimeout(() => {
          if (!loginSent && get().connecting) sendLogin();
        }, LOGIN_FALLBACK_MS);

        loginHardTimer = setTimeout(() => {
          void failLogin(
            "Claude login timed out. Try again, or run `claude` in a terminal and type /login.",
          );
        }, LOGIN_HARD_TIMEOUT_MS);

        pollTimer = setInterval(() => {
          void (async () => {
            if (!get().connecting || finishing) return;
            const status = await claudeStatus();
            if (status.authenticated) {
              void finish();
              return;
            }
            // Keychain ACL denial will never flip authenticated — abort with
            // an actionable error instead of spinning until the hard timeout.
            if (status.credentialError) {
              void failLogin(status.credentialError);
            }
          })();
        }, 2000);
      } catch (e) {
        resetFlow();
        set({ connecting: false, error: String(e) });
      }
    },

    writeLogin: async (data) => {
      if (!get().connecting) return;
      await claudeLoginWrite(data);
    },

    cancelLogin: async () => {
      resetFlow();
      set({ connecting: false });
      await claudeLoginCancel();
    },

    openInstallDocs: async () => {
      await openExternal(CLAUDE_INSTALL_URL);
    },
  };
});
