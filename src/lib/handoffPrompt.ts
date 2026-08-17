import type { ChatTabState, Message } from "../store/chatStore";
import type { ContextUsage, SessionUsage } from "./contextUsage";
import {
  extractHandoffSummary,
  isHandoffUserMessage,
} from "./handoff";

/** Prompt Smart Handoff once Claude usage reaches this percent. */
export const HANDOFF_USAGE_THRESHOLD = 90;

/** How long to wait after a run ends so late usage events can land. */
export const HANDOFF_PROMPT_SETTLE_MS = 300;

export type ClaudeUsageSnapshot = {
  contextPercent: number | null;
  sessionPercent: number | null;
  weekPercent: number | null;
  sessionResetsAt: string | null;
  weekResetsAt: string | null;
};

export type HandoffPromptOffer = {
  tabId: string;
  title: string;
  usage: ClaudeUsageSnapshot;
};

export function snapshotClaudeUsage(
  context: ContextUsage | undefined,
  session: SessionUsage | undefined,
): ClaudeUsageSnapshot {
  return {
    contextPercent: context?.percent ?? null,
    sessionPercent: session?.fiveHour?.percent ?? null,
    weekPercent: session?.sevenDay?.percent ?? null,
    sessionResetsAt: session?.fiveHour?.resetsAt ?? null,
    weekResetsAt: session?.sevenDay?.resetsAt ?? null,
  };
}

export function peakUsagePercent(usage: ClaudeUsageSnapshot): number {
  return Math.max(
    usage.contextPercent ?? 0,
    usage.sessionPercent ?? 0,
    usage.weekPercent ?? 0,
  );
}

export function isClaudeUsageNearLimit(
  usage: ClaudeUsageSnapshot,
  threshold = HANDOFF_USAGE_THRESHOLD,
): boolean {
  return peakUsagePercent(usage) >= threshold;
}

/** Which quota is driving the prompt, for dialog copy. */
export function usageLimitReason(usage: ClaudeUsageSnapshot): {
  label: string;
  percent: number;
} | null {
  if (
    usage.contextPercent != null &&
    usage.contextPercent >= HANDOFF_USAGE_THRESHOLD
  ) {
    return { label: "context window", percent: usage.contextPercent };
  }
  if (
    usage.sessionPercent != null &&
    usage.sessionPercent >= HANDOFF_USAGE_THRESHOLD
  ) {
    return { label: "5-hour session", percent: usage.sessionPercent };
  }
  if (
    usage.weekPercent != null &&
    usage.weekPercent >= HANDOFF_USAGE_THRESHOLD
  ) {
    return { label: "weekly usage", percent: usage.weekPercent };
  }
  return null;
}

export function claudeLoadingTabIds(
  tabs: Record<string, ChatTabState>,
): string[] {
  return Object.entries(tabs)
    .filter(([, tab]) => tab.selectedHarness === "claudecode" && tab.loading)
    .map(([id]) => id)
    .sort();
}

function lastUserMessage(messages: Message[]): Message | null {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i]!;
    if (message.role === "user") return message;
  }
  return null;
}

function lastTurnWasCancelled(messages: Message[]): boolean {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i]!;
    if (message.role === "user") return false;
    if (
      message.role === "assistant" &&
      /^Agent cancelled\.?$/i.test((message.content ?? "").trim())
    ) {
      return true;
    }
  }
  return false;
}

/**
 * A finished Claude chat that can be handed off: has a reply, isn't already
 * a handoff turn, and wasn't cancelled.
 */
export function chatEligibleForHandoffPrompt(
  tab: ChatTabState | undefined,
): boolean {
  if (!tab || tab.selectedHarness !== "claudecode") return false;
  if (tab.loading || tab.messages.length === 0) return false;
  const last = tab.messages[tab.messages.length - 1];
  if (!last || last.role === "user") return false;
  if (lastTurnWasCancelled(tab.messages)) return false;
  const user = lastUserMessage(tab.messages);
  if (user && isHandoffUserMessage(user)) return false;
  if (extractHandoffSummary(tab.messages)) return false;
  return true;
}
