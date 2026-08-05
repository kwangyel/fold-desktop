import { create } from "zustand";
import {
  cursorConnect,
  cursorDisconnect,
  cursorStatus,
} from "../lib/cursor";
import { openExternal } from "../lib/github";

/** Dashboard page where users create Cloud Agents / CLI API keys. */
export const CURSOR_API_KEYS_URL = "https://cursor.com/dashboard/api";

/** Cursor Agent CLI install docs. */
export const CURSOR_CLI_INSTALL_URL = "https://cursor.com/docs/cli/overview";

type CursorStore = {
  authenticated: boolean;
  method: string | null;
  apiKeyName: string | null;
  userEmail: string | null;
  cliInstalled: boolean;
  /** Initial status check in flight. */
  checking: boolean;
  /** Connect (validate + save) in flight. */
  connecting: boolean;
  /** Disconnect in flight. */
  disconnecting: boolean;
  error: string | null;
  refresh: (opts?: { force?: boolean }) => Promise<void>;
  connect: (apiKey: string) => Promise<void>;
  disconnect: () => Promise<void>;
  openApiKeyDocs: () => Promise<void>;
  openCliDocs: () => Promise<void>;
};

const STATUS_TTL_MS = 15_000;

let inflightRefresh: Promise<void> | null = null;
let checkedAt = 0;

export const useCursorStore = create<CursorStore>((set, get) => ({
  authenticated: false,
  method: null,
  apiKeyName: null,
  userEmail: null,
  cliInstalled: false,
  checking: false,
  connecting: false,
  disconnecting: false,
  error: null,

  refresh: async (opts) => {
    const force = opts?.force ?? false;
    if (!force && checkedAt && Date.now() - checkedAt < STATUS_TTL_MS) {
      return;
    }
    if (inflightRefresh) return inflightRefresh;

    inflightRefresh = (async () => {
      set({ checking: true, error: null });
      try {
        const status = await cursorStatus(force);
        checkedAt = Date.now();
        set({
          authenticated: status.authenticated,
          method: status.method,
          apiKeyName: status.apiKeyName,
          userEmail: status.userEmail,
          cliInstalled: status.cliInstalled,
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

  connect: async (apiKey) => {
    if (get().connecting) return;
    const trimmed = apiKey.trim();
    if (!trimmed) {
      set({ error: "Paste a Cursor API key to connect." });
      return;
    }
    set({ connecting: true, error: null });
    try {
      const status = await cursorConnect(trimmed);
      checkedAt = Date.now();
      set({
        authenticated: status.authenticated,
        method: status.method,
        apiKeyName: status.apiKeyName,
        userEmail: status.userEmail,
        cliInstalled: status.cliInstalled,
        connecting: false,
        error: null,
      });
    } catch (e) {
      set({ connecting: false, error: String(e) });
    }
  },

  disconnect: async () => {
    if (get().disconnecting) return;
    set({ disconnecting: true, error: null });
    try {
      const status = await cursorDisconnect();
      checkedAt = Date.now();
      set({
        authenticated: false,
        method: null,
        apiKeyName: null,
        userEmail: null,
        cliInstalled: status.cliInstalled,
        disconnecting: false,
        error: null,
      });
    } catch (e) {
      set({ disconnecting: false, error: String(e) });
    }
  },

  openApiKeyDocs: async () => {
    await openExternal(CURSOR_API_KEYS_URL);
  },

  openCliDocs: async () => {
    await openExternal(CURSOR_CLI_INSTALL_URL);
  },
}));
