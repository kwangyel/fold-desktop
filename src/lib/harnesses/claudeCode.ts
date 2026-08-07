import type { ModelInfo } from "@anthropic-ai/claude-agent-sdk";
import { claudeListModels } from "../claude";
import { useClaudeStore } from "../../store/claudeStore";
import { harnessMeta } from "./catalog";
import type { HarnessAdapter } from "./types";

/**
 * Full Claude Code model-alias catalog from the docs.
 * Live `supportedModels()` is preferred when available; this list fills any
 * aliases the SDK omits so the picker matches `/model` in Claude Code.
 *
 * @see https://code.claude.com/docs/en/model-config
 * @see https://code.claude.com/docs/en/fast-mode
 */
export const CLAUDE_CODE_MODELS_FALLBACK: ModelInfo[] = [
  {
    value: "default",
    resolvedModel: "claude-sonnet-5",
    displayName: "Default (recommended)",
    description: "Recommended model for your account type",
    supportsEffort: true,
    supportedEffortLevels: ["low", "medium", "high", "xhigh", "max"],
    supportsAdaptiveThinking: true,
    supportsAutoMode: true,
  },
  {
    value: "best",
    resolvedModel: "claude-fable-5",
    displayName: "Best",
    description: "Fable 5 when available, otherwise latest Opus",
    supportsEffort: true,
    supportedEffortLevels: ["low", "medium", "high", "xhigh", "max"],
    supportsAdaptiveThinking: true,
    supportsAutoMode: true,
  },
  {
    value: "fable",
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
    value: "claude-fable-5[1m]",
    resolvedModel: "claude-fable-5",
    displayName: "Fable (1M)",
    description: "Fable 5 with 1M context · Requires usage credits",
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
    value: "sonnet[1m]",
    resolvedModel: "claude-sonnet-5",
    displayName: "Sonnet (1M)",
    description: "Sonnet with a 1M-token context window for long sessions",
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
    value: "opus[1m]",
    resolvedModel: "claude-opus-5",
    displayName: "Opus (1M)",
    description: "Opus with a 1M-token context window for long sessions",
    supportsEffort: true,
    supportedEffortLevels: ["low", "medium", "high", "xhigh", "max"],
    supportsAdaptiveThinking: true,
    supportsFastMode: true,
    supportsAutoMode: true,
  },
  {
    value: "opusplan",
    resolvedModel: "claude-opus-5",
    displayName: "Opus Plan",
    description: "Opus while planning, then Sonnet for execution",
    supportsEffort: true,
    supportedEffortLevels: ["low", "medium", "high", "xhigh", "max"],
    supportsAdaptiveThinking: true,
    supportsAutoMode: true,
  },
  {
    value: "haiku",
    resolvedModel: "claude-haiku-4-5-20251001",
    displayName: "Haiku",
    description: "Haiku 4.5 · Fastest for quick answers",
    // No supportsEffort — Haiku does not expose effort levels.
  },
];

/**
 * Prefer live SDK entries (accurate capability flags), then append any
 * documented aliases the SDK omitted so the picker matches Claude Code `/model`.
 */
export function mergeClaudeModelCatalog(
  live: ModelInfo[],
  fallback: ModelInfo[] = CLAUDE_CODE_MODELS_FALLBACK,
): ModelInfo[] {
  const byValue = new Map<string, ModelInfo>();
  for (const model of live) {
    byValue.set(model.value, model);
  }
  for (const model of fallback) {
    if (!byValue.has(model.value)) {
      byValue.set(model.value, model);
    }
  }

  // Stable order: documented catalog order, then any extra live-only entries.
  const ordered: ModelInfo[] = [];
  const seen = new Set<string>();
  for (const model of fallback) {
    const entry = byValue.get(model.value);
    if (entry) {
      ordered.push(entry);
      seen.add(model.value);
    }
  }
  for (const model of live) {
    if (!seen.has(model.value)) {
      ordered.push(model);
      seen.add(model.value);
    }
  }
  return ordered;
}

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
      const live = await claudeListModels();
      return mergeClaudeModelCatalog(live);
    } catch {
      // Live SDK query failed — use documented catalog.
      return CLAUDE_CODE_MODELS_FALLBACK;
    }
  },
  fallbackModels: () => CLAUDE_CODE_MODELS_FALLBACK,
};
