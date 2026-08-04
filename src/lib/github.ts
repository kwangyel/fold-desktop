import { Channel, invoke } from "@tauri-apps/api/core";
import { isTauri } from "./git";

export interface GhStatus {
  authenticated: boolean;
  username: string | null;
}

/** Raw output chunk from the streamed `gh auth login` process. */
export type GhOutput = Uint8Array | number[];

/**
 * Keep login Channels reachable so Tauri can deliver streamed output after
 * `invoke("gh_auth_login")` returns (spawn is non-blocking). Cleared on cancel
 * / finish / process exit.
 */
const retainedLoginChannels: Channel<GhOutput>[] = [];

function retainLoginChannel(channel: Channel<GhOutput>): void {
  retainedLoginChannels.push(channel);
}

/** Drop retained login Channels (call after finish / cancel / exit). */
export function ghAuthReleaseChannel(): void {
  retainedLoginChannels.length = 0;
}

/** Current GitHub auth state via the `gh` CLI. */
export async function ghAuthStatus(): Promise<GhStatus> {
  if (!isTauri()) return { authenticated: false, username: null };
  return invoke<GhStatus>("gh_auth_status");
}

/**
 * Start the interactive browser login. Output from `gh auth login --web` is
 * streamed to `onOutput`; the caller parses the one-time code from it.
 */
export async function ghAuthLogin(
  onOutput: (chunk: GhOutput) => void,
): Promise<void> {
  if (!isTauri()) {
    throw new Error("GitHub connection requires the Tauri desktop app.");
  }
  const output = new Channel<GhOutput>();
  output.onmessage = onOutput;
  retainLoginChannel(output);
  try {
    await invoke("gh_auth_login", { onOutput: output });
  } catch (e) {
    ghAuthReleaseChannel();
    throw e;
  }
}

/** Open a URL in the user's default browser (via the OS opener). */
export async function openExternal(url: string): Promise<void> {
  if (!isTauri()) {
    window.open(url, "_blank");
    return;
  }
  await invoke("open_external", { url });
}

/** Cancel a running login flow (stops the `gh auth login` process). */
export async function ghAuthCancel(): Promise<void> {
  ghAuthReleaseChannel();
  if (!isTauri()) return;
  await invoke("gh_auth_cancel");
}

/** Log out of GitHub (removes gh's stored credentials for github.com). */
export async function ghAuthLogout(): Promise<void> {
  if (!isTauri()) return;
  await invoke("gh_auth_logout");
}

/** Open the GitHub PR creation page in the browser via `gh pr create --web`. */
export async function ghPrCreateWeb(worktreePath: string): Promise<void> {
  if (!isTauri()) return;
  await invoke("gh_pr_create_web", { worktreePath });
}

export type PrMergeMethod = "squash" | "merge" | "rebase";

export interface PrFile {
  path: string;
  additions: number;
  deletions: number;
}

/** PR details for the current branch, as returned by `gh pr view --json`. */
export interface PrInfo {
  number: number;
  title: string;
  body: string;
  state: string;
  author: { login: string } | null;
  headRefName: string;
  baseRefName: string;
  url: string;
  isDraft: boolean;
  mergeable: string;
  files: PrFile[];
  additions: number;
  deletions: number;
  changedFiles: number;
}

/**
 * Fetch the PR for the current branch. Resolves to `null` when no PR exists yet
 * (the backend signals this with a `NO_PR` error). Other errors propagate.
 */
export async function ghPrView(worktreePath: string): Promise<PrInfo | null> {
  if (!isTauri()) return null;
  try {
    const json = await invoke<string>("gh_pr_view", { worktreePath });
    return JSON.parse(json) as PrInfo;
  } catch (e) {
    if (String(e).startsWith("NO_PR")) return null;
    throw e;
  }
}

/** Resolve the repository's preferred merge method. */
export async function ghPrMergeMethod(worktreePath: string): Promise<PrMergeMethod> {
  if (!isTauri()) return "squash";
  return invoke<PrMergeMethod>("gh_pr_merge_method", { worktreePath });
}

/** Merge the PR for the current branch using the given method. */
export async function ghPrMerge(
  worktreePath: string,
  method: PrMergeMethod,
): Promise<void> {
  if (!isTauri()) return;
  await invoke("gh_pr_merge", { worktreePath, method });
}
