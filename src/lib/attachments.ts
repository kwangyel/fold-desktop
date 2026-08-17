import type { Attachment, AttachmentKind, LinkedIssueRef } from '../store/chatStore';
import type { GhIssue } from './github';
import type { LinearIssue } from './linear';
import { readFile, writeBytes, writeFile } from './git';
import { absoluteFoldPath } from './plans';

const ATTACHMENTS_DIR = '.fold/attachments';

const ID_CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';

/** Conductor-style short id for the attachment folder. */
function shortId(length = 6): string {
  let id = '';
  const bytes = crypto.getRandomValues(new Uint8Array(length));
  for (let i = 0; i < length; i += 1) {
    id += ID_CHARS[bytes[i]! % ID_CHARS.length]!;
  }
  return id;
}

function sanitizeFilename(name: string, fallback: string): string {
  const cleaned = name
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 120);
  return cleaned || fallback;
}

function pad2(n: number): string {
  return String(n).padStart(2, '0');
}

/** `pasted_text_YYYY-MM-DD_HH-MM-SS.txt` — matches Conductor's naming. */
function pastedTextFilename(date = new Date()): string {
  const stamp = [
    date.getFullYear(),
    pad2(date.getMonth() + 1),
    pad2(date.getDate()),
  ].join('-');
  const time = [pad2(date.getHours()), pad2(date.getMinutes()), pad2(date.getSeconds())].join(
    '-',
  );
  return `pasted_text_${stamp}_${time}.txt`;
}

function extForMime(mime: string): string {
  if (mime.includes('jpeg')) return 'jpg';
  if (mime.includes('webp')) return 'webp';
  if (mime.includes('gif')) return 'gif';
  if (mime.includes('svg')) return 'svg';
  return 'png';
}

function attachmentPath(id: string, filename: string): string {
  return `${ATTACHMENTS_DIR}/${id}/${filename}`;
}

/**
 * `.fold/...` is stored beside the git worktree, not inside it. Agents whose
 * cwd is the worktree cannot read the logical path — give them the absolute
 * sibling path instead (same pattern as plans / review comments).
 */
function pathForAgent(path: string, worktreePath?: string | null): string {
  if (!worktreePath) return path;
  const norm = path.replace(/\\/g, '/');
  if (norm === '.fold' || norm.startsWith('.fold/')) {
    return absoluteFoldPath(worktreePath, path);
  }
  return path;
}

function chipLabelFromText(text: string, fallback: string): string {
  const trimmed = text.replace(/\s+$/, '');
  const oneLine = trimmed.replace(/\s+/g, ' ').trim();
  if (!oneLine) return fallback;
  return oneLine.length > 40 ? `${oneLine.slice(0, 40)}…` : oneLine;
}

async function writeTextAttachmentFile(
  id: string,
  filename: string,
  content: string,
): Promise<string> {
  const path = attachmentPath(id, filename);
  await writeFile(path, content.endsWith('\n') ? content : `${content}\n`);
  return path;
}

async function writeImageAttachmentFile(
  id: string,
  filename: string,
  dataUrl: string,
): Promise<{ path: string; mime: string } | null> {
  const match = /^data:([^;]+);base64,(.+)$/i.exec(dataUrl);
  if (!match) return null;
  const mime = match[1] || 'image/png';
  const binary = atob(match[2]!);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i);
  }
  const path = attachmentPath(id, filename);
  await writeBytes(path, bytes);
  return { path, mime };
}

function readAsDataUrl(file: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result ?? ''));
    reader.onerror = () => reject(reader.error ?? new Error('Failed to read file'));
    reader.readAsDataURL(file);
  });
}

function readAsArrayBuffer(file: Blob): Promise<ArrayBuffer> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as ArrayBuffer);
    reader.onerror = () => reject(reader.error ?? new Error('Failed to read file'));
    reader.readAsArrayBuffer(file);
  });
}

/**
 * Persist pasted text to `.fold/attachments/<id>/pasted_text_….txt`
 * and return a chip that points at that path (Conductor-style).
 */
export async function makeTextAttachment(
  text: string,
  displayName?: string,
): Promise<Attachment> {
  const id = shortId();
  const filename = pastedTextFilename();
  const name = displayName ?? chipLabelFromText(text, 'Pasted text');
  try {
    const path = await writeTextAttachmentFile(id, filename, text);
    return {
      id,
      name,
      kind: 'text',
      type: 'text/plain',
      size: text.length,
      path,
      content: text,
    };
  } catch {
    return {
      id,
      name,
      kind: 'text',
      type: 'text/plain',
      size: text.length,
      content: text,
    };
  }
}

/**
 * Persist a prompt chip (e.g. Create PR) as a named markdown/text file under
 * `.fold/attachments/<id>/`.
 */
export async function makePromptAttachment(
  name: string,
  content: string,
): Promise<Attachment> {
  const id = shortId();
  const filename =
    name.toLowerCase().includes('pr')
      ? 'PR instructions.md'
      : name.toLowerCase().includes('merge')
        ? 'Merge instructions.md'
        : name.toLowerCase().includes('commit')
          ? 'Commit instructions.md'
          : sanitizeFilename(`${name}.md`, 'instructions.md');
  try {
    const path = await writeTextAttachmentFile(id, filename, content);
    return {
      id,
      name,
      kind: 'prompt',
      type: 'text/markdown',
      size: content.length,
      path,
      // Keep the body so send inlines it. The on-disk `.fold/` copy lives
      // outside the git worktree, so a path-only chip is unreadable to agents.
      content,
    };
  } catch {
    return {
      id,
      name,
      kind: 'prompt',
      type: 'text/markdown',
      size: content.length,
      content,
    };
  }
}

/** Markdown body the agent reads when a Linear issue is attached. */
export function formatLinearIssueMarkdown(issue: LinearIssue): string {
  const lines = [`# ${issue.identifier}: ${issue.title}`, ""];
  lines.push(`**URL:** ${issue.url}`);
  if (issue.stateName) lines.push(`**Status:** ${issue.stateName}`);
  if (issue.teamName) lines.push(`**Team:** ${issue.teamName}`);
  if (issue.assigneeName) lines.push(`**Assignee:** ${issue.assigneeName}`);
  if (issue.priorityLabel && issue.priorityLabel !== "No priority") {
    lines.push(`**Priority:** ${issue.priorityLabel}`);
  }
  const description = issue.description?.trim();
  if (description) {
    lines.push("", "## Description", "", description);
  }
  lines.push("", "Implement this Linear issue in the current worktree.");
  return lines.join("\n");
}

/** Prompt chip for a Linear issue (Conductor-style attach-from-+). */
export async function makeLinearIssueAttachment(
  issue: LinearIssue,
): Promise<Attachment> {
  const attachment = await makePromptAttachment(
    issue.identifier,
    formatLinearIssueMarkdown(issue),
  );
  return {
    ...attachment,
    issue: {
      source: 'linear',
      id: issue.id,
      identifier: issue.identifier,
      title: issue.title,
      url: issue.url,
    },
  };
}

/** Markdown body the agent reads when a GitHub issue is attached. */
export function formatGitHubIssueMarkdown(issue: GhIssue): string {
  const lines = [`# #${issue.number}: ${issue.title}`, ""];
  lines.push(`**URL:** ${issue.url}`);
  if (issue.state) lines.push(`**Status:** ${issue.state}`);
  if (issue.labels.length) lines.push(`**Labels:** ${issue.labels.join(", ")}`);
  if (issue.assignees.length) {
    lines.push(`**Assignees:** ${issue.assignees.join(", ")}`);
  }
  const body = issue.body?.trim();
  if (body) {
    lines.push("", "## Description", "", body);
  }
  lines.push("", "Implement this GitHub issue in the current worktree.");
  return lines.join("\n");
}

const GH_ISSUE_URL = /https?:\/\/github\.com\/[^/\s]+\/[^/\s]+\/issues\/(\d+)/i;
const LINEAR_ISSUE_URL = /https?:\/\/linear\.app\/\S+\/issue\/([A-Z][A-Z0-9]+-\d+)/i;
const GH_ISSUE_HEADING = /^#\s+#(\d+):\s*(.*)$/m;
const LINEAR_ISSUE_HEADING = /^#\s+([A-Z][A-Z0-9]+-\d+):\s*(.*)$/m;

function firstLine(text: string | undefined, fallback: string): string {
  const line = text?.trim().split('\n')[0]?.trim();
  return line || fallback;
}

/** Recover a GitHub/Linear issue from a chip, including older prompt files with no `issue` field. */
export function parseIssueAttachment(
  att: Pick<Attachment, 'name' | 'content' | 'issue'>,
  body?: string,
): LinkedIssueRef | null {
  if (att.issue) return att.issue;

  const text = body ?? att.content ?? '';
  const ghUrl = GH_ISSUE_URL.exec(text);
  if (ghUrl) {
    const number = ghUrl[1]!;
    const heading = GH_ISSUE_HEADING.exec(text);
    return {
      source: 'github',
      id: number,
      identifier: `#${number}`,
      title: firstLine(heading?.[2], att.name.replace(/^#/, '') || `#${number}`),
      url: ghUrl[0].replace(/[).,;]+$/, ''),
    };
  }

  const linearUrl = LINEAR_ISSUE_URL.exec(text);
  if (linearUrl) {
    const identifier = linearUrl[1]!;
    const heading = LINEAR_ISSUE_HEADING.exec(text);
    return {
      source: 'linear',
      id: identifier,
      identifier,
      title: firstLine(heading?.[2], att.name || identifier),
      url: linearUrl[0].replace(/[).,;]+$/, ''),
    };
  }

  return null;
}

/** Like `parseIssueAttachment`, but reads the on-disk prompt when the chip only has a path. */
export async function resolveIssueAttachment(
  att: Attachment,
): Promise<LinkedIssueRef | null> {
  if (att.issue) return att.issue;
  if (att.content?.trim()) return parseIssueAttachment(att);
  if (!att.path) return parseIssueAttachment(att);
  try {
    const body = await readFile(att.path);
    return parseIssueAttachment(att, body);
  } catch {
    return parseIssueAttachment(att);
  }
}

/** Prompt chip for a GitHub issue (Conductor-style attach-from-+). */
export async function makeGitHubIssueAttachment(
  issue: GhIssue,
): Promise<Attachment> {
  const attachment = await makePromptAttachment(
    `#${issue.number}`,
    formatGitHubIssueMarkdown(issue),
  );
  return {
    ...attachment,
    issue: {
      source: 'github',
      id: String(issue.number),
      identifier: `#${issue.number}`,
      title: issue.title,
      url: issue.url,
    },
  };
}

/**
 * Persist the transcript of an earlier chat so it can be handed to a different
 * harness. Kept as a normal removable chip: the user can drop it to start the
 * new harness with a clean slate.
 */
export async function makeTranscriptAttachment(
  name: string,
  markdown: string,
  sourceChatId?: string,
): Promise<Attachment> {
  const id = shortId();
  const filename = sanitizeFilename(`${name}.md`, 'transcript.md');
  try {
    const path = await writeTextAttachmentFile(id, filename, markdown);
    return {
      id,
      name,
      kind: 'transcript',
      type: 'text/markdown',
      size: markdown.length,
      path,
      content: markdown,
      sourceChatId,
    };
  } catch {
    return {
      id,
      name,
      kind: 'transcript',
      type: 'text/markdown',
      size: markdown.length,
      content: markdown,
      sourceChatId,
    };
  }
}

/**
 * Persist a compact Smart Handoff summary. Distinct from a verbatim transcript
 * (`kind: 'handoff'`) so the composer can show a brain icon.
 */
export async function makeHandoffAttachment(
  name: string,
  markdown: string,
  sourceChatId?: string,
): Promise<Attachment> {
  const id = shortId();
  const filename = sanitizeFilename(`${name}.md`, 'handoff.md');
  try {
    const path = await writeTextAttachmentFile(id, filename, markdown);
    return {
      id,
      name,
      kind: 'handoff',
      type: 'text/markdown',
      size: markdown.length,
      path,
      content: markdown,
      sourceChatId,
    };
  } catch {
    return {
      id,
      name,
      kind: 'handoff',
      type: 'text/markdown',
      size: markdown.length,
      content: markdown,
      sourceChatId,
    };
  }
}

/** Persist a picked/pasted file or image under `.fold/attachments/<id>/`. */
export async function attachmentFromFile(file: File): Promise<Attachment> {
  const id = shortId();

  if (file.type.startsWith('image/') || /\.(png|jpe?g|gif|webp|svg)$/i.test(file.name)) {
    const dataUrl = await readAsDataUrl(file);
    const mime = file.type || 'image/png';
    const base = sanitizeFilename(file.name || 'image', 'image');
    const filename = /\.\w+$/.test(base) ? base : `${base}.${extForMime(mime)}`;
    try {
      const written = await writeImageAttachmentFile(id, filename, dataUrl);
      return {
        id,
        name: file.name || filename,
        kind: 'image',
        type: written?.mime ?? mime,
        size: file.size,
        dataUrl,
        path: written?.path,
      };
    } catch {
      return {
        id,
        name: file.name || filename,
        kind: 'image',
        type: mime,
        size: file.size,
        dataUrl,
      };
    }
  }

  const filename = sanitizeFilename(file.name || 'attachment', 'attachment');
  const path = attachmentPath(id, filename);
  try {
    if (file.type.startsWith('text/') || !file.type) {
      const content = await file.text();
      await writeFile(path, content);
      return {
        id,
        name: file.name || filename,
        kind: 'file',
        type: file.type || 'text/plain',
        size: file.size,
        path,
        content,
      };
    }

    const buffer = await readAsArrayBuffer(file);
    await writeBytes(path, new Uint8Array(buffer));
    return {
      id,
      name: file.name || filename,
      kind: 'file',
      type: file.type || 'application/octet-stream',
      size: file.size,
      path,
    };
  } catch {
    const content = await file.text().catch(() => '');
    return {
      id,
      name: file.name || filename,
      kind: 'file',
      type: file.type || 'text/plain',
      size: file.size,
      content: content || undefined,
    };
  }
}

/**
 * Ensure every attachment has a path on disk. Used as a send-time safety net
 * for older in-memory chips that were created before path materialization.
 */
export async function materializeAttachments(
  attachments: Attachment[],
): Promise<Attachment[]> {
  const out: Attachment[] = [];
  for (const att of attachments) {
    if (att.path) {
      out.push(att);
      continue;
    }
    if (att.kind === 'image' && att.dataUrl) {
      const id = att.id || shortId();
      const base = sanitizeFilename(att.name || 'image', 'image');
      const filename = /\.\w+$/.test(base) ? base : `${base}.${extForMime(att.type)}`;
      const written = await writeImageAttachmentFile(id, filename, att.dataUrl);
      out.push(written ? { ...att, id, path: written.path, type: written.mime } : att);
      continue;
    }
    if (att.content != null) {
      const id = att.id || shortId();
      const filename =
        att.kind === 'transcript'
          ? sanitizeFilename(`${att.name}.md`, 'transcript.md')
          : att.kind === 'handoff'
            ? sanitizeFilename(`${att.name}.md`, 'handoff.md')
            : att.kind === 'prompt'
              ? att.name.toLowerCase().includes('pr')
                ? 'PR instructions.md'
                : sanitizeFilename(`${att.name}.md`, 'instructions.md')
              : pastedTextFilename();
      const path = await writeTextAttachmentFile(id, filename, att.content);
      // Keep `content` so composeAgentPrompt can inline text chips. `.fold/`
      // files live outside the worktree and agents cannot read the logical path.
      out.push({ ...att, id, path });
      continue;
    }
    out.push(att);
  }
  return out;
}

/**
 * Build the agent prompt: user text + attachments.
 * Text chips are inlined when we still have `content` — Fold stores `.fold/`
 * files beside the worktree, so a logical path is not readable to the agent.
 * Remaining path refs (images, files) are rewritten to the absolute Fold path.
 */
export function composeAgentPrompt(
  userText: string,
  attachments: Attachment[],
  worktreePath?: string | null,
): string {
  const parts: string[] = [];
  const trimmed = userText.trim();
  if (trimmed) parts.push(trimmed);

  for (const att of attachments) {
    if (att.content?.trim() && att.kind !== 'image') {
      if (att.kind === 'prompt') {
        parts.push(att.content.trim());
      } else if (att.kind === 'transcript') {
        parts.push(
          `This conversation continues an earlier chat with a different agent.\n\n${att.content.trim()}`,
        );
      } else if (att.kind === 'handoff') {
        parts.push(
          `This conversation continues from a compact handoff summary of an earlier chat. Treat it as the source of truth for what was done, what is outstanding, and the next step.\n\n${att.content.trim()}`,
        );
      } else {
        parts.push(`The user attached "${att.name}":\n\`\`\`\n${att.content}\n\`\`\``);
      }
      continue;
    }

    if (att.path) {
      const visible = pathForAgent(att.path, worktreePath);
      if (att.kind === 'prompt') {
        parts.push(
          `The user attached instructions "${att.name}". Read and follow the file at: ${visible}`,
        );
      } else if (att.kind === 'image') {
        parts.push(
          `The user attached an image "${att.name}". Read and examine the file at: ${visible}`,
        );
      } else if (att.kind === 'transcript') {
        parts.push(
          `This conversation continues an earlier chat with a different agent. ` +
            `Read the transcript at: ${visible} for context before responding.`,
        );
      } else if (att.kind === 'handoff') {
        parts.push(
          `This conversation continues from a compact handoff summary of an earlier chat. ` +
            `Read the summary at: ${visible} for context before responding.`,
        );
      } else {
        parts.push(
          `The user attached "${att.name}". Read the file at: ${visible}`,
        );
      }
      continue;
    }

    parts.push(
      `The user attached "${att.name}" but it could not be saved to disk.`,
    );
  }

  return parts.join('\n\n');
}

export type { AttachmentKind };
