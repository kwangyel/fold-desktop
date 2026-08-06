import { Channel, invoke } from "@tauri-apps/api/core";
import type { ModelInfo } from "@anthropic-ai/claude-agent-sdk";
import { isTauri } from "./git";

export interface ClaudeStatus {
  installed: boolean;
  authenticated: boolean;
  /** `"subscription"` | `"apiKey"` when authenticated. */
  method: string | null;
  /**
   * Set when the credential store exists but could not be read (e.g. macOS
   * keychain ACL denied `/usr/bin/security`). Distinct from "not logged in".
   */
  credentialError?: string | null;
}

/** Raw output chunk from a streamed Claude CLI process. */
export type ClaudeOutput = Uint8Array | number[];

/**
 * Keep Channels reachable so Tauri can deliver streamed output after
 * `invoke` returns (spawn is non-blocking). Cleared on cancel / finish / exit.
 */
const retainedLoginChannels: Channel<ClaudeOutput>[] = [];
const retainedAgentChannels = new Map<string, Channel<ClaudeOutput>>();

/** Drop the retained login Channel. */
export function claudeReleaseLoginChannel(): void {
  retainedLoginChannels.length = 0;
}

/** Drop a retained agent Channel (or all of them when `sessionId` omitted). */
export function claudeReleaseChannel(sessionId?: string): void {
  if (sessionId) {
    retainedAgentChannels.delete(sessionId);
  } else {
    retainedAgentChannels.clear();
  }
}

/** Current Claude Code CLI install + auth state. */
export async function claudeStatus(force = false): Promise<ClaudeStatus> {
  if (!isTauri()) {
    return { installed: false, authenticated: false, method: null };
  }
  return invoke<ClaudeStatus>("claude_status", { force });
}

/**
 * Model catalog from the Claude Agent SDK (`supportedModels()`).
 * Throws when the SDK query fails (caller may fall back to docs).
 */
export async function claudeListModels(): Promise<ModelInfo[]> {
  if (!isTauri()) {
    throw new Error("Claude model catalog requires the Tauri desktop app.");
  }
  return invoke<ModelInfo[]>("claude_list_models");
}

/** Context-window + plan session usage from the Agent SDK. */
export type ClaudeUsageStatus = {
  context: Record<string, unknown> | null;
  session: Record<string, unknown> | null;
};

/** Fetch Claude context + session usage without running an agent turn. */
export async function claudeUsageStatus(
  worktree?: string | null,
): Promise<ClaudeUsageStatus> {
  if (!isTauri()) {
    return { context: null, session: null };
  }
  return invoke<ClaudeUsageStatus>("claude_usage_status", {
    worktree: worktree ?? null,
  });
}

/**
 * Start interactive Claude Code login in a PTY. Output streams to `onOutput`.
 * Caller should watch for TUI readiness before writing `/login\r`.
 */
export async function claudeLogin(
  onOutput: (chunk: ClaudeOutput) => void,
): Promise<void> {
  if (!isTauri()) {
    throw new Error("Claude Code connection requires the Tauri desktop app.");
  }
  const output = new Channel<ClaudeOutput>();
  output.onmessage = onOutput;
  retainedLoginChannels.push(output);
  try {
    await invoke("claude_login", { onOutput: output });
  } catch (e) {
    claudeReleaseLoginChannel();
    throw e;
  }
}

/** Write to the in-progress login PTY. */
export async function claudeLoginWrite(data: string): Promise<void> {
  if (!isTauri()) return;
  await invoke("claude_login_write", { data });
}

/** Cancel a running login flow (kills the login PTY). */
export async function claudeLoginCancel(): Promise<void> {
  claudeReleaseLoginChannel();
  if (!isTauri()) return;
  await invoke("claude_login_cancel");
}

/** Permission modes accepted by the Claude Agent SDK. */
export type ClaudePermissionMode =
  | "default"
  | "acceptEdits"
  | "plan"
  | "dontAsk"
  | "bypassPermissions";

/**
 * A pending `canUseTool` request from the agent sidecar. Emitted for
 * `ExitPlanMode`, `AskUserQuestion`, and any tool call the permission mode
 * routes to a prompt.
 */
export type ClaudePermissionRequest = {
  type: "fold_permission_request";
  requestId: string;
  toolName: string;
  input: Record<string, unknown>;
  toolUseID?: string;
  title?: string;
  description?: string;
};

/** Our answer to a `ClaudePermissionRequest`. */
export type ClaudePermissionResponse =
  | {
      type: "fold_permission_response";
      requestId: string;
      behavior: "allow";
      updatedInput?: Record<string, unknown>;
    }
  | {
      type: "fold_permission_response";
      requestId: string;
      behavior: "deny";
      message: string;
    };

/**
 * Run a Claude Code agent in a worktree via the Agent SDK sidecar. Streams
 * NDJSON SDK messages (plus a final `__CLAUDE_EXIT__:<code>` sentinel) to
 * `onEvent`.
 */
export async function claudeAgentRun(
  sessionId: string,
  prompt: string,
  worktree: string,
  model: string | null,
  effort: string | null,
  fastMode: boolean,
  permissionMode: ClaudePermissionMode | null,
  onEvent: (chunk: ClaudeOutput) => void,
): Promise<void> {
  if (!isTauri()) {
    throw new Error("Claude Code agents require the Tauri desktop app.");
  }
  const output = new Channel<ClaudeOutput>();
  output.onmessage = onEvent;
  retainedAgentChannels.set(sessionId, output);
  try {
    await invoke("claude_agent_run", {
      sessionId,
      prompt,
      worktree,
      model,
      effort,
      fastMode,
      permissionMode,
      resumeSessionId: null,
      onOutput: output,
    });
  } catch (e) {
    claudeReleaseChannel(sessionId);
    throw e;
  }
}

/** Answer a pending `canUseTool` request for a running agent. */
export async function claudeAgentRespond(
  sessionId: string,
  response: ClaudePermissionResponse,
): Promise<void> {
  if (!isTauri()) return;
  await invoke("claude_agent_respond", {
    sessionId,
    response: JSON.stringify(response),
  });
}

/** Cancel a running Claude Code agent for the given session. */
export async function claudeAgentCancel(sessionId: string): Promise<void> {
  if (!isTauri()) return;
  await invoke("claude_agent_cancel", { sessionId });
}
