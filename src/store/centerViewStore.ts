import { create } from "zustand";
import { readFile } from "../lib/git";

export type CenterTabType = "chat" | "editor" | "diff";

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

const INITIAL_CHAT_TAB: CenterTab = {
  id: "chat-1",
  type: "chat",
  label: "Chat",
};

type CenterViewStore = {
  tabs: CenterTab[];
  activeTabId: string;
  addChatTab: () => void;
  openFileTab: (path: string, pin?: boolean) => void;
  openDiffTab: (path: string, original: string, modified: string) => void;
  updateDiffContent: (id: string, original: string, modified: string) => void;
  closeDiffTab: () => void;
  pinTab: (id: string) => void;
  closeTab: (id: string) => void;
  setActiveTab: (id: string) => void;
  updateTabContent: (id: string, content: string) => void;
};

function loadFileContent(
  set: (fn: (state: CenterViewStore) => Partial<CenterViewStore>) => void,
  tabId: string,
  path: string,
) {
  void readFile(path)
    .then((content) => {
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
      set((state) => {
        const tab = state.tabs.find((t) => t.id === tabId);
        if (!tab || tab.filePath !== path) return state;
        return {
          tabs: state.tabs.map((t) =>
            t.id === tabId
              ? {
                  ...t,
                  fileContent: `// Failed to read file\n// ${String(err)}\n`,
                  fileLoading: false,
                }
              : t,
          ),
        };
      });
    });
}

export const useCenterViewStore = create<CenterViewStore>((set, get) => ({
  tabs: [INITIAL_CHAT_TAB],
  activeTabId: INITIAL_CHAT_TAB.id,

  addChatTab: () => {
    const id = `chat-${Date.now()}`;
    const tab: CenterTab = { id, type: "chat", label: "Chat" };
    set((state) => ({
      tabs: [...state.tabs, tab],
      activeTabId: id,
    }));
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

  pinTab: (id) => {
    set((state) => ({
      tabs: state.tabs.map((tab) =>
        tab.id === id && tab.type === "editor" ? { ...tab, isPreview: false } : tab,
      ),
    }));
  },

  closeTab: (id) => {
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
    set((state) => ({
      tabs: state.tabs.map((tab) =>
        tab.id === id ? { ...tab, fileContent: content } : tab,
      ),
    }));
  },
}));
