import { listChats, loadChat, messageFromRow } from "./chats";
import { readFile, writeFile } from "./git";
import {
  ghCloseIssue,
  ghPrViewCached,
  type GhIssue,
  type PrInfo,
} from "./github";
import { linearCloseIssue, type LinearIssue } from "./linear";
import { resolveIssueAttachment } from "./attachments";
import type { LinkedIssueRef } from "../store/chatStore";
import { useProjectStore } from "../store/projectStore";

const LINKED_ISSUES_FILE = ".fold/linked-issues.json";

export type LinkedIssue = LinkedIssueRef & {
  closed: boolean;
  closedAt?: string;
  closedByPr?: number;
};

type FileShape = { issues?: LinkedIssue[] };

const inflight = new Map<string, Promise<void>>();

export function linkedIssueFromGithub(issue: GhIssue): LinkedIssueRef {
  return {
    source: "github",
    id: String(issue.number),
    identifier: `#${issue.number}`,
    title: issue.title,
    url: issue.url,
  };
}

export function linkedIssueFromLinear(issue: LinearIssue): LinkedIssueRef {
  return {
    source: "linear",
    id: issue.id,
    identifier: issue.identifier,
    title: issue.title,
    url: issue.url,
  };
}

async function loadLinkedIssues(): Promise<LinkedIssue[]> {
  try {
    const raw = await readFile(LINKED_ISSUES_FILE);
    const parsed = JSON.parse(raw) as FileShape;
    return Array.isArray(parsed.issues) ? parsed.issues : [];
  } catch {
    return [];
  }
}

async function saveLinkedIssues(issues: LinkedIssue[]): Promise<void> {
  const body = `${JSON.stringify({ issues }, null, 2)}\n`;
  await writeFile(LINKED_ISSUES_FILE, body);
}

function sameIssue(a: LinkedIssueRef, b: LinkedIssueRef): boolean {
  if (a.source !== b.source) return false;
  if (a.id === b.id) return true;
  // Recovered Linear chips use the identifier when the UUID was not persisted.
  return a.source === "linear" && a.identifier === b.identifier;
}

async function recoverIssueLinksFromChats(
  worktreePath: string,
): Promise<LinkedIssueRef[]> {
  const chats = await listChats(worktreePath);
  const found: LinkedIssueRef[] = [];
  for (const chat of chats) {
    const record = await loadChat(worktreePath, chat.id);
    if (!record) continue;
    for (const row of record.messages) {
      const attachments = messageFromRow(row).attachments;
      if (!attachments?.length) continue;
      for (const att of attachments) {
        const ref = await resolveIssueAttachment(att);
        if (!ref) continue;
        if (!found.some((existing) => sameIssue(existing, ref))) {
          found.push(ref);
        }
      }
    }
  }
  return found;
}

/**
 * Linked issues on disk, plus any GitHub/Linear chips already sent in this
 * worktree's chats (so attaching before this file existed still counts).
 */
async function loadLinkedIssuesOrRecover(
  worktreePath?: string | null,
): Promise<LinkedIssue[]> {
  const existing = await loadLinkedIssues();
  if (existing.some((issue) => !issue.closed)) return existing;

  const path = worktreePath ?? useProjectStore.getState().activePath;
  if (!path) return existing;

  const recovered = await recoverIssueLinksFromChats(path);
  if (recovered.length === 0) return existing;

  let changed = false;
  for (const ref of recovered) {
    if (existing.some((issue) => sameIssue(issue, ref))) continue;
    existing.push({ ...ref, closed: false });
    changed = true;
  }
  if (changed) {
    try {
      await saveLinkedIssues(existing);
    } catch (e) {
      console.warn("Failed to persist recovered linked issues:", e);
    }
  }
  return existing;
}

/** Remember that this worktree is implementing `issue`. */
export async function linkWorktreeIssue(issue: LinkedIssueRef): Promise<void> {
  try {
    const issues = await loadLinkedIssues();
    if (issues.some((existing) => sameIssue(existing, issue))) return;
    issues.push({ ...issue, closed: false });
    await saveLinkedIssues(issues);
  } catch (e) {
    console.warn("Failed to persist linked issue:", e);
  }
}

/** Drop a linked issue that was removed from the composer before send. */
export async function unlinkWorktreeIssue(
  source: LinkedIssueRef["source"],
  id: string,
): Promise<void> {
  try {
    const issues = await loadLinkedIssues();
    const next = issues.filter(
      (issue) => !(issue.source === source && issue.id === id && !issue.closed),
    );
    if (next.length === issues.length) return;
    await saveLinkedIssues(next);
  } catch (e) {
    console.warn("Failed to unlink issue:", e);
  }
}

export async function listLinkedIssues(
  worktreePath?: string | null,
): Promise<LinkedIssue[]> {
  return loadLinkedIssuesOrRecover(worktreePath);
}

function closeComment(issue: LinkedIssue, pr: PrInfo): string {
  return `Closed by Fold when PR #${pr.number} was opened: ${pr.url}`;
}

async function closeOne(issue: LinkedIssue, pr: PrInfo, repoPath: string): Promise<void> {
  if (issue.source === "github") {
    const number = Number(issue.id);
    if (!Number.isFinite(number) || number <= 0) {
      throw new Error(`Invalid GitHub issue number: ${issue.id}`);
    }
    await ghCloseIssue(repoPath, number, closeComment(issue, pr));
    return;
  }
  await linearCloseIssue(issue.id);
}

/**
 * Close GitHub and Linear issues linked to the active worktree now that a PR
 * exists. Idempotent: already-closed rows are skipped, and concurrent callers
 * share one in-flight pass.
 */
export async function closeLinkedIssuesIfPrOpen(
  pr: PrInfo | null,
  worktreePath?: string | null,
): Promise<void> {
  if (!pr) return;
  const path = worktreePath ?? useProjectStore.getState().activePath;
  if (!path) return;
  if (useProjectStore.getState().activePath !== path) return;

  const pending = inflight.get(path);
  if (pending) return pending;

  const run = (async () => {
    const issues = await loadLinkedIssuesOrRecover(path);
    const open = issues.filter((issue) => !issue.closed);
    if (open.length === 0) return;

    let changed = false;
    for (const issue of open) {
      try {
        await closeOne(issue, pr, path);
        issue.closed = true;
        issue.closedAt = new Date().toISOString();
        issue.closedByPr = pr.number;
        changed = true;
      } catch (e) {
        console.warn(
          `Failed to close ${issue.source} issue ${issue.identifier}:`,
          e,
        );
      }
    }
    if (changed) await saveLinkedIssues(issues);
  })().finally(() => {
    inflight.delete(path);
  });

  inflight.set(path, run);
  return run;
}

/** After linking an issue, close it immediately if this branch already has a PR. */
export async function linkAndCloseIfPrExists(issue: LinkedIssueRef): Promise<void> {
  await linkWorktreeIssue(issue);
  const path = useProjectStore.getState().activePath;
  if (!path) return;
  try {
    const pr = await ghPrViewCached(path);
    await closeLinkedIssuesIfPrOpen(pr, path);
  } catch {
    // No GitHub remote / no PR yet — close later when one appears.
  }
}
