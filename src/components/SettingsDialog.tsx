import { useEffect, useState } from "react";
import { IconDownload } from "@tabler/icons-react";
import { getCurrentVersion } from "../lib/appUpdate";
import { clearDismissedVersion } from "../lib/updatePrompt";
import { useUpdateStore } from "../store/updateStore";
import UpdateProgress from "./UpdateProgress";
import "./ProjectDialog.css";
import "./SettingsDialog.css";

type Props = {
  onClose: () => void;
};

/**
 * Minimal settings panel opened from the profile menu. For now it just shows
 * the app version and the update status (with an install / re-check action).
 */
export default function SettingsDialog({ onClose }: Props) {
  const status = useUpdateStore((s) => s.status);
  const latest = useUpdateStore((s) => s.latest);
  const checking = useUpdateStore((s) => s.checking);
  const phase = useUpdateStore((s) => s.phase);
  const progress = useUpdateStore((s) => s.progress);
  const error = useUpdateStore((s) => s.error);
  const runCheck = useUpdateStore((s) => s.runCheck);
  const install = useUpdateStore((s) => s.install);

  const [version, setVersion] = useState<string | null>(null);
  useEffect(() => {
    void getCurrentVersion().then(setVersion);
  }, []);

  const busy = phase === "downloading" || phase === "installing";
  const updateAvailable = status === "optional" || status === "mandatory";

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !busy) onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose, busy]);

  const handleCheck = () => {
    // Clear any prior "Later" so a re-check re-surfaces an available update.
    clearDismissedVersion();
    void runCheck();
  };

  return (
    <div className="dialog-overlay" onMouseDown={busy ? undefined : onClose}>
      <div
        className="dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="settings-title"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="dialog-header" id="settings-title">
          Settings
        </div>
        <div className="dialog-body">
          <div className="settings-row">
            <span className="settings-label">Version</span>
            <span className="settings-value">{version ?? "—"}</span>
          </div>

          <div className="settings-update">
            {checking ? (
              <span className="settings-hint">Checking for updates…</span>
            ) : updateAvailable ? (
              <>
                <span className="settings-hint">
                  Update available — <strong>{latest}</strong>
                </span>
                {busy ? (
                  <UpdateProgress phase={phase} progress={progress} />
                ) : (
                  <button
                    type="button"
                    className="primary-btn settings-update-btn"
                    onClick={() => void install()}
                  >
                    <IconDownload size={14} stroke={2} />
                    Update now
                  </button>
                )}
              </>
            ) : (
              <>
                <span className="settings-hint">You&rsquo;re up to date.</span>
                <button
                  type="button"
                  className="ghost-btn"
                  onClick={handleCheck}
                >
                  Check for updates
                </button>
              </>
            )}
            {error ? <div className="dialog-error">{error}</div> : null}
          </div>
        </div>
        <div className="dialog-footer">
          <button
            type="button"
            className="ghost-btn"
            onClick={onClose}
            disabled={busy}
          >
            Close
          </button>
        </div>
      </div>
    </div>
  );
}
