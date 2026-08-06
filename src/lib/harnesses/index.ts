import { claudeCodeAdapter } from "./claudeCode";
import { codexAdapter } from "./codex";
import { cursorAdapter } from "./cursor";
import { opencodeAdapter } from "./opencode";
import type { HarnessAdapter, HarnessId, HarnessModel } from "./types";

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

/** Whether the given harness offers a read-only planning mode. */
export function harnessSupportsPlanMode(harnessId: string): boolean {
  return ADAPTERS.some((a) => a.id === harnessId && a.supportsPlanMode);
}

/** Adapters whose harness is currently connected. */
export function getConnectedAdapters(): HarnessAdapter[] {
  return ADAPTERS.filter((a) => a.isConnected());
}

/** Per-harness cap so one hung IPC cannot blank the whole picker. */
const LIST_MODELS_TIMEOUT_MS = 8_000;
/** Cursor hits a networked `GET /v1/models`; give it more headroom than CLI probes. */
const CURSOR_LIST_MODELS_TIMEOUT_MS = 20_000;

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`${label} timed out after ${Math.round(ms / 1000)}s`)),
      ms,
    );
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      },
    );
  });
}

function tagModels(
  adapter: HarnessAdapter,
  models: Awaited<ReturnType<HarnessAdapter["listModels"]>>,
): HarnessModel[] {
  return models.map(
    (m): HarnessModel => ({
      ...m,
      harnessId: adapter.id,
    }),
  );
}

/** Outcome of one catalog load, per connected harness. */
export type HarnessModelsResult = {
  models: HarnessModel[];
  /**
   * Harnesses whose live fetch failed, keyed by id. A harness listed here
   * either fell back to a static catalog or (Cursor, which has none)
   * contributed nothing — so the caller must not cache this result as good.
   */
  errors: Partial<Record<HarnessId, string>>;
};

/** Load models for every connected harness, tagged with harnessId. */
export async function listConnectedHarnessModels(): Promise<HarnessModelsResult> {
  const connected = getConnectedAdapters();
  const groups = await Promise.all(
    connected.map(
      async (
        adapter,
      ): Promise<{ models: HarnessModel[]; error?: string }> => {
        const timeoutMs =
          adapter.id === "cursor"
            ? CURSOR_LIST_MODELS_TIMEOUT_MS
            : LIST_MODELS_TIMEOUT_MS;
        try {
          const models = await withTimeout(
            adapter.listModels(),
            timeoutMs,
            `${adapter.id} models`,
          );
          if (models.length === 0) {
            throw new Error(`${adapter.meta.name} returned no models`);
          }
          return { models: tagModels(adapter, models) };
        } catch (err) {
          // Cursor has no static catalog, so a failure here means the harness
          // would silently vanish from the picker. Report it either way.
          return {
            models: tagModels(adapter, adapter.fallbackModels()),
            error: err instanceof Error ? err.message : String(err),
          };
        }
      },
    ),
  );

  const errors: Partial<Record<HarnessId, string>> = {};
  connected.forEach((adapter, i) => {
    const error = groups[i].error;
    if (error) errors[adapter.id] = error;
  });

  return { models: groups.flatMap((g) => g.models), errors };
}
