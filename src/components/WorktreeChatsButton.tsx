import { useEffect, useState } from "react";
import {
  IconMessage,
  IconMessages,
  IconPencil,
  IconTrash,
} from "@tabler/icons-react";
import { confirm } from "@tauri-apps/plugin-dialog";
import { isTauri } from "../lib/git";
import { deleteChatEverywhere, openChatTab } from "../lib/chatTabs";
import { useCenterViewStore } from "../store/centerViewStore";
import { useChatSessionStore } from "../store/chatSessionStore";
import { useProjectStore } from "../store/projectStore";
import { ChatStatusDot } from "./AgentStatusDot";
import "./WorktreeChatsButton.css";

type ChatMenu = {
  chatId: string;
  title: string;
  x: number;
  y: number;
};

async function confirmDelete(message: string, title: string): Promise<boolean> {
  if (isTauri()) {
    return confirm(message, { title, kind: "warning" });
  }
  return window.confirm(message);
}

/**
 * Icon on the center tab bar that lists persisted chats for the active worktree.
 */
export default function WorktreeChatsButton() {
  const worktreePath = useProjectStore((s) => s.activePath);
  const chats = useChatSessionStore((s) =>
    worktreePath ? s.byWorktree[worktreePath] : undefined,
  );
  const activeTabId = useCenterViewStore((s) => s.activeTabId);

  const [open, setOpen] = useState(false);
  const [menu, setMenu] = useState<ChatMenu | null>(null);
  const [renamingChatId, setRenamingChatId] = useState<string | null>(null);
  const [dropdownPos, setDropdownPos] = useState<{
    top: number;
    right: number;
  } | null>(null);

  const count = chats?.length ?? 0;

  useEffect(() => {
    setOpen(false);
    setMenu(null);
    setRenamingChatId(null);
  }, [worktreePath]);

  useEffect(() => {
    if (!open && !menu) return;
    const close = () => {
      setOpen(false);
      setMenu(null);
      setRenamingChatId(null);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        if (renamingChatId) {
          setRenamingChatId(null);
          return;
        }
        close();
      }
    };
    window.addEventListener("click", close);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("click", close);
      window.removeEventListener("keydown", onKey);
    };
  }, [open, menu, renamingChatId]);

  if (!worktreePath) return null;

  return (
    <div className="worktree-chats-wrap">
      <button
        type="button"
        className={`worktree-chats-btn ${open ? "open" : ""}`}
        aria-label={count > 0 ? `Chats (${count})` : "Chats"}
        aria-expanded={open}
        title="Chats"
        onClick={(e) => {
          e.stopPropagation();
          const next = !open;
          setOpen(next);
          setMenu(null);
          setRenamingChatId(null);
          if (next) {
            const rect = e.currentTarget.getBoundingClientRect();
            setDropdownPos({
              top: rect.bottom + 4,
              right: window.innerWidth - rect.right,
            });
            void useChatSessionStore.getState().refresh(worktreePath);
          }
        }}
      >
        <IconMessages size={16} stroke={1.75} />
      </button>

      {open && (
        <div
          className="worktree-chats-dropdown"
          style={dropdownPos ?? undefined}
          onClick={(e) => e.stopPropagation()}
        >
          {count === 0 ? (
            <div className="worktree-chats-empty">No saved chats yet.</div>
          ) : (
            <div className="worktree-chats-list">
              {chats?.map((chat) => (
                <div
                  key={chat.id}
                  className={`worktree-chats-row ${activeTabId === chat.id ? "active" : ""}`}
                  title={chat.title}
                  onClick={() => {
                    if (renamingChatId === chat.id) return;
                    setOpen(false);
                    void openChatTab(chat.id, worktreePath, chat.title);
                  }}
                  onContextMenu={(e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    setMenu({
                      chatId: chat.id,
                      title: chat.title,
                      x: e.clientX,
                      y: e.clientY,
                    });
                  }}
                >
                  <IconMessage size={13} stroke={1.75} className="worktree-chats-icon" />
                  {renamingChatId === chat.id ? (
                    <input
                      className="worktree-chats-rename"
                      defaultValue={chat.title}
                      autoFocus
                      onClick={(e) => e.stopPropagation()}
                      onBlur={() => setRenamingChatId(null)}
                      onKeyDown={(e) => {
                        if (e.key === "Escape") {
                          setRenamingChatId(null);
                          return;
                        }
                        if (e.key !== "Enter") return;
                        const next = e.currentTarget.value.trim();
                        if (next && next !== chat.title) {
                          void useChatSessionStore
                            .getState()
                            .rename(worktreePath, chat.id, next);
                          useCenterViewStore.getState().renameTab(chat.id, next);
                        }
                        setRenamingChatId(null);
                      }}
                    />
                  ) : (
                    <span className="worktree-chats-title">{chat.title}</span>
                  )}
                  <ChatStatusDot chatId={chat.id} />
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {menu && (
        <div
          className="context-menu"
          style={{ top: menu.y, left: menu.x }}
          onClick={(e) => e.stopPropagation()}
        >
          <button
            className="context-menu-item"
            type="button"
            onClick={() => {
              setRenamingChatId(menu.chatId);
              setMenu(null);
            }}
          >
            <IconPencil size={14} stroke={1.75} />
            Rename chat
          </button>
          <button
            className="context-menu-item danger"
            type="button"
            onClick={() => {
              const { chatId, title } = menu;
              setMenu(null);
              setOpen(false);
              void (async () => {
                const ok = await confirmDelete(
                  `Delete chat "${title}"? Its transcript cannot be recovered.`,
                  "Delete chat",
                );
                if (ok) await deleteChatEverywhere(worktreePath, chatId);
              })();
            }}
          >
            <IconTrash size={14} stroke={1.75} />
            Delete chat
          </button>
        </div>
      )}
    </div>
  );
}
