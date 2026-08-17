import { useEffect, useState } from "react";
import {
  chatEligibleForHandoffPrompt,
  claudeLoadingTabIds,
  HANDOFF_PROMPT_SETTLE_MS,
  isClaudeUsageNearLimit,
  snapshotClaudeUsage,
  type HandoffPromptOffer,
} from "../lib/handoffPrompt";
import { useAgentStatusStore } from "../store/agentStatusStore";
import { useChatStore } from "../store/chatStore";
import { useContextUsageStore } from "../store/contextUsageStore";
import { useQuestionStore } from "../store/questionStore";
import SmartHandoffDialog from "./SmartHandoffDialog";

function currentUsage() {
  const { byHarness, sessionByHarness } = useContextUsageStore.getState();
  return snapshotClaudeUsage(
    byHarness.claudecode,
    sessionByHarness.claudecode,
  );
}

function offerForTab(tabId: string): HandoffPromptOffer | null {
  const tab = useChatStore.getState().tabs[tabId];
  if (!chatEligibleForHandoffPrompt(tab)) return null;
  if (claudeLoadingTabIds(useChatStore.getState().tabs).length > 0) return null;
  if (useAgentStatusStore.getState().statuses[tabId]?.state === "needs-you") {
    return null;
  }
  if (Object.keys(useQuestionStore.getState().pending).length > 0) return null;

  const usage = currentUsage();
  if (!isClaudeUsageNearLimit(usage)) return null;

  return {
    tabId,
    title: tab?.title ?? "Chat",
    usage,
  };
}

function findOffer(preferredTabId: string): HandoffPromptOffer | null {
  const preferred = offerForTab(preferredTabId);
  if (preferred) return preferred;
  for (const id of Object.keys(useChatStore.getState().tabs)) {
    if (id === preferredTabId) continue;
    const offer = offerForTab(id);
    if (offer) return offer;
  }
  return null;
}

/**
 * After a Claude Code turn finishes, if usage is at or above 90% and no Claude
 * agent is still running, offer Smart Handoff. Cancel just dismisses it.
 */
export default function HandoffPromptWatcher() {
  const [offer, setOffer] = useState<HandoffPromptOffer | null>(null);

  useEffect(() => {
    let prev = claudeLoadingTabIds(useChatStore.getState().tabs);
    let settleTimer: ReturnType<typeof setTimeout> | null = null;

    const unsub = useChatStore.subscribe((state) => {
      const next = claudeLoadingTabIds(state.tabs);
      if (next.length === prev.length && next.every((id, i) => id === prev[i])) {
        return;
      }
      const nextSet = new Set(next);
      const finished = prev.filter((id) => !nextSet.has(id));
      prev = next;
      if (finished.length === 0 || next.length > 0) return;

      const tabId = finished[finished.length - 1]!;
      if (settleTimer) clearTimeout(settleTimer);
      settleTimer = setTimeout(() => {
        settleTimer = null;
        const nextOffer = findOffer(tabId);
        if (nextOffer) setOffer(nextOffer);
      }, HANDOFF_PROMPT_SETTLE_MS);
    });

    return () => {
      unsub();
      if (settleTimer) clearTimeout(settleTimer);
    };
  }, []);

  if (!offer) return null;
  return (
    <SmartHandoffDialog offer={offer} onClose={() => setOffer(null)} />
  );
}
