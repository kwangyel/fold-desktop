import { create } from "zustand";
import { useChangesStore } from "./changesStore";

type ReviewStore = {
  /** Ordered snapshot of changed file paths taken when review started. */
  queue: string[];
  /** Index into `queue` of the file currently under review. */
  index: number;
  /** Model/harness inline review comments are sent to. */
  selectedModel: string;
  selectedHarness: string;
  /** Snapshot the current changes and jump to the first unreviewed file. */
  start: () => void;
  next: () => void;
  prev: () => void;
  goTo: (path: string) => void;
  /** Mark the current file reviewed and advance to the next unreviewed one. */
  markReviewedAndNext: () => void;
  setModel: (model: string, harnessId: string) => void;
};

export const useReviewStore = create<ReviewStore>((set, get) => ({
  queue: [],
  index: 0,
  selectedModel: "sonnet",
  selectedHarness: "claudecode",

  start: () => {
    const { changes, readPaths } = useChangesStore.getState();
    const queue = changes.map((c) => c.path);
    const firstUnread = queue.findIndex((p) => !readPaths.has(p));
    set({ queue, index: firstUnread >= 0 ? firstUnread : 0 });
  },

  next: () =>
    set((s) => ({ index: Math.min(s.index + 1, Math.max(0, s.queue.length - 1)) })),

  prev: () => set((s) => ({ index: Math.max(s.index - 1, 0) })),

  goTo: (path) =>
    set((s) => {
      const i = s.queue.indexOf(path);
      return i >= 0 ? { index: i } : s;
    }),

  markReviewedAndNext: () => {
    const { queue, index } = get();
    const current = queue[index];
    if (!current) return;
    useChangesStore.getState().markRead(current);

    const readPaths = useChangesStore.getState().readPaths;
    const n = queue.length;
    // Next unreviewed file after the current one, wrapping around.
    for (let step = 1; step <= n; step++) {
      const j = (index + step) % n;
      if (!readPaths.has(queue[j])) {
        set({ index: j });
        return;
      }
    }
    // Everything reviewed — stay on the current file.
  },

  setModel: (model, harnessId) =>
    set({ selectedModel: model, selectedHarness: harnessId }),
}));

/** Path of the file currently under review, if any. */
export function selectReviewCurrentPath(s: ReviewStore): string | undefined {
  return s.queue[s.index];
}

/** How many queued files have been marked reviewed. */
export function selectReviewedCount(
  queue: string[],
  readPaths: Set<string>,
): number {
  return queue.reduce((n, p) => n + (readPaths.has(p) ? 1 : 0), 0);
}
