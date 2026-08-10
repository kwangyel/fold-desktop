import { Channel, invoke } from "@tauri-apps/api/core";
import type { ModelInfo } from "@anthropic-ai/claude-agent-sdk";
import { isTauri } from "./git";

export interface CodexStatus {
  installed: boolean;
  authenticated: boolean;
  /** `"subscription"` | `"apiKey"` when authenticated. */
  method: string | null;
}

/** Raw output chunk from a streamed Codex process. */
export type CodexOutput = Uint8Array | number[];

const retainedLoginChannels: Channel<CodexOutput>[] = [];
const retainedAgentChannels = new Map<string, Channel<CodexOutput>>();

export function codexReleaseLoginChannel(): void {
  retainedLoginChannels.length = 0;
}

export function codexReleaseChannel(sessionId?: string): void {
  if (sessionId) {
    retainedAgentChannels.delete(sessionId);
  } else {
    retainedAgentChannels.clear();
  }
}

export async function codexStatus(force = false): Promise<CodexStatus> {
  if (!isTauri()) {
    return { installed: false, authenticated: false, method: null };
  }
  return invoke<CodexStatus>("codex_status", { force });
}

export async function codexListModels(): Promise<ModelInfo[]> {
  if (!isTauri()) {
    throw new Error("Codex model catalog requires the Tauri desktop app.");
  }
  return invoke<ModelInfo[]>("codex_list_models");
}

/** Start interactive `codex login` in a PTY. */
export async function codexLogin(
  onOutput: (chunk: CodexOutput) => void,
): Promise<void> {
  if (!isTauri()) {
    throw new Error("Codex connection requires the Tauri desktop app.");
  }
  const output = new Channel<CodexOutput>();
  output.onmessage = onOutput;
  retainedLoginChannels.push(output);
  try {
    await invoke("codex_login", { onOutput: output });
  } catch (e) {
    codexReleaseLoginChannel();
    throw e;
  }
}

export async function codexLoginWrite(data: string): Promise<void> {
  if (!isTauri()) return;
  await invoke("codex_login_write", { data });
}

export async function codexLoginCancel(): Promise<void> {
  codexReleaseLoginChannel();
  if (!isTauri()) return;
  await invoke("codex_login_cancel");
}

/**
 * Run Codex in a worktree (`codex exec --json`). Streams JSONL events plus
 * a final `__CODEX_EXIT__:<code>` sentinel.
 */
export async function codexAgentRun(
  sessionId: string,
  prompt: string,
  worktree: string,
  model: string | null,
  effort: string | null,
  resumeSessionId: string | null,
  onEvent: (chunk: CodexOutput) => void,
): Promise<void> {
  if (!isTauri()) {
    throw new Error("Codex agents require the Tauri desktop app.");
  }
  const output = new Channel<CodexOutput>();
  output.onmessage = onEvent;
  retainedAgentChannels.set(sessionId, output);
  try {
    await invoke("codex_agent_run", {
      sessionId,
      prompt,
      worktree,
      model,
      effort,
      resumeSessionId,
      onOutput: output,
    });
  } catch (e) {
    codexReleaseChannel(sessionId);
    throw e;
  }
}

export async function codexAgentCancel(sessionId: string): Promise<void> {
  if (!isTauri()) return;
  await invoke("codex_agent_cancel", { sessionId });
}
