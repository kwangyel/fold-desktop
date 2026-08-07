import type { ModelInfo } from "@anthropic-ai/claude-agent-sdk";
import { claudeListModels } from "../claude";
import { useClaudeStore } from "../../store/claudeStore";
import { harnessMeta } from "./catalog";
import type { HarnessAdapter } from "./types";

/**
 * No static Claude Code catalog. Live Agent SDK `supportedModels()` is the
 * only source — aliases and versioned IDs come from whatever the SDK returns
 * for the installed Claude Code / account.
 *
 * @see https://code.claude.com/docs/en/model-config
 */
export const CLAUDE_CODE_MODELS_FALLBACK: ModelInfo[] = [];

export const claudeCodeAdapter: HarnessAdapter = {
  id: "claudecode",
  meta: harnessMeta("claudecode"),
  isConnected: () => {
    const { installed, authenticated } = useClaudeStore.getState();
    return installed && authenticated;
  },
  // Agent SDK `permissionMode: 'plan'`.
  supportsPlanMode: true,
  listModels: async () => claudeListModels(),
  fallbackModels: () => CLAUDE_CODE_MODELS_FALLBACK,
};
