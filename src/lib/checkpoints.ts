import { invoke } from "@tauri-apps/api/core";
import { isTauri } from "./git";

function asError(e: unknown, fallback: string): Error {
  if (e instanceof Error) return e;
  if (typeof e === "string" && e.trim()) return new Error(e);
  if (e && typeof e === "object" && "message" in e) {
    const message = (e as { message: unknown }).message;
    if (typeof message === "string" && message.trim()) return new Error(message);
  }
  return new Error(fallback);
}

/** Snapshot the worktree (tracked + untracked) and return the commit SHA. */
export async function createCheckpoint(worktree: string): Promise<string> {
  if (!isTauri()) return "";
  try {
    return await invoke<string>("checkpoint_create", { worktree });
  } catch (e) {
    throw asError(e, "Failed to create checkpoint.");
  }
}

/**
 * Restore the worktree to `sha`, drop chat messages after `messageId`, and
 * clear harness sessions for this chat.
 */
export async function rollbackCheckpoint(
  worktree: string,
  chatId: string,
  messageId: string,
  sha: string,
): Promise<void> {
  if (!isTauri()) return;
  try {
    await invoke("checkpoint_rollback", { worktree, chatId, messageId, sha });
  } catch (e) {
    throw asError(e, "Failed to restore checkpoint.");
  }
}
