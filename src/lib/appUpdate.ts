import { getVersion } from "@tauri-apps/api/app";
import { fetch } from "@tauri-apps/plugin-http";
import { relaunch } from "@tauri-apps/plugin-process";
import { check, type Update } from "@tauri-apps/plugin-updater";
import semver from "semver";
import { isTauri } from "./git";

/**
 * App auto-update orchestration.
 *
 * Two layers work together:
 *  - Mechanism: `@tauri-apps/plugin-updater` (`check`/`downloadAndInstall`) +
 *    `@tauri-apps/plugin-process` (`relaunch`) download, verify, install, and
 *    restart into a new signed build published on GitHub Releases.
 *  - Policy: the release manifest carries a custom `minimumSupported` field.
 *    If the running version is below it, the update is compulsory (a security
 *    fix); otherwise it is optional and the user may defer it.
 */

/**
 * Update manifest URL. MUST match `plugins.updater.endpoints` in
 * `src-tauri/tauri.conf.json` — the plugin uses it to find the signed bundle,
 * we fetch it here to read the `minimumSupported` policy field the plugin does
 * not surface.
 */
const MANIFEST_URL =
  "https://github.com/kwangyel/fold-desktop/releases/latest/download/latest.json";

export type UpdateStatus = "up_to_date" | "optional" | "mandatory";

export interface UpdateCheckResult {
  status: UpdateStatus;
  /** The running app version. */
  current: string;
  /** The newest published version (equals `current` when up to date). */
  latest: string;
  /** Release notes for the new version, if any. */
  notes: string | null;
  /** Updater handle used to download & install; `null` when up to date. */
  update: Update | null;
}

interface UpdateManifest {
  version: string;
  /** Builds older than this are forced to update (security lever). */
  minimumSupported?: string;
  notes?: string;
}

/** Coerce-tolerant `a < b` semver compare; false if either can't be parsed. */
function semverLt(a: string, b: string): boolean {
  const va = semver.valid(semver.coerce(a));
  const vb = semver.valid(semver.coerce(b));
  if (!va || !vb) return false;
  return semver.lt(va, vb);
}

/** Read the running app version (from the bundle / `tauri.conf.json`). */
export async function getCurrentVersion(): Promise<string> {
  if (!isTauri()) return "0.0.0";
  return getVersion();
}

/** Fetch the raw release manifest to read the `minimumSupported` policy field. */
async function fetchManifest(): Promise<UpdateManifest | null> {
  try {
    const res = await fetch(MANIFEST_URL, { method: "GET" });
    if (!res.ok) return null;
    return (await res.json()) as UpdateManifest;
  } catch (e) {
    console.warn("update manifest fetch failed", e);
    return null;
  }
}

/**
 * Check for an update and classify it. Never throws — on any failure (offline,
 * bad signature/pubkey, browser dev mode) it resolves to an "up to date"
 * result so the app keeps running.
 */
export async function checkForUpdate(): Promise<UpdateCheckResult> {
  if (!isTauri()) {
    return {
      status: "up_to_date",
      current: "0.0.0",
      latest: "0.0.0",
      notes: null,
      update: null,
    };
  }

  const current = await getVersion();
  const idle: UpdateCheckResult = {
    status: "up_to_date",
    current,
    latest: current,
    notes: null,
    update: null,
  };

  // The updater plugin tells us whether a newer signed build exists and hands
  // back the install handle. `null` => already on the latest version.
  let update: Update | null = null;
  try {
    update = await check();
  } catch (e) {
    console.warn("update check failed", e);
    return idle;
  }
  if (!update) return idle;

  // A newer build exists — decide whether it is compulsory.
  const manifest = await fetchManifest();
  const minimumSupported = manifest?.minimumSupported;
  const mandatory = !!minimumSupported && semverLt(current, minimumSupported);

  return {
    status: mandatory ? "mandatory" : "optional",
    current,
    latest: update.version,
    notes: update.body ?? manifest?.notes ?? null,
    update,
  };
}

export type InstallProgress =
  | { phase: "downloading"; downloaded: number; total: number | null }
  | { phase: "installing" }
  | { phase: "done" };

/**
 * Download & install `update`, reporting progress, then relaunch the app.
 * `relaunch()` replaces the current process, so this normally does not return.
 */
export async function installAndRelaunch(
  update: Update,
  onProgress?: (p: InstallProgress) => void,
): Promise<void> {
  let downloaded = 0;
  let total: number | null = null;

  await update.downloadAndInstall((event) => {
    switch (event.event) {
      case "Started":
        total = event.data.contentLength ?? null;
        onProgress?.({ phase: "downloading", downloaded: 0, total });
        break;
      case "Progress":
        downloaded += event.data.chunkLength;
        onProgress?.({ phase: "downloading", downloaded, total });
        break;
      case "Finished":
        onProgress?.({ phase: "installing" });
        break;
    }
  });

  onProgress?.({ phase: "done" });
  await relaunch();
}
