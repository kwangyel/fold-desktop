import type { ModelInfo } from "@anthropic-ai/claude-agent-sdk";
import { claudeListModels } from "../claude";
import { useClaudeStore } from "../../store/claudeStore";
import { harnessMeta } from "./catalog";
import type { HarnessAdapter } from "./types";

/**
 * Documentation / SDK-shaped fallback when live `supportedModels()` is
 * unavailable (no Node, script missing, etc.). Mirrors Claude Code model-config
 * + Agent SDK ModelInfo fields (effort / fast mode).
 *
 * @see https://code.claude.com/docs/en/model-config
 * @see https://code.claude.com/docs/en/fast-mode
 */
export const CLAUDE_CODE_MODELS_FALLBACK: ModelInfo[] = [
  {
    value: "default",
    resolvedModel: "claude-sonnet-5",
    displayName: "Default (recommended)",
    description: "Sonnet 5 · Efficient for routine tasks",
    supportsEffort: true,
    supportedEffortLevels: ["low", "medium", "high", "xhigh", "max"],
    supportsAdaptiveThinking: true,
    supportsAutoMode: true,
  },
  {
    value: "sonnet",
    resolvedModel: "claude-sonnet-5",
    displayName: "Sonnet",
    description: "Sonnet 5 · Efficient for routine tasks",
    supportsEffort: true,
    supportedEffortLevels: ["low", "medium", "high", "xhigh", "max"],
    supportsAdaptiveThinking: true,
    supportsAutoMode: true,
  },
  {
    value: "claude-fable-5[1m]",
    resolvedModel: "claude-fable-5",
    displayName: "Fable",
    description:
      "Fable 5 · Most capable for your hardest and longest-running tasks · Requires usage credits",
    supportsEffort: true,
    supportedEffortLevels: ["low", "medium", "high", "xhigh", "max"],
    supportsAdaptiveThinking: true,
    supportsAutoMode: true,
  },
  {
    value: "opus",
    resolvedModel: "claude-opus-5",
    displayName: "Opus",
    description: "Opus 5 · Best for everyday, complex tasks · ~2× usage vs Sonnet",
    supportsEffort: true,
    supportedEffortLevels: ["low", "medium", "high", "xhigh", "max"],
    supportsAdaptiveThinking: true,
    supportsFastMode: true,
    supportsAutoMode: true,
  },
  {
    value: "haiku",
    resolvedModel: "claude-haiku-4-5-20251001",
    displayName: "Haiku",
    description: "Haiku 4.5 · Fastest for quick answers",
  },
];

export const claudeCodeAdapter: HarnessAdapter = {
  id: "claudecode",
  meta: harnessMeta("claudecode"),
  isConnected: () => {
    const { installed, authenticated } = useClaudeStore.getState();
    return installed && authenticated;
  },
  // Agent SDK `permissionMode: 'plan'`.
  supportsPlanMode: true,
  listModels: async () => {
    try {
      return await claudeListModels();
    } catch {
      // Live SDK query failed — use documented catalog.
      return CLAUDE_CODE_MODELS_FALLBACK;
    }
  },
  fallbackModels: () => CLAUDE_CODE_MODELS_FALLBACK,
};
