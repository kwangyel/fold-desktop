import { loadChat, messageFromRow, type ChatSummary } from "./chats";
import {
  renderTranscriptMarkdown,
  transcriptAttachmentName,
} from "./chatTranscript";
import { makePromptAttachment, makeTranscriptAttachment } from "./attachments";
import { readPlanMarkdown, type PlanRecord } from "./plans";
import type { Attachment } from "../store/chatStore";
import type { HarnessId } from "./harnesses";

/**
 * A piece of context that already exists in a worktree and can be pulled into a
 * fresh chat with one click: another chat's transcript, or a saved plan. Powers
 * the borderless panel at the top of a new chat. Items are lightweight refs —
 * the markdown is only rendered when the user clicks (`buildTranscriptAttachment`
 * / `buildPlanAttachment`), so opening a new chat never pays to serialize every
 * sibling transcript or plan upfront.
 */
export type WorktreeContextItem =
  | {
      kind: "transcript";
      key: string;
      sourceChatId: string;
      sourceChatTitle: string;
      harness: HarnessId;
    }
  | {
      kind: "plan";
      key: string;
      plan: PlanRecord;
    };

/** Name a sibling chat's transcript chip gets, matched by `attachmentPresenceKey`. */
export function transcriptChipName(sourceChatTitle: string): string {
  return `${sourceChatTitle} transcript`;
}

/**
 * Identity of a transcript/plan chip on the composer, so the panel can tell
 * whether a given item is already attached (and re-offer it once removed). Both
 * `makeTranscriptAttachment` and `makePromptAttachment` key off the chip name.
 */
export function attachmentPresenceKey(att: Attachment): string {
  if (att.kind === "transcript") return `transcript-${att.name}`;
  if (att.kind === "prompt") return `plan-${att.name}`;
  return `other-${att.id}`;
}

/** Presence key for a panel item, comparable against composer attachments. */
export function itemPresenceKey(item: WorktreeContextItem): string {
  if (item.kind === "transcript") {
    return `transcript-${transcriptChipName(item.sourceChatTitle)}`;
  }
  return `plan-${item.plan.title}`;
}

/**
 * List a worktree's reusable context: every sibling chat's transcript (excluding
 * the current chat) plus every saved plan. Whether an item is *already on the
 * composer* is decided at render time by the panel (so removing a chip re-offers
 * it), not filtered out here.
 */
export function gatherWorktreeContext(
  currentChatId: string,
  summaries: ChatSummary[],
  plans: PlanRecord[],
): WorktreeContextItem[] {
  const items: WorktreeContextItem[] = [];

  const seenChatIds = new Set<string>();
  for (const summary of summaries) {
    if (summary.id === currentChatId || summary.messageCount === 0) continue;
    // `chat_list` should be unique by id, but dedupe defensively so a repeated
    // row can never surface the same transcript twice.
    if (seenChatIds.has(summary.id)) continue;
    seenChatIds.add(summary.id);

    items.push({
      kind: "transcript",
      key: `tr-${summary.id}`,
      sourceChatId: summary.id,
      sourceChatTitle: summary.title,
      harness: summary.harness as HarnessId,
    });
  }

  for (const plan of plans) {
    items.push({ kind: "plan", key: `plan-${plan.id}`, plan });
  }

  return items;
}

/**
 * Render a sibling chat's transcript to a removable attachment chip. Mirrors the
 * harness-handoff path (`startHarnessHandoff`) but reads the sibling's persisted
 * messages rather than a live tab's.
 */
export async function buildTranscriptAttachment(
  worktree: string,
  chatId: string,
  harness: HarnessId,
  name: string,
): Promise<Attachment | null> {
  const record = await loadChat(worktree, chatId);
  if (!record || record.messages.length === 0) return null;
  const messages = record.messages.map(messageFromRow);
  const markdown = renderTranscriptMarkdown(messages, harness);
  return makeTranscriptAttachment(
    name || transcriptAttachmentName(harness),
    markdown,
  );
}

/**
 * Render a saved plan to a removable prompt chip. The chip is named after the
 * plan title so `attachmentPresenceKey` can match it back to its panel row.
 */
export async function buildPlanAttachment(
  plan: PlanRecord,
): Promise<Attachment | null> {
  try {
    const markdown = await readPlanMarkdown(plan);
    return makePromptAttachment(plan.title || "Plan", markdown);
  } catch {
    return null;
  }
}
