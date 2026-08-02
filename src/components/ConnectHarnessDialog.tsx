import { useEffect } from "react";
import "./ConnectHarnessDialog.css";

type Harness = {
  id: string;
  name: string;
  description: string;
  iconClass: string;
  iconLabel: string;
};

const HARNESSES: Harness[] = [
  {
    id: "claudecode",
    name: "Claude Code",
    description: "Connect the Claude Code CLI harness",
    iconClass: "claudecode",
    iconLabel: "CC",
  },
  {
    id: "codex",
    name: "Codex",
    description: "Connect the Codex harness",
    iconClass: "codex",
    iconLabel: "CX",
  },
  {
    id: "cursor",
    name: "Cursor",
    description: "Connect the Cursor harness",
    iconClass: "cursor",
    iconLabel: "CR",
  },
  {
    id: "opencode",
    name: "OpenCode",
    description: "Connect the OpenCode harness",
    iconClass: "opencode",
    iconLabel: "OC",
  },
];

export default function ConnectHarnessDialog({
  onClose,
}: {
  onClose: () => void;
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div className="dialog-overlay" onMouseDown={onClose}>
      <div className="dialog" onMouseDown={(e) => e.stopPropagation()}>
        <div className="dialog-header">Connect Harness</div>

        <div className="dialog-body">
          <p className="harness-intro">
            Link an agent harness so Fold can run coding agents in your
            worktrees.
          </p>

          <div className="harness-list">
            {HARNESSES.map((harness) => (
              <div key={harness.id} className="harness-row">
                <div className={`harness-icon ${harness.iconClass}`}>
                  {harness.iconLabel}
                </div>
                <div className="harness-meta">
                  <div className="harness-name">{harness.name}</div>
                  <div className="harness-sub">{harness.description}</div>
                </div>
                <button
                  className="ghost-btn harness-connect-btn"
                  type="button"
                  disabled
                  title="Coming soon"
                >
                  Connect
                </button>
              </div>
            ))}
          </div>
        </div>

        <div className="dialog-footer">
          <button className="ghost-btn" type="button" onClick={onClose}>
            Close
          </button>
        </div>
      </div>
    </div>
  );
}
