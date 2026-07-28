import { create } from 'zustand';

export type Attachment = {
  id: string;
  name: string;
  size: number;
  type: string;
};

export type Message = {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  attachments?: Attachment[];
  timestamp: number;
};

export type ChatTabState = {
  messages: Message[];
  selectedModel: string;
  modelEffort: 'low' | 'medium' | 'high' | 'ultracode';
  mode: 'normal' | 'fast';
  attachments: Attachment[];
  loading: boolean;
};

type ChatStore = {
  tabs: Record<string, ChatTabState>;

  // Initialize a new chat tab
  initializeTab: (tabId: string) => void;

  // Message operations
  addMessage: (tabId: string, message: Message) => void;

  // Model/settings operations
  setModel: (tabId: string, model: string) => void;
  setEffort: (tabId: string, effort: 'low' | 'medium' | 'high' | 'ultracode') => void;
  setMode: (tabId: string, mode: 'normal' | 'fast') => void;
  setLoading: (tabId: string, loading: boolean) => void;

  // Attachment operations
  addAttachment: (tabId: string, attachment: Attachment) => void;
  removeAttachment: (tabId: string, attachmentId: string) => void;

  // Tab cleanup
  clearChat: (tabId: string) => void;
  deleteTab: (tabId: string) => void;
};

export const useChatStore = create<ChatStore>((set) => ({
  tabs: {},

  initializeTab: (tabId) =>
    set((state) => {
      if (state.tabs[tabId]) return state;
      return {
        tabs: {
          ...state.tabs,
          [tabId]: {
            messages: [],
            selectedModel: 'claude-3-5-sonnet',
            modelEffort: 'medium',
            mode: 'normal',
            attachments: [],
            loading: false,
          },
        },
      };
    }),

  addMessage: (tabId, message) =>
    set((state) => {
      const tab = state.tabs[tabId];
      if (!tab) return state;
      return {
        tabs: {
          ...state.tabs,
          [tabId]: {
            ...tab,
            messages: [...tab.messages, message],
          },
        },
      };
    }),

  setModel: (tabId, model) =>
    set((state) => {
      const tab = state.tabs[tabId];
      if (!tab) return state;
      return {
        tabs: {
          ...state.tabs,
          [tabId]: {
            ...tab,
            selectedModel: model,
          },
        },
      };
    }),

  setEffort: (tabId, effort) =>
    set((state) => {
      const tab = state.tabs[tabId];
      if (!tab) return state;
      return {
        tabs: {
          ...state.tabs,
          [tabId]: {
            ...tab,
            modelEffort: effort,
          },
        },
      };
    }),

  setMode: (tabId, mode) =>
    set((state) => {
      const tab = state.tabs[tabId];
      if (!tab) return state;
      return {
        tabs: {
          ...state.tabs,
          [tabId]: {
            ...tab,
            mode,
          },
        },
      };
    }),

  setLoading: (tabId, loading) =>
    set((state) => {
      const tab = state.tabs[tabId];
      if (!tab) return state;
      return {
        tabs: {
          ...state.tabs,
          [tabId]: {
            ...tab,
            loading,
          },
        },
      };
    }),

  addAttachment: (tabId, attachment) =>
    set((state) => {
      const tab = state.tabs[tabId];
      if (!tab) return state;
      return {
        tabs: {
          ...state.tabs,
          [tabId]: {
            ...tab,
            attachments: [...tab.attachments, attachment],
          },
        },
      };
    }),

  removeAttachment: (tabId, attachmentId) =>
    set((state) => {
      const tab = state.tabs[tabId];
      if (!tab) return state;
      return {
        tabs: {
          ...state.tabs,
          [tabId]: {
            ...tab,
            attachments: tab.attachments.filter((a) => a.id !== attachmentId),
          },
        },
      };
    }),

  clearChat: (tabId) =>
    set((state) => {
      const tab = state.tabs[tabId];
      if (!tab) return state;
      return {
        tabs: {
          ...state.tabs,
          [tabId]: {
            ...tab,
            messages: [],
            attachments: [],
          },
        },
      };
    }),

  deleteTab: (tabId) =>
    set((state) => {
      const { [tabId]: _, ...remainingTabs } = state.tabs;
      return { tabs: remainingTabs };
    }),
}));
