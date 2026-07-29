import { useState } from "react";
import "./ChangesList.css";

interface ChangedFile {
  path: string;
  status: "modified" | "added" | "deleted";
  additions: number;
  deletions: number;
}

const MOCK_CHANGES: ChangedFile[] = [
  { path: "src/components/RightPane.tsx", status: "modified", additions: 42, deletions: 18 },
  { path: "src/components/XTerminal.tsx", status: "added", additions: 95, deletions: 0 },
  { path: "src/components/TerminalPanel.tsx", status: "added", additions: 68, deletions: 0 },
  { path: "src-tauri/src/pty.rs", status: "added", additions: 102, deletions: 0 },
  { path: "src-tauri/src/lib.rs", status: "modified", additions: 55, deletions: 3 },
  { path: "package.json", status: "modified", additions: 2, deletions: 0 },
];

const STATUS_LABELS: Record<ChangedFile["status"], string> = {
  modified: "M",
  added: "A",
  deleted: "D",
};

export default function ChangesList() {
  const [selected, setSelected] = useState<string | null>(null);

  return (
    <div className="changes-list">
      <div className="changes-header">
        <span className="changes-count">{MOCK_CHANGES.length} changed files</span>
      </div>
      {MOCK_CHANGES.map((file) => (
        <div
          key={file.path}
          className={`change-row ${selected === file.path ? "selected" : ""}`}
          onClick={() => setSelected(file.path)}
        >
          <span className={`change-status status-${file.status}`}>
            {STATUS_LABELS[file.status]}
          </span>
          <span className="change-path">{file.path}</span>
          <span className="change-stats">
            {file.additions > 0 && <span className="stat-add">+{file.additions}</span>}
            {file.deletions > 0 && <span className="stat-del">-{file.deletions}</span>}
          </span>
        </div>
      ))}
    </div>
  );
}
