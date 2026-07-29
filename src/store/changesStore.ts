import { create } from "zustand";
import { ChangedFile, getChanges } from "../lib/git";

type ChangesStore = {
  changes: ChangedFile[];
  loading: boolean;
  error: string | null;
  /** Session-only set of paths the user has marked as read. */
  readPaths: Set<string>;
  refresh: () => Promise<void>;
  markRead: (path: string) => void;
  markUnread: (path: string) => void;
  toggleRead: (path: string) => void;
  isRead: (path: string) => boolean;
};

export const useChangesStore = create<ChangesStore>((set, get) => ({
  changes: [],
  loading: false,
  error: null,
  readPaths: new Set(),

  refresh: async () => {
    set({ loading: true, error: null });
    try {
      const changes = await getChanges();
      // Drop read marks for paths that are no longer changed.
      const paths = new Set(changes.map((c) => c.path));
      const readPaths = new Set(
        [...get().readPaths].filter((p) => paths.has(p)),
      );
      set({ changes, readPaths, loading: false });
    } catch (e) {
      set({ error: String(e), loading: false });
    }
  },

  markRead: (path) =>
    set((state) => {
      const readPaths = new Set(state.readPaths);
      readPaths.add(path);
      return { readPaths };
    }),

  markUnread: (path) =>
    set((state) => {
      const readPaths = new Set(state.readPaths);
      readPaths.delete(path);
      return { readPaths };
    }),

  toggleRead: (path) =>
    set((state) => {
      const readPaths = new Set(state.readPaths);
      if (readPaths.has(path)) readPaths.delete(path);
      else readPaths.add(path);
      return { readPaths };
    }),

  isRead: (path) => get().readPaths.has(path),
}));
