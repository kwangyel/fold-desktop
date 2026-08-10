import { invoke } from "@tauri-apps/api/core";
import { isTauri } from "./git";
import type { Attachment, Message } from "../store/chatStore";
import type { HarnessId } from "./harnesses";

/**
 * Chat transcripts are persisted per worktree in a SQLite database inside that
 * worktree's Fold data directory (`.fold/<worktree>/chats.db`), so archiving or
 * removing the worktree drops its chats along with its plans and asks.
 *
 * Every call passes the worktree explicitly — unlike `readFile` / `writeFile`,
 * which resolve against the active project — so the sidebar can list chats for
 * worktrees that are not currently open.
 */

/** Row backing one entry in the sidebar's per-worktree chat list. */
export type ChatSummary = {
  id: string;
  title: string;
  harness: string;
  model: string | null;
  createdAt: number;
  updatedAt: number;
  messageCount: number;
};

export type ChatMeta = {
  id: string;
  title: string;
  harness: string;
  model: string | null;
  effort: string | null;
  createdAt: number;
  updatedAt: number;
};

/** Harness session id bound to a chat, one per harness the chat has used. */
export type ChatSession = {
  harness: string;
  sessionId: string;
};

/** Wire shape of a persisted transcript row (list fields are JSON strings). */
export type ChatMessageRow = {
  id: string;
  seq: number;
  role: string;
  content: string;
  toolName: string | null;
  toolStatus: string | null;
  detail: string | null;
  toolOutput: string | null;
  filePaths: string | null;
  attachments: string | null;
  timestamp: number;
};

export type ChatRecord = {
  meta: ChatMeta;
  sessions: ChatSession[];
  messages: ChatMessageRow[];
};

/** Chat id that is stable across reloads and usable as a center-pane tab id. */
export function newChatId(): string {
  return `chat-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
}

/** First few words of the opening prompt, used as the sidebar label. */
export function chatTitleFromPrompt(prompt: string, fallback = "New chat"): string {
  const words = prompt.trim().replace(/\s+/g, " ").split(" ").slice(0, 10).join(" ");
  if (!words) return fallback;
  return words.length > 60 ? `${words.slice(0, 60)}…` : words;
}

function parseJsonArray<T>(raw: string | null): T[] | undefined {
  if (!raw) return undefined;
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) && parsed.length > 0 ? (parsed as T[]) : undefined;
  } catch {
    return undefined;
  }
}

/** Transcript row → in-memory `Message`. */
export function messageFromRow(row: ChatMessageRow): Message {
  return {
    id: row.id,
    role: row.role as Message["role"],
    content: row.content ?? "",
    toolName: row.toolName ?? undefined,
    toolStatus: (row.toolStatus as Message["toolStatus"]) ?? undefined,
    detail: row.detail ?? undefined,
    toolOutput: row.toolOutput ?? undefined,
    filePaths: parseJsonArray<string>(row.filePaths),
    attachments: parseJsonArray<Attachment>(row.attachments),
    timestamp: row.timestamp,
  };
}

/** In-memory `Message` → transcript row. `seq` preserves transcript order. */
export function rowFromMessage(message: Message, seq: number): ChatMessageRow {
  return {
    id: message.id,
    seq,
    role: message.role,
    content: message.content ?? "",
    toolName: message.toolName ?? null,
    toolStatus: message.toolStatus ?? null,
    detail: message.detail ?? null,
    toolOutput: message.toolOutput ?? null,
    filePaths: message.filePaths?.length ? JSON.stringify(message.filePaths) : null,
    attachments: message.attachments?.length
      ? JSON.stringify(message.attachments)
      : null,
    timestamp: message.timestamp,
  };
}

export async function listChats(worktree: string): Promise<ChatSummary[]> {
  if (!isTauri()) return [];
  try {
    return await invoke<ChatSummary[]>("chat_list", { worktree });
  } catch {
    // A worktree whose folder is gone (archived mid-session) has no chats.
    return [];
  }
}

export async function loadChat(
  worktree: string,
  chatId: string,
): Promise<ChatRecord | null> {
  if (!isTauri()) return null;
  return (await invoke<ChatRecord | null>("chat_load", { worktree, chatId })) ?? null;
}

export async function upsertChat(worktree: string, meta: ChatMeta): Promise<void> {
  if (!isTauri()) return;
  await invoke("chat_upsert", { worktree, meta });
}

export async function saveChatMessages(
  worktree: string,
  chatId: string,
  messages: ChatMessageRow[],
): Promise<void> {
  if (!isTauri() || messages.length === 0) return;
  await invoke("chat_save_messages", { worktree, chatId, messages });
}

export async function setChatSession(
  worktree: string,
  chatId: string,
  harness: HarnessId,
  sessionId: string,
): Promise<void> {
  if (!isTauri()) return;
  await invoke("chat_set_session", {
    worktree,
    chatId,
    harness,
    sessionId,
    updatedAt: Date.now(),
  });
}

export async function clearChatSession(
  worktree: string,
  chatId: string,
  harness: HarnessId,
): Promise<void> {
  if (!isTauri()) return;
  await invoke("chat_clear_session", { worktree, chatId, harness });
}

export async function renameChat(
  worktree: string,
  chatId: string,
  title: string,
): Promise<void> {
  if (!isTauri()) return;
  await invoke("chat_rename", { worktree, chatId, title });
}

export async function deleteChat(worktree: string, chatId: string): Promise<void> {
  if (!isTauri()) return;
  await invoke("chat_delete", { worktree, chatId });
}
