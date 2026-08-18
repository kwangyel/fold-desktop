import { IconShieldLock } from "@tabler/icons-react";
import { useUpdateStore } from "../store/updateStore";
import UpdateProgress from "./UpdateProgress";
import "./UpdateRequiredScreen.css";

/**
 * Blocking gate for a compulsory (security) update. Rendered in place of the
 * whole app when the running version is below the manifest's `minimumSupported`.
 * There is no dismiss — the only action is to install and restart.
 */
export default function UpdateRequiredScreen() {
  const current = useUpdateStore((s) => s.current);
  const latest = useUpdateStore((s) => s.latest);
  const notes = useUpdateStore((s) => s.notes);
  const phase = useUpdateStore((s) => s.phase);
  const progress = useUpdateStore((s) => s.progress);
  const error = useUpdateStore((s) => s.error);
  const install = useUpdateStore((s) => s.install);

  const busy = phase === "downloading" || phase === "installing";

  return (
    <div className="update-required" role="alertdialog" aria-modal="true">
      <div className="update-required-card">
        <div className="update-required-icon">
          <IconShieldLock size={28} stroke={1.75} />
        </div>
        <h1 className="update-required-title">Security update required</h1>
        <p className="update-required-text">
          This version of Fold{current ? <> (<strong>{current}</strong>)</> : null}{" "}
          is no longer supported and must be updated to continue.
          {latest ? (
            <>
              {" "}
              Installing version <strong>{latest}</strong> takes a moment and
              restarts the app.
            </>
          ) : null}
        </p>
        {notes ? <div className="update-required-notes">{notes}</div> : null}
        {busy ? (
          <UpdateProgress phase={phase} progress={progress} />
        ) : (
          <button
            type="button"
            className="primary-btn update-required-btn"
            onClick={() => void install()}
          >
            Download &amp; install update
          </button>
        )}
        {error ? <div className="update-required-error">{error}</div> : null}
      </div>
    </div>
  );
}
