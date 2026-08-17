import { loadChat, messageFromRow, type ChatSummary } from "./chats";
import {
  renderTranscriptMarkdown,
  transcriptAttachmentName,
} from "./chatTranscript";
import {
  makeHandoffAttachment,
  makePromptAttachment,
  makeTranscriptAttachment,
} from "./attachments";
import { extractHandoffSummary, handoffChipName } from "./handoff";
import { readPlanMarkdown, type PlanRecord } from "./plans";
import { useChatStore, type Attachment, type Message } from "../store/chatStore";
import type { HarnessId } from "./harnesses";

/**
 * A piece of context that already exists in a worktree and can be pulled into a
 * fresh chat with one click: another chat's transcript, a Smart Handoff
 * summary, or a saved plan. Powers the borderless panel at the top of a new
 * chat. Items are lightweight refs — the markdown is only rendered when the
 * user clicks (`buildTranscriptAttachment` / `buildHandoffAttachment` /
 * `buildPlanAttachment`), so opening a new chat never pays to serialize every
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
      kind: "handoff";
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

function chatPresenceKey(sourceChatId: string): string {
  return `chat-${sourceChatId}`;
}

/**
 * Identity of a transcript/handoff/plan chip on the composer, so the panel can
 * tell whether a given item is already attached (and re-offer it once removed).
 * Handoff and transcript chips from the same source chat share a key so
 * attaching either hides that sibling's row.
 */
export function attachmentPresenceKey(att: Attachment): string {
  if (
    (att.kind === "transcript" || att.kind === "handoff") &&
    att.sourceChatId
  ) {
    return chatPresenceKey(att.sourceChatId);
  }
  if (att.kind === "handoff") return `handoff-${att.name}`;
  if (att.kind === "transcript") return `transcript-${att.name}`;
  if (att.kind === "prompt") return `plan-${att.name}`;
  return `other-${att.id}`;
}

/** Presence key for a panel item, comparable against composer attachments. */
export function itemPresenceKey(item: WorktreeContextItem): string {
  if (item.kind === "transcript" || item.kind === "handoff") {
    return chatPresenceKey(item.sourceChatId);
  }
  return `plan-${item.plan.title}`;
}

/**
 * List a worktree's reusable context: every sibling chat's transcript or
 * handoff summary (excluding the current chat) plus every saved plan. Whether
 * an item is *already on the composer* is decided at render time by the panel
 * (so removing a chip re-offers it), not filtered out here.
 *
 * `handoffSourceIds` marks siblings whose last turn is a Smart Handoff
 * summary, so the panel can show a brain icon instead of the transcript one.
 */
export function gatherWorktreeContext(
  currentChatId: string,
  summaries: ChatSummary[],
  plans: PlanRecord[],
  handoffSourceIds?: Set<string>,
): WorktreeContextItem[] {
  const items: WorktreeContextItem[] = [];

  const seenChatIds = new Set<string>();
  for (const summary of summaries) {
    if (summary.id === currentChatId || summary.messageCount === 0) continue;
    // `chat_list` should be unique by id, but dedupe defensively so a repeated
    // row can never surface the same transcript twice.
    if (seenChatIds.has(summary.id)) continue;
    seenChatIds.add(summary.id);

    const isHandoff = handoffSourceIds?.has(summary.id) ?? false;
    if (isHandoff) {
      items.push({
        kind: "handoff",
        key: `ho-${summary.id}`,
        sourceChatId: summary.id,
        sourceChatTitle: summary.title,
        harness: summary.harness as HarnessId,
      });
    } else {
      items.push({
        kind: "transcript",
        key: `tr-${summary.id}`,
        sourceChatId: summary.id,
        sourceChatTitle: summary.title,
        harness: summary.harness as HarnessId,
      });
    }
  }

  for (const plan of plans) {
    items.push({ kind: "plan", key: `plan-${plan.id}`, plan });
  }

  return items;
}

/** Prefer the live tab (just-finished handoff may not have flushed to disk). */
async function loadChatMessages(
  worktree: string,
  chatId: string,
): Promise<{ messages: Message[]; title: string } | null> {
  const live = useChatStore.getState().tabs[chatId];
  if (live && live.messages.length > 0) {
    return { messages: live.messages, title: live.title };
  }
  const record = await loadChat(worktree, chatId);
  if (!record || record.messages.length === 0) return null;
  return {
    messages: record.messages.map(messageFromRow),
    title: record.meta.title,
  };
}

/**
 * Render a sibling chat's transcript to a removable attachment chip. Mirrors the
 * harness-handoff path (`startHarnessHandoff`) but reads the sibling's persisted
 * messages rather than a live tab's. If that sibling already ran Smart Handoff,
 * attach the compact summary instead of the full transcript.
 */
export async function buildTranscriptAttachment(
  worktree: string,
  chatId: string,
  harness: HarnessId,
  name: string,
): Promise<Attachment | null> {
  const loaded = await loadChatMessages(worktree, chatId);
  if (!loaded) return null;
  const summary = extractHandoffSummary(loaded.messages);
  if (summary) {
    return makeHandoffAttachment(
      handoffChipName(loaded.title || name),
      summary,
      chatId,
    );
  }
  const markdown = renderTranscriptMarkdown(loaded.messages, harness);
  return makeTranscriptAttachment(
    name || transcriptAttachmentName(harness),
    markdown,
    chatId,
  );
}

/**
 * Render a sibling chat's Smart Handoff summary to a removable chip. Falls
 * back to the full transcript if the summary cannot be recovered.
 */
export async function buildHandoffAttachment(
  worktree: string,
  chatId: string,
  harness: HarnessId,
  name: string,
): Promise<Attachment | null> {
  const loaded = await loadChatMessages(worktree, chatId);
  if (!loaded) return null;
  const summary = extractHandoffSummary(loaded.messages);
  if (summary) {
    return makeHandoffAttachment(
      name || handoffChipName(loaded.title),
      summary,
      chatId,
    );
  }
  const markdown = renderTranscriptMarkdown(loaded.messages, harness);
  return makeTranscriptAttachment(
    transcriptChipName(loaded.title),
    markdown,
    chatId,
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
