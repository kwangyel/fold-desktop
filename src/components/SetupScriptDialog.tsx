import { useEffect, useState } from "react";
import { getSetupScript, setSetupScript } from "../lib/setup";
import "./ProjectDialog.css";

type Props = {
  projectId: string;
  projectName: string;
  onClose: () => void;
};

export default function SetupScriptDialog({
  projectId,
  projectName,
  onClose,
}: Props) {
  const [script, setScript] = useState("");
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
      setError(null);
      try {
        const existing = await getSetupScript(projectId);
        if (!cancelled) setScript(existing ?? "");
      } catch (e) {
        if (!cancelled) setError(String(e));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [projectId]);

  async function save() {
    setBusy(true);
    setError(null);
    try {
      const trimmed = script.trim();
      await setSetupScript(projectId, trimmed.length > 0 ? script : null);
      onClose();
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="dialog-overlay" onMouseDown={onClose}>
      <div
        className="dialog dialog-wide"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="dialog-header">Setup script — {projectName}</div>

        <div className="dialog-body">
          <div className="field">
            <label>Shell script</label>
            <p className="dialog-hint">
              Runs once after each new worktree is created, from the worktree
              directory. Available env:{" "}
              <code>FOLD_WORKSPACE_PATH</code>, <code>FOLD_ROOT_PATH</code>,{" "}
              <code>FOLD_WORKSPACE_NAME</code>. Stored in Fold, not committed to
              the repo.
            </p>
            {loading ? (
              <div className="dialog-preview">Loading…</div>
            ) : (
              <textarea
                className="setup-script-textarea"
                rows={12}
                spellCheck={false}
                placeholder={"pnpm install\n# or: npm install, bundle install, …"}
                value={script}
                onChange={(e) => setScript(e.target.value)}
                autoFocus
              />
            )}
          </div>
          {error && <div className="dialog-error">{error}</div>}
        </div>

        <div className="dialog-footer">
          <button className="ghost-btn" type="button" onClick={onClose}>
            Cancel
          </button>
          <button
            className="primary-btn"
            type="button"
            disabled={busy || loading}
            onClick={() => void save()}
          >
            {busy ? "Saving…" : "Save"}
          </button>
        </div>
      </div>
    </div>
  );
}
