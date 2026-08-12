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

export default function DeleteWorktreeDialog({
  projectId,
  worktreeId,
  name,
  onClose,
}: Props) {
  const removeWorktree = useProjectStore((s) => s.removeWorktree);
  const [risk, setRisk] = useState<WorktreeDeletionRisk | null>(null);
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [createRescue, setCreateRescue] = useState(true);
  const [forceAccepted, setForceAccepted] = useState(false);
  const [confirmText, setConfirmText] = useState("");

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

  const requiresForce = Boolean(risk?.requiresForce && risk.branchExists);
  const typedOk = confirmText.trim().toLowerCase() === "delete";
  const canSubmit =
    !loading &&
    !submitting &&
    !!risk &&
    risk.archived &&
    (!requiresForce || (forceAccepted && typedOk));

  const handleDelete = async () => {
    if (!canSubmit || !risk) return;
    setSubmitting(true);
    setError(null);
    try {
      await removeWorktree(projectId, worktreeId, {
        createRescue,
        force: requiresForce ? forceAccepted && typedOk : false,
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
        aria-labelledby="delete-wt-title"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="dialog-header">
          <h2 id="delete-wt-title">Delete worktree permanently</h2>
        </div>
        <div className="dialog-body">
          <p className="dialog-hint">
            Permanently remove <strong>{name}</strong>
            {risk ? (
              <>
                {" "}
                and branch <code>{risk.branch}</code>
              </>
            ) : null}
            . This cannot be undone from Fold.
          </p>

          {loading && <p className="dialog-hint">Checking branch safety…</p>}

          {risk && !loading && (
            <div className="delete-risk-list">
              {risk.branchExists ? (
                <>
                  <div className="delete-risk-row">
                    <span className="delete-risk-label">Unpushed commits</span>
                    <span className="delete-risk-value">
                      {risk.unpushedCommits === 0
                        ? "None"
                        : `${risk.unpushedCommits} not on ${
                            risk.hasUpstream ? "upstream" : "any remote"
                          }`}
                    </span>
                  </div>
                  <div className="delete-risk-row">
                    <span className="delete-risk-label">Dirty / untracked</span>
                    <span className="delete-risk-value">
                      {risk.dirty || risk.untracked
                        ? [
                            risk.dirty ? "dirty working tree" : null,
                            risk.untracked ? "untracked files" : null,
                          ]
                            .filter(Boolean)
                            .join(", ")
                        : "None (folder already archived)"}
                    </span>
                  </div>
                  <div className="delete-risk-row">
                    <span className="delete-risk-label">Safe delete (-d)</span>
                    <span className="delete-risk-value">
                      {risk.requiresForce
                        ? "Not safe — force required"
                        : "OK"}
                    </span>
                  </div>
                </>
              ) : (
                <p className="dialog-hint">
                  Branch no longer exists locally; only the Fold entry will be
                  removed.
                </p>
              )}
            </div>
          )}

          {risk?.branchExists && (
            <label className="delete-check">
              <input
                type="checkbox"
                checked={createRescue}
                onChange={(e) => setCreateRescue(e.target.checked)}
              />
              <span>
                Save a rescue ref under <code>refs/fold/rescue/…</code> before
                deleting
                <span className="delete-check-default"> (recommended)</span>
              </span>
            </label>
          )}

          {requiresForce && (
            <div className="delete-force-block">
              <label className="delete-check">
                <input
                  type="checkbox"
                  checked={forceAccepted}
                  onChange={(e) => setForceAccepted(e.target.checked)}
                />
                <span>
                  I understand this will force-delete the branch (
                  <code>-D</code>)
                </span>
              </label>
              <label className="delete-type-label">
                Type <strong>delete</strong> to confirm
                <input
                  className="delete-type-input"
                  value={confirmText}
                  onChange={(e) => setConfirmText(e.target.value)}
                  placeholder="delete"
                  autoComplete="off"
                  spellCheck={false}
                />
              </label>
            </div>
          )}

          {error && <div className="dialog-error">{error}</div>}
        </div>
        <div className="dialog-footer">
          <button type="button" className="ghost-btn" onClick={onClose}>
            Cancel
          </button>
          <button
            type="button"
            className="primary-btn danger-btn"
            disabled={!canSubmit}
            onClick={() => void handleDelete()}
          >
            {submitting ? "Deleting…" : "Delete permanently"}
          </button>
        </div>
      </div>
    </div>
  );
}
