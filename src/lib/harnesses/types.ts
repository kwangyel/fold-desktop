import type { ModelInfo } from "@anthropic-ai/claude-agent-sdk";

/** Known harness identifiers. */
export type HarnessId = "claudecode" | "codex" | "cursor" | "opencode";

/**
 * Effort / reasoning levels across harnesses.
 * @see https://platform.claude.com/docs/en/build-with-claude/effort
 * @see https://developers.openai.com/codex/config-advanced
 */
export type EffortLevel =
  | "minimal"
  | "low"
  | "medium"
  | "high"
  | "xhigh"
  | "max"
  | "ultracode";

/** Shared display metadata for a harness (icons, labels). */
export type HarnessMeta = {
  id: HarnessId;
  name: string;
  description: string;
  iconClass: string;
  iconLabel: string;
};

/** A model offered by a connected harness, ready for the chat picker. */
export type HarnessModel = Omit<ModelInfo, "supportedEffortLevels"> & {
  harnessId: HarnessId;
  supportedEffortLevels?: EffortLevel[];
};

export type HarnessAdapter = {
  id: HarnessId;
  meta: HarnessMeta;
  /** Whether this harness is installed + authenticated. */
  isConnected: () => boolean;
  /**
   * Whether this harness has a read-only planning mode. Codex has none — its
   * `exec` subcommand only offers `--sandbox read-only` — so the plan toggle is
   * hidden for it.
   */
  supportsPlanMode: boolean;
  /** Fetch models from the harness SDK/API (or docs fallback). */
  listModels: () => Promise<ModelInfo[]>;
  /**
   * Static catalog used when the live fetch hangs or fails. Kept separate so
   * a timed-out `listModels` can still fill the picker without waiting on IPC.
   */
  fallbackModels: () => ModelInfo[];
};
