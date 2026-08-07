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
import { useContextUsageStore } from "./contextUsageStore";

/** Skip full refresh if a successful fetch landed within this window. */
const HARNESS_CACHE_TTL_MS = 30_000;

type RefreshOpts = {
  /** Bypass TTL and re-check status + models. */
  force?: boolean;
  /**
   * Revalidate in the background without flipping `loading` — keeps the model
   * picker interactive when a catalog is already on screen.
   */
  silent?: boolean;
};

type HarnessStore = {
  /** Models from currently connected harnesses only. */
  models: HarnessModel[];
  /** Connected harness metadata (for icons / section headers). */
  connectedHarnesses: HarnessMeta[];
  /**
   * Why a connected harness's catalog failed to load, keyed by harness id.
   * Surfaced in the picker so a connected-but-empty harness explains itself
   * instead of silently disappearing.
   */
  harnessErrors: Partial<Record<HarnessId, string>>;
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
  refreshModels: (opts?: { silent?: boolean }) => Promise<void>;
};

let inflightRefresh: Promise<void> | null = null;
let inflightModels: Promise<void> | null = null;

async function loadModelsInto(
  set: (partial: Partial<HarnessStore>) => void,
): Promise<void> {
  const adapters = getConnectedAdapters();
  const connected = adapters.map((a) => a.meta);
  if (connected.length === 0) {
    set({
      models: [],
      connectedHarnesses: [],
      harnessErrors: {},
      loading: false,
      fetchedAt: Date.now(),
      error: null,
    });
    return;
  }

  // Per-adapter timeouts always settle — no outer race that would discard a
  // successful Cursor /v1/models response and replace it with static stubs.
  const { models, errors } = await listConnectedHarnessModels();
  const failed = Object.keys(errors).length > 0;
  set({
    models,
    connectedHarnesses: connected,
    harnessErrors: errors,
    loading: false,
    // A partial result must never satisfy the TTL: leaving `fetchedAt` null
    // makes the next refresh re-fetch instead of serving a catalog that is
    // missing a connected harness (Claude Code / Cursor have no static
    // fallback and would otherwise disappear until the TTL expires).
    fetchedAt: failed ? null : Date.now(),
    error: null,
  });
  if (connected.some((h) => h.id === "claudecode")) {
    void useContextUsageStore.getState().refresh();
  }
}

/** Docs fallbacks when a live fetch fails (empty for Claude Code / Cursor). */
function fallbackModelsForConnected(): {
  models: HarnessModel[];
  connectedHarnesses: HarnessMeta[];
} {
  const adapters = getConnectedAdapters();
  return {
    connectedHarnesses: adapters.map((a) => a.meta),
    models: adapters.flatMap((adapter) => {
      // Claude Code / Cursor have no static catalog — omit stubs.
      if (adapter.id === "cursor" || adapter.id === "claudecode") return [];
      return adapter.fallbackModels().map(
        (m): HarnessModel => ({ ...m, harnessId: adapter.id }),
      );
    }),
  };
}

export const useHarnessStore = create<HarnessStore>((set, get) => ({
  models: [],
  connectedHarnesses: [],
  harnessErrors: {},
  loading: false,
  error: null,
  fetchedAt: null,

  refresh: async (opts) => {
    const force = opts?.force ?? false;
    const silent = opts?.silent ?? false;
    const { fetchedAt, models } = get();
    // Only reuse a recent hit when the last fetch was complete. Partial
    // results leave `fetchedAt` null so they never suppress a retry.
    if (
      !force &&
      models.length > 0 &&
      fetchedAt != null &&
      Date.now() - fetchedAt < HARNESS_CACHE_TTL_MS
    ) {
      return;
    }
    if (inflightRefresh) return inflightRefresh;

    inflightRefresh = (async () => {
      // Keep the picker usable when we already have a catalog to show.
      const blockUi = !silent && models.length === 0;
      if (blockUi) set({ loading: true, error: null });
      else set({ error: null });
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
        // Still publish connected harnesses + any static catalogs so the
        // picker doesn't claim "Connect a harness" while the dialog shows Connected.
        const fallback = fallbackModelsForConnected();
        set({
          error: String(e),
          loading: false,
          ...(fallback.models.length > 0
            ? {
                models: fallback.models,
                connectedHarnesses: fallback.connectedHarnesses,
                fetchedAt: Date.now(),
              }
            : models.length === 0
              ? { models: [], connectedHarnesses: [] }
              : {}),
        });
      } finally {
        inflightRefresh = null;
      }
    })();

    return inflightRefresh;
  },

  refreshModels: async (opts) => {
    if (inflightModels) return inflightModels;

    const silent = opts?.silent ?? false;
    const { models } = get();

    inflightModels = (async () => {
      // Wait out a full refresh, then always reload from *current* connection
      // state. Joining the in-flight refresh would reuse a models snapshot
      // taken before a just-completed login, leaving the new harness missing
      // until the 30s TTL expires.
      if (inflightRefresh) await inflightRefresh;

      const blockUi = !silent && models.length === 0;
      if (blockUi) set({ loading: true, error: null });
      else set({ error: null });
      try {
        await loadModelsInto(set);
      } catch (e) {
        const fallback = fallbackModelsForConnected();
        set({
          error: String(e),
          loading: false,
          ...(fallback.models.length > 0
            ? {
                models: fallback.models,
                connectedHarnesses: fallback.connectedHarnesses,
                fetchedAt: Date.now(),
              }
            : models.length === 0
              ? { models: [], connectedHarnesses: [] }
              : {}),
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
