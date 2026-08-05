import type { HarnessId } from "./harnesses";

/** Live context-window occupancy for a harness session. */
export type ContextUsage = {
  harnessId: HarnessId;
  /** Tokens currently in the context window. */
  usedTokens: number;
  /** Model context window size in tokens. */
  contextWindow: number;
  /** 0–100, clamped. */
  percent: number;
};

/** One Claude.ai plan rate-limit window (5-hour session or weekly). */
export type RateLimitWindow = {
  /** 0–100 utilization. */
  percent: number;
  /** ISO timestamp when the window resets, if known. */
  resetsAt: string | null;
};

/**
 * Claude.ai subscription session usage — 5-hour + weekly quotas from `/usage`.
 * Absent for API-key / Bedrock sessions where plan limits don't apply.
 */
export type SessionUsage = {
  harnessId: HarnessId;
  fiveHour: RateLimitWindow | null;
  sevenDay: RateLimitWindow | null;
  subscriptionType: string | null;
  /** Client-side session cost estimate in USD, if known. */
  sessionCostUsd: number | null;
};

/** Harnesses that can report context-window / session usage via their stream. */
export const CONTEXT_STATUS_HARNESSES: readonly HarnessId[] = ["claudecode"];

export function harnessSupportsContextStatus(id: HarnessId): boolean {
  return CONTEXT_STATUS_HARNESSES.includes(id);
}

type TokenUsage = {
  input_tokens?: number;
  output_tokens?: number;
  cache_creation_input_tokens?: number;
  cache_read_input_tokens?: number;
};

type ModelUsageEntry = {
  inputTokens?: number;
  outputTokens?: number;
  cacheReadInputTokens?: number;
  cacheCreationInputTokens?: number;
  contextWindow?: number;
};

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object"
    ? (value as Record<string, unknown>)
    : null;
}

function readUsage(raw: unknown): TokenUsage | null {
  const u = asRecord(raw);
  if (!u) return null;
  const input = u.input_tokens;
  const cacheCreate = u.cache_creation_input_tokens;
  const cacheRead = u.cache_read_input_tokens;
  if (
    typeof input !== "number" &&
    typeof cacheCreate !== "number" &&
    typeof cacheRead !== "number"
  ) {
    return null;
  }
  return {
    input_tokens: typeof input === "number" ? input : 0,
    output_tokens:
      typeof u.output_tokens === "number" ? u.output_tokens : undefined,
    cache_creation_input_tokens:
      typeof cacheCreate === "number" ? cacheCreate : 0,
    cache_read_input_tokens: typeof cacheRead === "number" ? cacheRead : 0,
  };
}

function usedFromUsage(usage: TokenUsage): number {
  return (
    (usage.input_tokens ?? 0) +
    (usage.cache_creation_input_tokens ?? 0) +
    (usage.cache_read_input_tokens ?? 0)
  );
}

function contextWindowFromModelUsage(raw: unknown): number | null {
  const modelUsage = asRecord(raw);
  if (!modelUsage) return null;
  let best: number | null = null;
  for (const entry of Object.values(modelUsage)) {
    const m = asRecord(entry) as ModelUsageEntry | null;
    if (m && typeof m.contextWindow === "number" && m.contextWindow > 0) {
      if (best == null || m.contextWindow > best) best = m.contextWindow;
    }
  }
  return best;
}

function buildUsage(
  harnessId: HarnessId,
  usedTokens: number,
  contextWindow: number,
  percentOverride?: number,
): ContextUsage {
  const percent =
    typeof percentOverride === "number"
      ? Math.min(100, Math.max(0, Math.round(percentOverride)))
      : Math.min(
          100,
          Math.max(0, Math.round((usedTokens / contextWindow) * 100)),
        );
  return { harnessId, usedTokens, contextWindow, percent };
}

function readRateWindow(raw: unknown): RateLimitWindow | null {
  const w = asRecord(raw);
  if (!w) return null;
  const percent =
    typeof w.percent === "number"
      ? w.percent
      : typeof w.utilization === "number"
        ? w.utilization
        : null;
  if (percent == null) return null;
  return {
    percent: Math.min(100, Math.max(0, Math.round(percent))),
    resetsAt: typeof w.resetsAt === "string" ? w.resetsAt : null,
  };
}

/**
 * Preferred path: Fold's sidecar emits `{ type: "fold_context_usage", ... }`
 * from Claude Agent SDK `getContextUsage()` — same numbers as `/context`.
 */
export function contextUsageFromFoldEvent(
  event: unknown,
): ContextUsage | null {
  const ev = asRecord(event);
  if (!ev || ev.type !== "fold_context_usage") return null;
  const harnessId =
    ev.harnessId === "claudecode" ? ("claudecode" as const) : null;
  if (!harnessId) return null;
  const used =
    typeof ev.totalTokens === "number"
      ? ev.totalTokens
      : typeof ev.usedTokens === "number"
        ? ev.usedTokens
        : null;
  const window =
    typeof ev.maxTokens === "number"
      ? ev.maxTokens
      : typeof ev.contextWindow === "number"
        ? ev.contextWindow
        : null;
  if (used == null || window == null || window <= 0) return null;
  const pct = typeof ev.percentage === "number" ? ev.percentage : undefined;
  return buildUsage(harnessId, used, window, pct);
}

/** Parse `{ type: "fold_session_usage", ... }` from the Claude sidecar. */
export function sessionUsageFromFoldEvent(
  event: unknown,
): SessionUsage | null {
  const ev = asRecord(event);
  if (!ev || ev.type !== "fold_session_usage") return null;
  const harnessId =
    ev.harnessId === "claudecode" ? ("claudecode" as const) : null;
  if (!harnessId) return null;

  const fiveHour = readRateWindow(ev.fiveHour);
  const sevenDay = readRateWindow(ev.sevenDay);
  // Nothing useful to show yet (API-key plans, or pre-first-response).
  if (!fiveHour && !sevenDay && typeof ev.sessionCostUsd !== "number") {
    return null;
  }

  return {
    harnessId,
    fiveHour,
    sevenDay,
    subscriptionType:
      typeof ev.subscriptionType === "string" ? ev.subscriptionType : null,
    sessionCostUsd:
      typeof ev.sessionCostUsd === "number" ? ev.sessionCostUsd : null,
  };
}

/**
 * Fallback: extract context usage from Claude Code stream-json events when
 * `fold_context_usage` isn't available (older sidecar / mid-turn assistant).
 */
export function contextUsageFromClaudeEvent(
  event: unknown,
): ContextUsage | null {
  const fromFold = contextUsageFromFoldEvent(event);
  if (fromFold) return fromFold;

  const ev = asRecord(event);
  if (!ev) return null;

  if (ev.type === "result") {
    const usage = readUsage(ev.usage);
    if (!usage) return null;
    const window =
      contextWindowFromModelUsage(ev.modelUsage) ??
      contextWindowFromModelUsage(ev.model_usage) ??
      200_000;
    return buildUsage("claudecode", usedFromUsage(usage), window);
  }

  if (ev.type === "assistant") {
    const message = asRecord(ev.message);
    const usage = readUsage(message?.usage);
    if (!usage) return null;
    const window =
      contextWindowFromModelUsage(ev.modelUsage) ??
      contextWindowFromModelUsage(ev.model_usage) ??
      200_000;
    return buildUsage("claudecode", usedFromUsage(usage), window);
  }

  return null;
}

/** Compact token count for the status bar (e.g. 12.4k, 200k, 1.0M). */
export function formatTokenCount(n: number): string {
  if (n >= 1_000_000) {
    const m = n / 1_000_000;
    return `${m % 1 === 0 ? m.toFixed(0) : m.toFixed(1)}M`;
  }
  if (n >= 1_000) {
    const k = n / 1_000;
    return `${k % 1 === 0 ? k.toFixed(0) : k.toFixed(1)}k`;
  }
  return String(n);
}

/** Human-readable time until a rate-limit window resets. */
export function formatResetsIn(resetsAt: string | null): string | null {
  if (!resetsAt) return null;
  const resetMs = Date.parse(resetsAt);
  if (!Number.isFinite(resetMs)) return null;
  const deltaSec = Math.max(0, Math.round((resetMs - Date.now()) / 1000));
  if (deltaSec < 60) return `${deltaSec}s`;
  const mins = Math.floor(deltaSec / 60);
  if (mins < 60) return `${mins}m`;
  const hours = Math.floor(mins / 60);
  const remMins = mins % 60;
  if (hours < 48) return remMins > 0 ? `${hours}h ${remMins}m` : `${hours}h`;
  const days = Math.floor(hours / 24);
  return `${days}d`;
}
