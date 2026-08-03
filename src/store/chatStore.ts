import { create } from 'zustand';
import {
  ClaudeOutput,
  claudeAgentCancel,
  claudeAgentRun,
  claudeReleaseChannel,
} from '../lib/claude';
import {
  CursorOutput,
  cursorAgentCancel,
  cursorAgentRun,
  cursorReleaseChannel,
} from '../lib/cursor';
import type { EffortLevel, HarnessId } from '../lib/harnesses';
import type { SDKMessage } from '../lib/claudeStreamTypes';
import { useProjectStore } from './projectStore';
import { useChangesStore } from './changesStore';
import { findHarnessModel, useHarnessStore } from './harnessStore';
import { useCursorStore } from './cursorStore';

export type Attachment = {
  id: string;
  name: string;
  size: number;
  type: string;
};

export type Message = {
  id: string;
  role: 'user' | 'assistant' | 'tool';
  content: string;
  /** Present when role === 'tool'. */
  toolName?: string;
  toolStatus?: 'running' | 'done';
  attachments?: Attachment[];
  timestamp: number;
};

export type ChatTabState = {
  messages: Message[];
  selectedModel: string;
  /** Selected harness id for the model (e.g. claudecode). */
  selectedHarness: string;
  modelEffort: EffortLevel;
  mode: 'normal' | 'fast';
  attachments: Attachment[];
  loading: boolean;
};

type ChatStore = {
  tabs: Record<string, ChatTabState>;

  initializeTab: (tabId: string) => void;
  addMessage: (tabId: string, message: Message) => void;
  updateMessage: (
    tabId: string,
    messageId: string,
    patch: Partial<Message>,
  ) => void;
  setModel: (tabId: string, model: string, harnessId?: string) => void;
  setEffort: (tabId: string, effort: EffortLevel) => void;
  setMode: (tabId: string, mode: 'normal' | 'fast') => void;
  setLoading: (tabId: string, loading: boolean) => void;
  addAttachment: (tabId: string, attachment: Attachment) => void;
  removeAttachment: (tabId: string, attachmentId: string) => void;
  clearChat: (tabId: string) => void;
  deleteTab: (tabId: string) => void;
  /** Send a prompt to the selected harness agent in the active worktree. */
  sendPrompt: (tabId: string, prompt: string) => Promise<void>;
  /** Cancel an in-flight agent for this tab. */
  cancelAgent: (tabId: string) => Promise<void>;
};

/** Sentinel emitted by the Rust monitor when the Claude child exits. */
const CLAUDE_EXIT_RE = /__CLAUDE_EXIT__:(-?\d+)/;
/** Sentinel emitted by the Rust monitor when the Cursor child exits. */
const CURSOR_EXIT_RE = /__CURSOR_EXIT__:(-?\d+)/;

type ContentBlock = {
  type: string;
  text?: string;
  id?: string;
  name?: string;
  tool_use_id?: string;
  content?: unknown;
  input?: unknown;
};

type StreamEvent = SDKMessage | CursorStreamEvent;

type CursorStreamEvent = {
  type: string;
  subtype?: string;
  message?: { content?: unknown };
  result?: string;
  is_error?: boolean;
  call_id?: string;
  tool_call?: Record<string, unknown>;
  timestamp_ms?: number;
  model_call_id?: string;
};

function decode(chunk: ClaudeOutput | CursorOutput): string {
  const bytes = chunk instanceof Uint8Array ? chunk : new Uint8Array(chunk);
  return new TextDecoder().decode(bytes);
}

function contentBlocks(message: { content?: unknown } | undefined): ContentBlock[] {
  const content = message?.content;
  if (!content) return [];
  if (typeof content === 'string') return [{ type: 'text', text: content }];
  if (Array.isArray(content)) return content as ContentBlock[];
  return [];
}

function textFromBlocks(blocks: ContentBlock[]): string {
  return blocks
    .filter((b) => b.type === 'text')
    .map((b) => b.text ?? '')
    .join('');
}

function toolUsesFromBlocks(
  blocks: ContentBlock[],
): Array<{ id: string; name: string }> {
  return blocks
    .filter((b) => b.type === 'tool_use')
    .map((b, i) => ({
      id: b.id ?? `tool-${i}`,
      name: b.name ?? 'tool',
    }));
}

/** Map Cursor CLI `tool_call` payload keys to a display name. */
function cursorToolName(toolCall: Record<string, unknown> | undefined): string {
  if (!toolCall) return 'tool';
  const key = Object.keys(toolCall)[0];
  if (!key) return 'tool';
  if (key === 'function') {
    const fn = toolCall.function as { name?: string } | undefined;
    return fn?.name ?? 'function';
  }
  // readToolCall → read, writeToolCall → write, …
  const stripped = key.replace(/ToolCall$/, '');
  return stripped.replace(/([a-z])([A-Z])/g, '$1 $2').toLowerCase();
}

export const useChatStore = create<ChatStore>((set, get) => ({
  tabs: {},

  initializeTab: (tabId) =>
    set((state) => {
      if (state.tabs[tabId]) return state;
      return {
        tabs: {
          ...state.tabs,
          [tabId]: {
            messages: [],
            selectedModel: 'sonnet',
            selectedHarness: 'claudecode',
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

  updateMessage: (tabId, messageId, patch) =>
    set((state) => {
      const tab = state.tabs[tabId];
      if (!tab) return state;
      return {
        tabs: {
          ...state.tabs,
          [tabId]: {
            ...tab,
            messages: tab.messages.map((m) =>
              m.id === messageId ? { ...m, ...patch } : m,
            ),
          },
        },
      };
    }),

  setModel: (tabId, model, harnessId) =>
    set((state) => {
      const tab = state.tabs[tabId];
      if (!tab) return state;
      return {
        tabs: {
          ...state.tabs,
          [tabId]: {
            ...tab,
            selectedModel: model,
            ...(harnessId != null ? { selectedHarness: harnessId } : {}),
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

  sendPrompt: async (tabId, prompt) => {
    const tab = get().tabs[tabId];
    if (!tab || tab.loading || !prompt.trim()) return;

    const worktree = useProjectStore.getState().activePath;
    if (!worktree) {
      get().addMessage(tabId, {
        id: `err-${Date.now()}`,
        role: 'assistant',
        content: 'No worktree selected. Open a worktree before running an agent.',
        timestamp: Date.now(),
      });
      return;
    }

    const harnessId = (tab.selectedHarness || 'claudecode') as HarnessId;
    if (harnessId === 'cursor' && !useCursorStore.getState().authenticated) {
      get().addMessage(tabId, {
        id: `err-${Date.now()}`,
        role: 'assistant',
        content:
          'Cursor is not connected. Open Connect Harness and paste a Cursor API key.',
        timestamp: Date.now(),
      });
      return;
    }

    const userMessage: Message = {
      id: `user-${Date.now()}`,
      role: 'user',
      content: prompt.trim(),
      attachments:
        tab.attachments.length > 0 ? [...tab.attachments] : undefined,
      timestamp: Date.now(),
    };
    get().addMessage(tabId, userMessage);
    set((state) => {
      const t = state.tabs[tabId];
      if (!t) return state;
      return {
        tabs: {
          ...state.tabs,
          [tabId]: { ...t, attachments: [], loading: true },
        },
      };
    });

    let lineBuffer = '';
    let assistantId: string | null = null;
    let finished = false;
    let lastAssistantSegment = '';

    const ensureAssistant = (): string => {
      if (assistantId) return assistantId;
      assistantId = `assistant-${Date.now()}`;
      get().addMessage(tabId, {
        id: assistantId,
        role: 'assistant',
        content: '',
        timestamp: Date.now(),
      });
      return assistantId;
    };

    const appendAssistant = (text: string) => {
      if (!text) return;
      const id = ensureAssistant();
      const current = get().tabs[tabId]?.messages.find((m) => m.id === id);
      get().updateMessage(tabId, id, {
        content: (current?.content ?? '') + text,
      });
    };

    const setAssistantSegment = (text: string) => {
      if (!text) return;
      if (text === lastAssistantSegment) return;
      if (lastAssistantSegment && text.startsWith(lastAssistantSegment)) {
        appendAssistant(text.slice(lastAssistantSegment.length));
      } else {
        appendAssistant(text);
      }
      lastAssistantSegment = text;
    };

    const finish = (errorText?: string) => {
      if (finished) return;
      finished = true;
      if (errorText) {
        const id = ensureAssistant();
        const current = get().tabs[tabId]?.messages.find((m) => m.id === id);
        const existing = current?.content?.trim() ?? '';
        get().updateMessage(tabId, id, {
          content: existing ? `${existing}\n\n${errorText}` : errorText,
        });
      }
      const messages = get().tabs[tabId]?.messages ?? [];
      for (const m of messages) {
        if (m.role === 'tool' && m.toolStatus === 'running') {
          get().updateMessage(tabId, m.id, { toolStatus: 'done' });
        }
      }
      get().setLoading(tabId, false);
      if (harnessId === 'cursor') {
        cursorReleaseChannel(tabId);
      } else {
        claudeReleaseChannel(tabId);
      }
      void useChangesStore.getState().refresh();
    };

    const handleEvent = (event: StreamEvent) => {
      if (event.type === 'assistant') {
        const cursorEvent = event as CursorStreamEvent;
        if (cursorEvent.model_call_id) return;

        const blocks = contentBlocks(
          'message' in event ? event.message : undefined,
        );
        const text = textFromBlocks(blocks);
        if (harnessId === 'cursor') {
          if (cursorEvent.timestamp_ms != null) {
            appendAssistant(text);
            lastAssistantSegment += text;
          } else if (text) {
            setAssistantSegment(text);
          }
        } else if (text) {
          appendAssistant(text);
        }

        for (const tool of toolUsesFromBlocks(blocks)) {
          const id = `tool-${tool.id}`;
          const existing = get().tabs[tabId]?.messages.find((m) => m.id === id);
          if (existing) continue;
          get().addMessage(tabId, {
            id,
            role: 'tool',
            content: tool.name,
            toolName: tool.name,
            toolStatus: 'running',
            timestamp: Date.now(),
          });
        }
        return;
      }

      if (event.type === 'tool_call') {
        const cursorEvent = event as CursorStreamEvent;
        const callId = cursorEvent.call_id ?? `tool-${Date.now()}`;
        const id = `tool-${callId}`;
        const name = cursorToolName(cursorEvent.tool_call);
        if (cursorEvent.subtype === 'started') {
          const existing = get().tabs[tabId]?.messages.find((m) => m.id === id);
          if (!existing) {
            get().addMessage(tabId, {
              id,
              role: 'tool',
              content: name,
              toolName: name,
              toolStatus: 'running',
              timestamp: Date.now(),
            });
          }
          lastAssistantSegment = '';
        } else if (cursorEvent.subtype === 'completed') {
          const existing = get().tabs[tabId]?.messages.find((m) => m.id === id);
          if (existing) {
            get().updateMessage(tabId, id, { toolStatus: 'done' });
          } else {
            get().addMessage(tabId, {
              id,
              role: 'tool',
              content: name,
              toolName: name,
              toolStatus: 'done',
              timestamp: Date.now(),
            });
          }
          lastAssistantSegment = '';
        }
        return;
      }

      if (event.type === 'user') {
        const blocks = contentBlocks(
          'message' in event ? event.message : undefined,
        );
        for (const block of blocks) {
          if (block.type === 'tool_result' && block.tool_use_id) {
            const id = `tool-${block.tool_use_id}`;
            const existing = get().tabs[tabId]?.messages.find((m) => m.id === id);
            if (existing) {
              get().updateMessage(tabId, id, { toolStatus: 'done' });
            }
          }
        }
        return;
      }

      if (event.type === 'result') {
        const resultText = 'result' in event ? event.result : undefined;
        const isError = 'is_error' in event ? Boolean(event.is_error) : false;
        if (isError && resultText) {
          appendAssistant(String(resultText));
        } else if (resultText && !assistantId) {
          appendAssistant(String(resultText));
        }
      }
    };

    const onEvent = (chunk: ClaudeOutput | CursorOutput) => {
      if (finished) return;
      lineBuffer += decode(chunk);

      const exitRe = harnessId === 'cursor' ? CURSOR_EXIT_RE : CLAUDE_EXIT_RE;
      const exitMatch = lineBuffer.match(exitRe);
      if (exitMatch) {
        const code = Number(exitMatch[1]);
        const before = lineBuffer.slice(0, exitMatch.index);
        for (const line of before.split('\n')) {
          const trimmed = line.trim();
          if (
            !trimmed ||
            trimmed.startsWith('__CLAUDE_EXIT__') ||
            trimmed.startsWith('__CURSOR_EXIT__')
          ) {
            continue;
          }
          try {
            handleEvent(JSON.parse(trimmed) as StreamEvent);
          } catch {
            // Non-JSON stderr noise — ignore.
          }
        }
        if (code === -1) {
          finish('Agent cancelled.');
        } else if (code !== 0) {
          finish(
            harnessId === 'cursor'
              ? `Cursor agent exited with code ${code}.`
              : `Claude Code exited with code ${code}.`,
          );
        } else {
          finish();
        }
        return;
      }

      const lines = lineBuffer.split('\n');
      lineBuffer = lines.pop() ?? '';
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        try {
          handleEvent(JSON.parse(trimmed) as StreamEvent);
        } catch {
          // Non-JSON (stderr) — ignore for the chat transcript.
        }
      }
    };

    try {
      const modelInfo = findHarnessModel(
        useHarnessStore.getState().models,
        tab.selectedModel,
        harnessId,
      );

      if (harnessId === 'cursor') {
        await cursorAgentRun(
          tabId,
          prompt.trim(),
          worktree,
          tab.selectedModel || null,
          onEvent,
        );
      } else {
        const effort =
          modelInfo?.supportsEffort && tab.modelEffort
            ? tab.modelEffort
            : null;
        const fastMode = Boolean(
          modelInfo?.supportsFastMode && tab.mode === 'fast',
        );

        await claudeAgentRun(
          tabId,
          prompt.trim(),
          worktree,
          tab.selectedModel || null,
          effort,
          fastMode,
          onEvent,
        );
      }
    } catch (e) {
      finish(String(e));
    }
  },

  cancelAgent: async (tabId) => {
    const harnessId = get().tabs[tabId]?.selectedHarness;
    if (harnessId === 'cursor') {
      await cursorAgentCancel(tabId);
      cursorReleaseChannel(tabId);
    } else {
      await claudeAgentCancel(tabId);
      claudeReleaseChannel(tabId);
    }
    get().setLoading(tabId, false);
  },
}));
