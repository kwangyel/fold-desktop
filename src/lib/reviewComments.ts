import { readFile, writeFile } from "./git";
import { absoluteFoldPath } from "./plans";
import { makePromptAttachment, makeTextAttachment } from "./attachments";
import { useChatStore } from "../store/chatStore";
import { useProjectStore } from "../store/projectStore";
import { useReviewStore } from "../store/reviewStore";
import { newChatTab } from "./chatTabs";

/**
 * Conductor-style diff review comments.
 *
 * A comment is anchored to a `(file, line)` on the diff and carries a body.
 * Comments persist in a Fold data file *beside* the worktree (never inside it),
 * so they survive reloads and never dirty the git diff:
 *
 *   {workspaces}/.fold/{worktree}/review-comments.json
 *
 * Saving a comment pastes it into the review composer (the chat input under
 * the diff) as a removable attachment. Sending from that composer opens a
 * new chat with the prompt and attachments — the source file is never edited
 * by the comment.
 */
export const COMMENTS_PATH = ".fold/review-comments.json";

/** Hidden chat-store tab that backs the composer under the diff viewer. */
export const REVIEW_COMPOSER_TAB_ID = "review-composer";

/** Worktree the composer chips belong to; used to drop them on switch. */
let composerWorktree: string | null = null;

export interface DiffComment {
  id: string;
  /** Repo-relative path of the file the comment is on. */
  file: string;
  /** 1-based line on the modified side. */
  line: number;
  /** 1-based end line for a range comment; equals `line` for a single line. */
  endLine: number;
  body: string;
  /** Source text of the commented line(s), captured at save time. */
  snippet?: string;
  author: "user" | "agent";
  resolved: boolean;
  createdAt: number;
}

export type NewDiffComment = Pick<
  DiffComment,
  "file" | "line" | "endLine" | "body"
> & { snippet?: string; author?: DiffComment["author"] };

function newId(): string {
  return `cmt-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
}

/** Read all persisted comments for the active worktree ([] when none). */
export async function loadComments(): Promise<DiffComment[]> {
  try {
    const raw = await readFile(COMMENTS_PATH);
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as DiffComment[]) : [];
  } catch {
    return [];
  }
}

/** Persist the full comment list for the active worktree. */
export async function saveComments(comments: DiffComment[]): Promise<void> {
  await writeFile(COMMENTS_PATH, `${JSON.stringify(comments, null, 2)}\n`);
}

/** Build a full comment record from user input. */
export function makeComment(input: NewDiffComment): DiffComment {
  return {
    id: newId(),
    file: input.file,
    line: input.line,
    endLine: input.endLine,
    body: input.body.trim(),
    snippet: input.snippet?.trimEnd() || undefined,
    author: input.author ?? "user",
    resolved: false,
    createdAt: Date.now(),
  };
}

/** Location label for a comment, e.g. "line 12" or "lines 12–18". */
export function commentLocation(c: Pick<DiffComment, "line" | "endLine">): string {
  return c.line === c.endLine ? `line ${c.line}` : `lines ${c.line}–${c.endLine}`;
}

/** Slice `startLine`–`endLine` (1-based, inclusive) out of a file's text. */
export function snippetForRange(
  text: string,
  startLine: number,
  endLine: number,
): string {
  const lines = text.split("\n");
  const from = Math.max(0, startLine - 1);
  const to = Math.max(from + 1, endLine);
  return lines.slice(from, to).join("\n");
}

function basename(file: string): string {
  return file.split("/").pop() ?? file;
}

function chipName(c: Pick<DiffComment, "file" | "line" | "endLine" | "body">): string {
  const base = basename(c.file);
  const loc = c.line === c.endLine ? `${base}:${c.line}` : `${base}:${c.line}–${c.endLine}`;
  const note = c.body.replace(/\s+/g, " ").trim();
  if (!note) return loc;
  return note.length > 28 ? `${loc} — ${note.slice(0, 28)}…` : `${loc} — ${note}`;
}

function fenceLang(file: string): string {
  const ext = file.split(".").pop()?.toLowerCase() ?? "";
  if (!ext || ext === file.toLowerCase()) return "";
  return ext;
}

/** Attachment body for one comment: path, line snippet, and the review note. */
export function buildCommentAttachmentContent(
  c: DiffComment,
  lineText: string,
): string {
  const lang = fenceLang(c.file);
  const snippet = (lineText || c.snippet || "").trimEnd();
  const parts = [
    `Review comment on \`${c.file}\` (${commentLocation(c)}):`,
    "",
  ];
  if (snippet) {
    parts.push("```" + lang, snippet, "```", "");
  }
  parts.push("Comment:", c.body.trim());
  return parts.join("\n");
}

/**
 * Prompt-style attachment for a batch of unresolved comments. Points at the
 * on-disk JSON (absolute, since it lives outside the worktree) rather than
 * inlining source — the agent reads the comments and the code itself.
 */
export function buildAddressCommentsPrompt(
  worktreePath: string,
  unresolved: DiffComment[],
): string {
  const abs = absoluteFoldPath(worktreePath, COMMENTS_PATH);
  const summary = unresolved
    .map((c) => `- ${c.file}:${c.line} — ${c.body.replace(/\s+/g, " ").trim()}`)
    .join("\n");
  return [
    `Please address the ${unresolved.length} review comment${
      unresolved.length === 1 ? "" : "s"
    } left on this diff.`,
    "",
    `The comments are stored as JSON at ${abs} (fields: file, line, body,`,
    `resolved). Read that file for the authoritative list, then open each`,
    `referenced file, read the surrounding code, and make the requested change.`,
    "",
    "Comments:",
    summary,
    "",
    "When you finish a comment, you may set its \"resolved\" field to true in that",
    "JSON file. Explain briefly what you changed for each one.",
  ].join("\n");
}

/** Create the hidden composer tab if it does not already exist. */
export function ensureReviewComposer(): string {
  const worktree = useProjectStore.getState().activePath;
  const { selectedModel, selectedHarness } = useReviewStore.getState();
  useChatStore.getState().initializeTab(REVIEW_COMPOSER_TAB_ID, {
    model: selectedModel,
    harnessId: selectedHarness,
  });
  if (composerWorktree !== null && composerWorktree !== worktree) {
    resetReviewComposer();
  }
  composerWorktree = worktree;
  return REVIEW_COMPOSER_TAB_ID;
}

/** Drop composer chips when switching worktrees so they cannot leak. */
export function resetReviewComposer(): void {
  const store = useChatStore.getState();
  const tab = store.tabs[REVIEW_COMPOSER_TAB_ID];
  if (!tab) return;
  for (const att of [...tab.attachments]) {
    store.removeAttachment(REVIEW_COMPOSER_TAB_ID, att.id);
  }
}

/** Stable chip id so a comment can be re-attached after the chip is removed. */
export function commentAttachmentId(commentId: string): string {
  return `review-${commentId}`;
}

export function isCommentInComposer(commentId: string): boolean {
  const tab = useChatStore.getState().tabs[REVIEW_COMPOSER_TAB_ID];
  return Boolean(
    tab?.attachments.some((a) => a.id === commentAttachmentId(commentId)),
  );
}

/** Paste one comment into the review composer as a removable chip. */
export async function attachCommentToComposer(
  c: DiffComment,
  lineText: string,
): Promise<void> {
  ensureReviewComposer();
  if (isCommentInComposer(c.id)) return;
  const content = buildCommentAttachmentContent(c, lineText || c.snippet || "");
  const attachment = await makeTextAttachment(content, chipName(c));
  useChatStore.getState().addAttachment(REVIEW_COMPOSER_TAB_ID, {
    ...attachment,
    id: commentAttachmentId(c.id),
    kind: "prompt",
    // Keep the body in memory so Send inlines the line + comment, not just a path.
    content,
  });
}

/** Paste all unresolved comments into the review composer as one chip. */
export async function attachCommentsToComposer(
  unresolved: DiffComment[],
): Promise<void> {
  if (unresolved.length === 0) return;
  const worktree = useProjectStore.getState().activePath;
  if (!worktree) {
    window.alert("Open a worktree before sending review comments.");
    return;
  }
  ensureReviewComposer();
  const attachment = await makePromptAttachment(
    unresolved.length === 1 ? "Review comment" : "Review comments",
    buildAddressCommentsPrompt(worktree, unresolved),
  );
  useChatStore.getState().addAttachment(REVIEW_COMPOSER_TAB_ID, attachment);
}

/**
 * Open a new chat with the review composer's model, attachments, and `prompt`,
 * then send. The composer under the diff is cleared and stays put.
 */
export async function sendReviewComposer(prompt: string): Promise<void> {
  const worktree = useProjectStore.getState().activePath;
  if (!worktree) {
    window.alert("Open a worktree before sending.");
    return;
  }
  ensureReviewComposer();
  const draft = useChatStore.getState().tabs[REVIEW_COMPOSER_TAB_ID];
  if (!draft) return;
  if (!prompt.trim() && draft.attachments.length === 0) return;

  const attachments = [...draft.attachments];
  const chatId = newChatTab(worktree, {
    harnessId: draft.selectedHarness,
    model: draft.selectedModel,
    attachments,
  });
  const store = useChatStore.getState();
  store.setEffort(chatId, draft.modelEffort);
  store.setMode(chatId, draft.mode);
  store.setPlanMode(chatId, draft.planMode);
  for (const att of attachments) {
    store.removeAttachment(REVIEW_COMPOSER_TAB_ID, att.id);
  }
  await store.sendPrompt(chatId, prompt);
}
