import { useEffect, useMemo } from "react";
import { useShallow } from "zustand/react/shallow";
import { IconChecklist, IconMessage } from "@tabler/icons-react";
import { useChatStore } from "../store/chatStore";
import { useChatSessionStore } from "../store/chatSessionStore";
import { useProjectStore } from "../store/projectStore";
import { usePlanStore } from "../store/planStore";
import {
  attachmentPresenceKey,
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

  const items = useMemo<WorktreeContextItem[]>(
    () =>
      gatherWorktreeContext(
        tabId,
        summaries ?? [],
        plansAvailable ? plans : [],
      ),
    [tabId, summaries, plansAvailable, plans],
  );

  // Items already on the composer, keyed by identity (not id). Deriving this
  // from live attachments — rather than a one-way "added" set — means removing a
  // chip re-offers it in the panel.
  const presentKeys = useMemo(
    () =>
      new Set(
        (tab?.attachments ?? [])
          .filter((a) => a.kind === "transcript" || a.kind === "prompt")
          .map(attachmentPresenceKey),
      ),
    [tab?.attachments],
  );

  const handleAdd = async (item: WorktreeContextItem) => {
    const att =
      item.kind === "transcript"
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
          const label = isPlan ? item.plan.title : item.sourceChatTitle;
          return (
            <button
              key={item.key}
              type="button"
              className="chat-context-item"
              onClick={() => void handleAdd(item)}
              title={isPlan ? `Plan — ${label}` : `Transcript — from ${label}`}
            >
              <span className="chat-context-item-icon">
                {isPlan ? (
                  <IconChecklist size={14} stroke={2} />
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
