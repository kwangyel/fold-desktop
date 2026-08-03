import { create } from "zustand";
import {
  CodexOutput,
  codexLogin,
  codexLoginCancel,
  codexLoginWrite,
  codexReleaseLoginChannel,
  codexStatus,
} from "../lib/codex";
import { openExternal } from "../lib/github";

export const CODEX_INSTALL_URL =
  "https://developers.openai.com/codex/cli";

// eslint-disable-next-line no-control-regex
const ANSI_RE = /\x1b\[[0-9;?]*[A-Za-z]/g;

type CodexStore = {
  installed: boolean;
  authenticated: boolean;
  method: string | null;
  checking: boolean;
  connecting: boolean;
  error: string | null;
  subscribeLoginOutput: (listener: (data: Uint8Array) => void) => () => void;
  refresh: () => Promise<void>;
  startLogin: () => Promise<void>;
  writeLogin: (data: string) => Promise<void>;
  cancelLogin: () => Promise<void>;
  openInstallDocs: () => Promise<void>;
};

function decode(chunk: CodexOutput): Uint8Array {
  return chunk instanceof Uint8Array ? chunk : new Uint8Array(chunk);
}

export const useCodexStore = create<CodexStore>((set, get) => {
  const outputListeners = new Set<(data: Uint8Array) => void>();
  let pollTimer: ReturnType<typeof setInterval> | null = null;
  let finishing = false;

  function stopPolling() {
    if (pollTimer) {
      clearInterval(pollTimer);
      pollTimer = null;
    }
  }

  function resetFlow() {
    stopPolling();
    finishing = false;
    codexReleaseLoginChannel();
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
    try {
      const status = await codexStatus();
      set({
        installed: status.installed,
        authenticated: status.authenticated,
        method: status.method,
        connecting: false,
        error: status.authenticated
          ? null
          : "Codex login finished but no credentials were found.",
      });
      await codexLoginCancel();
    } catch (e) {
      set({ connecting: false, error: String(e) });
    } finally {
      codexReleaseLoginChannel();
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

    refresh: async () => {
      set({ checking: true, error: null });
      try {
        const status = await codexStatus();
        set({
          installed: status.installed,
          authenticated: status.authenticated,
          method: status.method,
          checking: false,
        });
      } catch (e) {
        set({ error: String(e), checking: false });
      }
    },

    startLogin: async () => {
      if (get().connecting) return;
      resetFlow();
      set({ connecting: true, error: null });

      const onOutput = (chunk: CodexOutput) => {
        if (!get().connecting) return;
        const bytes = decode(chunk);
        emitOutput(bytes);

        const text = new TextDecoder().decode(bytes).replace(ANSI_RE, "");
        if (
          /Logged in|Successfully logged in|login successful|Authentication successful/i.test(
            text,
          )
        ) {
          void (async () => {
            if (!get().connecting || finishing) return;
            const status = await codexStatus();
            if (status.authenticated) void finish();
          })();
        }
      };

      try {
        await codexLogin(onOutput);
        pollTimer = setInterval(() => {
          void (async () => {
            if (!get().connecting || finishing) return;
            const status = await codexStatus();
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
      await codexLoginWrite(data);
    },

    cancelLogin: async () => {
      resetFlow();
      set({ connecting: false });
      await codexLoginCancel();
    },

    openInstallDocs: async () => {
      await openExternal(CODEX_INSTALL_URL);
    },
  };
});
