import { listDir, readFile, writeFile } from "./git";
import type { HarnessId } from "./harnesses";

/**
 * Plans live in a Fold data directory *beside* the git worktree (not inside
 * it), so they never appear in the explorer or dirty the working tree:
 *
 *   ~/fold/workspaces/<project>/.fold/<worktree>/plans/
 *
 * Logical paths still use the `.fold/plans/...` prefix; the Tauri backend
 * redirects those to the sibling directory. Claude writes there via an
 * absolute `plansDirectory` (see `fold_paths` / `claude.rs`).
 */
export const PLANS_DIR = ".fold/plans";
const INDEX_PATH = `${PLANS_DIR}/index.json`;

/**
 * Absolute Fold data root for a worktree:
 * `{parent}/.fold/{worktree-name}/`.
 */
export function foldDataDir(worktreePath: string): string {
  const norm = worktreePath.replace(/\\/g, "/").replace(/\/$/, "");
  const slash = norm.lastIndexOf("/");
  const parent = slash >= 0 ? norm.slice(0, slash) : norm;
  const name = slash >= 0 ? norm.slice(slash + 1) : norm;
  return `${parent}/.fold/${name}`;
}

/** Absolute path for a logical `.fold/...` path under a worktree. */
export function absoluteFoldPath(
  worktreePath: string,
  logicalPath: string,
): string {
  const norm = logicalPath.replace(/\\/g, "/").replace(/^\.\//, "");
  const rest = norm === ".fold" ? "" : norm.replace(/^\.fold\/?/, "");
  const base = foldDataDir(worktreePath);
  return rest ? `${base}/${rest}` : base;
}

/**
 * No harness reports whether a plan was carried out, so status is derived from
 * the implementation run's own lifecycle plus the git diff it produced.
 */
export type PlanStatus =
  | "draft"
  | "approved"
  | "implementing"
  | "implemented"
  | "rejected"
  | "failed";

export type PlanRecord = {
  id: string;
  title: string;
  /** Logical `.fold/plans/...` path — the cross-harness handoff. */
  path: string;
  worktreePath: string;
  createdByHarness: HarnessId;
  createdByModel: string;
  createdAt: number;
  sourceChatTabId: string;
  status: PlanStatus;
  implementedByHarness?: HarnessId;
  implementedByModel?: string;
  implementChatTabId?: string;
  /** HEAD at the moment the plan was approved. */
  baseCommit?: string;
  /** HEAD after the implementation run finished. */
  headCommit?: string;
  changedFiles?: number;
  implementedAt?: number;
};

/** Human-readable label for a plan status. */
export const PLAN_STATUS_LABELS: Record<PlanStatus, string> = {
  draft: "Awaiting review",
  approved: "Approved",
  implementing: "Implementing",
  implemented: "Implemented",
  rejected: "Rejected",
  failed: "Failed",
};

/** Whether a path (absolute or logical) points at a plan markdown file. */
export function isPlanFilePath(path: string): boolean {
  const norm = path.replace(/\\/g, "/");
  if (!norm.endsWith(".md")) return false;
  // Logical / legacy: `.fold/plans/...`
  if (norm.includes(`${PLANS_DIR}/`)) return true;
  // Absolute sibling layout: `.../.fold/<worktree>/plans/...`
  return /\/\.fold\/[^/]+\/plans\//.test(norm);
}

/**
 * Turn an absolute or messy path into a logical `.fold/...` path that
 * `readFile` accepts. Claude Code often reports absolute plan paths via
 * Write / ExitPlanMode.
 */
export function toRepoRelativePath(
  path: string,
  worktreePath?: string,
): string {
  let norm = path.replace(/\\/g, "/").trim();
  if (!norm) return norm;

  if (worktreePath) {
    const root = worktreePath.replace(/\\/g, "/").replace(/\/$/, "");
    if (norm === root) return "";
    if (norm.startsWith(`${root}/`)) {
      return norm.slice(root.length + 1);
    }
    // Absolute sibling Fold data dir for this worktree.
    const data = foldDataDir(root);
    if (norm === data) return ".fold";
    if (norm.startsWith(`${data}/`)) {
      return `.fold/${norm.slice(data.length + 1)}`;
    }
  }

  // Any `.../.fold/<name>/plans/...` absolute path → logical `.fold/plans/...`
  const absFold = norm.match(/\/\.fold\/[^/]+\/(.+)$/);
  if (absFold) return `.fold/${absFold[1]}`;

  // Fall back to the plans-directory suffix when the absolute root differs.
  const plansIdx = norm.indexOf(`${PLANS_DIR}/`);
  if (plansIdx >= 0) return norm.slice(plansIdx);

  if (norm.startsWith("./")) norm = norm.slice(2);
  return norm;
}

/**
 * Read a specific plan markdown file from disk. Does **not** fall back to other
 * plans in the directory — that previously caused unrelated older plans (often
 * the longest file) to be shown for a new planning run.
 */
export async function loadPlanMarkdownFromDisk(
  preferredPath?: string | null,
  worktreePath?: string,
): Promise<{ path: string; markdown: string } | null> {
  if (!preferredPath) return null;
  const rel = toRepoRelativePath(preferredPath, worktreePath);
  if (!rel || !isPlanFilePath(rel)) return null;
  try {
    const markdown = await readFile(rel);
    if (!markdown.trim()) return null;
    return { path: rel, markdown };
  } catch {
    return null;
  }
}

/**
 * Find a plan markdown that is not yet in the index — used only for Claude
 * Code when ExitPlanMode fires without a usable path. Prefer `plan-<timestamp>-*`
 * filenames (newest first); never prefer "longest body" (that picks old plans).
 */
export async function findUnindexedPlanMarkdown(): Promise<{
  path: string;
  markdown: string;
} | null> {
  try {
    const index = await loadPlanIndex();
    const known = new Set(
      index.map((r) => toRepoRelativePath(r.path, r.worktreePath)),
    );
    const entries = await listDir(PLANS_DIR);
    const mdFiles = entries.filter((e) => !e.isDir && e.name.endsWith(".md"));

    const candidates = mdFiles
      .filter((e) => !known.has(e.path))
      .map((e) => {
        const ts = e.name.match(/^plan-(\d+)/)?.[1];
        return { entry: e, ts: ts ? Number(ts) : 0 };
      })
      .sort((a, b) => b.ts - a.ts);

    for (const { entry } of candidates) {
      try {
        const markdown = await readFile(entry.path);
        if (markdown.trim()) return { path: entry.path, markdown };
      } catch {
        // Skip unreadable entries.
      }
    }
    return null;
  } catch {
    return null;
  }
}

/** Extract a plan id from a `.fold/plans/<id>.md` path when possible. */
export function planIdFromPath(path: string): string | null {
  const base = path.replace(/\\/g, "/").split("/").pop() ?? "";
  const match = base.match(/^(plan-[\w-]+)\.md$/i);
  return match ? match[1] : null;
}

/** Derive a plan title from its markdown, falling back to the prompt. */
export function planTitle(markdown: string, fallback: string): string {
  for (const line of markdown.split("\n")) {
    const heading = line.match(/^#{1,3}\s+(.*\S)/);
    if (heading) return heading[1].trim();
  }
  const firstWords = fallback.trim().split(/\s+/).slice(0, 10).join(" ");
  return firstWords || "Untitled plan";
}

/** Read the plan index for the active worktree. Missing index reads as empty. */
export async function loadPlanIndex(): Promise<PlanRecord[]> {
  try {
    const raw = await readFile(INDEX_PATH);
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as PlanRecord[]) : [];
  } catch {
    // No plans written yet for this worktree.
    return [];
  }
}

async function savePlanIndex(records: PlanRecord[]): Promise<void> {
  await writeFile(INDEX_PATH, `${JSON.stringify(records, null, 2)}\n`);
}

/** Insert or replace a record, keeping the index newest-first. */
export async function upsertPlan(record: PlanRecord): Promise<PlanRecord[]> {
  const records = await loadPlanIndex();
  const next = [record, ...records.filter((r) => r.id !== record.id)].sort(
    (a, b) => b.createdAt - a.createdAt,
  );
  await savePlanIndex(next);
  return next;
}

/** Apply a partial update to one record. No-op when the id is unknown. */
export async function patchPlan(
  id: string,
  patch: Partial<PlanRecord>,
): Promise<PlanRecord[]> {
  const records = await loadPlanIndex();
  if (!records.some((r) => r.id === id)) return records;
  const next = records.map((r) => (r.id === id ? { ...r, ...patch } : r));
  await savePlanIndex(next);
  return next;
}

/** Read a plan's markdown body. */
export async function readPlanMarkdown(record: PlanRecord): Promise<string> {
  const rel = toRepoRelativePath(record.path, record.worktreePath);
  return readFile(rel);
}

/** Write a plan body and return its logical `.fold/plans/...` path. */
export async function writePlanMarkdown(
  id: string,
  markdown: string,
): Promise<string> {
  const path = `${PLANS_DIR}/${id}.md`;
  await writeFile(path, markdown.endsWith("\n") ? markdown : `${markdown}\n`);
  return path;
}

/** Generate a plan id that is also a safe filename. */
export function newPlanId(): string {
  return `plan-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
}

/**
 * Prompt handed to the harness chosen to implement a plan. It points at the
 * plan file rather than inlining it, so the same prompt works no matter which
 * harness wrote the plan or which one is implementing it.
 *
 * Uses an absolute path because plans live outside the git worktree.
 */
export function buildImplementPrompt(record: PlanRecord): string {
  const abs = absoluteFoldPath(
    record.worktreePath,
    toRepoRelativePath(record.path, record.worktreePath),
  );
  return [
    `Implement the plan at ${abs}.`,
    "",
    "Read that file first, then carry it out in full. Follow the plan's own",
    "verification section before reporting that you are done. If part of the",
    "plan turns out to be wrong or infeasible, complete everything else and say",
    "plainly what you left out and why.",
  ].join("\n");
}

/**
 * Soft plan-mode wrapper for Cursor Agent CLI.
 *
 * Cursor's native `--mode plan` hangs in non-interactive `-p` mode: after
 * researching it calls `create_plan` and waits for a UI client that never
 * responds (known Cursor CLI bug). Instead we stay in normal agent mode and
 * instruct the model to research, write the plan to a Fold path, and stop
 * without editing source files.
 *
 * `planPath` should be workspace-relative (`.fold/plans/...`) so Cursor's
 * Write tool accepts it; Fold migrates the file out of the worktree on read.
 */
export function buildCursorPlanPrompt(
  userPrompt: string,
  planPath: string,
): string {
  return [
    "You are in Fold PLAN MODE (read-only planning). This is NOT implementation.",
    "",
    "HARD RULES — violating these fails the task:",
    "1. Research with read / search / grep / list tools only.",
    "2. Do NOT edit, create, or delete any file except the single plan file below.",
    "3. Do NOT run mutating shell commands (no installs, no git commits, no codegen).",
    "4. Do NOT implement the feature. Do NOT apply the plan. Planning only.",
    "5. If requirements are ambiguous, ask with the fold_ask_user MCP tool,",
    "   then continue planning.",
    "6. Write the complete implementation plan as markdown to this exact path",
    `   (relative to the workspace root): ${planPath}`,
    "7. The plan must include: overview, approach, files to change, step-by-step",
    "   tasks, and a short verification section.",
    "8. After writing that ONE file, print a one-line confirmation and STOP",
    "   immediately. Do not wait for approval. Do not call create_plan.",
    "",
    "User request:",
    userPrompt.trim(),
  ].join("\n");
}
