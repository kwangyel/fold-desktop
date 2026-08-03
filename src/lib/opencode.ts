import { Channel, invoke } from "@tauri-apps/api/core";
import type { ModelInfo } from "@anthropic-ai/claude-agent-sdk";
import { isTauri } from "./git";

export interface OpenCodeStatus {
  installed: boolean;
  authenticated: boolean;
  /** `"apiKey"` when providers are configured. */
  method: string | null;
  providerCount: number;
}

/** Raw output chunk from a streamed OpenCode process. */
export type OpenCodeOutput = Uint8Array | number[];

const retainedLoginChannels: Channel<OpenCodeOutput>[] = [];
const retainedAgentChannels = new Map<string, Channel<OpenCodeOutput>>();

export function opencodeReleaseLoginChannel(): void {
  retainedLoginChannels.length = 0;
}

export function opencodeReleaseChannel(sessionId?: string): void {
  if (sessionId) {
    retainedAgentChannels.delete(sessionId);
  } else {
    retainedAgentChannels.clear();
  }
}

export async function opencodeStatus(): Promise<OpenCodeStatus> {
  if (!isTauri()) {
    return {
      installed: false,
      authenticated: false,
      method: null,
      providerCount: 0,
    };
  }
  return invoke<OpenCodeStatus>("opencode_status");
}

export async function opencodeListModels(): Promise<ModelInfo[]> {
  if (!isTauri()) {
    throw new Error("OpenCode model catalog requires the Tauri desktop app.");
  }
  return invoke<ModelInfo[]>("opencode_list_models");
}

/** Start interactive `opencode auth login` in a PTY. */
export async function opencodeLogin(
  onOutput: (chunk: OpenCodeOutput) => void,
): Promise<void> {
  if (!isTauri()) {
    throw new Error("OpenCode connection requires the Tauri desktop app.");
  }
  const output = new Channel<OpenCodeOutput>();
  output.onmessage = onOutput;
  retainedLoginChannels.push(output);
  try {
    await invoke("opencode_login", { onOutput: output });
  } catch (e) {
    opencodeReleaseLoginChannel();
    throw e;
  }
}

export async function opencodeLoginWrite(data: string): Promise<void> {
  if (!isTauri()) return;
  await invoke("opencode_login_write", { data });
}

export async function opencodeLoginCancel(): Promise<void> {
  opencodeReleaseLoginChannel();
  if (!isTauri()) return;
  await invoke("opencode_login_cancel");
}

/**
 * Run OpenCode in a worktree (`opencode run --format json`). Streams JSONL
 * events plus a final `__OPENCODE_EXIT__:<code>` sentinel.
 */
export async function opencodeAgentRun(
  sessionId: string,
  prompt: string,
  worktree: string,
  model: string | null,
  onEvent: (chunk: OpenCodeOutput) => void,
): Promise<void> {
  if (!isTauri()) {
    throw new Error("OpenCode agents require the Tauri desktop app.");
  }
  const output = new Channel<OpenCodeOutput>();
  output.onmessage = onEvent;
  retainedAgentChannels.set(sessionId, output);
  try {
    await invoke("opencode_agent_run", {
      sessionId,
      prompt,
      worktree,
      model,
      onOutput: output,
    });
  } catch (e) {
    opencodeReleaseChannel(sessionId);
    throw e;
  }
}

export async function opencodeAgentCancel(sessionId: string): Promise<void> {
  if (!isTauri()) return;
  await invoke("opencode_agent_cancel", { sessionId });
}
