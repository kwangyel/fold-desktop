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

/** Skip full refresh if a successful fetch landed within this window. */
const HARNESS_CACHE_TTL_MS = 30_000;

type RefreshOpts = {
  /** Bypass TTL and re-check status + models. */
  force?: boolean;
};

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
   * harnesses only. Concurrent callers share one in-flight promise; recent
   * results are reused unless `force` is set.
   */
  refresh: (opts?: RefreshOpts) => Promise<void>;
  /**
   * Reload models from current connection state without re-checking CLI
   * status (use after connect / disconnect / login).
   */
  refreshModels: () => Promise<void>;
};

let inflightRefresh: Promise<void> | null = null;
let inflightModels: Promise<void> | null = null;

async function loadModelsInto(
  set: (partial: Partial<HarnessStore>) => void,
): Promise<void> {
  const connected = getConnectedAdapters().map((a) => a.meta);
  if (connected.length === 0) {
    set({
      models: [],
      connectedHarnesses: [],
      loading: false,
      fetchedAt: Date.now(),
      error: null,
    });
    return;
  }

  const models = await listConnectedHarnessModels();
  set({
    models,
    connectedHarnesses: connected,
    loading: false,
    fetchedAt: Date.now(),
    error: null,
  });
}

export const useHarnessStore = create<HarnessStore>((set, get) => ({
  models: [],
  connectedHarnesses: [],
  loading: false,
  error: null,
  fetchedAt: null,

  refresh: async (opts) => {
    const force = opts?.force ?? false;
    const { fetchedAt } = get();
    if (
      !force &&
      fetchedAt != null &&
      Date.now() - fetchedAt < HARNESS_CACHE_TTL_MS
    ) {
      return;
    }
    if (inflightRefresh) return inflightRefresh;

    inflightRefresh = (async () => {
      set({ loading: true, error: null });
      try {
        // Ensure connection state is current before filtering adapters.
        await Promise.all([
          useClaudeStore.getState().refresh({ force }),
          useCodexStore.getState().refresh({ force }),
          useCursorStore.getState().refresh({ force }),
          useOpenCodeStore.getState().refresh({ force }),
        ]);
        await loadModelsInto(set);
      } catch (e) {
        set({
          error: String(e),
          loading: false,
          models: [],
          connectedHarnesses: [],
        });
      } finally {
        inflightRefresh = null;
      }
    })();

    return inflightRefresh;
  },

  refreshModels: async () => {
    if (inflightModels) return inflightModels;
    // Prefer joining a full refresh if one is already running.
    if (inflightRefresh) return inflightRefresh;

    inflightModels = (async () => {
      set({ loading: true, error: null });
      try {
        await loadModelsInto(set);
      } catch (e) {
        set({
          error: String(e),
          loading: false,
          models: [],
          connectedHarnesses: [],
        });
      } finally {
        inflightModels = null;
      }
    })();

    return inflightModels;
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
