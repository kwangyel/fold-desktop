import { invoke } from "@tauri-apps/api/core";
import { MOCK_DIFFS } from "../data/mockWorkspace";

export interface ChangedFile {
  path: string;
  status: "modified" | "added" | "deleted";
  additions: number;
  deletions: number;
  isUntracked: boolean;
}

export interface FileDiff {
  original: string;
  modified: string;
}

export interface DirEntry {
  name: string;
  path: string;
  isDir: boolean;
}

export function isTauri(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

// --- Browser fallback (mock data) --------------------------------------------

const MOCK_CHANGES: ChangedFile[] = [
  { path: "src/components/RightPane.tsx", status: "modified", additions: 42, deletions: 18, isUntracked: false },
  { path: "src/components/XTerminal.tsx", status: "added", additions: 95, deletions: 0, isUntracked: true },
  { path: "src/components/TerminalPanel.tsx", status: "added", additions: 68, deletions: 0, isUntracked: true },
  { path: "src-tauri/src/pty.rs", status: "added", additions: 102, deletions: 0, isUntracked: true },
  { path: "src-tauri/src/lib.rs", status: "modified", additions: 55, deletions: 3, isUntracked: false },
  { path: "package.json", status: "modified", additions: 2, deletions: 0, isUntracked: false },
];

// --- Public API --------------------------------------------------------------

export async function getChanges(): Promise<ChangedFile[]> {
  if (!isTauri()) return MOCK_CHANGES;
  return invoke<ChangedFile[]>("git_changes");
}

export async function getFileDiff(path: string): Promise<FileDiff> {
  if (!isTauri()) {
    const diff = MOCK_DIFFS[path];
    return { original: diff?.original ?? "", modified: diff?.modified ?? "" };
  }
  return invoke<FileDiff>("git_file_diff", { path });
}

export async function discardFile(path: string, isUntracked: boolean): Promise<void> {
  if (!isTauri()) return;
  await invoke("git_discard", { path, isUntracked });
}

export async function listDir(path: string): Promise<DirEntry[]> {
  if (!isTauri()) return [];
  return invoke<DirEntry[]>("list_dir", { path });
}

export async function readFile(path: string): Promise<string> {
  if (!isTauri()) {
    const diff = MOCK_DIFFS[path];
    return diff?.modified ?? "";
  }
  return invoke<string>("read_file", { path });
}

export async function writeFile(path: string, content: string): Promise<void> {
  if (!isTauri()) return;
  await invoke("write_file", { path, content });
}
