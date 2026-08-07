import type { EffortLevel, HarnessId, HarnessModel } from "./harnesses/types";

/** Canonical effort order for cycling and display. */
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

/** Map API / catalog synonyms onto our canonical effort tokens. */
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

/** Normalize and order effort levels from a catalog/SDK payload. */
export function normalizeEffortLevels(
  levels: string[] | undefined,
): EffortLevel[] {
  if (!levels?.length) return [];
  const set = new Set<EffortLevel>();
  for (const raw of levels) {
    const level = normalizeEffortToken(raw);
    if (level) set.add(level);
  }
  return EFFORT_ORDER.filter((level) => set.has(level));
}

/**
 * Effort options for a model from catalog/SDK `supportedEffortLevels`.
 * Claude Code: when the model reports `xhigh`, also offer `ultracode`
 * (session flag, not listed by the SDK — requires an xhigh-capable model).
 */
export function resolveEffortLevels(
  model: HarnessModel | undefined,
): EffortLevel[] {
  if (!model) return [];
  const levels = normalizeEffortLevels(model.supportedEffortLevels);
  if (
    model.harnessId === "claudecode" &&
    levels.includes("xhigh") &&
    !levels.includes("ultracode")
  ) {
    return EFFORT_ORDER.filter(
      (level) => levels.includes(level) || level === "ultracode",
    );
  }
  return levels;
}

/** Mirror catalog effort fields after load (normalized tokens only). */
export function enrichModelEffort(model: HarnessModel): HarnessModel {
  const levels = resolveEffortLevels(model);
  if (levels.length === 0) {
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
