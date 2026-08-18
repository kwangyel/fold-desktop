import { useCenterViewStore } from "../store/centerViewStore";
import { useChatSessionStore } from "../store/chatSessionStore";
import { useChatStore, type Attachment, type NewTabOptions } from "../store/chatStore";
import { useAgentStatusStore } from "../store/agentStatusStore";
import { loadChat, newChatId } from "./chats";
import { makeHandoffAttachment, makeTranscriptAttachment } from "./attachments";
import {
  renderTranscriptMarkdown,
  transcriptAttachmentName,
} from "./chatTranscript";
import {
  extractHandoffSummary,
  HANDOFF_PROMPT,
  handoffChipName,
} from "./handoff";
import type { HarnessId } from "./harnesses";

/**
 * Glue between persisted chats (`lib/chats`), the center-pane tab list, and the
 * in-memory transcript store.
 *
 * It lives outside all three stores because `chatStore` already imports
 * `centerViewStore`; putting the orchestration in either of them would make the
 * import graph circular.
 */

/** Open a persisted chat in the center pane, restoring its transcript. */
export async function openChatTab(
  chatId: string,
  worktreePath: string,
  label?: string,
): Promise<void> {
  const alreadyOpen = useCenterViewStore
    .getState()
    .tabs.some((t) => t.id === chatId);
  if (alreadyOpen) {
    useCenterViewStore.getState().setActiveTab(chatId);
    return;
  }

  const record = await loadChat(worktreePath, chatId);
  if (record) {
    // Seed the transcript before the tab mounts; `initializeTab` then no-ops.
    useChatStore.getState().hydrateTab(chatId, worktreePath, record);
  }
  useCenterViewStore
    .getState()
    .openChatTab(chatId, worktreePath, record?.meta.title ?? label);
}

/** Attachments to seed onto the next draft chat for a worktree. */
const pendingChatAttachments = new Map<string, Attachment[]>();

/** Queue chips that `newChatTab` should attach when that worktree opens. */
export function queueNewChatAttachments(
  worktreePath: string,
  attachments: Attachment[],
): void {
  if (!worktreePath || attachments.length === 0) return;
  pendingChatAttachments.set(worktreePath, attachments);
}

function takePendingChatAttachments(worktreePath: string | null): Attachment[] {
  if (!worktreePath) return [];
  const pending = pendingChatAttachments.get(worktreePath) ?? [];
  pendingChatAttachments.delete(worktreePath);
  return pending;
}

/** Wait out an in-flight run (including a resume retry after sendPrompt returns). */
function waitWhileTabLoading(tabId: string): Promise<void> {
  if (!useChatStore.getState().tabs[tabId]?.loading) return Promise.resolve();
  return new Promise((resolve) => {
    const unsub = useChatStore.subscribe((state) => {
      const tab = state.tabs[tabId];
      if (!tab || !tab.loading) {
        unsub();
        resolve();
      }
    });
    if (!useChatStore.getState().tabs[tabId]?.loading) {
      unsub();
      resolve();
    }
  });
}

function isCancelledHandoff(summary: string): boolean {
  return /^Agent cancelled\.?$/i.test(summary.trim());
}

/** Open a fresh, unsaved chat in the given worktree. */
export function newChatTab(
  worktreePath: string | null,
  options?: NewTabOptions,
): string {
  const id = newChatId();
  const queued = takePendingChatAttachments(worktreePath);
  const attachments = [...(options?.attachments ?? []), ...queued];
  useChatStore.getState().initializeTab(id, {
    ...options,
    attachments: attachments.length > 0 ? attachments : undefined,
  });
  useCenterViewStore.getState().addChatTab({ id, worktreePath });
  return id;
}

/** Worktree of the most recent sync request, used to drop stale ones. */
let latestSyncTarget: string | null = null;

/**
 * Make the open chat tabs match the active worktree.
 *
 * Called on every workspace switch: foreign tabs are dropped by
 * `closeWorkspaceTabs`, then the worktree's most recent chat is opened
 * (or a draft is started when it has none).
 */
export async function syncChatTabsForWorktree(
  worktreePath: string | null,
): Promise<void> {
  latestSyncTarget = worktreePath;

  // `closeWorkspaceTabs` only drops the center-pane tabs; release the
  // transcripts behind the ones going away so they don't accumulate in memory
  // across worktree switches. They are on disk and rehydrate on reopen.
  //
  // A tab with a run still in flight is left alone: its agent keeps streaming
  // into the store and persisting, so the finished turn is there when the chat
  // is reopened.
  const chatStore = useChatStore.getState();
  for (const tab of useCenterViewStore.getState().tabs) {
    if (
      tab.type === "chat" &&
      tab.worktreePath !== worktreePath &&
      !chatStore.tabs[tab.id]?.loading
    ) {
      chatStore.deleteTab(tab.id);
    }
  }
  useCenterViewStore.getState().closeWorkspaceTabs(worktreePath);
  if (!worktreePath) return;

  await useChatSessionStore.getState().refresh(worktreePath);
  // Switching again while the list loaded makes this call stale; the newer
  // one owns the tabs.
  if (latestSyncTarget !== worktreePath) return;

  const latest = useChatSessionStore.getState().latest(worktreePath);
  if (latest) {
    await openChatTab(latest.id, worktreePath, latest.title);
    return;
  }

  const hasChat = useCenterViewStore
    .getState()
    .tabs.some((t) => t.type === "chat" && t.worktreePath === worktreePath);
  if (!hasChat) newChatTab(worktreePath);
}

/** Open (or focus) the most recently updated chat for a worktree. */
export async function openLatestChat(worktreePath: string): Promise<void> {
  await useChatSessionStore.getState().refresh(worktreePath);
  const latest = useChatSessionStore.getState().latest(worktreePath);
  if (!latest) return;
  await openChatTab(latest.id, worktreePath, latest.title);
}

/**
 * Switching harness mid-conversation opens a *new* chat rather than continuing
 * the old one: harnesses cannot read each other's sessions, so the only way to
 * carry the conversation across is to attach the transcript as context. The
 * chip is removable, so the user can start the new harness clean instead.
 */
export async function startHarnessHandoff(
  fromTabId: string,
  toHarnessId: string,
  toModel: string,
): Promise<void> {
  const source = useChatStore.getState().tabs[fromTabId];
  if (!source || source.messages.length === 0) return;

  const worktreePath =
    source.worktreePath ??
    useCenterViewStore.getState().tabs.find((t) => t.id === fromTabId)
      ?.worktreePath ??
    null;

  const fromHarness = source.selectedHarness as HarnessId;
  const id = newChatId();

  let attachments;
  try {
    const markdown = renderTranscriptMarkdown(source.messages, fromHarness);
    attachments = [
      await makeTranscriptAttachment(
        transcriptAttachmentName(fromHarness),
        markdown,
        fromTabId,
      ),
    ];
  } catch {
    // Without the transcript the handoff still works, just without context.
    attachments = undefined;
  }

  useChatStore.getState().initializeTab(id, {
    harnessId: toHarnessId,
    model: toModel,
    attachments,
  });
  useCenterViewStore.getState().addChatTab({ id, worktreePath });
}

/**
 * Ask the current session to write a compact handoff summary, then open a
 * fresh chat with that summary attached — same new-tab behaviour as switching
 * harness. The chip is removable; the empty-chat context panel can add it back.
 */
export async function startSmartHandoff(fromTabId: string): Promise<void> {
  const source = useChatStore.getState().tabs[fromTabId];
  if (!source || source.messages.length === 0 || source.loading) return;

  const worktreePath =
    source.worktreePath ??
    useCenterViewStore.getState().tabs.find((t) => t.id === fromTabId)
      ?.worktreePath ??
    null;

  await useChatStore.getState().sendPrompt(fromTabId, HANDOFF_PROMPT);
  await waitWhileTabLoading(fromTabId);

  const after = useChatStore.getState().tabs[fromTabId];
  if (!after) return;
  const summary = extractHandoffSummary(after.messages);
  if (!summary || isCancelledHandoff(summary)) return;

  const id = newChatId();
  let attachments: Attachment[] | undefined;
  try {
    attachments = [
      await makeHandoffAttachment(
        handoffChipName(after.title),
        summary,
        fromTabId,
      ),
    ];
  } catch {
    // Without the summary the new chat still works, just without context.
    attachments = undefined;
  }

  useChatStore.getState().initializeTab(id, {
    harnessId: after.selectedHarness,
    model: after.selectedModel,
    attachments,
  });
  useCenterViewStore.getState().addChatTab({ id, worktreePath });
}

/** Delete a chat from disk and close its tab if it is open. */
export async function deleteChatEverywhere(
  worktreePath: string,
  chatId: string,
): Promise<void> {
  await useChatSessionStore.getState().remove(worktreePath, chatId);
  useAgentStatusStore.getState().clear(chatId);
  const center = useCenterViewStore.getState();
  if (!center.tabs.some((t) => t.id === chatId)) return;
  // `closeTab` refuses to close the last remaining tab, so open a draft first.
  if (center.tabs.length <= 1) newChatTab(worktreePath);
  useChatStore.getState().deleteTab(chatId);
  useCenterViewStore.getState().closeTab(chatId);
}
