import { create } from "zustand";
import {
  ChangedFile,
  commit as gitCommit,
  getChanges,
  push as gitPush,
  stageAll as gitStageAll,
  stageFile as gitStageFile,
  unstageAll as gitUnstageAll,
  unstageFile as gitUnstageFile,
} from "../lib/git";

type ChangesStore = {
  changes: ChangedFile[];
  loading: boolean;
  error: string | null;
  commitMessage: string;
  committing: boolean;
  generatingMessage: boolean;
  /** Session-only set of paths the user has marked as read. */
  readPaths: Set<string>;
  refresh: () => Promise<void>;
  setCommitMessage: (message: string) => void;
  setGeneratingMessage: (generating: boolean) => void;
  stageFile: (path: string) => Promise<void>;
  unstageFile: (path: string) => Promise<void>;
  stageAll: () => Promise<void>;
  unstageAll: () => Promise<void>;
  commit: () => Promise<void>;
  commitAndPush: () => Promise<void>;
  markRead: (path: string) => void;
  markUnread: (path: string) => void;
  toggleRead: (path: string) => void;
  isRead: (path: string) => boolean;
};

export const useChangesStore = create<ChangesStore>((set, get) => ({
  changes: [],
  loading: false,
  error: null,
  commitMessage: "",
  committing: false,
  generatingMessage: false,
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

  setCommitMessage: (message) => set({ commitMessage: message }),

  setGeneratingMessage: (generating) => set({ generatingMessage: generating }),

  stageFile: async (path) => {
    try {
      await gitStageFile(path);
      await get().refresh();
    } catch (e) {
      set({ error: String(e) });
    }
  },

  unstageFile: async (path) => {
    try {
      await gitUnstageFile(path);
      await get().refresh();
    } catch (e) {
      set({ error: String(e) });
    }
  },

  stageAll: async () => {
    try {
      await gitStageAll();
      await get().refresh();
    } catch (e) {
      set({ error: String(e) });
    }
  },

  unstageAll: async () => {
    try {
      await gitUnstageAll();
      await get().refresh();
    } catch (e) {
      set({ error: String(e) });
    }
  },

  commit: async () => {
    const message = get().commitMessage.trim();
    if (!message) {
      set({ error: "Commit message is empty" });
      return;
    }
    const staged = get().changes.filter((c) => c.staged);
    if (staged.length === 0) {
      set({ error: "No staged changes to commit" });
      return;
    }
    set({ committing: true, error: null });
    try {
      await gitCommit(message);
      set({ commitMessage: "", committing: false });
      await get().refresh();
    } catch (e) {
      set({ error: String(e), committing: false });
    }
  },

  commitAndPush: async () => {
    const message = get().commitMessage.trim();
    if (!message) {
      set({ error: "Commit message is empty" });
      return;
    }
    const staged = get().changes.filter((c) => c.staged);
    if (staged.length === 0) {
      set({ error: "No staged changes to commit" });
      return;
    }
    set({ committing: true, error: null });
    try {
      await gitCommit(message);
      set({ commitMessage: "" });
      await gitPush();
      set({ committing: false });
      await get().refresh();
    } catch (e) {
      set({ error: String(e), committing: false });
      await get().refresh();
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
