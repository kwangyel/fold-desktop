import { useEffect } from "react";
import { useProjectStore } from "../store/projectStore";
import {
  selectTargetBranch,
  useTargetBranchStore,
} from "../store/targetBranchStore";
import { useConflictRadarStore } from "../store/conflictRadarStore";
import type { RadarWorktree } from "../lib/git";

const POLL_INTERVAL_MS = 15_000;

/**
 * Invisible driver for the conflict radar. Continuously re-scans the active project's
 * worktrees (against the target branch and each other) so the row chips and Conflicts
 * tab stay fresh. Mounted once, beside the other background watchers in CenterPane.
 */
export default function ConflictRadarWatcher() {
  const projects = useProjectStore((s) => s.projects);
  const activeId = useProjectStore((s) => s.activeId);
  const byProjectId = useTargetBranchStore((s) => s.byProjectId);

  const project = projects.find((p) => p.id === activeId) ?? null;
  const targetBranch = selectTargetBranch(byProjectId, activeId);

  // A stable signature so the effect only re-subscribes when the worktree set changes.
  const worktrees: RadarWorktree[] = (project?.worktrees ?? [])
    .filter((w) => !w.archived)
    .map((w) => ({ id: w.id, path: w.path, branch: w.branch }));
  const signature = worktrees
    .map((w) => `${w.id}:${w.path}:${w.branch}`)
    .join("|");

  useEffect(() => {
    const run = () => {
      void useConflictRadarStore.getState().refresh(targetBranch, worktrees);
    };
    run();
    const timer = setInterval(run, POLL_INTERVAL_MS);
    window.addEventListener("focus", run);
    return () => {
      clearInterval(timer);
      window.removeEventListener("focus", run);
    };
    // `worktrees` is derived from `signature`; re-run when it or the target changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [signature, targetBranch]);

  return null;
}
