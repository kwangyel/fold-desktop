#!/usr/bin/env node
/**
 * Fetch Claude.ai plan session usage (5-hour + weekly quotas, same data as
 * `/usage`) via the Agent SDK. Used by the Tauri `claude_usage_status` command.
 *
 * Deliberately does NOT report context-window usage. This script stands up its
 * own throwaway SDK session, so `getContextUsage()` here describes that session
 * (~13k baseline tokens) rather than the user's conversation — a number that
 * looks live but is always wrong. Real context usage comes from the long-lived
 * `claude-agent.mjs` sidecar, which owns the actual session. Rate limits are
 * account-wide, so they're accurate from any session.
 *
 * Important: control-channel methods only work after the query has finished
 * initializing — we await `supportedModels()` (same pattern as
 * list-claude-models.mjs) before calling them.
 *
 * Output is NDJSON in two phases, so the caller can time connecting and
 * querying separately (booting the CLI dominates the wall time — ~20s cold —
 * while the usage call itself returns in milliseconds):
 *   1. `{"type":"fold_usage_ready"}` once the SDK control channel is live.
 *   2. `{"session":…}` — the result, always printed, `null` when unavailable.
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

/** @type {{ session: object | null, error?: string }} */
const result = { session: null };

try {
  // Wait for the SDK session / control channel before querying usage. No local
  // timeout here — the caller bounds this phase via the handshake below, so a
  // slow-but-progressing cold boot isn't cut off at an arbitrary mark.
  await q.supportedModels();
  // Connection is live: the caller now switches to its shorter query deadline.
  process.stdout.write(`${JSON.stringify({ type: "fold_usage_ready" })}\n`);

  const usageFn =
    typeof q.usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET ===
    "function"
      ? q.usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET.bind(q)
      : typeof q.getUsage === "function"
        ? q.getUsage.bind(q)
        : null;

  if (!usageFn) {
    result.error = "SDK exposes no usage method";
  } else {
    const usage = await withTimeout(usageFn(), 10000, "getUsage");
    if (!usage) {
      result.error = "usage call returned nothing";
    } else {
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
  }
} catch (err) {
  // Never exit without a result line — the caller distinguishes "connected but
  // no usage data" from a crash, and a bare rejection would look like the latter.
  result.error = err?.message ?? String(err);
} finally {
  await q.close?.();
}

process.stdout.write(`${JSON.stringify(result)}\n`);
