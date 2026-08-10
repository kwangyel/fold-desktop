import { create } from 'zustand';

/**
 * What a chat's agent is doing right now.
 *
 * Derived entirely from harness stream events (see `chatStore.sendPrompt`) and
 * from pending question sets — never from scraping terminal output.
 */
export type AgentState = 'running' | 'needs-you' | 'done';

/** Why a chat is blocked, for notification wording and for settling `finish`. */
export type AgentStatusReason = 'question' | 'plan';

export type AgentStatusEntry = {
  state: AgentState;
  /** Only set for `needs-you`. */
  reason?: AgentStatusReason;
  /** Worktree the chat belongs to, for the sidebar's aggregate row. */
  worktreePath: string | null;
  /** Chat title at the time the state was set, for notification text. */
  title: string;
  at: number;
};

export type AgentStatuses = Record<string, AgentStatusEntry>;

/** Chat identity, carried in so this store depends on no other store. */
export type AgentStatusMeta = {
  worktreePath?: string | null;
  title?: string;
  reason?: AgentStatusReason;
};

type AgentStatusStore = {
  /** Keyed by chat tab id, which is also the chat id in the sidebar. */
  statuses: AgentStatuses;

  setState: (tabId: string, state: AgentState, meta?: AgentStatusMeta) => void;
  /** Mark as seen — drops the entry, clearing the dot and the badge slot. */
  clear: (tabId: string) => void;
  clearWorktree: (worktreePath: string) => void;
};

export const useAgentStatusStore = create<AgentStatusStore>((set) => ({
  statuses: {},

  setState: (tabId, state, meta) =>
    set((store) => {
      const prev = store.statuses[tabId];
      if (prev?.state === state && prev.reason === meta?.reason) return store;
      return {
        statuses: {
          ...store.statuses,
          [tabId]: {
            state,
            reason: state === 'needs-you' ? meta?.reason : undefined,
            worktreePath: meta?.worktreePath ?? prev?.worktreePath ?? null,
            title: meta?.title || prev?.title || 'Chat',
            at: Date.now(),
          },
        },
      };
    }),

  clear: (tabId) =>
    set((store) => {
      if (!store.statuses[tabId]) return store;
      const { [tabId]: _dropped, ...rest } = store.statuses;
      return { statuses: rest };
    }),

  clearWorktree: (worktreePath) =>
    set((store) => ({
      statuses: Object.fromEntries(
        Object.entries(store.statuses).filter(
          ([, entry]) => entry.worktreePath !== worktreePath,
        ),
      ),
    })),
}));

/**
 * The one state to show on a worktree row. A worktree that has anything
 * blocked on the user says so first, then anything still working, then done.
 */
export function worktreeState(
  statuses: AgentStatuses,
  worktreePath: string,
): AgentState | null {
  let best: AgentState | null = null;
  for (const entry of Object.values(statuses)) {
    if (entry.worktreePath !== worktreePath) continue;
    if (entry.state === 'needs-you') return 'needs-you';
    if (entry.state === 'running') best = 'running';
    else if (entry.state === 'done' && best === null) best = 'done';
  }
  return best;
}

/** Chats wanting the user: blocked on input, or finished and not yet seen. */
export function attentionCount(statuses: AgentStatuses): number {
  return Object.values(statuses).filter((e) => e.state !== 'running').length;
}
