import { Channel, invoke } from "@tauri-apps/api/core";
import { isTauri } from "./git";

export interface GhStatus {
  authenticated: boolean;
  username: string | null;
}

export interface GhIssue {
  number: number;
  title: string;
  body: string | null;
  url: string;
  state: string;
  labels: string[];
  assignees: string[];
}

/** Open issues for the repo at `repoPath`; searches when `query` is set. */
export async function ghListIssues(
  repoPath: string,
  query?: string,
  first?: number,
): Promise<GhIssue[]> {
  if (!isTauri()) return [];
  return invoke<GhIssue[]>("gh_list_issues", {
    repoPath,
    query: query?.trim() || null,
    first: first ?? null,
  });
}

/** Fetch one issue by number from the repo at `repoPath`. */
export async function ghGetIssue(
  repoPath: string,
  number: number,
): Promise<GhIssue | null> {
  if (!isTauri()) return null;
  return invoke<GhIssue | null>("gh_get_issue", { repoPath, number });
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

/** Whether a repo name can be created under the authenticated GitHub account. */
export interface GhRepoNameCheck {
  available: boolean;
  message: string | null;
  owner: string | null;
}

/** Check if `name` is creatable as a new GitHub repository for the signed-in user. */
export async function ghRepoNameCheck(name: string): Promise<GhRepoNameCheck> {
  if (!isTauri()) {
    return {
      available: Boolean(name.trim()),
      message: name.trim() ? null : "Repository name is required",
      owner: null,
    };
  }
  return invoke<GhRepoNameCheck>("gh_repo_name_check", { name });
}

/** Linked GitHub account or organization. */
export interface GhOwner {
  login: string;
  avatarUrl: string;
  kind: "user" | "org" | string;
}

/** Repository from list / search. */
export interface GhRepo {
  name: string;
  fullName: string;
  description: string | null;
  private: boolean;
  updatedAt: string | null;
}

/** Authenticated user plus organizations they can access. */
export async function ghListOwners(): Promise<GhOwner[]> {
  if (!isTauri()) return [];
  return invoke<GhOwner[]>("gh_list_owners");
}

/**
 * List or search repos for an owner. Empty `query` returns recent repos
 * (default limit 5). With a query, searches that owner's repositories.
 */
export async function ghListRepos(
  owner: string,
  query?: string,
  limit = 5,
  ownerKind?: string,
): Promise<GhRepo[]> {
  if (!isTauri()) return [];
  return invoke<GhRepo[]>("gh_list_repos", {
    owner,
    query: query?.trim() ? query.trim() : null,
    limit,
    ownerKind: ownerKind ?? null,
  });
}

/** Default parent folder for cloning: `~/fold/projects`. */
export async function defaultCloneParent(): Promise<string> {
  if (!isTauri()) return "~/fold/projects";
  return invoke<string>("default_clone_parent");
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

/**
 * Shared PR lookup for the pollers (`CreatePrButton`, `CenterPane`).
 *
 * Every call shells out to `gh pr view` — a network round-trip — so results are
 * reused for a short window and concurrent callers share one request instead of
 * each spawning their own `gh` process on their own timer.
 */
const PR_CACHE_TTL_MS = 20_000;

type PrCacheEntry = { at: number; value: PrInfo | null };

const prCache = new Map<string, PrCacheEntry>();
const prInflight = new Map<string, Promise<PrInfo | null>>();

export async function ghPrViewCached(
  worktreePath: string,
  opts?: { force?: boolean },
): Promise<PrInfo | null> {
  if (!opts?.force) {
    const cached = prCache.get(worktreePath);
    if (cached && Date.now() - cached.at < PR_CACHE_TTL_MS) return cached.value;
  }

  const pending = prInflight.get(worktreePath);
  if (pending) return pending;

  const request = ghPrView(worktreePath)
    .then((value) => {
      prCache.set(worktreePath, { at: Date.now(), value });
      return value;
    })
    .finally(() => {
      prInflight.delete(worktreePath);
    });

  prInflight.set(worktreePath, request);
  return request;
}

/** Drop the cached PR for a worktree (after creating or merging one). */
export function invalidatePrCache(worktreePath?: string): void {
  if (worktreePath) prCache.delete(worktreePath);
  else prCache.clear();
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
