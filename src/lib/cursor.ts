import { Channel, invoke } from "@tauri-apps/api/core";
import type { ModelInfo } from "@anthropic-ai/claude-agent-sdk";
import { isTauri } from "./git";

export interface CursorStatus {
  authenticated: boolean;
  /** `"apiKey"` when a key is saved in app config. */
  method: string | null;
  apiKeyName: string | null;
  userEmail: string | null;
  /** Whether the Cursor Agent CLI (`agent`) is installed. */
  cliInstalled: boolean;
}

/** Raw output chunk from a streamed Cursor agent process. */
export type CursorOutput = Uint8Array | number[];

/**
 * Keep Channels reachable so Tauri can deliver streamed output after
 * `invoke` returns. Cleared on cancel / finish / exit.
 */
const retainedAgentChannels = new Map<string, Channel<CursorOutput>>();

/** Drop a retained agent Channel (or all of them when `sessionId` omitted). */
export function cursorReleaseChannel(sessionId?: string): void {
  if (sessionId) {
    retainedAgentChannels.delete(sessionId);
  } else {
    retainedAgentChannels.clear();
  }
}

/** Current Cursor API key + CLI install state. */
export async function cursorStatus(force = false): Promise<CursorStatus> {
  if (!isTauri()) {
    return {
      authenticated: false,
      method: null,
      apiKeyName: null,
      userEmail: null,
      cliInstalled: false,
    };
  }
  return invoke<CursorStatus>("cursor_status", { force });
}

/**
 * Validate `apiKey` against Cursor `GET /v1/me` and persist it.
 * @see https://cursor.com/docs/cloud-agent/api/endpoints#api-key-info
 */
export async function cursorConnect(apiKey: string): Promise<CursorStatus> {
  if (!isTauri()) {
    throw new Error("Cursor connection requires the Tauri desktop app.");
  }
  return invoke<CursorStatus>("cursor_connect", { apiKey });
}

/** Clear the saved Cursor API key. */
export async function cursorDisconnect(): Promise<CursorStatus> {
  if (!isTauri()) {
    return {
      authenticated: false,
      method: null,
      apiKeyName: null,
      userEmail: null,
      cliInstalled: false,
    };
  }
  return invoke<CursorStatus>("cursor_disconnect");
}

/**
 * Model catalog from Cursor Cloud Agents API (`GET /v1/models`).
 * @see https://cursor.com/docs/cloud-agent/api/endpoints#list-models
 */
export async function cursorListModels(): Promise<ModelInfo[]> {
  if (!isTauri()) {
    throw new Error("Cursor model catalog requires the Tauri desktop app.");
  }
  return invoke<ModelInfo[]>("cursor_list_models");
}

/**
 * Run Cursor Agent CLI in a worktree. Streams NDJSON `stream-json` events
 * (plus a final `__CURSOR_EXIT__:<code>` sentinel) to `onEvent`.
 */
export async function cursorAgentRun(
  sessionId: string,
  prompt: string,
  worktree: string,
  model: string | null,
  planMode: boolean,
  onEvent: (chunk: CursorOutput) => void,
): Promise<void> {
  if (!isTauri()) {
    throw new Error("Cursor agents require the Tauri desktop app.");
  }
  const output = new Channel<CursorOutput>();
  output.onmessage = onEvent;
  retainedAgentChannels.set(sessionId, output);
  try {
    await invoke("cursor_agent_run", {
      sessionId,
      prompt,
      worktree,
      model,
      planMode,
      onOutput: output,
    });
  } catch (e) {
    cursorReleaseChannel(sessionId);
    throw e;
  }
}

/** Cancel a running Cursor agent for the given session. */
export async function cursorAgentCancel(sessionId: string): Promise<void> {
  if (!isTauri()) return;
  await invoke("cursor_agent_cancel", { sessionId });
}
