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
  if (effort) {
    // The SDK's EffortLevel union is low|medium|high|xhigh|max. The chat also
    // offers `ultracode`, so pass anything outside the union straight through
    // as a CLI arg and let Claude Code validate it.
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
  try {
    for await (const message of q) {
      emit(message);
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
