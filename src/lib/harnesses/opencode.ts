import type { ModelInfo } from "@anthropic-ai/claude-agent-sdk";
import { opencodeListModels } from "../opencode";
import { useOpenCodeStore } from "../../store/opencodeStore";
import { harnessMeta } from "./catalog";
import type { HarnessAdapter } from "./types";

/**
 * Docs-shaped fallback when live `opencode models` is unavailable.
 * @see https://opencode.ai/docs/cli/
 */
export const OPENCODE_MODELS_FALLBACK: ModelInfo[] = [
  {
    value: "opencode/gpt-5.1-codex",
    resolvedModel: "opencode/gpt-5.1-codex",
    displayName: "GPT-5.1 Codex",
    description: "OpenCode Zen · GPT-5.1 Codex",
  },
  {
    value: "anthropic/claude-sonnet-4-5",
    resolvedModel: "anthropic/claude-sonnet-4-5",
    displayName: "Claude Sonnet 4.5",
    description: "Anthropic · Claude Sonnet 4.5",
  },
  {
    value: "openai/gpt-5",
    resolvedModel: "openai/gpt-5",
    displayName: "GPT-5",
    description: "OpenAI · GPT-5",
  },
];

export const opencodeAdapter: HarnessAdapter = {
  id: "opencode",
  meta: harnessMeta("opencode"),
  isConnected: () => {
    const { installed, authenticated } = useOpenCodeStore.getState();
    return installed && authenticated;
  },
  // `opencode run --agent plan` (built-in read-only planning agent).
  supportsPlanMode: true,
  listModels: async () => {
    try {
      return await opencodeListModels();
    } catch {
      return OPENCODE_MODELS_FALLBACK;
    }
  },
  fallbackModels: () => OPENCODE_MODELS_FALLBACK,
};
