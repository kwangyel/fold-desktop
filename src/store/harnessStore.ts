import { create } from "zustand";
import {
  getConnectedAdapters,
  listConnectedHarnessModels,
  type HarnessId,
  type HarnessMeta,
  type HarnessModel,
} from "../lib/harnesses";
import { useClaudeStore } from "./claudeStore";
import { useCodexStore } from "./codexStore";
import { useCursorStore } from "./cursorStore";
import { useOpenCodeStore } from "./opencodeStore";

type HarnessStore = {
  /** Models from currently connected harnesses only. */
  models: HarnessModel[];
  /** Connected harness metadata (for icons / section headers). */
  connectedHarnesses: HarnessMeta[];
  loading: boolean;
  error: string | null;
  /** Last successful fetch timestamp (ms). */
  fetchedAt: number | null;
  /**
   * Refresh harness connection status then reload models for connected
   * harnesses only.
   */
  refresh: () => Promise<void>;
};

export const useHarnessStore = create<HarnessStore>((set, get) => ({
  models: [],
  connectedHarnesses: [],
  loading: false,
  error: null,
  fetchedAt: null,

  refresh: async () => {
    if (get().loading) return;
    set({ loading: true, error: null });

    try {
      // Ensure connection state is current before filtering adapters.
      await Promise.all([
        useClaudeStore.getState().refresh(),
        useCodexStore.getState().refresh(),
        useCursorStore.getState().refresh(),
        useOpenCodeStore.getState().refresh(),
      ]);

      const connected = getConnectedAdapters().map((a) => a.meta);
      if (connected.length === 0) {
        set({
          models: [],
          connectedHarnesses: [],
          loading: false,
          fetchedAt: Date.now(),
        });
        return;
      }

      const models = await listConnectedHarnessModels();
      set({
        models,
        connectedHarnesses: connected,
        loading: false,
        fetchedAt: Date.now(),
      });
    } catch (e) {
      set({
        error: String(e),
        loading: false,
        models: [],
        connectedHarnesses: [],
      });
    }
  },
}));

/** Find a loaded model by value (and optional harness). */
export function findHarnessModel(
  models: HarnessModel[],
  value: string,
  harnessId?: HarnessId,
): HarnessModel | undefined {
  return models.find(
    (m) => m.value === value && (harnessId == null || m.harnessId === harnessId),
  );
}
