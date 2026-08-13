import { create } from "zustand";
import {
  linearConnect,
  linearConnectCancel,
  linearDisconnect,
  linearListIssues,
  linearStatus,
  type LinearIssue,
} from "../lib/linear";

type LinearStore = {
  authenticated: boolean;
  userName: string | null;
  userEmail: string | null;
  organizationName: string | null;
  /** Initial status check in flight. */
  checking: boolean;
  /** Browser OAuth flow is running. */
  connecting: boolean;
  /** Disconnect in flight. */
  disconnecting: boolean;
  error: string | null;
  refresh: (opts?: { force?: boolean }) => Promise<void>;
  startLogin: () => Promise<void>;
  cancelLogin: () => Promise<void>;
  disconnect: () => Promise<void>;
  searchIssues: (query?: string) => Promise<LinearIssue[]>;
};

const STATUS_TTL_MS = 15_000;

let inflightRefresh: Promise<void> | null = null;
let checkedAt = 0;

function applyStatus(
  set: (partial: Partial<LinearStore>) => void,
  extra: Partial<LinearStore>,
) {
  return (status: Awaited<ReturnType<typeof linearStatus>>) => {
    checkedAt = Date.now();
    set({
      authenticated: status.authenticated,
      userName: status.userName,
      userEmail: status.userEmail,
      organizationName: status.organizationName,
      ...extra,
    });
  };
}

function isCancelled(error: unknown): boolean {
  const msg = String(error).toLowerCase();
  return msg.includes("cancelled") || msg.includes("canceled");
}

export const useLinearStore = create<LinearStore>((set, get) => ({
  authenticated: false,
  userName: null,
  userEmail: null,
  organizationName: null,
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
        const status = await linearStatus();
        applyStatus(set, { checking: false })(status);
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
    set({ connecting: true, error: null });
    try {
      const status = await linearConnect();
      applyStatus(set, { connecting: false, error: null })(status);
    } catch (e) {
      if (!get().connecting || isCancelled(e)) {
        set({ connecting: false });
        return;
      }
      set({ connecting: false, error: String(e) });
    }
  },

  cancelLogin: async () => {
    set({ connecting: false, error: null });
    await linearConnectCancel();
  },

  disconnect: async () => {
    if (get().disconnecting) return;
    set({ disconnecting: true, error: null });
    try {
      const status = await linearDisconnect();
      applyStatus(set, { disconnecting: false, error: null })(status);
    } catch (e) {
      set({ disconnecting: false, error: String(e) });
    }
  },

  searchIssues: async (query) => {
    return linearListIssues(query);
  },
}));
