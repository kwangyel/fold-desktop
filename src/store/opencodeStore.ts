import { create } from "zustand";
import {
  OpenCodeOutput,
  opencodeLogin,
  opencodeLoginCancel,
  opencodeLoginWrite,
  opencodeReleaseLoginChannel,
  opencodeStatus,
} from "../lib/opencode";
import { openExternal } from "../lib/github";

export const OPENCODE_INSTALL_URL = "https://opencode.ai/docs";

// eslint-disable-next-line no-control-regex
const ANSI_RE = /\x1b\[[0-9;?]*[A-Za-z]/g;

type OpenCodeStore = {
  installed: boolean;
  authenticated: boolean;
  method: string | null;
  providerCount: number;
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

function decode(chunk: OpenCodeOutput): Uint8Array {
  return chunk instanceof Uint8Array ? chunk : new Uint8Array(chunk);
}

export const useOpenCodeStore = create<OpenCodeStore>((set, get) => {
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
    opencodeReleaseLoginChannel();
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
      const status = await opencodeStatus();
      set({
        installed: status.installed,
        authenticated: status.authenticated,
        method: status.method,
        providerCount: status.providerCount,
        connecting: false,
        error: status.authenticated
          ? null
          : "OpenCode login finished but no providers were found.",
      });
      await opencodeLoginCancel();
    } catch (e) {
      set({ connecting: false, error: String(e) });
    } finally {
      opencodeReleaseLoginChannel();
      finishing = false;
    }
  }

  return {
    installed: false,
    authenticated: false,
    method: null,
    providerCount: 0,
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
        const status = await opencodeStatus();
        set({
          installed: status.installed,
          authenticated: status.authenticated,
          method: status.method,
          providerCount: status.providerCount,
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

      const onOutput = (chunk: OpenCodeOutput) => {
        if (!get().connecting) return;
        const bytes = decode(chunk);
        emitOutput(bytes);

        const text = new TextDecoder().decode(bytes).replace(ANSI_RE, "");
        if (
          /Logged in|login successful|Authentication successful|API key saved|added successfully/i.test(
            text,
          )
        ) {
          void (async () => {
            if (!get().connecting || finishing) return;
            const status = await opencodeStatus();
            if (status.authenticated) void finish();
          })();
        }
      };

      try {
        await opencodeLogin(onOutput);
        pollTimer = setInterval(() => {
          void (async () => {
            if (!get().connecting || finishing) return;
            const status = await opencodeStatus();
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
      await opencodeLoginWrite(data);
    },

    cancelLogin: async () => {
      resetFlow();
      set({ connecting: false });
      await opencodeLoginCancel();
    },

    openInstallDocs: async () => {
      await openExternal(OPENCODE_INSTALL_URL);
    },
  };
});
