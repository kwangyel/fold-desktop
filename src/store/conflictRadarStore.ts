import { create } from "zustand";
import {
  gitConflictRadar,
  type RadarWorktree,
  type WorktreeRadar,
} from "../lib/git";

type ConflictRadarStore = {
  /** Radar result per worktree id. Missing → not yet scanned / clean. */
  byWorktreeId: Record<string, WorktreeRadar>;
  refresh: (targetBranch: string, worktrees: RadarWorktree[]) => Promise<void>;
};

export const useConflictRadarStore = create<ConflictRadarStore>((set) => ({
  byWorktreeId: {},
  refresh: async (targetBranch, worktrees) => {
    if (worktrees.length === 0) {
      set({ byWorktreeId: {} });
      return;
    }
    try {
      const radars = await gitConflictRadar(targetBranch, worktrees);
      const byWorktreeId: Record<string, WorktreeRadar> = {};
      for (const r of radars) byWorktreeId[r.worktreeId] = r;
      set({ byWorktreeId });
    } catch (err) {
      // Radar is best-effort — a failed scan shouldn't disrupt the UI.
      console.warn("[conflict-radar] scan failed:", err);
    }
  },
}));

export type RadarLevel = "none" | "overlap" | "conflict";

/** Severity of a worktree's radar state: confirmed conflict > file overlap > clear. */
export function selectRadarLevel(radar: WorktreeRadar | undefined): RadarLevel {
  if (!radar) return "none";
  if (radar.conflictsWithTarget || radar.collisions.some((c) => c.willConflict)) {
    return "conflict";
  }
  if (radar.collisions.some((c) => c.sharedFiles.length > 0)) return "overlap";
  return "none";
}

/** Distinct files this worktree shares with any sibling (for the tab count badge). */
export function selectCollisionFileCount(radar: WorktreeRadar | undefined): number {
  if (!radar) return 0;
  const files = new Set<string>();
  for (const c of radar.collisions) {
    for (const f of c.sharedFiles) files.add(f);
  }
  return files.size;
}
