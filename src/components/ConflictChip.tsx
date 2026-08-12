import {
  selectRadarLevel,
  useConflictRadarStore,
} from "../store/conflictRadarStore";
import type { WorktreeRadar } from "../lib/git";

/** Human-readable tooltip summarising why the chip is showing. */
function describe(radar: WorktreeRadar, targetBranch: string): string {
  const parts: string[] = [];
  if (radar.conflictsWithTarget) {
    parts.push(`Conflicts with ${targetBranch}`);
  }
  for (const c of radar.collisions) {
    if (c.sharedFiles.length === 0) continue;
    const verb = c.willConflict ? "Conflicts with" : "Also editing";
    const files = c.sharedFiles.slice(0, 3).join(", ");
    const more = c.sharedFiles.length > 3 ? ` +${c.sharedFiles.length - 3} more` : "";
    parts.push(`${verb} ${files}${more} in ${c.otherName}`);
  }
  return parts.join("\n");
}

/**
 * Conflict-radar chip for a sidebar worktree row. Amber when a sibling is heading for
 * the same file; red when a merge would actually conflict (sibling or target).
 */
export default function ConflictChip({
  worktreeId,
  targetBranch,
}: {
  worktreeId: string;
  targetBranch: string;
}) {
  const radar = useConflictRadarStore((s) => s.byWorktreeId[worktreeId]);
  const level = selectRadarLevel(radar);
  if (level === "none" || !radar) return null;

  const label = describe(radar, targetBranch);
  return (
    <span
      className={`conflict-chip ${level}`}
      title={label}
      aria-label={label}
      role="img"
    />
  );
}
