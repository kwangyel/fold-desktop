import type { ModelInfo } from "@anthropic-ai/claude-agent-sdk";
import { codexListModels } from "../codex";
import { useCodexStore } from "../../store/codexStore";
import { harnessMeta } from "./catalog";
import type { HarnessAdapter } from "./types";

/**
 * Docs-shaped fallback when live Codex model list is unavailable.
 * @see https://developers.openai.com/codex/cli/reference
 */
export const CODEX_MODELS_FALLBACK: ModelInfo[] = [
  {
    value: "gpt-5.4",
    resolvedModel: "gpt-5.4",
    displayName: "GPT-5.4",
    description: "GPT-5.4 · Default Codex coding model",
    supportsEffort: true,
    supportedEffortLevels: ["low", "medium", "high", "xhigh"],
    supportsFastMode: true,
  },
  {
    value: "gpt-5.4-mini",
    resolvedModel: "gpt-5.4-mini",
    displayName: "GPT-5.4 Mini",
    description: "GPT-5.4 Mini · Faster, lighter coding tasks",
    supportsEffort: true,
    supportedEffortLevels: ["low", "medium", "high"],
  },
  {
    value: "gpt-5.5",
    resolvedModel: "gpt-5.5",
    displayName: "GPT-5.5",
    description: "GPT-5.5 · Latest Codex model when available",
    supportsEffort: true,
    supportedEffortLevels: ["low", "medium", "high", "xhigh"],
  },
  {
    value: "o3",
    resolvedModel: "o3",
    displayName: "o3",
    description: "o3 · Strong reasoning for complex tasks",
    supportsEffort: true,
    supportedEffortLevels: ["low", "medium", "high"],
  },
];

export const codexAdapter: HarnessAdapter = {
  id: "codex",
  meta: harnessMeta("codex"),
  isConnected: () => {
    const { installed, authenticated } = useCodexStore.getState();
    return installed && authenticated;
  },
  // `codex exec` has no planning mode — only `--sandbox read-only`.
  supportsPlanMode: false,
  listModels: async () => {
    try {
      return await codexListModels();
    } catch {
      return CODEX_MODELS_FALLBACK;
    }
  },
};
