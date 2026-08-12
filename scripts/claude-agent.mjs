#!/usr/bin/env node
/**
 * Claude Code agent sidecar, driven by the Claude Agent SDK.
 *
 * Replaces the raw `claude -p` spawn. The SDK is required (rather than the CLI's
 * headless mode) because `ExitPlanMode` and `AskUserQuestion` are only enabled
 * when a `canUseTool` callback is present — in `claude -p` they are absent from
 * the session tool list, so plan approval and clarifying questions are
 * impossible there.
 *
 * Protocol (NDJSON over stdio, consumed by src-tauri/src/claude.rs):
 *   stdin  — first line is the run config, subsequent lines are
 *            `fold_permission_response` objects.
 *   stdout — every SDK message verbatim, plus `fold_permission_request` lines
 *            emitted whenever `canUseTool` fires.
 */
import { query } from "@anthropic-ai/claude-agent-sdk";
import { createInterface } from "node:readline";

/** Effort levels the SDK accepts directly on `Options.effort`. */
const SDK_EFFORT_LEVELS = new Set(["low", "medium", "high", "xhigh", "max"]);

/** Resolvers for in-flight `canUseTool` calls, keyed by our own request id. */
const pending = new Map();
let requestSeq = 0;

/** Write one NDJSON line to stdout. */
function emit(value) {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

const rl = createInterface({ input: process.stdin });

/**
 * Resolve with the run config from the first stdin line; route every later line
 * to the matching pending permission request.
 */
const configPromise = new Promise((resolve) => {
  let haveConfig = false;
  rl.on("line", (line) => {
    const trimmed = line.trim();
    if (!trimmed) return;

    let message;
    try {
      message = JSON.parse(trimmed);
    } catch {
      // Ignore malformed input rather than killing the run.
      return;
    }

    if (!haveConfig) {
      haveConfig = true;
      resolve(message);
      return;
    }

    if (message?.type === "fold_permission_response") {
      const resolver = pending.get(message.requestId);
      if (resolver) {
        pending.delete(message.requestId);
        resolver(
          message.behavior === "allow"
            ? { behavior: "allow", updatedInput: message.updatedInput }
            : { behavior: "deny", message: message.message ?? "Denied by user." },
        );
      }
    }
  });
});

/**
 * Ask the app to decide a tool call. Stays pending until the app responds — the
 * SDK keeps the turn paused, which is what lets the plan sit awaiting approval.
 */
function canUseTool(toolName, input, options) {
  const requestId = `perm-${++requestSeq}`;
  emit({
    type: "fold_permission_request",
    requestId,
    toolName,
    input,
    toolUseID: options?.toolUseID,
    title: options?.title,
    description: options?.description,
  });

  return new Promise((resolve) => {
    pending.set(requestId, resolve);
    options?.signal?.addEventListener("abort", () => {
      if (pending.delete(requestId)) {
        resolve({ behavior: "deny", message: "Cancelled." });
      }
    });
  });
}

async function main() {
  const config = await configPromise;
  const {
    prompt,
    cwd,
    model,
    effort,
    fastMode,
    permissionMode,
    resumeSessionId,
    plansDirectory,
  } = config;

  /** @type {Record<string, unknown>} */
  const settings = {};
  if (plansDirectory) settings.plansDirectory = plansDirectory;

  const options = {
    cwd,
    // Plan mode routes edits to canUseTool on its own; outside it we keep the
    // previous CLI behaviour of accepting edits without prompting.
    permissionMode: permissionMode || "acceptEdits",
    canUseTool,
    includePartialMessages: false,
    stderr: (data) => process.stderr.write(data),
  };

  if (model) options.model = model;
  if (effort === "ultracode") {
    options.ultracode = true;
    options.effort = "xhigh";
  } else if (effort) {
    // The SDK's EffortLevel union is low|medium|high|xhigh|max. Pass anything
    // outside the union straight through as a CLI arg and let Claude Code validate it.
    if (SDK_EFFORT_LEVELS.has(effort)) {
      options.effort = effort;
    } else {
      options.extraArgs = { ...options.extraArgs, effort };
    }
  }
  if (resumeSessionId) options.resume = resumeSessionId;
  if (Object.keys(settings).length > 0) options.settings = settings;
  // Non-interactive fast mode is a settings flag, matching the previous
  // `--settings '{"fastMode":true}'` CLI invocation.
  if (fastMode) options.settings = { ...settings, fastMode: true };

  const q = query({ prompt, options });

  /** Race a promise against a short timeout so the stream never stalls. */
  function withTimeout(promise, ms, label) {
    return Promise.race([
      promise,
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error(`${label} timeout`)), ms),
      ),
    ]);
  }

  /** Retry an async fn up to `attempts` times with a pause between failures. */
  async function retryAsync(fn, attempts, delayMs = 1000) {
    let lastErr;
    for (let i = 1; i <= attempts; i++) {
      try {
        return await fn();
      } catch (err) {
        lastErr = err;
        if (i < attempts) {
          await new Promise((resolve) => setTimeout(resolve, delayMs));
        }
      }
    }
    throw lastErr;
  }

  /** Push Claude Code's `/context` occupancy to the app for the status bar. */
  async function emitContextUsage() {
    if (typeof q.getContextUsage !== "function") return false;
    try {
      const usage = await retryAsync(
        () => withTimeout(q.getContextUsage(), 10000, "getContextUsage"),
        3,
      );
      if (!usage || typeof usage.totalTokens !== "number") return false;
      emit({
        type: "fold_context_usage",
        harnessId: "claudecode",
        totalTokens: usage.totalTokens,
        maxTokens: usage.maxTokens,
        percentage: usage.percentage,
        model: usage.model,
      });
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Push Claude.ai plan session / weekly rate-limit utilization (same data as
   * `/usage`). Method name is experimental in the SDK — call defensively.
   */
  async function emitSessionUsage() {
    const usageFn =
      typeof q.usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET ===
      "function"
        ? q.usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET.bind(q)
        : typeof q.getUsage === "function"
          ? q.getUsage.bind(q)
          : null;
    if (!usageFn) return false;
    try {
      const usage = await retryAsync(
        () => withTimeout(usageFn(), 10000, "getUsage"),
        3,
      );
      if (!usage) return false;
      const five = usage.rate_limits?.five_hour;
      const seven = usage.rate_limits?.seven_day;
      emit({
        type: "fold_session_usage",
        harnessId: "claudecode",
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
      });
      return true;
    } catch {
      return false;
    }
  }

  // Control-channel usage APIs need initialization first (same as supportedModels).
  async function emitUsageAfterInit() {
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        if (typeof q.supportedModels === "function") {
          await retryAsync(
            () => withTimeout(q.supportedModels(), 20000, "supportedModels"),
            3,
          );
        }
        const gotContext = await emitContextUsage();
        const gotSession = await emitSessionUsage();
        if (gotContext || gotSession) return;
      } catch {
        // Init / control channel not ready — retry.
      }
      if (attempt < 3) {
        await new Promise((resolve) => setTimeout(resolve, 1000));
      }
    }
  }

  // Fetch status as soon as the SDK session is live — don't wait for a turn.
  void emitUsageAfterInit();

  try {
    for await (const message of q) {
      emit(message);
      // Refresh after assistant turns while the control channel is still alive.
      if (message?.type === "assistant") {
        await emitContextUsage();
        await emitSessionUsage();
      }
      // Capture utilization when the SDK surfaces a rate-limit snapshot.
      if (message?.type === "rate_limit_event") {
        const info = message.rate_limit_info;
        if (info && typeof info.utilization === "number") {
          const pct =
            info.utilization <= 1
              ? Math.round(info.utilization * 100)
              : Math.round(info.utilization);
          emit({
            type: "fold_session_usage",
            harnessId: "claudecode",
            rateLimitsAvailable: true,
            fiveHour:
              !info.rateLimitType || info.rateLimitType === "five_hour"
                ? {
                    percent: pct,
                    resetsAt:
                      typeof info.resetsAt === "number"
                        ? new Date(info.resetsAt * 1000).toISOString()
                        : null,
                  }
                : null,
            sevenDay:
              info.rateLimitType === "seven_day"
                ? {
                    percent: pct,
                    resetsAt:
                      typeof info.resetsAt === "number"
                        ? new Date(info.resetsAt * 1000).toISOString()
                        : null,
                  }
                : null,
            sessionCostUsd: null,
          });
        }
      }
    }
  } finally {
    for (const resolve of pending.values()) {
      resolve({ behavior: "deny", message: "Session ended." });
    }
    pending.clear();
    rl.close();
    await q.close?.();
  }
}

main().then(
  () => process.exit(0),
  (err) => {
    process.stderr.write(`${err?.stack ?? String(err)}\n`);
    process.exit(1);
  },
);
