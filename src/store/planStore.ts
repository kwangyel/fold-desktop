import { create } from "zustand";
import {
  loadPlanIndex,
  patchPlan,
  upsertPlan,
  type PlanRecord,
} from "../lib/plans";
import { gitChangedSince, gitHeadCommit } from "../lib/git";
import { useAgentStatusStore } from "./agentStatusStore";

type PlanStore = {
  /** Plans for the active worktree, newest first. */
  plans: PlanRecord[];
  loading: boolean;
  error: string | null;

  /** Reload the index from the Fold plans index (`.fold/plans/index.json`). */
  refresh: () => Promise<void>;
  /** Record a newly captured plan. */
  add: (record: PlanRecord) => Promise<void>;
  /** Apply a partial update to one plan. */
  update: (id: string, patch: Partial<PlanRecord>) => Promise<void>;
  /**
   * Close out an implementation run. Status is derived rather than reported:
   * no harness tells us whether a plan was carried out, so we treat "the run
   * finished cleanly and the working tree actually changed" as implemented.
   */
  finishImplementation: (id: string, ok: boolean) => Promise<void>;
  find: (id: string) => PlanRecord | undefined;
};

export const usePlanStore = create<PlanStore>((set, get) => ({
  plans: [],
  loading: false,
  error: null,

  refresh: async () => {
    set({ loading: true, error: null });
    try {
      set({ plans: await loadPlanIndex(), loading: false });
    } catch (e) {
      set({ error: String(e), loading: false, plans: [] });
    }
  },

  add: async (record) => {
    set({ plans: await upsertPlan(record) });
  },

  update: async (id, patch) => {
    const before = get().plans.find((p) => p.id === id);
    set({ plans: await patchPlan(id, patch) });
    // The plan is no longer waiting on the user, so its source chat should stop
    // saying so. The plan opens in its own center tab, so viewing it never
    // reaches the chat tab's "seen" clearing.
    if (patch.status && patch.status !== "draft" && before?.sourceChatTabId) {
      useAgentStatusStore.getState().clear(before.sourceChatTabId);
    }
  },

  finishImplementation: async (id, ok) => {
    const record = get().plans.find((p) => p.id === id);
    if (!record) return;

    const worktree = record.worktreePath;
    const headCommit = await gitHeadCommit(worktree).catch(() => "");
    const changedFiles = await gitChangedSince(
      worktree,
      record.baseCommit ?? "",
    ).catch(() => 0);

    await get().update(id, {
      status: ok && changedFiles > 0 ? "implemented" : "failed",
      headCommit,
      changedFiles,
      implementedAt: Date.now(),
    });
  },

  find: (id) => get().plans.find((p) => p.id === id),
}));
