import { Channel, invoke } from "@tauri-apps/api/core";
import { isTauri } from "./git";

export interface GhStatus {
  authenticated: boolean;
  username: string | null;
}

/** Raw output chunk from the streamed `gh auth login` process. */
export type GhOutput = Uint8Array | number[];

/**
 * Keep login Channels reachable so Tauri can deliver streamed output after
 * `invoke("gh_auth_login")` returns (spawn is non-blocking). Cleared on cancel
 * / finish / process exit.
 */
const retainedLoginChannels: Channel<GhOutput>[] = [];

function retainLoginChannel(channel: Channel<GhOutput>): void {
  retainedLoginChannels.push(channel);
}

/** Drop retained login Channels (call after finish / cancel / exit). */
export function ghAuthReleaseChannel(): void {
  retainedLoginChannels.length = 0;
}

/** Current GitHub auth state via the `gh` CLI. */
export async function ghAuthStatus(): Promise<GhStatus> {
  if (!isTauri()) return { authenticated: false, username: null };
  return invoke<GhStatus>("gh_auth_status");
}

/**
 * Start the interactive browser login. Output from `gh auth login --web` is
 * streamed to `onOutput`; the caller parses the one-time code from it.
 */
export async function ghAuthLogin(
  onOutput: (chunk: GhOutput) => void,
): Promise<void> {
  if (!isTauri()) {
    throw new Error("GitHub connection requires the Tauri desktop app.");
  }
  const output = new Channel<GhOutput>();
  output.onmessage = onOutput;
  retainLoginChannel(output);
  try {
    await invoke("gh_auth_login", { onOutput: output });
  } catch (e) {
    ghAuthReleaseChannel();
    throw e;
  }
}

/** Open a URL in the user's default browser (via the OS opener). */
export async function openExternal(url: string): Promise<void> {
  if (!isTauri()) {
    window.open(url, "_blank");
    return;
  }
  await invoke("open_external", { url });
}

/** Cancel a running login flow (stops the `gh auth login` process). */
export async function ghAuthCancel(): Promise<void> {
  ghAuthReleaseChannel();
  if (!isTauri()) return;
  await invoke("gh_auth_cancel");
}

/** Log out of GitHub (removes gh's stored credentials for github.com). */
export async function ghAuthLogout(): Promise<void> {
  if (!isTauri()) return;
  await invoke("gh_auth_logout");
}
