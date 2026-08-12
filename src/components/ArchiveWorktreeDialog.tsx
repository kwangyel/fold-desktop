import { useEffect, useState } from "react";
import {
  assessWorktreeDeletion,
  type WorktreeDeletionRisk,
} from "../lib/projects";
import { useProjectStore } from "../store/projectStore";
import "./ProjectDialog.css";
import "./DeleteWorktreeDialog.css";

type Props = {
  projectId: string;
  worktreeId: string;
  name: string;
  onClose: () => void;
};

export default function ArchiveWorktreeDialog({
  projectId,
  worktreeId,
  name,
  onClose,
}: Props) {
  const archiveWorktree = useProjectStore((s) => s.archiveWorktree);
  const [risk, setRisk] = useState<WorktreeDeletionRisk | null>(null);
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [createRescue, setCreateRescue] = useState(true);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    void assessWorktreeDeletion(projectId, worktreeId)
      .then((r) => {
        if (!cancelled) setRisk(r);
      })
      .catch((e) => {
        if (!cancelled) setError(String(e));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [projectId, worktreeId]);

  const hasUncommitted = Boolean(risk && (risk.dirty || risk.untracked));
  const canSubmit = !loading && !submitting && !!risk && !risk.archived;

  const handleArchive = async () => {
    if (!canSubmit || !risk) return;
    setSubmitting(true);
    setError(null);
    try {
      await archiveWorktree(projectId, worktreeId, {
        createRescue: hasUncommitted ? createRescue : false,
      });
      onClose();
    } catch (e) {
      setError(String(e));
      setSubmitting(false);
    }
  };

  return (
    <div className="dialog-overlay" onClick={onClose}>
      <div
        className="dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="archive-wt-title"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="dialog-header">
          <h2 id="archive-wt-title">Archive worktree</h2>
        </div>
        <div className="dialog-body">
          <p className="dialog-hint">
            Archive <strong>{name}</strong>
            {risk ? (
              <>
                {" "}
                on branch <code>{risk.branch}</code>
              </>
            ) : null}
            . The folder is removed and the branch is kept.
          </p>

          {loading && <p className="dialog-hint">Checking for uncommitted work…</p>}

          {risk && !loading && (
            <div className="delete-risk-list">
              <div className="delete-risk-row">
                <span className="delete-risk-label">Dirty / untracked</span>
                <span className="delete-risk-value">
                  {hasUncommitted
                    ? [
                        risk.dirty ? "dirty working tree" : null,
                        risk.untracked ? "untracked files" : null,
                      ]
                        .filter(Boolean)
                        .join(", ")
                    : "None"}
                </span>
              </div>
            </div>
          )}

          {hasUncommitted && (
            <>
              <p className="dialog-hint">
                Uncommitted changes will be lost when the folder is removed
                unless they are saved to a rescue ref (
                <code>refs/fold/rescue/…</code>) via{" "}
                <code>git stash</code>.
              </p>
              <label className="delete-check">
                <input
                  type="checkbox"
                  checked={createRescue}
                  onChange={(e) => setCreateRescue(e.target.checked)}
                />
                <span>
                  Save uncommitted work to a rescue ref before archiving
                  <span className="delete-check-default"> (recommended)</span>
                </span>
              </label>
              {!createRescue && (
                <p className="dialog-error">
                  Uncommitted and untracked files will be permanently discarded.
                </p>
              )}
            </>
          )}

          {error && <div className="dialog-error">{error}</div>}
        </div>
        <div className="dialog-footer">
          <button type="button" className="ghost-btn" onClick={onClose}>
            Cancel
          </button>
          <button
            type="button"
            className="primary-btn"
            disabled={!canSubmit}
            onClick={() => void handleArchive()}
          >
            {submitting ? "Archiving…" : "Archive"}
          </button>
        </div>
      </div>
    </div>
  );
}
