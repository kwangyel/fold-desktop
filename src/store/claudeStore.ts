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
  let inflightRefresh: Promise<void> | null = null;
  let checkedAt = 0;

  function stopPolling() {
    if (pollTimer) {
      clearInterval(pollTimer);
      pollTimer = null;
    }
  }

  function clearKickoff() {
    if (loginKickoffTimer) {
      clearTimeout(loginKickoffTimer);
      loginKickoffTimer = null;
    }
  }

  function resetFlow() {
    stopPolling();
    clearKickoff();
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
    clearKickoff();
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
          : "Claude login finished but no credentials were found.",
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
          const status = await claudeStatus();
          checkedAt = Date.now();
          set({
            installed: status.installed,
            authenticated: status.authenticated,
            method: status.method,
            checking: false,
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

      const onOutput = (chunk: ClaudeOutput) => {
        if (!get().connecting) return;
        const bytes = decode(chunk);
        emitOutput(bytes);

        // Best-effort success detection from TUI text (polling is the source of truth).
        const text = new TextDecoder().decode(bytes).replace(ANSI_RE, "");
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
        // Kick off the slash-command login once the Ink TUI has had time to boot.
        loginKickoffTimer = setTimeout(() => {
          void claudeLoginWrite("/login\r");
        }, 800);

        pollTimer = setInterval(() => {
          void (async () => {
            if (!get().connecting || finishing) return;
            const status = await claudeStatus();
            if (status.authenticated) void finish();
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
