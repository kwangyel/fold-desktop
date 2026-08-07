import type { EffortLevel, HarnessId, HarnessModel } from "./harnesses/types";

/** Canonical effort order for cycling and merge. */
export const EFFORT_ORDER: EffortLevel[] = [
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
  "ultracode",
];

export const EFFORT_LABELS: Record<EffortLevel, string> = {
  minimal: "Min",
  low: "Low",
  medium: "Med",
  high: "High",
  xhigh: "Extra",
  max: "Max",
  ultracode: "Ultra",
};

/** Claude Code effort ladder for models that report `supportsEffort`. */
const CLAUDE_EFFORT: EffortLevel[] = [
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
  "ultracode",
];

/** Codex `model_reasoning_effort` per documented model support. */
const CODEX_EFFORT_BY_MODEL: Record<string, EffortLevel[]> = {
  "gpt-5.4": ["low", "medium", "high", "xhigh"],
  "gpt-5.5": ["low", "medium", "high", "xhigh"],
  "gpt-5.4-mini": ["low", "medium", "high"],
  o3: ["low", "medium", "high"],
};

const OPENCODE_EFFORT: EffortLevel[] = ["low", "medium", "high", "xhigh"];

/** Map API / docs synonyms onto our canonical effort tokens. */
export function normalizeEffortToken(raw: string): EffortLevel | null {
  const key = raw.trim().toLowerCase().replace(/[\s_-]+/g, "");
  switch (key) {
    case "minimal":
    case "min":
      return "minimal";
    case "low":
      return "low";
    case "medium":
    case "med":
      return "medium";
    case "high":
      return "high";
    case "xhigh":
    case "extra":
    case "extrahigh":
      return "xhigh";
    case "max":
    case "maximum":
      return "max";
    case "ultracode":
    case "ultra":
      return "ultracode";
    default:
      return null;
  }
}

export function normalizeEffortLevels(
  levels: string[] | undefined,
): EffortLevel[] {
  if (!levels?.length) return [];
  const out: EffortLevel[] = [];
  for (const raw of levels) {
    const level = normalizeEffortToken(raw);
    if (level && !out.includes(level)) out.push(level);
  }
  return mergeEffortLevels(out, []);
}

/**
 * Docs fallback levels — only used when the catalog already marks the model as
 * effort-capable (`supportsEffort` or non-empty `supportedEffortLevels`).
 * Never invent levels for models like Haiku that omit effort entirely.
 */
function documentedEffortLevels(
  harnessId: HarnessId,
  modelValue: string,
): EffortLevel[] {
  const key = modelValue.toLowerCase();
  switch (harnessId) {
    case "claudecode":
      // Haiku and other non-effort models must stay empty even if called.
      if (key.includes("haiku")) return [];
      return CLAUDE_EFFORT;
    case "codex": {
      for (const [pattern, levels] of Object.entries(CODEX_EFFORT_BY_MODEL)) {
        if (key.includes(pattern)) return levels;
      }
      return ["low", "medium", "high", "xhigh"];
    }
    case "opencode":
      return opencodeModelSupportsEffort(modelValue) ? OPENCODE_EFFORT : [];
    case "cursor":
      return [];
    default:
      return [];
  }
}

/** Heuristic: OpenCode reasoning effort applies to most frontier provider models. */
export function opencodeModelSupportsEffort(modelValue: string): boolean {
  const [provider, model] = modelValue.split("/");
  if (!provider || !model) return false;
  const p = provider.toLowerCase();
  const m = model.toLowerCase();
  if (!["openai", "anthropic", "google", "opencode"].includes(p)) {
    return false;
  }
  return !m.includes("instant") && !m.includes("nano");
}

export function mergeEffortLevels(
  a: EffortLevel[],
  b: EffortLevel[],
): EffortLevel[] {
  const set = new Set([...a, ...b]);
  return EFFORT_ORDER.filter((level) => set.has(level));
}

/**
 * Resolve effort options for a model.
 * Trust the catalog: if a model does not report effort support (e.g. Haiku),
 * show no effort control. Docs only fill gaps for models that already support it.
 */
export function resolveEffortLevels(
  model: HarnessModel | undefined,
): EffortLevel[] {
  if (!model) return [];

  const reported = normalizeEffortLevels(model.supportedEffortLevels);
  const catalogSaysEffort = Boolean(model.supportsEffort) || reported.length > 0;

  // Do not invent effort for models the catalog leaves unmarked (Haiku, etc.).
  if (!catalogSaysEffort) return [];

  const documented = documentedEffortLevels(model.harnessId, model.value);
  let merged = mergeEffortLevels(reported, documented);

  if (model.harnessId === "claudecode" && merged.length > 0) {
    merged = mergeEffortLevels(merged, ["ultracode"]);
  }

  return merged;
}

/** Fill `supportsEffort` / `supportedEffortLevels` after catalog load. */
export function enrichModelEffort(model: HarnessModel): HarnessModel {
  const levels = resolveEffortLevels(model);
  if (levels.length === 0) {
    // Ensure the UI hides effort when this model has none (e.g. Haiku).
    if (!model.supportsEffort && !model.supportedEffortLevels?.length) {
      return model;
    }
    return {
      ...model,
      supportsEffort: undefined,
      supportedEffortLevels: undefined,
    };
  }
  return {
    ...model,
    supportsEffort: true,
    supportedEffortLevels: levels,
  };
}

/** Map UI effort to the wire value for a harness agent invocation. */
export function effortForAgentWire(
  harnessId: HarnessId,
  effort: EffortLevel,
): string | null {
  switch (harnessId) {
    case "claudecode":
      return effort;
    case "codex":
      if (effort === "ultracode" || effort === "max") return "xhigh";
      if (effort === "minimal") return "minimal";
      return effort;
    case "cursor":
      if (effort === "ultracode") return "xhigh";
      return effort;
    case "opencode":
      if (effort === "ultracode" || effort === "max") return "xhigh";
      if (effort === "minimal") return "low";
      return effort;
    default:
      return effort;
  }
}

/** Whether Claude Agent SDK should enable session ultracode mode. */
export function claudeUsesUltracode(effort: EffortLevel): boolean {
  return effort === "ultracode";
}
