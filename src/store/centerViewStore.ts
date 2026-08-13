import { create } from "zustand";
import { readFile } from "../lib/git";
import { ghPrViewCached, type PrInfo } from "../lib/github";

export type CenterTabType = "chat" | "editor" | "diff" | "pr" | "plan" | "review";

export type CenterTab = {
  id: string;
  type: CenterTabType;
  label: string;
  isPreview?: boolean;
  filePath?: string;
  fileContent?: string;
  fileLoading?: boolean;
  diffOriginal?: string;
  diffModified?: string;
  prWorktreePath?: string;
  prInfo?: PrInfo;
  prLoading?: boolean;
  prError?: string;
  /** Set on `plan` tabs — the PlanRecord id being reviewed. */
  planId?: string;
  /**
   * Set on `chat` tabs — the worktree the chat belongs to. Chats are stored per
   * worktree, so tabs follow the active worktree rather than staying global.
   */
  worktreePath?: string | null;
};

function fileName(path: string): string {
  return path.split("/").pop() ?? path;
}

function editorTabFields(path: string): Pick<CenterTab, "label" | "filePath" | "fileContent" | "fileLoading"> {
  return {
    label: fileName(path),
    filePath: path,
    fileContent: "",
    fileLoading: true,
  };
}

/** In-memory editor buffer so UI can debounce store writes without losing keystrokes. */
const liveEditorContent = new Map<string, string>();

export function setLiveEditorContent(id: string, content: string) {
  liveEditorContent.set(id, content);
}

export function getLiveEditorContent(id: string): string | undefined {
  return liveEditorContent.get(id);
}

export function clearLiveEditorContent(id: string) {
  liveEditorContent.delete(id);
}

type CenterViewStore = {
  tabs: CenterTab[];
  activeTabId: string;
  /** Open a new (unsaved) chat tab bound to a worktree. */
  addChatTab: (options?: {
    id?: string;
    worktreePath?: string | null;
    label?: string;
  }) => void;
  /** Open (or focus) a persisted chat. The tab id is the chat id. */
  openChatTab: (
    chatId: string,
    worktreePath: string,
    label?: string,
  ) => void;
  openFileTab: (path: string, pin?: boolean) => void;
  openDiffTab: (path: string, original: string, modified: string) => void;
  updateDiffContent: (id: string, original: string, modified: string) => void;
  closeDiffTab: () => void;
  openPrTab: (worktreePath: string) => void;
  setPrMerged: (id: string) => void;
  /** Open (or focus) the review tab for a captured plan. */
  openPlanTab: (planId: string, label?: string) => void;
  /** Open (or focus) the single review-queue tab. */
  openReviewTab: () => void;
  /**
   * Drop editor/diff/pr/plan tabs, plus chat tabs belonging to another
   * worktree, when switching projects or worktrees.
   */
  closeWorkspaceTabs: (activePath: string | null) => void;
  pinTab: (id: string) => void;
  /** Retitle a tab (a chat picks up its title from its first prompt). */
  renameTab: (id: string, label: string) => void;
  closeTab: (id: string) => void;
  setActiveTab: (id: string) => void;
  updateTabContent: (id: string, content: string) => void;
  /** Re-read open editor tabs from disk (after a checkpoint restore). */
  reloadEditorTabs: () => void;
};

function loadFileContent(
  set: (fn: (state: CenterViewStore) => Partial<CenterViewStore>) => void,
  tabId: string,
  path: string,
) {
  void readFile(path)
    .then((content) => {
      liveEditorContent.set(tabId, content);
      set((state) => {
        const tab = state.tabs.find((t) => t.id === tabId);
        if (!tab || tab.filePath !== path) return state;
        return {
          tabs: state.tabs.map((t) =>
            t.id === tabId ? { ...t, fileContent: content, fileLoading: false } : t,
          ),
        };
      });
    })
    .catch((err) => {
      const fallback = `// Failed to read file\n// ${String(err)}\n`;
      liveEditorContent.set(tabId, fallback);
      set((state) => {
        const tab = state.tabs.find((t) => t.id === tabId);
        if (!tab || tab.filePath !== path) return state;
        return {
          tabs: state.tabs.map((t) =>
            t.id === tabId
              ? {
                  ...t,
                  fileContent: fallback,
                  fileLoading: false,
                }
              : t,
          ),
        };
      });
    });
}

export const useCenterViewStore = create<CenterViewStore>((set, get) => ({
  tabs: [],
  activeTabId: "",

  addChatTab: (options) => {
    const id = options?.id ?? `chat-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    const tab: CenterTab = {
      id,
      type: "chat",
      label: options?.label ?? "New chat",
      worktreePath: options?.worktreePath ?? null,
    };
    set((state) => ({
      tabs: [...state.tabs, tab],
      activeTabId: id,
    }));
  },

  openChatTab: (chatId, worktreePath, label) => {
    const state = get();
    const existing = state.tabs.find((tab) => tab.id === chatId);
    if (existing) {
      set({
        tabs: label
          ? state.tabs.map((t) => (t.id === chatId ? { ...t, label } : t))
          : state.tabs,
        activeTabId: chatId,
      });
      return;
    }
    const tab: CenterTab = {
      id: chatId,
      type: "chat",
      label: label ?? "Chat",
      worktreePath,
    };
    set({ tabs: [...state.tabs, tab], activeTabId: chatId });
  },

  openFileTab: (path, pin = false) => {
    const state = get();
    const existing = state.tabs.find(
      (tab) => tab.type === "editor" && tab.filePath === path,
    );
    if (existing) {
      set({
        tabs: pin
          ? state.tabs.map((tab) =>
              tab.id === existing.id ? { ...tab, isPreview: false } : tab,
            )
          : state.tabs,
        activeTabId: existing.id,
      });
      return;
    }

    const previewTab = state.tabs.find(
      (tab) => tab.type === "editor" && tab.isPreview,
    );

    if (previewTab) {
      const tabId = previewTab.id;
      set({
        tabs: state.tabs.map((tab) =>
          tab.id === previewTab.id
            ? {
                ...tab,
                ...editorTabFields(path),
                isPreview: pin ? false : tab.isPreview,
              }
            : tab,
        ),
        activeTabId: tabId,
      });
      loadFileContent(set, tabId, path);
      return;
    }

    const id = `file-${Date.now()}`;
    const tab: CenterTab = {
      id,
      type: "editor",
      isPreview: !pin,
      ...editorTabFields(path),
    };

    set({
      tabs: [...state.tabs, tab],
      activeTabId: id,
    });
    loadFileContent(set, id, path);
  },

  openDiffTab: (path, original, modified) => {
    set((state) => {
      // Reuse the single diff tab if one is already open (review flow).
      const existing = state.tabs.find((tab) => tab.type === "diff");
      if (existing) {
        const tabs = state.tabs.map((tab) =>
          tab.id === existing.id
            ? {
                ...tab,
                label: `${fileName(path)} (diff)`,
                filePath: path,
                diffOriginal: original,
                diffModified: modified,
              }
            : tab,
        );
        return { tabs, activeTabId: existing.id };
      }

      const id = `diff-${Date.now()}`;
      const tab: CenterTab = {
        id,
        type: "diff",
        label: `${fileName(path)} (diff)`,
        filePath: path,
        diffOriginal: original,
        diffModified: modified,
      };
      return { tabs: [...state.tabs, tab], activeTabId: id };
    });
  },

  updateDiffContent: (id, original, modified) => {
    set((state) => ({
      tabs: state.tabs.map((tab) =>
        tab.id === id
          ? { ...tab, diffOriginal: original, diffModified: modified }
          : tab,
      ),
    }));
  },

  closeDiffTab: () => {
    set((state) => {
      const diff = state.tabs.find((tab) => tab.type === "diff");
      if (!diff || state.tabs.length <= 1) return state;
      const index = state.tabs.findIndex((t) => t.id === diff.id);
      const newTabs = state.tabs.filter((t) => t.id !== diff.id);
      let activeTabId = state.activeTabId;
      if (state.activeTabId === diff.id) {
        const newIndex = Math.min(index, newTabs.length - 1);
        activeTabId = newTabs[newIndex].id;
      }
      return { tabs: newTabs, activeTabId };
    });
  },

  openPrTab: (worktreePath) => {
    const state = get();
    const existing = state.tabs.find((tab) => tab.type === "pr");
    const tabId = existing ? existing.id : `pr-${Date.now()}`;

    if (existing) {
      set({
        tabs: state.tabs.map((tab) =>
          tab.id === existing.id
            ? { ...tab, prWorktreePath: worktreePath, prLoading: true, prError: undefined }
            : tab,
        ),
        activeTabId: existing.id,
      });
    } else {
      const tab: CenterTab = {
        id: tabId,
        type: "pr",
        label: "Pull Request",
        prWorktreePath: worktreePath,
        prLoading: true,
      };
      set({ tabs: [...state.tabs, tab], activeTabId: tabId });
    }

    void ghPrViewCached(worktreePath)
      .then((info) => {
        set((s) => {
          const tab = s.tabs.find((t) => t.id === tabId);
          if (!tab || tab.prWorktreePath !== worktreePath) return s;
          return {
            tabs: s.tabs.map((t) =>
              t.id === tabId
                ? {
                    ...t,
                    prInfo: info ?? undefined,
                    label: info ? `PR #${info.number}` : "Pull Request",
                    prLoading: false,
                    prError: info ? undefined : "No pull request found for this branch.",
                  }
                : t,
            ),
          };
        });
      })
      .catch((err) => {
        set((s) => {
          const tab = s.tabs.find((t) => t.id === tabId);
          if (!tab || tab.prWorktreePath !== worktreePath) return s;
          return {
            tabs: s.tabs.map((t) =>
              t.id === tabId ? { ...t, prLoading: false, prError: String(err) } : t,
            ),
          };
        });
      });
  },

  openPlanTab: (planId, label) => {
    const state = get();
    const existing = state.tabs.find(
      (tab) => tab.type === "plan" && tab.planId === planId,
    );
    if (existing) {
      set({ activeTabId: existing.id });
      return;
    }

    const id = `plan-${planId}`;
    const tab: CenterTab = {
      id,
      type: "plan",
      label: label ?? "Plan",
      planId,
    };
    set({ tabs: [...state.tabs, tab], activeTabId: id });
  },

  openReviewTab: () => {
    const state = get();
    const existing = state.tabs.find((tab) => tab.type === "review");
    if (existing) {
      set({ activeTabId: existing.id });
      return;
    }
    const id = `review-${Date.now()}`;
    const tab: CenterTab = { id, type: "review", label: "Review" };
    set({ tabs: [...state.tabs, tab], activeTabId: id });
  },

  setPrMerged: (id) => {
    set((state) => ({
      tabs: state.tabs.map((tab) =>
        tab.id === id && tab.prInfo
          ? { ...tab, prInfo: { ...tab.prInfo, state: "MERGED" } }
          : tab,
      ),
    }));
  },

  closeWorkspaceTabs: (activePath) => {
    set((state) => {
      if (!activePath) {
        return { tabs: [], activeTabId: "" };
      }
      // Chats belong to a worktree now, so only this worktree's survive.
      // `syncChatTabsForWorktree` opens one if that leaves none.
      const nextTabs = state.tabs.filter(
        (tab) => tab.type === "chat" && tab.worktreePath === activePath,
      );
      const activeStillOpen = nextTabs.some((t) => t.id === state.activeTabId);
      return {
        tabs: nextTabs,
        activeTabId: activeStillOpen
          ? state.activeTabId
          : (nextTabs[0]?.id ?? ""),
      };
    });
  },

  pinTab: (id) => {
    set((state) => ({
      tabs: state.tabs.map((tab) =>
        tab.id === id && tab.type === "editor" ? { ...tab, isPreview: false } : tab,
      ),
    }));
  },

  renameTab: (id, label) => {
    set((state) => ({
      tabs: state.tabs.map((tab) => (tab.id === id ? { ...tab, label } : tab)),
    }));
  },

  closeTab: (id) => {
    clearLiveEditorContent(id);
    set((state) => {
      const tab = state.tabs.find((t) => t.id === id);
      if (!tab || state.tabs.length <= 1) return state;

      const index = state.tabs.findIndex((t) => t.id === id);
      if (index === -1) return state;

      const newTabs = state.tabs.filter((t) => t.id !== id);
      let activeTabId = state.activeTabId;

      if (state.activeTabId === id) {
        const newIndex = Math.min(index, newTabs.length - 1);
        activeTabId = newTabs[newIndex].id;
      }

      return { tabs: newTabs, activeTabId };
    });
  },

  setActiveTab: (id) => set({ activeTabId: id }),

  updateTabContent: (id, content) => {
    liveEditorContent.set(id, content);
    set((state) => ({
      tabs: state.tabs.map((tab) =>
        tab.id === id ? { ...tab, fileContent: content } : tab,
      ),
    }));
  },

  reloadEditorTabs: () => {
    for (const tab of get().tabs) {
      if (tab.type === "editor" && tab.filePath) {
        loadFileContent(set, tab.id, tab.filePath);
      }
    }
  },
}));
