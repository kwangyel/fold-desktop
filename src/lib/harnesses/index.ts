import { claudeCodeAdapter } from "./claudeCode";
import { codexAdapter } from "./codex";
import { cursorAdapter } from "./cursor";
import { opencodeAdapter } from "./opencode";
import type { HarnessAdapter, HarnessModel } from "./types";

export { HARNESS_CATALOG, harnessMeta } from "./catalog";
export { CLAUDE_CODE_MODELS_FALLBACK } from "./claudeCode";
export { CODEX_MODELS_FALLBACK } from "./codex";
export { CURSOR_MODELS_FALLBACK } from "./cursor";
export { OPENCODE_MODELS_FALLBACK } from "./opencode";
export type {
  EffortLevel,
  HarnessAdapter,
  HarnessId,
  HarnessMeta,
  HarnessModel,
} from "./types";

/** Registered harness adapters. */
const ADAPTERS: HarnessAdapter[] = [
  claudeCodeAdapter,
  codexAdapter,
  cursorAdapter,
  opencodeAdapter,
];

export function getHarnessAdapters(): HarnessAdapter[] {
  return ADAPTERS;
}

/** Adapters whose harness is currently connected. */
export function getConnectedAdapters(): HarnessAdapter[] {
  return ADAPTERS.filter((a) => a.isConnected());
}

/** Load models for every connected harness, tagged with harnessId. */
export async function listConnectedHarnessModels(): Promise<HarnessModel[]> {
  const connected = getConnectedAdapters();
  const groups = await Promise.all(
    connected.map(async (adapter) => {
      const models = await adapter.listModels();
      return models.map(
        (m): HarnessModel => ({
          ...m,
          harnessId: adapter.id,
        }),
      );
    }),
  );
  return groups.flat();
}
