import type { UpdatePhase } from "../store/updateStore";
import "./UpdateProgress.css";

/** Download/install progress bar shared by the update dialog and gate screen. */
export default function UpdateProgress({
  phase,
  progress,
}: {
  phase: UpdatePhase;
  progress: number | null;
}) {
  const pct = progress != null ? Math.round(progress * 100) : null;
  const label =
    phase === "installing"
      ? "Installing…"
      : pct != null
        ? `Downloading… ${pct}%`
        : "Downloading…";
  // No known total (or installing) → indeterminate sweep.
  const indeterminate = phase === "installing" || pct == null;

  return (
    <div className="update-progress">
      <div className="update-progress-label">{label}</div>
      <div className="update-progress-track">
        <div
          className="update-progress-fill"
          data-indeterminate={indeterminate ? "true" : undefined}
          style={indeterminate ? undefined : { width: `${pct}%` }}
        />
      </div>
    </div>
  );
}
