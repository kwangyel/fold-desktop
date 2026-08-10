import type { Message } from "../store/chatStore";
import { harnessMeta, type HarnessId } from "./harnesses";

/**
 * Renders a chat transcript as markdown so it can be handed to a *different*
 * harness as an attachment.
 *
 * Each harness keeps its own conversation memory (Claude's SDK sessions,
 * Cursor chats, Codex threads, OpenCode sessions), and none of them can read
 * another's. Switching harness mid-conversation therefore has to carry the
 * history across as plain text.
 */

/** Cap per tool body so a long run doesn't produce a megabyte of markdown. */
const MAX_DETAIL_CHARS = 1200;

function truncate(text: string, limit = MAX_DETAIL_CHARS): string {
  const trimmed = text.trim();
  if (trimmed.length <= limit) return trimmed;
  return `${trimmed.slice(0, limit)}\n… (truncated)`;
}

function fence(body: string): string {
  // Pick a fence longer than any run of backticks inside the body so nested
  // code blocks (very common in tool output) don't break out early.
  const longest = /(`{3,})/g;
  let max = 2;
  let match: RegExpExecArray | null;
  while ((match = longest.exec(body)) !== null) {
    max = Math.max(max, match[1].length);
  }
  const ticks = "`".repeat(Math.max(3, max + 1));
  return `${ticks}\n${body}\n${ticks}`;
}

function renderTool(message: Message): string {
  const name = message.toolName ?? "tool";
  const summary = message.content?.trim();
  const head = summary && summary !== name ? `**${name}** — ${summary}` : `**${name}**`;
  const parts = [`- ${head}`];
  if (message.filePaths?.length) {
    parts.push(`  - files: ${message.filePaths.join(", ")}`);
  }
  if (message.toolOutput?.trim()) {
    parts.push(`  - output:\n${fence(truncate(message.toolOutput))}`);
  }
  return parts.join("\n");
}

/**
 * Full verbatim transcript: user turns, assistant replies, thinking, and a
 * summarised line per tool call.
 */
export function renderTranscriptMarkdown(
  messages: Message[],
  fromHarness: HarnessId,
): string {
  const label = (() => {
    try {
      return harnessMeta(fromHarness).name;
    } catch {
      return fromHarness;
    }
  })();

  const lines: string[] = [
    `# Previous conversation (${label})`,
    "",
    "This is the transcript of an earlier chat in this workspace, carried over" +
      " because the user switched harness. Use it as background context for" +
      " what follows.",
    "",
  ];

  // Consecutive tool/thinking rows belong to the assistant turn above them;
  // collect them so they render as one list rather than a heading each.
  let pendingActivity: string[] = [];

  const flushActivity = () => {
    if (pendingActivity.length === 0) return;
    lines.push("### Activity", "", ...pendingActivity, "");
    pendingActivity = [];
  };

  for (const message of messages) {
    switch (message.role) {
      case "user": {
        flushActivity();
        lines.push("## User", "");
        const body = message.content?.trim();
        if (body) lines.push(body, "");
        for (const att of message.attachments ?? []) {
          lines.push(`- attached: ${att.name}${att.path ? ` (${att.path})` : ""}`);
        }
        if (message.attachments?.length) lines.push("");
        break;
      }
      case "assistant": {
        flushActivity();
        const body = message.content?.trim();
        if (!body) break;
        lines.push("## Assistant", "", body, "");
        break;
      }
      case "thinking": {
        const body = message.detail?.trim() || message.content?.trim();
        if (body) pendingActivity.push(`- *thinking* — ${truncate(body, 400)}`);
        break;
      }
      case "tool": {
        pendingActivity.push(renderTool(message));
        break;
      }
    }
  }
  flushActivity();

  return `${lines.join("\n").replace(/\n{3,}/g, "\n\n").trim()}\n`;
}

/** Attachment chip label for a carried-over transcript. */
export function transcriptAttachmentName(fromHarness: HarnessId): string {
  try {
    return `${harnessMeta(fromHarness).name} chat transcript`;
  } catch {
    return "Chat transcript";
  }
}
