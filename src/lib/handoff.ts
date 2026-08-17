import type { Message } from "../store/chatStore";

/**
 * Prompt sent in the current session when the user clicks Smart Handoff.
 * The assistant's reply is the compact summary attached to the new chat.
 */
export const HANDOFF_PROMPT =
  "This chat is running out of room. Build me a handover prompt for a fresh chat that covers: (1) state of play: what's done, what's signed off, what's outstanding or unresolved (2) files needed: list every file the new chat won't have, and tell me which I should already have versus which you need to generate now so I can download; (3) key learnings: decisions, gotchas, things to avoid (4) working state: variables, constants, naming patterns, conventions (5) the next concrete step. Write it for an LLM to read, not me. Flag anything you're unsure about.";

/** Distinctive phrase used to recognise a Smart Handoff turn later. */
const HANDOFF_PROMPT_MARKER = "Build me a handover prompt for a fresh chat";

export function isHandoffPrompt(text: string): boolean {
  return text.includes(HANDOFF_PROMPT_MARKER);
}

/** Chip label for a compact handoff summary, matched by `attachmentPresenceKey`. */
export function handoffChipName(sourceChatTitle: string): string {
  return `${sourceChatTitle} handoff`;
}

export function isHandoffUserMessage(message: Message): boolean {
  if (message.role !== "user") return false;
  if (isHandoffPrompt(message.content ?? "")) return true;
  return (message.attachments ?? []).some(
    (att) =>
      att.kind === "prompt" &&
      (att.name === "Smart Handoff" || isHandoffPrompt(att.content ?? "")),
  );
}

/**
 * Pull the compact summary from a chat that already ran Smart Handoff: the
 * assistant text after the last handoff prompt. Returns null when this chat
 * has not been handed off (or the agent produced nothing).
 */
export function extractHandoffSummary(messages: Message[]): string | null {
  let lastHandoffIdx = -1;
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    if (isHandoffUserMessage(messages[i]!)) {
      lastHandoffIdx = i;
      break;
    }
  }
  if (lastHandoffIdx < 0) return null;

  const parts: string[] = [];
  for (let i = lastHandoffIdx + 1; i < messages.length; i += 1) {
    const message = messages[i]!;
    if (message.role === "assistant" && message.content?.trim()) {
      parts.push(message.content.trim());
    }
  }
  const summary = parts.join("\n\n").trim();
  return summary || null;
}
