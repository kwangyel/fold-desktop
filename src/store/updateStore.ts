import { create } from "zustand";
import type { Update } from "@tauri-apps/plugin-updater";
import {
  checkForUpdate,
  installAndRelaunch,
  type UpdateStatus,
} from "../lib/appUpdate";

/** Lifecycle of an in-progress install. */
export type UpdatePhase = "idle" | "downloading" | "installing" | "error";

type UpdateStore = {
  /** Classification from the last check. */
  status: UpdateStatus;
  current: string | null;
  latest: string | null;
  notes: string | null;
  /** Updater handle to install with; null when up to date. */
  update: Update | null;
  phase: UpdatePhase;
  /** 0–1 download progress, or null when unknown / not downloading. */
  progress: number | null;
  error: string | null;
  /** True while a check is running (drives the menu "Checking…" state). */
  checking: boolean;
  /** Timestamp of the last completed check, for a manual "up to date" hint. */
  lastCheckedAt: number | null;

  /** Fetch the manifest and classify (up to date / optional / mandatory). */
  runCheck: () => Promise<void>;
  /** Download, install, and relaunch into the new version. */
  install: () => Promise<void>;
};

export const useUpdateStore = create<UpdateStore>((set, get) => ({
  status: "up_to_date",
  current: null,
  latest: null,
  notes: null,
  update: null,
  phase: "idle",
  progress: null,
  error: null,
  checking: false,
  lastCheckedAt: null,

  runCheck: async () => {
    const { checking, phase } = get();
    // Don't re-check while a check or install is already underway.
    if (checking || phase === "downloading" || phase === "installing") return;

    set({ checking: true });
    try {
      const result = await checkForUpdate();
      set({
        status: result.status,
        current: result.current,
        latest: result.latest,
        notes: result.notes,
        update: result.update,
        lastCheckedAt: Date.now(),
      });
    } catch (e) {
      set({ error: String(e) });
    } finally {
      set({ checking: false });
    }
  },

  install: async () => {
    const update = get().update;
    if (!update) return;

    set({ phase: "downloading", progress: 0, error: null });
    try {
      await installAndRelaunch(update, (p) => {
        if (p.phase === "downloading") {
          set({
            phase: "downloading",
            progress: p.total ? p.downloaded / p.total : null,
          });
        } else if (p.phase === "installing") {
          set({ phase: "installing", progress: 1 });
        }
      });
      // relaunch() replaces the process; code past here normally doesn't run.
    } catch (e) {
      set({ phase: "error", error: String(e) });
    }
  },
}));
