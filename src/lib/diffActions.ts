import { getFileDiff } from "./git";
import { useChangesStore } from "../store/changesStore";
import { useCenterViewStore } from "../store/centerViewStore";

/** Fetch the diff for a path and open (or reuse) the diff tab in the center pane. */
export async function openDiffForPath(path: string): Promise<void> {
  const { original, modified } = await getFileDiff(path);
  useCenterViewStore.getState().openDiffTab(path, original, modified);
}

/**
 * Mark a file as read, then advance the diff view to the next unread file in the
 * list (wrapping around). If nothing is left unread, close the diff tab.
 */
export async function markReadAndAdvance(path: string): Promise<void> {
  const store = useChangesStore.getState();
  store.markRead(path);

  const { changes, readPaths } = useChangesStore.getState();
  const idx = changes.findIndex((c) => c.path === path);
  const ordered = [...changes.slice(idx + 1), ...changes.slice(0, idx + 1)];
  const next = ordered.find((c) => !readPaths.has(c.path));

  if (next) {
    await openDiffForPath(next.path);
  } else {
    useCenterViewStore.getState().closeDiffTab();
  }
}
