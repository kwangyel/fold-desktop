import { useEffect, useMemo } from "react";
import { useShallow } from "zustand/react/shallow";
import { IconBrain, IconChecklist, IconMessage } from "@tabler/icons-react";
import { useChatStore } from "../store/chatStore";
import { useChatSessionStore } from "../store/chatSessionStore";
import { useProjectStore } from "../store/projectStore";
import { usePlanStore } from "../store/planStore";
import { extractHandoffSummary, handoffChipName } from "../lib/handoff";
import {
  attachmentPresenceKey,
  buildHandoffAttachment,
  buildPlanAttachment,
  buildTranscriptAttachment,
  gatherWorktreeContext,
  itemPresenceKey,
  transcriptChipName,
  type WorktreeContextItem,
} from "../lib/worktreeContext";
import "./ChatContextPanel.css";

interface ChatContextPanelProps {
  tabId: string;
}

/**
 * Borderless panel overlaid at the top of a fresh chat. Surfaces the transcripts
 * of other chats in the same worktree so their history can be carried over with
 * a click. It renders only while the chat has no messages yet and vanishes the
 * moment the first prompt is sent — so it reads as part of the empty chat rather
 * than a separate widget (KIN-31).
 */
export default function ChatContextPanel({ tabId }: ChatContextPanelProps) {
  const tab = useChatStore(
    useShallow((s) => {
      const t = s.tabs[tabId];
      if (!t) return null;
      return {
        messagesLength: t.messages.length,
        worktreePath: t.worktreePath,
        attachments: t.attachments,
      };
    }),
  );
  const activePath = useProjectStore((s) => s.activePath);
  const worktreePath = tab?.worktreePath ?? activePath ?? null;

  const summaries = useChatSessionStore((s) =>
    worktreePath ? s.byWorktree[worktreePath] : undefined,
  );

  // The plan index is loaded for the *active* worktree, so only trust it when
  // this chat belongs to that worktree (always true for a new chat).
  const plansAvailable = !!worktreePath && worktreePath === activePath;
  const plans = usePlanStore((s) => s.plans);

  const messagesLength = tab?.messagesLength ?? 0;

  // Keep the per-worktree chat index and plan index fresh so the panel reflects
  // siblings and plans created while this draft was open.
  useEffect(() => {
    if (worktreePath) void useChatSessionStore.getState().refresh(worktreePath);
  }, [worktreePath]);
  useEffect(() => {
    if (plansAvailable) void usePlanStore.getState().refresh();
  }, [plansAvailable]);

  // Siblings whose live tab already has a Smart Handoff summary. Read via
  // getState so this panel doesn't subscribe to every token of every chat.
  const handoffSourceIds = useMemo(() => {
    const ids = new Set<string>();
    const tabs = useChatStore.getState().tabs;
    for (const summary of summaries ?? []) {
      if (summary.id === tabId) continue;
      const messages = tabs[summary.id]?.messages;
      if (messages && extractHandoffSummary(messages)) ids.add(summary.id);
    }
    return ids;
    // Attachments changing (chip removed) is when we need a fresh look.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tabId, summaries, tab?.attachments]);

  const items = useMemo<WorktreeContextItem[]>(
    () =>
      gatherWorktreeContext(
        tabId,
        summaries ?? [],
        plansAvailable ? plans : [],
        handoffSourceIds,
      ),
    [tabId, summaries, plansAvailable, plans, handoffSourceIds],
  );

  // Items already on the composer, keyed by identity (not id). Deriving this
  // from live attachments — rather than a one-way "added" set — means removing a
  // chip re-offers it in the panel.
  const presentKeys = useMemo(
    () =>
      new Set(
        (tab?.attachments ?? [])
          .filter(
            (a) =>
              a.kind === "transcript" ||
              a.kind === "prompt" ||
              a.kind === "handoff",
          )
          .map(attachmentPresenceKey),
      ),
    [tab?.attachments],
  );

  const handleAdd = async (item: WorktreeContextItem) => {
    const att =
      item.kind === "handoff"
        ? await buildHandoffAttachment(
            worktreePath!,
            item.sourceChatId,
            item.harness,
            handoffChipName(item.sourceChatTitle),
          )
        : item.kind === "transcript"
          ? await buildTranscriptAttachment(
              worktreePath!,
              item.sourceChatId,
              item.harness,
              transcriptChipName(item.sourceChatTitle),
            )
          : await buildPlanAttachment(item.plan);
    if (!att) return;
    useChatStore.getState().addAttachment(tabId, att);
  };

  if (messagesLength !== 0 || !worktreePath) return null;

  const visible = items.filter((it) => !presentKeys.has(itemPresenceKey(it)));
  if (visible.length === 0) return null;

  return (
    <div className="chat-context-panel">
      <div className="chat-context-hint">Add from this worktree</div>
      <div className="chat-context-items">
        {visible.map((item) => {
          const isPlan = item.kind === "plan";
          const isHandoff = item.kind === "handoff";
          const label = isPlan ? item.plan.title : item.sourceChatTitle;
          const title = isPlan
            ? `Plan — ${label}`
            : isHandoff
              ? `Handoff — from ${label}`
              : `Transcript — from ${label}`;
          return (
            <button
              key={item.key}
              type="button"
              className={`chat-context-item${isHandoff ? " handoff" : ""}`}
              onClick={() => void handleAdd(item)}
              title={title}
            >
              <span className="chat-context-item-icon">
                {isPlan ? (
                  <IconChecklist size={14} stroke={2} />
                ) : isHandoff ? (
                  <IconBrain size={14} stroke={2} />
                ) : (
                  <IconMessage size={14} stroke={2} />
                )}
              </span>
              <span className="chat-context-item-name">{label}</span>
            </button>
          );
        })}
      </div>
    </div>
  );
}
