import { create } from "zustand";
import { claudeUsageStatus } from "../lib/claude";
import {
  sessionUsageFromFoldEvent,
  type ContextUsage,
  type SessionUsage,
  harnessSupportsContextStatus,
} from "../lib/contextUsage";
import type { HarnessId } from "../lib/harnesses";
import { workspacePath } from "../lib/projects";
import { useClaudeStore } from "./claudeStore";
import { useProjectStore } from "./projectStore";

/** Reuse a recent fetch unless explicitly refreshed. */
const USAGE_CACHE_TTL_MS = 30_000;

type ContextUsageStore = {
  /** Latest known context-window usage keyed by harness. */
  byHarness: Partial<Record<HarnessId, ContextUsage>>;
  /** Latest known Claude.ai session / weekly rate-limit usage. */
  sessionByHarness: Partial<Record<HarnessId, SessionUsage>>;
  /**
   * Which harness's status the bar is showing. Null = auto (prefer active
   * chat harness, else first with data).
   */
  viewingHarnessId: HarnessId | null;
  /** Last successful proactive fetch (ms). */
  fetchedAt: number | null;
  /** Why the last refresh produced nothing, for the meter tooltips. */
  lastError: string | null;
  setUsage: (usage: ContextUsage) => void;
  setSessionUsage: (usage: SessionUsage) => void;
  setViewingHarness: (id: HarnessId | null) => void;
  clearHarness: (id: HarnessId) => void;
  /** Proactively fetch Claude context + session usage via the Agent SDK. */
  refresh: (opts?: { force?: boolean }) => Promise<void>;
};

let inflightRefresh: Promise<void> | null = null;

export const useContextUsageStore = create<ContextUsageStore>((set, get) => ({
  byHarness: {},
  sessionByHarness: {},
  viewingHarnessId: null,
  fetchedAt: null,
  lastError: null,

  setUsage: (usage) =>
    set((state) => ({
      byHarness: { ...state.byHarness, [usage.harnessId]: usage },
    })),

  setSessionUsage: (usage) =>
    set((state) => {
      const prev = state.sessionByHarness[usage.harnessId];
      // Merge so a five_hour-only update doesn't wipe seven_day (and vice versa).
      const merged: SessionUsage = {
        harnessId: usage.harnessId,
        fiveHour: usage.fiveHour ?? prev?.fiveHour ?? null,
        sevenDay: usage.sevenDay ?? prev?.sevenDay ?? null,
        subscriptionType:
          usage.subscriptionType ?? prev?.subscriptionType ?? null,
        sessionCostUsd:
          usage.sessionCostUsd ?? prev?.sessionCostUsd ?? null,
      };
      return {
        sessionByHarness: {
          ...state.sessionByHarness,
          [usage.harnessId]: merged,
        },
      };
    }),

  setViewingHarness: (id) => set({ viewingHarnessId: id }),

  clearHarness: (id) =>
    set((state) => {
      const nextCtx = { ...state.byHarness };
      const nextSession = { ...state.sessionByHarness };
      delete nextCtx[id];
      delete nextSession[id];
      return {
        byHarness: nextCtx,
        sessionByHarness: nextSession,
        viewingHarnessId:
          state.viewingHarnessId === id ? null : state.viewingHarnessId,
      };
    }),

  refresh: async (opts) => {
    const force = opts?.force ?? false;
    const { fetchedAt } = get();
    if (
      !force &&
      fetchedAt != null &&
      Date.now() - fetchedAt < USAGE_CACHE_TTL_MS
    ) {
      return;
    }
    if (inflightRefresh) return inflightRefresh;

    inflightRefresh = (async () => {
      const { installed, authenticated } = useClaudeStore.getState();
      if (!installed || !authenticated) {
        // Common cause of "usage never appears": the status probe hasn't
        // resolved yet, so we bail before ever reaching the SDK.
        console.info(
          `[usage] skipped — claude installed=${installed} authenticated=${authenticated}`,
        );
        set({ lastError: "Claude Code not connected yet" });
        return;
      }

      const { projects, activeId } = useProjectStore.getState();
      const project = projects.find((p) => p.id === activeId);
      const worktree = project ? workspacePath(project) : null;

      const startedAt = Date.now();
      console.info(`[usage] → claude_usage_status worktree=${worktree ?? "(none)"}`);
      try {
        const raw = await claudeUsageStatus(worktree);
        const ms = Date.now() - startedAt;
        console.info(`[usage] ← ${ms}ms`, raw);
        let gotSomething = false;
        if (raw.session) {
          const session = sessionUsageFromFoldEvent({
            type: "fold_session_usage",
            harnessId: "claudecode",
            ...raw.session,
          });
          if (session) {
            get().setSessionUsage(session);
            gotSomething = true;
          }
        }
        // Only cache successes — empty results should retry on next refresh.
        if (gotSomething) {
          set({ fetchedAt: Date.now(), lastError: null });
        } else {
          // The command succeeded but carried no usable numbers — distinct
          // from a transport failure, and the reason the meters sit at "—".
          const reason =
            typeof raw.error === "string"
              ? raw.error
              : "SDK returned no session usage (API-key plans have no quotas)";
          console.warn(`[usage] no usable data: ${reason}`);
          set({ lastError: reason });
        }
      } catch (err) {
        // SDK unavailable or not authenticated — keep last known values, but
        // don't fail silently: a swallowed error here hid a script timeout.
        console.warn("[usage] refresh failed:", err);
        set({ lastError: String(err) });
      } finally {
        inflightRefresh = null;
      }
    })();

    return inflightRefresh;
  },
}));

/** Resolve which harness context status to display in the bar. */
export function resolveViewingUsage(
  byHarness: Partial<Record<HarnessId, ContextUsage>>,
  viewingHarnessId: HarnessId | null,
  preferredHarnessId: HarnessId | null,
): ContextUsage | null {
  if (viewingHarnessId && byHarness[viewingHarnessId]) {
    return byHarness[viewingHarnessId] ?? null;
  }
  if (
    preferredHarnessId &&
    harnessSupportsContextStatus(preferredHarnessId) &&
    byHarness[preferredHarnessId]
  ) {
    return byHarness[preferredHarnessId] ?? null;
  }
  for (const usage of Object.values(byHarness)) {
    if (usage) return usage;
  }
  return null;
}

/** Resolve session / rate-limit usage for the currently viewed harness. */
export function resolveViewingSession(
  sessionByHarness: Partial<Record<HarnessId, SessionUsage>>,
  viewingHarnessId: HarnessId | null,
  preferredHarnessId: HarnessId | null,
  contextHarnessId: HarnessId | null,
): SessionUsage | null {
  const order = [
    viewingHarnessId,
    contextHarnessId,
    preferredHarnessId,
  ].filter(Boolean) as HarnessId[];
  for (const id of order) {
    if (sessionByHarness[id]) return sessionByHarness[id] ?? null;
  }
  for (const usage of Object.values(sessionByHarness)) {
    if (usage) return usage;
  }
  return null;
}
