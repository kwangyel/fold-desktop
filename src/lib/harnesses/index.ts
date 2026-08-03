import { claudeCodeAdapter } from "./claudeCode";
import { cursorAdapter } from "./cursor";
import type { HarnessAdapter, HarnessModel } from "./types";

export { HARNESS_CATALOG, harnessMeta } from "./catalog";
export { CLAUDE_CODE_MODELS_FALLBACK } from "./claudeCode";
export { CURSOR_MODELS_FALLBACK } from "./cursor";
export type {
  EffortLevel,
  HarnessAdapter,
  HarnessId,
  HarnessMeta,
  HarnessModel,
} from "./types";

/** Registered harness adapters. Claude Code + Cursor are wired today. */
const ADAPTERS: HarnessAdapter[] = [claudeCodeAdapter, cursorAdapter];

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
