const workspaceFiles = import.meta.glob<string>(
  [
    "../**/*.{ts,tsx,css}",
    "../../package.json",
    "../../README.md",
    "../../src-tauri/src/*.rs",
    "../../src-tauri/Cargo.toml",
  ],
  { query: "?raw", import: "default", eager: true },
);

const PATH_ALIASES: Record<string, string> = {};

function resolveModuleKey(path: string): string | null {
  const candidates = [
    PATH_ALIASES[path],
    `../${path.replace(/^src\//, "")}`,
    `../../${path}`,
  ].filter(Boolean) as string[];

  for (const candidate of candidates) {
    if (workspaceFiles[candidate] !== undefined) {
      return candidate;
    }
  }

  return null;
}

export function getWorkspaceFileContent(path: string): string | null {
  const key = resolveModuleKey(path);
  return key ? workspaceFiles[key] : null;
}

export const MOCK_DIFFS: Record<string, { original: string; modified: string }> = {
  "src/components/RightPane.tsx": {
    original: `import { useState } from "react";
import TerminalPanel from "./TerminalPanel";
import "./RightPane.css";

const MOCK_TABS = ["Terminal 1", "Terminal 2", "Diff"];

export default function RightPane() {
  const [active, setActive] = useState(0);

  return (
    <section className="right">
      <div className="tabbar">
        {MOCK_TABS.map((label, i) => (
          <div
            key={label}
            className={\`tab \${i === active ? "active" : ""}\`}
            onClick={() => setActive(i)}
          >
            <span>{label}</span>
          </div>
        ))}
      </div>
      <div className="pane-body">
        xterm.js terminal will mount here
      </div>
    </section>
  );
}`,
    modified: getWorkspaceFileContent("src/components/RightPane.tsx") ?? "",
  },
  "src/components/XTerminal.tsx": {
    original: "",
    modified: getWorkspaceFileContent("src/components/XTerminal.tsx") ?? "",
  },
  "src/components/TerminalPanel.tsx": {
    original: "",
    modified: getWorkspaceFileContent("src/components/TerminalPanel.tsx") ?? "",
  },
  "src-tauri/src/pty.rs": {
    original: "",
    modified: getWorkspaceFileContent("src-tauri/src/pty.rs") ?? "",
  },
  "src-tauri/src/lib.rs": {
    original: `mod pty;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}`,
    modified: getWorkspaceFileContent("src-tauri/src/lib.rs") ?? "",
  },
  "package.json": {
    original: `{
  "name": "fold",
  "dependencies": {
    "react": "^18.3.1",
    "react-dom": "^18.3.1"
  }
}`,
    modified: getWorkspaceFileContent("package.json") ?? "",
  },
};
