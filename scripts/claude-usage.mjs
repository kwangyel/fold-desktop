#!/usr/bin/env node
/**
 * Fetch Claude Code context-window + plan session usage via the Agent SDK.
 * Prints JSON to stdout. Used by the Tauri `claude_usage_status` command.
 *
 * Important: control-channel methods (`getContextUsage`, `getUsage`) only work
 * after the query has finished initializing — we await `supportedModels()`
 * (same pattern as list-claude-models.mjs) before calling them.
 */
import { query } from "@anthropic-ai/claude-agent-sdk";

function withTimeout(promise, ms, label) {
  return Promise.race([
    promise,
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error(`${label} timeout`)), ms),
    ),
  ]);
}

const cwd = process.argv[2] || process.cwd();

const q = query({
  prompt: "x",
  options: {
    cwd,
    maxTurns: 1,
    permissionMode: "bypassPermissions",
  },
});

/** @type {{ context: object | null, session: object | null }} */
const result = { context: null, session: null };

try {
  // Wait for the SDK session / control channel before querying usage.
  await withTimeout(q.supportedModels(), 20000, "supportedModels");

  if (typeof q.getContextUsage === "function") {
    try {
      const usage = await withTimeout(q.getContextUsage(), 10000, "getContextUsage");
      if (usage && typeof usage.totalTokens === "number") {
        result.context = {
          totalTokens: usage.totalTokens,
          maxTokens: usage.maxTokens,
          percentage: usage.percentage,
          model: usage.model,
        };
      }
    } catch {
      // Control channel may be unavailable — ignore.
    }
  }

  const usageFn =
    typeof q.usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET ===
    "function"
      ? q.usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET.bind(q)
      : typeof q.getUsage === "function"
        ? q.getUsage.bind(q)
        : null;

  if (usageFn) {
    try {
      const usage = await withTimeout(usageFn(), 10000, "getUsage");
      if (usage) {
        const five = usage.rate_limits?.five_hour;
        const seven = usage.rate_limits?.seven_day;
        result.session = {
          rateLimitsAvailable: Boolean(usage.rate_limits_available),
          subscriptionType: usage.subscription_type ?? null,
          fiveHour:
            five && typeof five.utilization === "number"
              ? { percent: five.utilization, resetsAt: five.resets_at ?? null }
              : null,
          sevenDay:
            seven && typeof seven.utilization === "number"
              ? { percent: seven.utilization, resetsAt: seven.resets_at ?? null }
              : null,
          sessionCostUsd:
            typeof usage.session?.total_cost_usd === "number"
              ? usage.session.total_cost_usd
              : null,
        };
      }
    } catch {
      // Experimental API — ignore.
    }
  }
} finally {
  await q.close?.();
}

process.stdout.write(JSON.stringify(result));
