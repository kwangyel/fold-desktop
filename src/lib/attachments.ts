import type { Attachment, AttachmentKind } from '../store/chatStore';
import { writeBytes, writeFile } from './git';

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

/**
 * Persist the transcript of an earlier chat so it can be handed to a different
 * harness. Kept as a normal removable chip: the user can drop it to start the
 * new harness with a clean slate.
 */
export async function makeTranscriptAttachment(
  name: string,
  markdown: string,
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
    };
  } catch {
    return {
      id,
      name,
      kind: 'transcript',
      type: 'text/markdown',
      size: markdown.length,
      content: markdown,
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
          : att.kind === 'prompt'
            ? att.name.toLowerCase().includes('pr')
              ? 'PR instructions.md'
              : sanitizeFilename(`${att.name}.md`, 'instructions.md')
            : pastedTextFilename();
      const path = await writeTextAttachmentFile(id, filename, att.content);
      out.push({ ...att, id, path, content: undefined });
      continue;
    }
    out.push(att);
  }
  return out;
}

/**
 * Build the agent prompt: user text + attachments.
 * When an attachment still has in-memory `content` (review comments), inline
 * it so the agent sees the line and the note. Otherwise point at the on-disk
 * path (Conductor-style for files/images).
 */
export function composeAgentPrompt(
  userText: string,
  attachments: Attachment[],
): string {
  const parts: string[] = [];
  const trimmed = userText.trim();
  if (trimmed) parts.push(trimmed);

  for (const att of attachments) {
    if (att.content?.trim() && att.kind !== "image" && att.kind !== "transcript") {
      if (att.kind === "prompt") {
        parts.push(att.content.trim());
      } else {
        parts.push(`The user attached "${att.name}":\n\`\`\`\n${att.content}\n\`\`\``);
      }
      continue;
    }

    if (att.path) {
      if (att.kind === 'prompt') {
        parts.push(
          `The user attached instructions "${att.name}". Read and follow the file at: ${att.path}`,
        );
      } else if (att.kind === 'image') {
        parts.push(
          `The user attached an image "${att.name}". Read and examine the file at: ${att.path}`,
        );
      } else if (att.kind === 'transcript') {
        parts.push(
          `This conversation continues an earlier chat with a different agent. ` +
            `Read the transcript at: ${att.path} for context before responding.`,
        );
      } else {
        parts.push(
          `The user attached "${att.name}". Read the file at: ${att.path}`,
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
