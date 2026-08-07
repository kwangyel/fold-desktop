import { invoke } from "@tauri-apps/api/core";
import { MOCK_DIFFS } from "../data/mockWorkspace";

export interface ChangedFile {
  path: string;
  status: "modified" | "added" | "deleted";
  additions: number;
  deletions: number;
  isUntracked: boolean;
  staged: boolean;
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

let mockChanges: ChangedFile[] = [
  { path: "src/components/RightPane.tsx", status: "modified", additions: 42, deletions: 18, isUntracked: false, staged: false },
  { path: "src/components/XTerminal.tsx", status: "added", additions: 95, deletions: 0, isUntracked: true, staged: false },
  { path: "src/components/TerminalPanel.tsx", status: "added", additions: 68, deletions: 0, isUntracked: true, staged: false },
  { path: "src-tauri/src/pty.rs", status: "added", additions: 102, deletions: 0, isUntracked: true, staged: true },
  { path: "src-tauri/src/lib.rs", status: "modified", additions: 55, deletions: 3, isUntracked: false, staged: true },
  { path: "package.json", status: "modified", additions: 2, deletions: 0, isUntracked: false, staged: false },
];

// --- Public API --------------------------------------------------------------

export async function getChanges(): Promise<ChangedFile[]> {
  if (!isTauri()) return mockChanges.map((c) => ({ ...c }));
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
  if (!isTauri()) {
    mockChanges = mockChanges.filter((c) => c.path !== path);
    return;
  }
  await invoke("git_discard", { path, isUntracked });
}

export async function stageFile(path: string): Promise<void> {
  if (!isTauri()) {
    mockChanges = mockChanges.map((c) =>
      c.path === path && !c.staged ? { ...c, staged: true, isUntracked: false } : c,
    );
    return;
  }
  await invoke("git_stage", { path });
}

export async function unstageFile(path: string): Promise<void> {
  if (!isTauri()) {
    mockChanges = mockChanges.map((c) =>
      c.path === path && c.staged ? { ...c, staged: false } : c,
    );
    return;
  }
  await invoke("git_unstage", { path });
}

export async function stageAll(): Promise<void> {
  if (!isTauri()) {
    mockChanges = mockChanges.map((c) => ({ ...c, staged: true, isUntracked: false }));
    return;
  }
  await invoke("git_stage_all");
}

export async function unstageAll(): Promise<void> {
  if (!isTauri()) {
    mockChanges = mockChanges.map((c) => ({ ...c, staged: false }));
    return;
  }
  await invoke("git_unstage_all");
}

export async function commit(message: string): Promise<void> {
  if (!isTauri()) {
    mockChanges = mockChanges.filter((c) => !c.staged);
    return;
  }
  await invoke("git_commit", { message });
}

export async function push(): Promise<void> {
  if (!isTauri()) return;
  await invoke("git_push");
}

export async function getStagedDiff(): Promise<string> {
  if (!isTauri()) {
    const staged = mockChanges.filter((c) => c.staged);
    return staged.map((c) => `diff --git a/${c.path} b/${c.path}\n+ mock change`).join("\n");
  }
  return invoke<string>("git_staged_diff");
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

/** Write raw bytes to a repo-relative path (e.g. pasted images under `.fold/`). */
export async function writeBytes(path: string, bytes: number[] | Uint8Array): Promise<void> {
  if (!isTauri()) return;
  const payload = Array.isArray(bytes) ? bytes : Array.from(bytes);
  await invoke("write_bytes", { path, bytes: payload });
}

/** Returns true if the repo at `path` has a GitHub remote as `origin`. */
export async function gitGithubRemote(path: string): Promise<boolean> {
  if (!isTauri()) return false;
  return invoke<boolean>("git_github_remote", { path });
}

/** GitHub owner (user or org) from `origin`, or null if not a GitHub remote. */
export async function gitGithubOwner(path: string): Promise<string | null> {
  if (!isTauri()) return null;
  return invoke<string | null>("git_github_owner", { path });
}

export interface GithubRepoOwner {
  login: string;
  avatarUrl: string;
}

/** GitHub repo owner + avatar URL fetched from GitHub, or null if not a remote repo. */
export async function gitGithubRepoOwner(
  path: string,
): Promise<GithubRepoOwner | null> {
  if (!isTauri()) return null;
  return invoke<GithubRepoOwner | null>("git_github_repo_owner", { path });
}

/**
 * Owner lookup shared across the app. The underlying command shells out to
 * `gh repo view` (a network round-trip), and the sidebar asks for one per
 * project every time it mounts — so results are cached for the session and
 * concurrent callers share a single in-flight request.
 */
const ownerCache = new Map<string, GithubRepoOwner | null>();
const ownerInflight = new Map<string, Promise<GithubRepoOwner | null>>();

export async function gitGithubRepoOwnerCached(
  path: string,
): Promise<GithubRepoOwner | null> {
  const cached = ownerCache.get(path);
  if (cached !== undefined) return cached;

  const pending = ownerInflight.get(path);
  if (pending) return pending;

  const request = gitGithubRepoOwner(path)
    .then((owner) => {
      ownerCache.set(path, owner);
      return owner;
    })
    .catch(() => {
      // Don't cache failures — a transient `gh` error shouldn't hide the avatar
      // for the rest of the session.
      return null;
    })
    .finally(() => {
      ownerInflight.delete(path);
    });

  ownerInflight.set(path, request);
  return request;
}

/** Current HEAD commit SHA for the repo at `path` ("" if there are no commits). */
export async function gitHeadCommit(path: string): Promise<string> {
  if (!isTauri()) return "";
  return invoke<string>("git_head_commit", { path });
}

/** How many files differ between `base` and the working tree (untracked included). */
export async function gitChangedSince(
  path: string,
  base: string,
): Promise<number> {
  if (!isTauri()) return 0;
  return invoke<number>("git_changed_since", { path, base });
}

/** List local branch names for the repo at `path`. */
export async function gitListBranches(path: string): Promise<string[]> {
  if (!isTauri()) return ["main"];
  return invoke<string[]>("git_list_branches", { path });
}

export interface MergeReadiness {
  currentBranch: string;
  dirty: boolean;
  aheadCount: number;
  hasConflicts: boolean;
  safeToMerge: boolean;
  reason: string;
}

/** Whether the branch at `path` is ready to merge into `targetBranch`. */
export async function gitMergeReadiness(
  path: string,
  targetBranch: string,
): Promise<MergeReadiness> {
  if (!isTauri()) {
    return {
      currentBranch: "feature",
      dirty: false,
      aheadCount: 1,
      hasConflicts: false,
      safeToMerge: true,
      reason: "",
    };
  }
  return invoke<MergeReadiness>("git_merge_readiness", { path, targetBranch });
}

/**
 * Merge `sourceBranch` into `targetBranch` in the main checkout at `repoPath`.
 * Must run in the main repo because worktrees keep the feature branch checked out.
 */
export async function gitMergeToTarget(
  repoPath: string,
  sourceBranch: string,
  targetBranch: string,
): Promise<void> {
  if (!isTauri()) return;
  await invoke("git_merge_to_target", { repoPath, sourceBranch, targetBranch });
}

/** Rebase the branch checked out at `path` onto `targetBranch`. */
export async function gitRebaseOntoTarget(
  path: string,
  targetBranch: string,
): Promise<void> {
  if (!isTauri()) return;
  await invoke("git_rebase_onto_target", { path, targetBranch });
}
