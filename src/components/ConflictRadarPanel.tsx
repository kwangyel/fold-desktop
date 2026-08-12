import { openDiffForPath } from "../lib/diffActions";
import { useProjectStore } from "../store/projectStore";
import {
  selectTargetBranch,
  useTargetBranchStore,
} from "../store/targetBranchStore";
import { useConflictRadarStore } from "../store/conflictRadarStore";
import "./ConflictRadarPanel.css";

/**
 * Conflicts tab body. Shows, for the active worktree, whether it conflicts with the
 * target branch and which sibling worktrees are heading for the same files.
 */
export default function ConflictRadarPanel() {
  const activeId = useProjectStore((s) => s.activeId);
  const project = useProjectStore((s) =>
    s.projects.find((p) => p.id === s.activeId),
  );
  const byProjectId = useTargetBranchStore((s) => s.byProjectId);
  const worktreeId = project?.activeWorktreeId ?? null;
  const radar = useConflictRadarStore((s) =>
    worktreeId ? s.byWorktreeId[worktreeId] : undefined,
  );

  const targetBranch = selectTargetBranch(byProjectId, activeId);

  if (!worktreeId) {
    return (
      <div className="conflict-panel">
        <div className="conflict-empty">Select a worktree to scan for conflicts.</div>
      </div>
    );
  }

  const collisions = (radar?.collisions ?? []).filter(
    (c) => c.sharedFiles.length > 0,
  );
  const conflictsWithTarget = radar?.conflictsWithTarget ?? false;

  if (!conflictsWithTarget && collisions.length === 0) {
    return (
      <div className="conflict-panel">
        <div className="conflict-empty">No collisions — clear runway.</div>
      </div>
    );
  }

  return (
    <div className="conflict-panel">
      {conflictsWithTarget && (
        <div className="conflict-target-banner">
          This branch conflicts with <strong>{targetBranch}</strong>. Rebase or resolve
          before merging.
        </div>
      )}
      {collisions.map((c) => (
        <div className="conflict-section" key={c.otherId}>
          <div className={`conflict-section-header ${c.willConflict ? "conflict" : "overlap"}`}>
            <span className="conflict-badge" />
            <span className="conflict-other-name">{c.otherName}</span>
            <span className="conflict-section-tag">
              {c.willConflict ? "conflict" : "also editing"}
            </span>
          </div>
          <ul className="conflict-file-list">
            {c.sharedFiles.map((f) => (
              <li key={f}>
                <button
                  type="button"
                  className="conflict-file"
                  title={`Open diff for ${f}`}
                  onClick={() => void openDiffForPath(f)}
                >
                  {f}
                </button>
              </li>
            ))}
          </ul>
        </div>
      ))}
    </div>
  );
}
