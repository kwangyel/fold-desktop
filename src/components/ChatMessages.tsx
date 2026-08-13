import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  IconArrowBackUp,
  IconBrain,
  IconCheck,
  IconChevronRight,
  IconCopy,
  IconFile,
  IconSearch,
  IconTerminal,
  IconTool,
  IconPencil,
  IconBook,
} from "@tabler/icons-react";
import { confirm } from "@tauri-apps/plugin-dialog";
import { isTauri } from "../lib/git";
import {
  activityKindFromToolName,
  activityLabel,
  type ActivityKind,
} from "../lib/chatActivity";
import { useChatStore, type Message } from "../store/chatStore";
import AssistantMarkdown from "./AssistantMarkdown";
import "./ChatMessages.css";

interface ChatMessagesProps {
  tabId: string;
}

type Turn = {
  user: Message | null;
  activities: Message[];
  assistants: Message[];
};

function groupTurns(messages: Message[]): Turn[] {
  const turns: Turn[] = [];
  let current: Turn = { user: null, activities: [], assistants: [] };

  const push = () => {
    if (current.user || current.activities.length || current.assistants.length) {
      turns.push(current);
    }
    current = { user: null, activities: [], assistants: [] };
  };

  for (const msg of messages) {
    if (msg.role === "user") {
      push();
      current.user = msg;
      continue;
    }
    if (msg.role === "tool" || msg.role === "thinking") {
      current.activities.push(msg);
      continue;
    }
    if (msg.role === "assistant") {
      current.assistants.push(msg);
    }
  }
  push();
  return turns;
}

function kindForMessage(msg: Message): ActivityKind {
  if (msg.role === "thinking") return "thinking";
  return activityKindFromToolName(msg.toolName ?? msg.content);
}

function ActivityIcon({ kind }: { kind: ActivityKind }) {
  const props = { size: 14, stroke: 1.75 } as const;
  switch (kind) {
    case "thinking":
      return <IconBrain {...props} />;
    case "search":
      return <IconSearch {...props} />;
    case "read":
      return <IconBook {...props} />;
    case "write":
      return <IconPencil {...props} />;
    case "shell":
      return <IconTerminal {...props} />;
    default:
      return <IconTool {...props} />;
  }
}

function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);

  const onCopy = async () => {
    if (!text.trim()) return;
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    } catch {
      // Clipboard may be unavailable in some environments.
    }
  };

  return (
    <button
      type="button"
      className="chat-copy-btn"
      onClick={() => void onCopy()}
      title={copied ? "Copied" : "Copy"}
      aria-label={copied ? "Copied" : "Copy message"}
    >
      {copied ? <IconCheck size={14} stroke={2} /> : <IconCopy size={14} stroke={1.75} />}
    </button>
  );
}

function ActivityAccordion({ msg }: { msg: Message }) {
  const [open, setOpen] = useState(false);
  const kind = kindForMessage(msg);
  const hasDetail = Boolean(
    (msg.detail && msg.detail.trim()) ||
      (msg.toolOutput && msg.toolOutput.trim()),
  );
  const running = msg.toolStatus === "running";

  return (
    <div className={`activity-row kind-${kind}${running ? " running" : ""}`}>
      <button
        type="button"
        className="activity-header"
        aria-expanded={open}
        disabled={!hasDetail}
        onClick={() => hasDetail && setOpen((v) => !v)}
      >
        <span className={`activity-chevron${open ? " open" : ""}${!hasDetail ? " hidden" : ""}`}>
          <IconChevronRight size={12} stroke={2} />
        </span>
        <span className="activity-icon">
          <ActivityIcon kind={kind} />
        </span>
        <span className="activity-summary">
          {msg.content || msg.toolName || kind}
        </span>
        {running ? <span className="activity-status">running…</span> : null}
      </button>
      {open && hasDetail ? (
        <div className="activity-body">
          {msg.detail?.trim() ? (
            <pre className="activity-pre">{msg.detail}</pre>
          ) : null}
          {msg.toolOutput?.trim() ? (
            <>
              {msg.detail?.trim() ? (
                <div className="activity-output-label">Output</div>
              ) : null}
              <pre className="activity-pre output">{msg.toolOutput}</pre>
            </>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

function SummaryAccordion({ activities }: { activities: Message[] }) {
  const [open, setOpen] = useState(false);

  const counts = useMemo(() => {
    const map = new Map<ActivityKind, number>();
    for (const msg of activities) {
      const kind = kindForMessage(msg);
      map.set(kind, (map.get(kind) ?? 0) + 1);
    }
    return map;
  }, [activities]);

  const parts: string[] = [];
  const order: ActivityKind[] = [
    "thinking",
    "search",
    "read",
    "write",
    "shell",
    "tool",
  ];
  for (const kind of order) {
    const n = counts.get(kind);
    if (n) parts.push(activityLabel(kind, n));
  }
  if (activities.length > 0) {
    parts.unshift(
      `${activities.length} step${activities.length === 1 ? "" : "s"}`,
    );
  }

  return (
    <div className="activity-summary-block">
      <button
        type="button"
        className="activity-summary-header"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        <span className={`activity-chevron${open ? " open" : ""}`}>
          <IconChevronRight size={12} stroke={2} />
        </span>
        <span className="activity-summary-text">{parts.join(" · ")}</span>
      </button>
      {open ? (
        <div className="activity-summary-body">
          {activities.map((msg) => (
            <ActivityAccordion key={msg.id} msg={msg} />
          ))}
        </div>
      ) : null}
    </div>
  );
}

const FILE_PREVIEW_LIMIT = 3;

function ChangedFilesLine({ paths }: { paths: string[] }) {
  const [showAll, setShowAll] = useState(false);
  if (paths.length === 0) return null;

  const visible = showAll ? paths : paths.slice(0, FILE_PREVIEW_LIMIT);
  const remaining = paths.length - visible.length;

  return (
    <div className="changed-files-line">
      <IconFile size={13} stroke={1.75} className="changed-files-icon" />
      <span className="changed-files-list">
        {visible.map((path, i) => (
          <span key={path}>
            {i > 0 ? <span className="changed-files-sep">, </span> : null}
            <span className="changed-files-name" title={path}>
              {path.split("/").pop() ?? path}
            </span>
          </span>
        ))}
        {!showAll && remaining > 0 ? (
          <>
            <span className="changed-files-sep">, </span>
            <button
              type="button"
              className="changed-files-more"
              onClick={() => setShowAll(true)}
            >
              show more (+{remaining})
            </button>
          </>
        ) : null}
        {showAll && paths.length > FILE_PREVIEW_LIMIT ? (
          <>
            <span className="changed-files-sep"> · </span>
            <button
              type="button"
              className="changed-files-more"
              onClick={() => setShowAll(false)}
            >
              show less
            </button>
          </>
        ) : null}
      </span>
    </div>
  );
}

function collectTurnFiles(activities: Message[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const msg of activities) {
    if (kindForMessage(msg) !== "write") continue;
    for (const p of msg.filePaths ?? []) {
      if (!seen.has(p)) {
        seen.add(p);
        out.push(p);
      }
    }
  }
  return out;
}

function assistantCopyText(assistants: Message[]): string {
  return assistants
    .map((m) => m.content.trim())
    .filter(Boolean)
    .join("\n\n");
}

/** Same messages in the same order? Message objects are only replaced when
 *  their content changes, so reference equality is enough. */
function sameMessages(a: Message[], b: Message[]): boolean {
  if (a === b) return true;
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

/**
 * One user prompt and everything the agent did in response.
 *
 * Memoized on message identity: streaming appends to the *last* turn only, so
 * earlier turns skip re-rendering entirely instead of re-reconciling (and
 * re-rendering their markdown) on every token.
 */
const ChatTurn = memo(
  function ChatTurn({
    tabId,
    turn,
    streaming,
    canRestore,
  }: {
    tabId: string;
    turn: Turn;
    streaming: boolean;
    canRestore: boolean;
  }) {
    const files = collectTurnFiles(turn.activities);
    const copyText = assistantCopyText(turn.assistants);
    const showAssistantCopy = !streaming && Boolean(copyText.trim());
    const [restoring, setRestoring] = useState(false);

    const onRestore = async () => {
      const userId = turn.user?.id;
      if (!userId || restoring) return;
      const message =
        "Restore files to how they were before this turn? Later chat messages will be removed.";
      const ok = isTauri()
        ? await confirm(message, {
            title: "Restore checkpoint",
            kind: "warning",
          })
        : window.confirm(message);
      if (!ok) return;
      setRestoring(true);
      try {
        await useChatStore.getState().rollbackTurn(tabId, userId);
      } catch (e) {
        window.alert(
          e instanceof Error ? e.message : "Failed to restore checkpoint.",
        );
      } finally {
        setRestoring(false);
      }
    };

    return (
      <div className="chat-turn">
        {turn.user ? (
          <div className="message user">
            <div className="message-content">
              {turn.user.content ? (
                <p className="message-text">{turn.user.content}</p>
              ) : turn.user.attachments && turn.user.attachments.length > 0 ? null : (
                <p className="message-text text-muted">…</p>
              )}
              {turn.user.attachments && turn.user.attachments.length > 0 ? (
                <div className="attachments">
                  {turn.user.attachments.map((att) => (
                    <div key={att.id} className="attachment-item">
                      {att.kind === 'image' && att.dataUrl ? (
                        <img
                          className="attachment-item-thumb"
                          src={att.dataUrl}
                          alt=""
                        />
                      ) : null}
                      <span className="attachment-item-name">{att.name}</span>
                    </div>
                  ))}
                </div>
              ) : null}
              <div className="message-actions">
                <CopyButton text={turn.user.content} />
              </div>
            </div>
          </div>
        ) : null}

        {streaming && turn.activities.length > 0 ? (
          <div className="activity-stream">
            {turn.activities.map((msg) => (
              <ActivityAccordion key={msg.id} msg={msg} />
            ))}
          </div>
        ) : null}

        {!streaming && turn.activities.length > 0 ? (
          <SummaryAccordion activities={turn.activities} />
        ) : null}

        {turn.assistants.map((msg) =>
          msg.content ? (
            <div key={msg.id} className="message assistant">
              <div className="message-content">
                <AssistantMarkdown content={msg.content} />
              </div>
            </div>
          ) : null,
        )}

        {files.length > 0 && !streaming ? (
          <ChangedFilesLine paths={files} />
        ) : null}

        {showAssistantCopy || canRestore ? (
          <div className="turn-actions assistant">
            {canRestore ? (
              <button
                type="button"
                className="chat-restore-btn"
                onClick={() => void onRestore()}
                disabled={restoring}
                title="Restore checkpoint"
                aria-label="Restore checkpoint"
              >
                <IconArrowBackUp size={14} stroke={1.75} />
                <span>{restoring ? "Restoring…" : "Restore"}</span>
              </button>
            ) : null}
            {showAssistantCopy ? <CopyButton text={copyText} /> : null}
          </div>
        ) : null}
      </div>
    );
  },
  (prev, next) =>
    prev.streaming === next.streaming &&
    prev.canRestore === next.canRestore &&
    prev.tabId === next.tabId &&
    prev.turn.user === next.turn.user &&
    sameMessages(prev.turn.activities, next.turn.activities) &&
    sameMessages(prev.turn.assistants, next.turn.assistants),
);

/** Treat the view as "following" the stream while within this many px of the end. */
const FOLLOW_THRESHOLD_PX = 80;

export default function ChatMessages({ tabId }: ChatMessagesProps) {
  const tab = useChatStore((state) => state.tabs[tabId]);
  const containerRef = useRef<HTMLDivElement>(null);
  // Stop yanking the view back down once the user scrolls up to read.
  const followRef = useRef(true);
  const scrollRafRef = useRef<number | null>(null);

  const onScroll = useCallback(() => {
    const el = containerRef.current;
    if (!el) return;
    const distance = el.scrollHeight - el.scrollTop - el.clientHeight;
    followRef.current = distance <= FOLLOW_THRESHOLD_PX;
  }, []);

  const messages = tab?.messages;
  const loading = tab?.loading;

  useEffect(() => {
    // Sending a prompt always brings the view back down, even if the user had
    // scrolled up to read earlier output.
    const last = messages?.[messages.length - 1];
    if (last?.role === "user") followRef.current = true;

    if (!followRef.current) return;
    // Coalesce to one scroll write per frame: assigning scrollTop (rather than
    // scrollIntoView) avoids a forced synchronous layout per streamed token.
    if (scrollRafRef.current !== null) return;
    scrollRafRef.current = requestAnimationFrame(() => {
      scrollRafRef.current = null;
      const el = containerRef.current;
      if (el) el.scrollTop = el.scrollHeight;
    });
  }, [messages, loading]);

  useEffect(
    () => () => {
      if (scrollRafRef.current !== null) {
        cancelAnimationFrame(scrollRafRef.current);
      }
    },
    [],
  );

  const turns = useMemo(() => groupTurns(messages ?? []), [messages]);

  if (!tab) {
    return <div className="chat-messages">Loading...</div>;
  }

  const lastTurnIndex = turns.length - 1;

  return (
    <div className="chat-messages" ref={containerRef} onScroll={onScroll}>
      {tab.messages.length === 0 ? (
        <div className="chat-empty">
          <p>Start a conversation</p>
          <p className="text-muted">Type a message below to begin</p>
        </div>
      ) : (
        turns.map((turn, turnIndex) => {
          const userId = turn.user?.id;
          const userIdx = userId
            ? (messages?.findIndex((m) => m.id === userId) ?? -1)
            : -1;
          const hasLater =
            userIdx >= 0 && userIdx < (messages?.length ?? 0) - 1;
          const canRestore =
            Boolean(turn.user?.checkpointSha) &&
            !(tab.loading && turnIndex === lastTurnIndex) &&
            hasLater;

          return (
            <ChatTurn
              key={turn.user?.id ?? `turn-${turnIndex}`}
              tabId={tabId}
              turn={turn}
              streaming={Boolean(tab.loading) && turnIndex === lastTurnIndex}
              canRestore={canRestore}
            />
          );
        })
      )}
      {tab.loading && (
        <div className="message assistant">
          <div className="message-content loading-bubble">
            <p className="loading-indicator">
              <span>●</span>
              <span>●</span>
              <span>●</span>
            </p>
          </div>
        </div>
      )}
    </div>
  );
}
