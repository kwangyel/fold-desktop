import { create } from 'zustand';
import {
  ClaudeOutput,
  claudeAgentCancel,
  claudeAgentRun,
  claudeReleaseChannel,
} from '../lib/claude';
import {
  CodexOutput,
  codexAgentCancel,
  codexAgentRun,
  codexReleaseChannel,
} from '../lib/codex';
import {
  CursorOutput,
  cursorAgentCancel,
  cursorAgentRun,
  cursorReleaseChannel,
} from '../lib/cursor';
import {
  OpenCodeOutput,
  opencodeAgentCancel,
  opencodeAgentRun,
  opencodeReleaseChannel,
} from '../lib/opencode';
import type { EffortLevel, HarnessId } from '../lib/harnesses';
import type { SDKMessage } from '../lib/claudeStreamTypes';
import { useProjectStore } from './projectStore';
import { useChangesStore } from './changesStore';
import { findHarnessModel, useHarnessStore } from './harnessStore';
import { useCodexStore } from './codexStore';
import { useCursorStore } from './cursorStore';
import { useOpenCodeStore } from './opencodeStore';

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
/** Sentinel emitted by the Rust monitor when the Codex child exits. */
const CODEX_EXIT_RE = /__CODEX_EXIT__:(-?\d+)/;
/** Sentinel emitted by the Rust monitor when the OpenCode child exits. */
const OPENCODE_EXIT_RE = /__OPENCODE_EXIT__:(-?\d+)/;

const EXIT_SENTINEL_PREFIXES = [
  '__CLAUDE_EXIT__',
  '__CURSOR_EXIT__',
  '__CODEX_EXIT__',
  '__OPENCODE_EXIT__',
] as const;

type ContentBlock = {
  type: string;
  text?: string;
  id?: string;
  name?: string;
  tool_use_id?: string;
  content?: unknown;
  input?: unknown;
};

type StreamEvent = SDKMessage | GenericStreamEvent;

type GenericStreamEvent = {
  type: string;
  subtype?: string;
  message?: { content?: unknown };
  result?: string;
  is_error?: boolean;
  call_id?: string;
  tool_call?: Record<string, unknown>;
  timestamp_ms?: number;
  model_call_id?: string;
  /** Codex `item.*` payload. */
  item?: {
    id?: string;
    type?: string;
    text?: string;
    command?: string;
    status?: string;
  };
  /** OpenCode `text` / `tool_use` part payload. */
  part?: {
    type?: string;
    text?: string;
    id?: string;
    tool?: string;
    state?: { status?: string; error?: string };
  };
  error?: unknown;
};

type AgentChunk = ClaudeOutput | CursorOutput | CodexOutput | OpenCodeOutput;

function decode(chunk: AgentChunk): string {
  const bytes = chunk instanceof Uint8Array ? chunk : new Uint8Array(chunk);
  return new TextDecoder().decode(bytes);
}

function exitRegexFor(harnessId: HarnessId): RegExp {
  switch (harnessId) {
    case 'cursor':
      return CURSOR_EXIT_RE;
    case 'codex':
      return CODEX_EXIT_RE;
    case 'opencode':
      return OPENCODE_EXIT_RE;
    case 'claudecode':
    default:
      return CLAUDE_EXIT_RE;
  }
}

function exitLabelFor(harnessId: HarnessId): string {
  switch (harnessId) {
    case 'cursor':
      return 'Cursor agent';
    case 'codex':
      return 'Codex';
    case 'opencode':
      return 'OpenCode';
    case 'claudecode':
    default:
      return 'Claude Code';
  }
}

function releaseChannelFor(harnessId: HarnessId, sessionId: string): void {
  switch (harnessId) {
    case 'cursor':
      cursorReleaseChannel(sessionId);
      break;
    case 'codex':
      codexReleaseChannel(sessionId);
      break;
    case 'opencode':
      opencodeReleaseChannel(sessionId);
      break;
    case 'claudecode':
    default:
      claudeReleaseChannel(sessionId);
      break;
  }
}

function isHarnessConnected(harnessId: HarnessId): boolean {
  switch (harnessId) {
    case 'cursor':
      return useCursorStore.getState().authenticated;
    case 'codex': {
      const s = useCodexStore.getState();
      return s.installed && s.authenticated;
    }
    case 'opencode': {
      const s = useOpenCodeStore.getState();
      return s.installed && s.authenticated;
    }
    case 'claudecode':
    default:
      return true;
  }
}

function connectHintFor(harnessId: HarnessId): string {
  switch (harnessId) {
    case 'cursor':
      return 'Cursor is not connected. Open Connect Harness and paste a Cursor API key.';
    case 'codex':
      return 'Codex is not connected. Open Connect Harness and log in.';
    case 'opencode':
      return 'OpenCode is not connected. Open Connect Harness and log in.';
    default:
      return 'Harness is not connected. Open Connect Harness to connect.';
  }
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
    if (harnessId !== 'claudecode' && !isHarnessConnected(harnessId)) {
      get().addMessage(tabId, {
        id: `err-${Date.now()}`,
        role: 'assistant',
        content: connectHintFor(harnessId),
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
      releaseChannelFor(harnessId, tabId);
      void useChangesStore.getState().refresh();
    };

    const upsertTool = (
      id: string,
      name: string,
      status: 'running' | 'done',
    ) => {
      const existing = get().tabs[tabId]?.messages.find((m) => m.id === id);
      if (existing) {
        if (status === 'done') {
          get().updateMessage(tabId, id, { toolStatus: 'done' });
        }
        return;
      }
      get().addMessage(tabId, {
        id,
        role: 'tool',
        content: name,
        toolName: name,
        toolStatus: status,
        timestamp: Date.now(),
      });
    };

    const handleEvent = (event: StreamEvent) => {
      // OpenCode JSON format: { type: "text"|"tool_use"|..., part: {...} }
      if (harnessId === 'opencode') {
        const oc = event as GenericStreamEvent;
        if (oc.type === 'text' && oc.part?.text) {
          appendAssistant(oc.part.text);
          return;
        }
        if (oc.type === 'tool_use' && oc.part) {
          const id = `tool-${oc.part.id ?? Date.now()}`;
          const name = oc.part.tool ?? 'tool';
          const status =
            oc.part.state?.status === 'completed' ||
            oc.part.state?.status === 'error'
              ? 'done'
              : 'running';
          upsertTool(id, name, status);
          return;
        }
        if (oc.type === 'error') {
          const msg =
            typeof oc.error === 'string'
              ? oc.error
              : oc.error != null
                ? JSON.stringify(oc.error)
                : 'OpenCode error';
          appendAssistant(msg);
        }
        return;
      }

      // Codex JSONL: item.started / item.completed with item.type
      if (harnessId === 'codex') {
        const cx = event as GenericStreamEvent;
        if (cx.type === 'item.started' || cx.type === 'item.completed') {
          const item = cx.item;
          if (!item) return;
          if (item.type === 'agent_message' && item.text) {
            if (cx.type === 'item.completed') {
              appendAssistant(item.text);
            }
            return;
          }
          if (
            item.type === 'command_execution' ||
            item.type === 'file_change' ||
            item.type === 'mcp_tool_call' ||
            item.type === 'web_search'
          ) {
            const id = `tool-${item.id ?? Date.now()}`;
            const name =
              item.type === 'command_execution'
                ? item.command?.split(/\s+/)[0] || 'command'
                : item.type.replace(/_/g, ' ');
            upsertTool(
              id,
              name,
              cx.type === 'item.completed' ? 'done' : 'running',
            );
          }
          return;
        }
        if (cx.type === 'turn.failed' || cx.type === 'error') {
          const msg =
            typeof cx.error === 'string'
              ? cx.error
              : cx.error != null
                ? JSON.stringify(cx.error)
                : 'Codex turn failed';
          appendAssistant(msg);
        }
        return;
      }

      if (event.type === 'assistant') {
        const cursorEvent = event as GenericStreamEvent;
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
        const cursorEvent = event as GenericStreamEvent;
        const callId = cursorEvent.call_id ?? `tool-${Date.now()}`;
        const id = `tool-${callId}`;
        const name = cursorToolName(cursorEvent.tool_call);
        if (cursorEvent.subtype === 'started') {
          upsertTool(id, name, 'running');
          lastAssistantSegment = '';
        } else if (cursorEvent.subtype === 'completed') {
          upsertTool(id, name, 'done');
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

    const onEvent = (chunk: AgentChunk) => {
      if (finished) return;
      lineBuffer += decode(chunk);

      const exitRe = exitRegexFor(harnessId);
      const exitMatch = lineBuffer.match(exitRe);
      if (exitMatch) {
        const code = Number(exitMatch[1]);
        const before = lineBuffer.slice(0, exitMatch.index);
        for (const line of before.split('\n')) {
          const trimmed = line.trim();
          if (
            !trimmed ||
            EXIT_SENTINEL_PREFIXES.some((p) => trimmed.startsWith(p))
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
          finish(`${exitLabelFor(harnessId)} exited with code ${code}.`);
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
      } else if (harnessId === 'codex') {
        await codexAgentRun(
          tabId,
          prompt.trim(),
          worktree,
          tab.selectedModel || null,
          onEvent,
        );
      } else if (harnessId === 'opencode') {
        await opencodeAgentRun(
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
    const harnessId = (get().tabs[tabId]?.selectedHarness ||
      'claudecode') as HarnessId;
    switch (harnessId) {
      case 'cursor':
        await cursorAgentCancel(tabId);
        break;
      case 'codex':
        await codexAgentCancel(tabId);
        break;
      case 'opencode':
        await opencodeAgentCancel(tabId);
        break;
      case 'claudecode':
      default:
        await claudeAgentCancel(tabId);
        break;
    }
    releaseChannelFor(harnessId, tabId);
    get().setLoading(tabId, false);
  },
}));
