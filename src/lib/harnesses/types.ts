import type { ModelInfo } from "@anthropic-ai/claude-agent-sdk";

/** Known harness identifiers. */
export type HarnessId = "claudecode" | "codex" | "cursor" | "opencode";

/** Effort levels accepted by Claude Code (`--effort`) / Agent SDK. */
export type EffortLevel = "low" | "medium" | "high" | "xhigh" | "max" | "ultracode";

/** Shared display metadata for a harness (icons, labels). */
export type HarnessMeta = {
  id: HarnessId;
  name: string;
  description: string;
  iconClass: string;
  iconLabel: string;
};

/** A model offered by a connected harness, ready for the chat picker. */
export type HarnessModel = ModelInfo & {
  harnessId: HarnessId;
};

export type HarnessAdapter = {
  id: HarnessId;
  meta: HarnessMeta;
  /** Whether this harness is installed + authenticated. */
  isConnected: () => boolean;
  /** Fetch models from the harness SDK/API (or docs fallback). */
  listModels: () => Promise<ModelInfo[]>;
};
