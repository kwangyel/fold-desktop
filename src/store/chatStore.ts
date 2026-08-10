import { create } from 'zustand';
import {
  ClaudeOutput,
  claudeAgentCancel,
  claudeAgentRespond,
  claudeAgentRun,
  claudeReleaseChannel,
  type ClaudePermissionRequest,
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
import { harnessSupportsPlanMode, type EffortLevel, type HarnessId } from '../lib/harnesses';
import { effortForAgentWire, resolveEffortLevels } from '../lib/effort';
import { writeFile } from '../lib/git';
import {
  composeAgentPrompt,
  makeTranscriptAttachment,
  materializeAttachments,
} from '../lib/attachments';
import { abandonQuestions } from '../lib/answerQuestions';
import {
  chatTitleFromPrompt,
  clearChatSession,
  deleteChat,
  messageFromRow,
  rowFromMessage,
  saveChatMessages,
  setChatSession,
  upsertChat,
  type ChatMessageRow,
  type ChatRecord,
} from '../lib/chats';
import {
  renderTranscriptMarkdown,
  transcriptAttachmentName,
} from '../lib/chatTranscript';
import { useChatSessionStore } from './chatSessionStore';
import type { SDKMessage } from '../lib/claudeStreamTypes';
import {
  cursorToolPayload,
  filePathsFromInput,
  stringifyPayload,
  toolExcerpt,
} from '../lib/chatActivity';
import { contextUsageFromClaudeEvent, sessionUsageFromFoldEvent } from '../lib/contextUsage';
import { useProjectStore } from './projectStore';
import { useChangesStore } from './changesStore';
import { usePlanStore } from './planStore';
import { useContextUsageStore } from './contextUsageStore';
import {
  newPlanId,
  planTitle,
  writePlanMarkdown,
  loadPlanMarkdownFromDisk,
  findUnindexedPlanMarkdown,
  isPlanFilePath,
  toRepoRelativePath,
  planIdFromPath,
  buildCursorPlanPrompt,
  PLANS_DIR,
  type PlanRecord,
} from '../lib/plans';
import { useCenterViewStore } from './centerViewStore';
import { useQuestionStore } from './questionStore';
import { useAgentStatusStore } from './agentStatusStore';
import type { Question } from '../lib/questions';
import { findHarnessModel, useHarnessStore } from './harnessStore';
import { useClaudeStore, CLAUDE_OAUTH_EXPIRED_RE } from './claudeStore';
import { useCodexStore } from './codexStore';
import { useCursorStore } from './cursorStore';
import { useOpenCodeStore } from './opencodeStore';

export type AttachmentKind =
  | 'file'
  | 'text'
  | 'image'
  | 'prompt'
  /** Transcript of an earlier chat, carried over on a harness switch. */
  | 'transcript';

export type Attachment = {
  id: string;
  name: string;
  size: number;
  type: string;
  kind: AttachmentKind;
  /** Text / prompt body included when the message is sent. */
  content?: string;
  /** Data URL for image preview. */
  dataUrl?: string;
  /** Worktree-relative path after an image is written to disk. */
  path?: string;
};

export type Message = {
  id: string;
  role: 'user' | 'assistant' | 'tool' | 'thinking';
  content: string;
  /** Present when role === 'tool'. */
  toolName?: string;
  toolStatus?: 'running' | 'done';
  /** Full tool input / thinking body for accordion detail. */
  detail?: string;
  /** Tool result / output when available. */
  toolOutput?: string;
  /** File paths touched by this tool (write/edit/read). */
  filePaths?: string[];
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
  /** Run the next prompt in the harness's read-only planning mode. */
  planMode: boolean;
  attachments: Attachment[];
  loading: boolean;
  /**
   * `false` until the first prompt is sent. Draft tabs are never written to
   * disk, so opening a tab and closing it again leaves no empty chat behind.
   */
  persisted: boolean;
  /** Worktree this chat belongs to; set when it is first persisted. */
  worktreePath: string | null;
  /** Sidebar label, derived from the opening prompt. */
  title: string;
  /**
   * Harness session ids for this chat, keyed by harness. Each harness keeps its
   * own conversation memory, so a chat can hold one session per harness it has
   * been run with and resume whichever is selected.
   */
  sessions: Partial<Record<HarnessId, string>>;
};

/** Options for seeding a new tab (used by the harness-switch handoff). */
export type NewTabOptions = {
  harnessId?: string;
  model?: string;
  attachments?: Attachment[];
};

/**
 * Claude `canUseTool` requests awaiting an answer, keyed by plan id. The agent
 * turn stays paused until we respond, which is what lets a plan sit in the Plan
 * tab waiting for the user.
 */
const pendingPlanApprovals = new Map<
  string,
  { tabId: string; requestId: string }
>();

/** Whether the agent that produced this plan is still waiting on approval. */
export function hasPendingPlanApproval(planId: string): boolean {
  return pendingPlanApprovals.has(planId);
}

/**
 * Answer the paused `ExitPlanMode` request for a plan. Approving lets the same
 * session continue straight into implementation; rejecting returns the agent to
 * planning with the user's reason.
 */
export async function resolvePlanApproval(
  planId: string,
  approve: boolean,
  reason?: string,
): Promise<boolean> {
  const pending = pendingPlanApprovals.get(planId);
  if (!pending) return false;
  pendingPlanApprovals.delete(planId);
  await claudeAgentRespond(
    pending.tabId,
    approve
      ? {
          type: 'fold_permission_response',
          requestId: pending.requestId,
          behavior: 'allow',
        }
      : {
          type: 'fold_permission_response',
          requestId: pending.requestId,
          behavior: 'deny',
          message: reason || 'User rejected the plan.',
        },
  );
  return true;
}

export type SendPromptOptions = {
  /** Set when this run is implementing a plan, so its status can be settled. */
  planId?: string;
};

type ChatStore = {
  tabs: Record<string, ChatTabState>;

  initializeTab: (tabId: string, options?: NewTabOptions) => void;
  /** Restore a persisted chat into a tab (transcript, harness, sessions). */
  hydrateTab: (
    tabId: string,
    worktreePath: string,
    record: ChatRecord,
  ) => void;
  addMessage: (tabId: string, message: Message) => void;
  updateMessage: (
    tabId: string,
    messageId: string,
    patch: Partial<Message>,
  ) => void;
  /** Append streamed text to a message in a single store write. */
  appendToMessage: (tabId: string, messageId: string, text: string) => void;
  /** Mark every still-running tool row as done in one write. */
  settleRunningTools: (tabId: string) => void;
  setModel: (tabId: string, model: string, harnessId?: string) => void;
  setEffort: (tabId: string, effort: EffortLevel) => void;
  setMode: (tabId: string, mode: 'normal' | 'fast') => void;
  setPlanMode: (tabId: string, planMode: boolean) => void;
  setLoading: (tabId: string, loading: boolean) => void;
  addAttachment: (tabId: string, attachment: Attachment) => void;
  removeAttachment: (tabId: string, attachmentId: string) => void;
  clearChat: (tabId: string) => void;
  deleteTab: (tabId: string) => void;
  /** Send a prompt to the selected harness agent in the active worktree. */
  sendPrompt: (
    tabId: string,
    prompt: string,
    options?: SendPromptOptions,
  ) => Promise<void>;
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
  thinking?: string;
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
  /** Claude Code (`system`/`init`) and Cursor stream-json session id. */
  session_id?: string;
  /** OpenCode stamps its `ses_…` id on every JSON event. */
  sessionID?: string;
  /** Codex `thread.started` conversation id. */
  thread_id?: string;
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
    case 'claudecode': {
      const s = useClaudeStore.getState();
      return s.installed && s.authenticated;
    }
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
    case 'claudecode':
      return 'Claude Code is not connected. Open Connect Harness and log in (or Re-login if OAuth expired).';
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
): Array<{ id: string; name: string; input?: unknown }> {
  return blocks
    .filter((b) => b.type === 'tool_use')
    .map((b, i) => ({
      id: b.id ?? `tool-${i}`,
      name: b.name ?? 'tool',
      input: b.input,
    }));
}

function thinkingFromBlocks(blocks: ContentBlock[]): string[] {
  return blocks
    .filter((b) => b.type === 'thinking' || b.type === 'redacted_thinking')
    .map((b) => {
      if (typeof b.thinking === 'string' && b.thinking) return b.thinking;
      return stringifyPayload(b.content ?? b.text ?? '');
    })
    .filter(Boolean);
}

/**
 * Streaming rewrites the same assistant row on every frame, so transcript
 * writes are batched: actions mark rows dirty and a debounced flush upserts
 * only what changed.
 */
const FLUSH_DEBOUNCE_MS = 500;
const dirtyMessages = new Map<string, Set<string>>();
const flushTimers = new Map<string, ReturnType<typeof setTimeout>>();

/**
 * Tabs the user cancelled. Killing the agent still drives the stream to its
 * exit sentinel, so `finish` consults this to avoid announcing a "done" the
 * user never waited for.
 */
const cancelledTabs = new Set<string>();

/** Queue a message row for the next transcript flush. No-op for draft tabs. */
function markMessageDirty(tabId: string, ...messageIds: string[]): void {
  const tab = useChatStore.getState().tabs[tabId];
  if (!tab?.persisted || !tab.worktreePath) return;
  let ids = dirtyMessages.get(tabId);
  if (!ids) {
    ids = new Set();
    dirtyMessages.set(tabId, ids);
  }
  for (const id of messageIds) ids.add(id);
  if (!flushTimers.has(tabId)) {
    flushTimers.set(
      tabId,
      setTimeout(() => {
        flushTimers.delete(tabId);
        void flushChatMessages(tabId);
      }, FLUSH_DEBOUNCE_MS),
    );
  }
}

/**
 * Write pending transcript rows for a tab. `refreshIndex` re-reads the sidebar
 * list, which is only worth doing at the end of a turn.
 */
export async function flushChatMessages(
  tabId: string,
  refreshIndex = false,
): Promise<void> {
  const pending = flushTimers.get(tabId);
  if (pending) {
    clearTimeout(pending);
    flushTimers.delete(tabId);
  }
  const ids = dirtyMessages.get(tabId);
  dirtyMessages.delete(tabId);

  const tab = useChatStore.getState().tabs[tabId];
  if (!tab?.persisted || !tab.worktreePath) return;

  const rows: ChatMessageRow[] = [];
  if (ids?.size) {
    tab.messages.forEach((m, index) => {
      if (ids.has(m.id)) rows.push(rowFromMessage(m, index));
    });
  }

  try {
    await saveChatMessages(tab.worktreePath, tabId, rows);
  } catch {
    // Losing a transcript write should never break the run; the next flush
    // will pick these rows up again if they change.
    if (ids?.size) dirtyMessages.set(tabId, ids);
  }
  if (refreshIndex) {
    void useChatSessionStore.getState().refresh(tab.worktreePath);
  }
}

/**
 * Harness session id carried by a stream event, or `null`.
 *
 * Every harness surfaces its own id differently: Claude Code and Cursor put
 * `session_id` on their `system`/`init` event, Codex opens with
 * `thread.started`, and OpenCode stamps `sessionID` on every event.
 */
function sessionIdFromEvent(
  harnessId: HarnessId,
  event: StreamEvent,
): string | null {
  const e = event as GenericStreamEvent;
  switch (harnessId) {
    case 'codex':
      return e.type === 'thread.started' && e.thread_id ? e.thread_id : null;
    case 'opencode':
      return e.sessionID || null;
    case 'cursor':
    case 'claudecode':
    default:
      return e.session_id || null;
  }
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

  initializeTab: (tabId, options) =>
    set((state) => {
      if (state.tabs[tabId]) return state;
      return {
        tabs: {
          ...state.tabs,
          [tabId]: {
            messages: [],
            selectedModel: options?.model ?? 'sonnet',
            selectedHarness: options?.harnessId ?? 'claudecode',
            modelEffort: 'medium',
            mode: 'normal',
            planMode: false,
            attachments: options?.attachments ?? [],
            loading: false,
            persisted: false,
            worktreePath: null,
            title: 'New chat',
            sessions: {},
          },
        },
      };
    }),

  hydrateTab: (tabId, worktreePath, record) =>
    set((state) => {
      const existing = state.tabs[tabId];
      const sessions: Partial<Record<HarnessId, string>> = {};
      for (const s of record.sessions) {
        sessions[s.harness as HarnessId] = s.sessionId;
      }
      return {
        tabs: {
          ...state.tabs,
          [tabId]: {
            messages: record.messages.map(messageFromRow),
            selectedModel: record.meta.model ?? existing?.selectedModel ?? 'sonnet',
            selectedHarness: record.meta.harness,
            modelEffort:
              (record.meta.effort as EffortLevel | null) ??
              existing?.modelEffort ??
              'medium',
            mode: 'normal',
            planMode: false,
            // A reopened chat starts with an empty composer.
            attachments: [],
            loading: false,
            persisted: true,
            worktreePath,
            title: record.meta.title,
            sessions,
          },
        },
      };
    }),

  addMessage: (tabId, message) => {
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
    });
    markMessageDirty(tabId, message.id);
  },

  updateMessage: (tabId, messageId, patch) => {
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
    });
    markMessageDirty(tabId, messageId);
  },

  appendToMessage: (tabId, messageId, text) => {
    set((state) => {
      const tab = state.tabs[tabId];
      if (!tab || !text) return state;
      const index = tab.messages.findIndex((m) => m.id === messageId);
      if (index === -1) return state;
      const messages = tab.messages.slice();
      const target = messages[index];
      messages[index] = { ...target, content: target.content + text };
      return {
        tabs: { ...state.tabs, [tabId]: { ...tab, messages } },
      };
    });
    markMessageDirty(tabId, messageId);
  },

  settleRunningTools: (tabId) => {
    const settled: string[] = [];
    set((state) => {
      const tab = state.tabs[tabId];
      if (!tab) return state;
      const messages = tab.messages.map((m) => {
        if (m.role !== 'tool' || m.toolStatus !== 'running') return m;
        settled.push(m.id);
        return { ...m, toolStatus: 'done' as const };
      });
      if (settled.length === 0) return state;
      return {
        tabs: { ...state.tabs, [tabId]: { ...tab, messages } },
      };
    });
    if (settled.length > 0) markMessageDirty(tabId, ...settled);
  },

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

  setPlanMode: (tabId, planMode) =>
    set((state) => {
      const tab = state.tabs[tabId];
      if (!tab) return state;
      return {
        tabs: {
          ...state.tabs,
          [tabId]: {
            ...tab,
            planMode,
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

  clearChat: (tabId) => {
    const tab = get().tabs[tabId];
    if (!tab) return;
    // Clearing means "start over": drop the persisted transcript and the
    // harness sessions with it, so the next prompt opens a fresh session.
    const { worktreePath, persisted } = tab;
    useAgentStatusStore.getState().clear(tabId);
    dirtyMessages.delete(tabId);
    const timer = flushTimers.get(tabId);
    if (timer) {
      clearTimeout(timer);
      flushTimers.delete(tabId);
    }
    set((state) => {
      const current = state.tabs[tabId];
      if (!current) return state;
      return {
        tabs: {
          ...state.tabs,
          [tabId]: {
            ...current,
            messages: [],
            attachments: [],
            sessions: {},
            persisted: false,
          },
        },
      };
    });
    if (persisted && worktreePath) {
      void deleteChat(worktreePath, tabId).then(() =>
        useChatSessionStore.getState().refresh(worktreePath),
      );
    }
  },

  // Closing a tab keeps the chat on disk — it stays listed under its worktree.
  deleteTab: (tabId) => {
    void flushChatMessages(tabId);
    set((state) => {
      const { [tabId]: _, ...remainingTabs } = state.tabs;
      return { tabs: remainingTabs };
    });
  },

  sendPrompt: async (tabId, prompt, options) => {
    const tab = get().tabs[tabId];
    if (!tab || tab.loading) return;

    const hasAttachments = tab.attachments.length > 0;
    if (!prompt.trim() && !hasAttachments) return;

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
    // Codex has no planning mode, so the toggle is hidden for it; guard here too
    // in case a stale tab kept planMode set across a harness switch.
    const planningRun = tab.planMode && harnessSupportsPlanMode(harnessId);
    const implementingPlanId = options?.planId;

    if (!isHarnessConnected(harnessId)) {
      get().addMessage(tabId, {
        id: `err-${Date.now()}`,
        role: 'assistant',
        content: connectHintFor(harnessId),
        timestamp: Date.now(),
      });
      return;
    }

    const preparedAttachments = hasAttachments
      ? await materializeAttachments(tab.attachments)
      : [];
    const displayContent = prompt.trim();
    const agentPrompt = composeAgentPrompt(displayContent, preparedAttachments);
    if (!agentPrompt.trim()) return;

    // First prompt promotes the draft tab into a real chat. Until this point
    // nothing was written to disk, so opening tabs and closing them again
    // never leaves empty chats in the sidebar.
    const chatTitle = tab.persisted
      ? tab.title
      : chatTitleFromPrompt(displayContent, 'New chat');
    const wasDraft = !tab.persisted;
    try {
      const stamp = Date.now();
      await upsertChat(worktree, {
        id: tabId,
        title: chatTitle,
        harness: harnessId,
        model: tab.selectedModel || null,
        effort: tab.modelEffort ?? null,
        createdAt: stamp,
        updatedAt: stamp,
      });
      set((state) => {
        const t = state.tabs[tabId];
        if (!t) return state;
        return {
          tabs: {
            ...state.tabs,
            [tabId]: {
              ...t,
              persisted: true,
              worktreePath: worktree,
              title: chatTitle,
            },
          },
        };
      });
      if (wasDraft) {
        useCenterViewStore.getState().renameTab(tabId, chatTitle);
        void useChatSessionStore.getState().refresh(worktree);
      }
    } catch {
      // Persistence is best-effort — a failed write must not block the run.
    }

    // Persist path-only chips in the transcript (drop bulky in-memory bodies).
    const messageAttachments =
      preparedAttachments.length > 0
        ? preparedAttachments.map(({ id, name, size, type, kind, path, dataUrl }) => ({
            id,
            name,
            size,
            type,
            kind,
            path,
            // Keep a small preview URL for images in the chat UI.
            dataUrl: kind === 'image' ? dataUrl : undefined,
          }))
        : undefined;
    const userMessage: Message = {
      id: `user-${Date.now()}`,
      role: 'user',
      content: displayContent,
      attachments: messageAttachments,
      timestamp: Date.now(),
    };
    get().addMessage(tabId, userMessage);
    // Write the prompt straight through rather than waiting on the streaming
    // debounce, so a crash mid-turn can't lose what the user actually asked.
    void flushChatMessages(tabId);
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
    // A cancel that never reached its exit sentinel must not swallow this run.
    cancelledTabs.delete(tabId);
    useAgentStatusStore
      .getState()
      .setState(tabId, 'running', { worktreePath: worktree, title: chatTitle });

    // Use the composed agent prompt (user text + attachment path refs) from here on.
    let promptForAgent = agentPrompt;
    let lineBuffer = '';
    let assistantId: string | null = null;
    let finished = false;
    let lastAssistantSegment = '';
    /** Session id this attempt asked the harness to resume, if any. */
    let runResumeId: string | null = null;
    /** Set once a resume has already been retried, so it happens at most once. */
    let resumeRetried = false;
    /** Whether the harness produced anything before failing. */
    let sawOutput = false;
    let runStartedAt = 0;
    // Set once a plan has been captured for this run, so the fallback capture
    // on exit doesn't produce a second record.
    let capturedPlan = false;
    /** Plan file Claude Code wrote during this planning run (Fold plans dir). */
    let trackedPlanPath: string | null = null;
    let cursorPlanPollTimer: number | undefined;

    const stopCursorPlanPoll = () => {
      if (cursorPlanPollTimer !== undefined) {
        window.clearInterval(cursorPlanPollTimer);
        cursorPlanPollTimer = undefined;
      }
    };

    const trackPlanFile = (toolName: string, input?: unknown) => {
      if (!planningRun) return;
      const name = toolName.toLowerCase().replace(/\s+/g, '');
      if (!/(write|edit|createplan|create_plan)/.test(name)) return;

      const paths = filePathsFromInput(input);
      for (const p of paths) {
        if (isPlanFilePath(p)) {
          trackedPlanPath = toRepoRelativePath(p, worktree);
        }
      }

      // Cursor soft plan: any write outside the plan file means the agent is
      // implementing — stop it and keep whatever plan we already have.
      if (
        harnessId === 'cursor' &&
        /(write|edit|delete)/.test(name) &&
        paths.some((p) => !isPlanFilePath(p))
      ) {
        const blocked = paths.filter((p) => !isPlanFilePath(p));
        appendAssistant(
          `\n\nPlan mode blocked edits outside the plan file (${blocked.join(', ')}). Stopping so the plan can be reviewed first.`,
        );
        // If the dedicated plan file already exists, capture it before cancel.
        if (trackedPlanPath) {
          void loadPlanMarkdownFromDisk(trackedPlanPath, worktree).then(
            (found) => {
              if (found) void capturePlan(found.markdown, undefined, found.path);
              void get().cancelAgent(tabId);
            },
          );
        } else {
          void get().cancelAgent(tabId);
        }
        return;
      }

      // Cursor CreatePlan may put the body in `plan` / `content` without a path.
      if (
        harnessId === 'cursor' &&
        /createplan|create_plan/.test(name) &&
        !capturedPlan
      ) {
        const obj =
          input && typeof input === 'object'
            ? (input as Record<string, unknown>)
            : null;
        const body = String(obj?.plan ?? obj?.content ?? obj?.markdown ?? '');
        if (body.trim().length > 200) {
          void capturePlan(body).then((ok) => {
            if (ok) void get().cancelAgent(tabId);
          });
        }
      }
    };

    /** Poll only the soft-plan target path — never other plans in the folder. */
    const startCursorPlanPoll = (path: string) => {
      stopCursorPlanPoll();
      cursorPlanPollTimer = window.setInterval(() => {
        if (capturedPlan || finished) {
          stopCursorPlanPoll();
          return;
        }
        void loadPlanMarkdownFromDisk(path, worktree).then((found) => {
          if (!found || found.markdown.trim().length < 80) return;
          stopCursorPlanPoll();
          void capturePlan(found.markdown, undefined, found.path).then((ok) => {
            if (ok) void get().cancelAgent(tabId);
          });
        });
      }, 1500);
    };

    /**
     * Persist a plan and open it for review. Always bind to this run's plan
     * path when we have one — never substitute a different file from the dir.
     */
    const capturePlan = async (
      markdown: string,
      requestId?: string,
      existingPath?: string,
      planFilePathHint?: string,
    ): Promise<boolean> => {
      if (capturedPlan) return false;

      const preferred =
        existingPath ||
        planFilePathHint ||
        trackedPlanPath ||
        undefined;

      // Strict read of the intended path only (no "longest plan in folder").
      const fromDisk = preferred
        ? await loadPlanMarkdownFromDisk(preferred, worktree)
        : null;
      const fromInput = markdown.trim();

      let body = '';
      let path: string | undefined = preferred
        ? toRepoRelativePath(preferred, worktree)
        : undefined;

      if (fromDisk?.markdown.trim()) {
        body = fromDisk.markdown.trim();
        path = fromDisk.path;
      } else if (fromInput) {
        body = fromInput;
      } else if (!preferred) {
        // Claude ExitPlanMode with no path: only accept unindexed plan files.
        const unindexed = await findUnindexedPlanMarkdown();
        if (unindexed) {
          body = unindexed.markdown.trim();
          path = unindexed.path;
        }
      }

      if (!body) return false;
      capturedPlan = true;

      // Keep id aligned with the pre-assigned Cursor soft-plan filename.
      const id = (path && planIdFromPath(path)) || newPlanId();
      try {
        if (!path) {
          path = await writePlanMarkdown(id, body);
        } else {
          path = toRepoRelativePath(path, worktree);
          // Ensure the dedicated file has the body we captured.
          if (!fromDisk || fromInput.length > fromDisk.markdown.trim().length) {
            await writeFile(path, body.endsWith('\n') ? body : `${body}\n`);
          }
        }
        const record: PlanRecord = {
          id,
          title: planTitle(body, displayContent || promptForAgent),
          path,
          worktreePath: worktree,
          createdByHarness: harnessId,
          createdByModel: tab.selectedModel,
          createdAt: Date.now(),
          sourceChatTabId: tabId,
          status: 'draft',
        };
        if (requestId) {
          pendingPlanApprovals.set(id, { tabId, requestId });
        }
        // Every captured plan lands in `draft` and waits on "Approve &
        // implement" — whether or not an agent is parked on an ExitPlanMode
        // request behind it — so it always wants the user.
        useAgentStatusStore.getState().setState(tabId, 'needs-you', {
          worktreePath: worktree,
          title: get().tabs[tabId]?.title,
          reason: 'plan',
        });
        await usePlanStore.getState().add(record);
        useCenterViewStore.getState().openPlanTab(id, record.title);
        return true;
      } catch (e) {
        capturedPlan = false;
        pendingPlanApprovals.delete(id);
        get().addMessage(tabId, {
          id: `plan-err-${Date.now()}`,
          role: 'assistant',
          content: `Failed to save the plan: ${String(e)}`,
          timestamp: Date.now(),
        });
        return false;
      }
    };

    /**
     * Record the harness's own session id for this chat so the next turn can
     * resume it. Stored per harness — switching back to a harness used earlier
     * in this chat picks its session up again.
     */
    const rememberSession = (sessionId: string) => {
      if (get().tabs[tabId]?.sessions?.[harnessId] === sessionId) return;
      set((state) => {
        const t = state.tabs[tabId];
        if (!t) return state;
        return {
          tabs: {
            ...state.tabs,
            [tabId]: {
              ...t,
              sessions: { ...t.sessions, [harnessId]: sessionId },
            },
          },
        };
      });
      void setChatSession(worktree, tabId, harnessId, sessionId).catch(() => {
        // Best-effort: an unsaved id just means the next turn starts fresh.
      });
    };

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

    // Batch token updates to one store write per animation frame so React isn't
    // re-parsing markdown on every tiny stream chunk.
    let pendingAssistantText = '';
    let flushRaf: number | null = null;

    const flushAssistant = () => {
      flushRaf = null;
      if (!pendingAssistantText) return;
      const text = pendingAssistantText;
      pendingAssistantText = '';
      get().appendToMessage(tabId, ensureAssistant(), text);
    };

    const appendAssistant = (text: string) => {
      if (!text) return;
      sawOutput = true;
      pendingAssistantText += text;
      if (flushRaf === null) {
        flushRaf = requestAnimationFrame(flushAssistant);
      }
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

    /**
     * A resume can be rejected when the harness has pruned its own session
     * store (or the id belongs to a session it no longer recognises). That
     * fails fast and silently, so retry the turn from a fresh session once,
     * carrying the transcript across so the context isn't lost.
     */
    const shouldRetryWithoutResume = (errorText?: string): boolean =>
      Boolean(errorText) &&
      runResumeId !== null &&
      !resumeRetried &&
      !sawOutput &&
      Date.now() - runStartedAt < 15_000;

    const retryWithoutResume = async () => {
      resumeRetried = true;
      const staleHarness = harnessId;
      void clearChatSession(worktree, tabId, staleHarness).catch(() => {});
      set((state) => {
        const t = state.tabs[tabId];
        if (!t) return state;
        const { [staleHarness]: _dropped, ...rest } = t.sessions;
        return { tabs: { ...state.tabs, [tabId]: { ...t, sessions: rest } } };
      });

      // Hand the previous turns over as an attachment, minus the prompt we are
      // about to send again.
      const prior =
        get().tabs[tabId]?.messages.filter((m) => m.id !== userMessage.id) ?? [];
      if (prior.length > 0) {
        try {
          const markdown = renderTranscriptMarkdown(prior, harnessId);
          const attachment = await makeTranscriptAttachment(
            transcriptAttachmentName(harnessId),
            markdown,
          );
          promptForAgent = composeAgentPrompt(agentPrompt, [attachment]);
        } catch {
          // Fall back to the bare prompt rather than dropping the turn.
        }
      }

      // Say so in the transcript — resuming silently failing and quietly
      // starting over would look like the agent had simply forgotten.
      get().addMessage(tabId, {
        id: `resume-${Date.now()}`,
        role: 'assistant',
        content:
          `Could not resume the previous ${exitLabelFor(harnessId)} session. ` +
          `Starting a new one` +
          (prior.length > 0 ? ' with the earlier transcript attached.' : '.'),
        timestamp: Date.now(),
      });

      // Reset the per-attempt stream state; the event handlers close over
      // these bindings, so reassigning is enough to start clean.
      lineBuffer = '';
      assistantId = null;
      lastAssistantSegment = '';
      pendingAssistantText = '';
      capturedPlan = false;
      trackedPlanPath = null;
      sawOutput = false;
      finished = false;
      await dispatch();
    };

    const finish = (errorText?: string) => {
      if (finished) return;
      finished = true;
      if (flushRaf !== null) {
        cancelAnimationFrame(flushRaf);
        flushAssistant();
      }
      stopCursorPlanPoll();

      if (shouldRetryWithoutResume(errorText)) {
        get().settleRunningTools(tabId);
        releaseChannelFor(harnessId, tabId);
        void retryWithoutResume();
        return;
      }

      if (errorText) {
        const id = ensureAssistant();
        const current = get().tabs[tabId]?.messages.find((m) => m.id === id);
        const existing = current?.content?.trim() ?? '';
        get().updateMessage(tabId, id, {
          content: existing ? `${existing}\n\n${errorText}` : errorText,
        });
      }
      get().settleRunningTools(tabId);
      get().setLoading(tabId, false);

      const wasCancelled = cancelledTabs.delete(tabId);
      const settleStatus = () => {
        const status = useAgentStatusStore.getState();
        if (wasCancelled) {
          status.clear(tabId);
          return;
        }
        // A plan is still waiting to be approved — that outranks "finished".
        // A pending *question*, by contrast, died with the run just above.
        if (status.statuses[tabId]?.reason === 'plan') return;
        status.setState(tabId, 'done', {
          worktreePath: worktree,
          title: get().tabs[tabId]?.title,
        });
      };
      releaseChannelFor(harnessId, tabId);
      // The agent is gone, so nothing is listening for an answer any more.
      const abandoned = useQuestionStore.getState().get(tabId);
      if (abandoned) void abandonQuestions(abandoned);
      useQuestionStore.getState().clear(tabId);
      void useChangesStore.getState().refresh();
      // Settle the transcript on disk and refresh the sidebar's chat list.
      void flushChatMessages(tabId, true);

      const willLookForPlan = planningRun && !errorText && !capturedPlan;
      // That search can still turn this run into "plan ready", so hold the
      // terminal status until it resolves — otherwise the user gets a
      // "finished" notification immediately followed by a "plan ready" one.
      if (!willLookForPlan) settleStatus();

      // Prefer THIS run's plan file only. Never scan for "some other" plan —
      // that was returning unrelated older plans from `.fold/plans/`.
      if (willLookForPlan) {
        void (async () => {
          if (trackedPlanPath) {
            const fromDisk = await loadPlanMarkdownFromDisk(
              trackedPlanPath,
              worktree,
            );
            if (fromDisk) {
              await capturePlan(fromDisk.markdown, undefined, fromDisk.path);
              return;
            }
          }
          if (harnessId === 'claudecode') {
            const unindexed = await findUnindexedPlanMarkdown();
            if (unindexed) {
              await capturePlan(unindexed.markdown, undefined, unindexed.path);
              return;
            }
          }
          if (assistantId) {
            const body = get().tabs[tabId]?.messages.find(
              (m) => m.id === assistantId,
            )?.content;
            if (body) await capturePlan(body);
          }
        })().finally(settleStatus);
      }

      // An implementation run just ended — settle the plan's status from it.
      if (implementingPlanId) {
        void usePlanStore
          .getState()
          .finishImplementation(implementingPlanId, !errorText);
      }
    };

    const upsertTool = (
      id: string,
      name: string,
      status: 'running' | 'done',
      extras?: {
        content?: string;
        detail?: string;
        toolOutput?: string;
        filePaths?: string[];
      },
    ) => {
      sawOutput = true;
      const existing = get().tabs[tabId]?.messages.find((m) => m.id === id);
      const content = extras?.content ?? name;
      if (existing) {
        if (status === 'done') {
          get().updateMessage(tabId, id, {
            toolStatus: 'done',
            content: extras?.content || existing.content,
            detail: extras?.detail || existing.detail,
            toolOutput: extras?.toolOutput || existing.toolOutput,
            filePaths: extras?.filePaths ?? existing.filePaths,
          });
        }
        return;
      }
      get().addMessage(tabId, {
        id,
        role: 'tool',
        content,
        toolName: name,
        toolStatus: status,
        detail: extras?.detail,
        toolOutput: extras?.toolOutput,
        filePaths: extras?.filePaths,
        timestamp: Date.now(),
      });
    };

    /**
     * Route a paused `canUseTool` request. `ExitPlanMode` captures the plan and
     * stays pending until the user reviews it; anything else is auto-allowed so
     * the run doesn't stall on a prompt with no UI behind it.
     */
    const handlePermissionRequest = (request: ClaudePermissionRequest) => {
      if (request.toolName === 'ExitPlanMode') {
        void (async () => {
          const markdown = String(request.input?.plan ?? '');
          const planFilePath =
            typeof request.input?.planFilePath === 'string'
              ? request.input.planFilePath
              : undefined;
          const captured = await capturePlan(
            markdown,
            request.requestId,
            trackedPlanPath ?? undefined,
            planFilePath,
          );
          // Nothing was captured — don't leave the agent hanging on a request
          // no UI will ever answer.
          if (!captured) {
            void claudeAgentRespond(tabId, {
              type: 'fold_permission_response',
              requestId: request.requestId,
              behavior: 'deny',
              message: 'Fold could not save the plan for review.',
            });
          }
        })();
        return;
      }

      if (request.toolName === 'AskUserQuestion') {
        const questions = (request.input?.questions ?? []) as Question[];
        if (questions.length > 0) {
          useQuestionStore
            .getState()
            .ask({ kind: 'claude', tabId, requestId: request.requestId }, questions);
          // Bring the chat forward so the question dialog is visible.
          useCenterViewStore.getState().setActiveTab(tabId);
          return;
        }
        // Malformed request — decline rather than pausing the run forever.
        void claudeAgentRespond(tabId, {
          type: 'fold_permission_response',
          requestId: request.requestId,
          behavior: 'deny',
          message: 'No questions were provided.',
        });
        return;
      }

      // Auto-allow plan-file writes; deny other mutating tools in plan mode so
      // the agent can't sneak edits past the review step.
      if (planningRun) {
        const name = request.toolName.toLowerCase();
        const paths = filePathsFromInput(request.input);
        const planWrite =
          /(write|edit)/.test(name) &&
          paths.length > 0 &&
          paths.every((p) => isPlanFilePath(p));
        if (planWrite) {
          for (const p of paths) {
            if (isPlanFilePath(p)) {
              trackedPlanPath = toRepoRelativePath(p, worktree);
            }
          }
          void claudeAgentRespond(tabId, {
            type: 'fold_permission_response',
            requestId: request.requestId,
            behavior: 'allow',
          });
          return;
        }
      }

      void claudeAgentRespond(tabId, {
        type: 'fold_permission_response',
        requestId: request.requestId,
        behavior: 'allow',
      });
    };

    const handleEvent = (event: StreamEvent) => {
      // Every harness announces its session id somewhere in the stream; grab it
      // before the per-harness branches so the next turn can resume.
      const sessionId = sessionIdFromEvent(harnessId, event);
      if (sessionId) rememberSession(sessionId);

      // Fold sidecar emits Claude `/context` occupancy for the status bar.
      if ((event as { type?: string }).type === 'fold_context_usage') {
        const usage = contextUsageFromClaudeEvent(event);
        if (usage) useContextUsageStore.getState().setUsage(usage);
        return;
      }

      // Fold sidecar emits Claude.ai 5h / weekly plan utilization (`/usage`).
      if ((event as { type?: string }).type === 'fold_session_usage') {
        const usage = sessionUsageFromFoldEvent(event);
        if (usage) useContextUsageStore.getState().setSessionUsage(usage);
        return;
      }

      // Permission requests from the Claude Agent SDK sidecar's canUseTool.
      if ((event as { type?: string }).type === 'fold_permission_request') {
        handlePermissionRequest(event as unknown as ClaudePermissionRequest);
        return;
      }

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

        if (harnessId === 'claudecode') {
          const usage = contextUsageFromClaudeEvent(event);
          if (usage) useContextUsageStore.getState().setUsage(usage);
        }

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

        for (const thinking of thinkingFromBlocks(blocks)) {
          const id = `thinking-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
          get().addMessage(tabId, {
            id,
            role: 'thinking',
            content: toolExcerpt('thinking', thinking),
            detail: thinking,
            toolStatus: 'done',
            timestamp: Date.now(),
          });
        }

        for (const tool of toolUsesFromBlocks(blocks)) {
          trackPlanFile(tool.name, tool.input);
          const id = `tool-${tool.id}`;
          const existing = get().tabs[tabId]?.messages.find((m) => m.id === id);
          if (existing) continue;
          const excerpt = toolExcerpt(tool.name, tool.input);
          const detail = stringifyPayload(tool.input);
          const filePaths = filePathsFromInput(tool.input);
          get().addMessage(tabId, {
            id,
            role: 'tool',
            content: excerpt,
            toolName: tool.name,
            toolStatus: 'running',
            detail: detail || undefined,
            filePaths: filePaths.length > 0 ? filePaths : undefined,
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
        const { args, result } = cursorToolPayload(cursorEvent.tool_call);
        trackPlanFile(name, args);
        const excerpt = toolExcerpt(name, args);
        const detail = stringifyPayload(args);
        const filePaths = filePathsFromInput(args);
        const output = stringifyPayload(result);

        if (cursorEvent.subtype === 'started') {
          upsertTool(id, name, 'running', {
            content: excerpt,
            detail: detail || undefined,
            filePaths: filePaths.length > 0 ? filePaths : undefined,
          });
          lastAssistantSegment = '';
        } else if (cursorEvent.subtype === 'completed') {
          upsertTool(id, name, 'done', {
            content: excerpt,
            detail: detail || undefined,
            toolOutput: output || undefined,
            filePaths: filePaths.length > 0 ? filePaths : undefined,
          });
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
              const output = stringifyPayload(block.content);
              get().updateMessage(tabId, id, {
                toolStatus: 'done',
                toolOutput: output || existing.toolOutput,
              });
            }
          }
        }
        return;
      }

      if (event.type === 'result') {
        if (harnessId === 'claudecode') {
          const usage = contextUsageFromClaudeEvent(event);
          if (usage) useContextUsageStore.getState().setUsage(usage);
        }
        const resultText = 'result' in event ? event.result : undefined;
        const isError = 'is_error' in event ? Boolean(event.is_error) : false;
        if (isError && resultText) {
          const text = String(resultText);
          appendAssistant(text);
          if (
            harnessId === 'claudecode' &&
            CLAUDE_OAUTH_EXPIRED_RE.test(text)
          ) {
            useClaudeStore.getState().markAuthInvalid(text);
          }
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
          // Soft-plan capture cancels the Cursor process on purpose once the
          // plan file is written — don't surface that as a user-facing error.
          finish(capturedPlan ? undefined : 'Agent cancelled.');
        } else if (code !== 0) {
          if (
            harnessId === 'claudecode' &&
            CLAUDE_OAUTH_EXPIRED_RE.test(lineBuffer)
          ) {
            useClaudeStore.getState().markAuthInvalid(
              'Claude Code OAuth session expired and could not be refreshed. Use Re-login in Connect Harness.',
            );
          }
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

    /**
     * Start the harness for this turn. Called again (with the resume id
     * dropped) when a resume is rejected — the event handlers close over
     * mutable state, so re-invoking is enough to run a clean attempt.
     */
    const dispatch = async (): Promise<void> => {
      runStartedAt = Date.now();
      // Resume this chat's session for the selected harness, when it has one.
      runResumeId = get().tabs[tabId]?.sessions?.[harnessId] ?? null;

      try {
        const modelInfo = findHarnessModel(
          useHarnessStore.getState().models,
          tab.selectedModel,
          harnessId,
        );
        const effortLevels = resolveEffortLevels(modelInfo);
        const selectedEffort =
          effortLevels.length > 0 && effortLevels.includes(tab.modelEffort)
            ? tab.modelEffort
            : null;
        const agentEffort = selectedEffort
          ? effortForAgentWire(harnessId, selectedEffort)
          : null;

        if (harnessId === 'cursor') {
          // Soft plan mode: Cursor's native `--mode plan` hangs in `-p` after
          // create_plan. We pre-assign a plan path, instruct the agent to write
          // there and stop, and poll until the file appears.
          let cursorPrompt = promptForAgent;
          if (planningRun) {
            const planPath = `${PLANS_DIR}/${newPlanId()}.md`;
            trackedPlanPath = planPath;
            cursorPrompt = buildCursorPlanPrompt(cursorPrompt, planPath);
            startCursorPlanPoll(planPath);
          }
          await cursorAgentRun(
            tabId,
            cursorPrompt,
            worktree,
            tab.selectedModel || null,
            agentEffort,
            planningRun,
            runResumeId,
            onEvent,
          );
        } else if (harnessId === 'codex') {
          await codexAgentRun(
            tabId,
            promptForAgent,
            worktree,
            tab.selectedModel || null,
            agentEffort,
            runResumeId,
            onEvent,
          );
        } else if (harnessId === 'opencode') {
          await opencodeAgentRun(
            tabId,
            promptForAgent,
            worktree,
            tab.selectedModel || null,
            agentEffort,
            planningRun,
            runResumeId,
            onEvent,
          );
        } else {
          const effort = agentEffort;
          const fastMode = Boolean(
            modelInfo?.supportsFastMode && tab.mode === 'fast',
          );

          await claudeAgentRun(
            tabId,
            promptForAgent,
            worktree,
            tab.selectedModel || null,
            effort,
            fastMode,
            planningRun ? 'plan' : null,
            runResumeId,
            onEvent,
          );
        }
      } catch (e) {
        finish(String(e));
      }
    };

    await dispatch();
  },

  cancelAgent: async (tabId) => {
    cancelledTabs.add(tabId);
    useAgentStatusStore.getState().clear(tabId);
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
