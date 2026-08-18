import { useEffect } from "react";
import { IconDownload } from "@tabler/icons-react";
import { useUpdateStore } from "../store/updateStore";
import UpdateProgress from "./UpdateProgress";
import "./ProjectDialog.css";
import "./UpdateDialog.css";

type Props = {
  /** Defer the update ("Later" / Escape / click-outside). */
  onClose: () => void;
};

/**
 * Dismissible prompt for an optional update. Modeled on SmartHandoffDialog —
 * shared `.dialog-*` classes, Escape/overlay-click to close. While an install
 * is running the dialog stays open, shows progress, and can't be dismissed.
 */
export default function UpdateDialog({ onClose }: Props) {
  const current = useUpdateStore((s) => s.current);
  const latest = useUpdateStore((s) => s.latest);
  const notes = useUpdateStore((s) => s.notes);
  const phase = useUpdateStore((s) => s.phase);
  const progress = useUpdateStore((s) => s.progress);
  const error = useUpdateStore((s) => s.error);
  const install = useUpdateStore((s) => s.install);

  const busy = phase === "downloading" || phase === "installing";

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !busy) onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose, busy]);

  return (
    <div
      className="dialog-overlay"
      onMouseDown={busy ? undefined : onClose}
    >
      <div
        className="dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="update-dialog-title"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="dialog-header" id="update-dialog-title">
          Update available
        </div>
        <div className="dialog-body">
          <p className="dialog-hint">
            A new version of Fold is ready — <strong>{latest}</strong>
            {current ? (
              <>
                {" "}
                (you have <strong>{current}</strong>)
              </>
            ) : null}
            . Updating downloads the new build and restarts the app.
          </p>
          {notes ? <div className="update-notes">{notes}</div> : null}
          {busy ? <UpdateProgress phase={phase} progress={progress} /> : null}
          {error ? <div className="dialog-error">{error}</div> : null}
        </div>
        <div className="dialog-footer">
          <button
            type="button"
            className="ghost-btn"
            onClick={onClose}
            disabled={busy}
          >
            Later
          </button>
          <button
            type="button"
            className="primary-btn update-dialog-confirm"
            onClick={() => void install()}
            disabled={busy}
          >
            <IconDownload size={14} stroke={2} />
            {busy ? "Updating…" : "Update now"}
          </button>
        </div>
      </div>
    </div>
  );
}
