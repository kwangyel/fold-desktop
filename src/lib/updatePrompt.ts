/**
 * Dismissal state for the optional-update prompt. Lightweight, renderer-only —
 * persisted in `localStorage` like `usePanelSizes`. Mandatory updates ignore
 * this entirely (they cannot be deferred).
 */

const DISMISSED_KEY = "fold.update.dismissedVersion";

/** The version the user most recently chose "Later" on, if any. */
export function getDismissedVersion(): string | null {
  try {
    return localStorage.getItem(DISMISSED_KEY);
  } catch {
    return null;
  }
}

export function setDismissedVersion(version: string): void {
  try {
    localStorage.setItem(DISMISSED_KEY, version);
  } catch {
    // Ignore quota / private-mode failures.
  }
}

export function clearDismissedVersion(): void {
  try {
    localStorage.removeItem(DISMISSED_KEY);
  } catch {
    // Ignore.
  }
}

/**
 * Whether the optional-update prompt should be shown for `latest`. Once the
 * user defers a version it stays suppressed until a newer one ships.
 */
export function shouldShowOptionalPrompt(latest: string | null): boolean {
  if (!latest) return false;
  return getDismissedVersion() !== latest;
}
