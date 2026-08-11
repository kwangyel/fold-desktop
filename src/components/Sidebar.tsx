import { lazy, Suspense, useCallback, useEffect, useRef, useState } from "react";
import {
  IconFolderPlus,
  IconFolderOpen,
  IconTrash,
  IconArchive,
  IconPlus,
  IconGitBranch,
  IconGitPullRequest,
  IconPlug,
  IconRobot,
  IconChevronRight,
  IconMessage,
  IconPencil,
  IconTerminal2,
} from "@tabler/icons-react";
import { confirm } from "@tauri-apps/plugin-dialog";
import { useProjectStore } from "../store/projectStore";
import { useCenterViewStore } from "../store/centerViewStore";
import { useChatSessionStore } from "../store/chatSessionStore";
import { deleteChatEverywhere, openChatTab } from "../lib/chatTabs";
import { isTauri } from "../lib/git";
import ProjectDialog from "./ProjectDialog";
import CreateWorktreeDialog from "./CreateWorktreeDialog";
import ConnectAppDialog from "./ConnectAppDialog";
import SetupScriptDialog from "./SetupScriptDialog";
import UserMenu from "./UserMenu";
import ProjectGithubAvatar from "./ProjectGithubAvatar";
import ResizeHandle from "./ResizeHandle";
import { ChatStatusDot, WorktreeStatusDot } from "./AgentStatusDot";

const ConnectHarnessDialog = lazy(() => import("./ConnectHarnessDialog"));

type DialogMode = "create" | "open" | "connect" | "harness" | null;
type ContextMenu =
  | { kind: "project"; id: string; name: string; x: number; y: number }
  | {
      kind: "worktree";
      projectId: string;
      worktreeId: string;
      name: string;
      archived: boolean;
      x: number;
      y: number;
    }
  | {
      kind: "chat";
      worktreePath: string;
      chatId: string;
      title: string;
      x: number;
      y: number;
    };

/**
 * Saved chats for one worktree, collapsed by default.
 *
 * The list itself is loaded eagerly with the project (see
 * `projectStore.refreshChatIndex`) so the count is available without
 * expanding; only chats that have actually been sent a prompt appear here.
 */
function WorktreeChats({
  projectId,
  worktreeId,
  worktreePath,
  onOpenMenu,
  renamingChatId,
  onRenameDone,
}: {
  projectId: string;
  worktreeId: string;
  worktreePath: string;
  onOpenMenu: (menu: ContextMenu) => void;
  /** Chat currently being retitled inline, if it belongs to this worktree. */
  renamingChatId: string | null;
  onRenameDone: () => void;
}) {
  const [open, setOpen] = useState(false);
  const chats = useChatSessionStore((s) => s.byWorktree[worktreePath]);
  const activeTabId = useCenterViewStore((s) => s.activeTabId);
  const selectWorktree = useProjectStore((s) => s.selectWorktree);

  const count = chats?.length ?? 0;
  // Keep the section visible while a rename is in flight even if it collapsed.
  const isRenamingHere = Boolean(
    renamingChatId && chats?.some((c) => c.id === renamingChatId),
  );
  useEffect(() => {
    if (isRenamingHere) setOpen(true);
  }, [isRenamingHere]);

  if (count === 0 && !open) return null;

  return (
    <div className="chats-group">
      <button
        type="button"
        className="chats-toggle"
        aria-expanded={open}
        onClick={(e) => {
          e.stopPropagation();
          setOpen((v) => !v);
          // Pick up chats written since the project was loaded.
          void useChatSessionStore.getState().refresh(worktreePath);
        }}
      >
        <span className={`chats-chevron ${open ? "open" : ""}`}>
          <IconChevronRight size={12} stroke={2} />
        </span>
        Chats
        <span className="chats-count">{count}</span>
      </button>

      {open &&
        (count === 0 ? (
          <div className="chat-list-empty">No saved chats yet.</div>
        ) : (
          <div className="chat-list">
            {chats?.map((chat) => (
              <div
                key={chat.id}
                className={`chat-row ${activeTabId === chat.id ? "active" : ""}`}
                title={chat.title}
                onClick={(e) => {
                  e.stopPropagation();
                  void (async () => {
                    // Opening a chat implies working in its worktree.
                    await selectWorktree(projectId, worktreeId);
                    await openChatTab(chat.id, worktreePath, chat.title);
                  })();
                }}
                onContextMenu={(e) => {
                  e.preventDefault();
                  e.stopPropagation();
                  onOpenMenu({
                    kind: "chat",
                    worktreePath,
                    chatId: chat.id,
                    title: chat.title,
                    x: e.clientX,
                    y: e.clientY,
                  });
                }}
              >
                <IconMessage size={12} stroke={1.75} className="chat-icon" />
                {renamingChatId === chat.id ? (
                  <input
                    className="chat-rename-input"
                    defaultValue={chat.title}
                    autoFocus
                    onClick={(e) => e.stopPropagation()}
                    onBlur={onRenameDone}
                    onKeyDown={(e) => {
                      if (e.key === "Escape") {
                        onRenameDone();
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
                      onRenameDone();
                    }}
                  />
                ) : (
                  <span className="chat-title">{chat.title}</span>
                )}
                <ChatStatusDot chatId={chat.id} />
              </div>
            ))}
          </div>
        ))}
    </div>
  );
}

/** Native confirm dialog in Tauri, browser confirm otherwise. */
async function confirmDelete(message: string, title: string): Promise<boolean> {
  if (isTauri()) {
    return confirm(message, { title, kind: "warning" });
  }
  return window.confirm(message);
}

type Props = {
  width?: number;
  topRatio?: number;
  onSplitDrag?: (dy: number, bodyHeight: number) => void;
};

export default function Sidebar({ width, topRatio = 0.38, onSplitDrag }: Props) {
  const projects = useProjectStore((s) => s.projects);
  const bodyRef = useRef<HTMLDivElement>(null);
  const activeId = useProjectStore((s) => s.activeId);
  const error = useProjectStore((s) => s.error);
  const load = useProjectStore((s) => s.load);
  const select = useProjectStore((s) => s.select);
  const selectWorktree = useProjectStore((s) => s.selectWorktree);
  const remove = useProjectStore((s) => s.remove);
  const removeWorktree = useProjectStore((s) => s.removeWorktree);
  const archiveWorktree = useProjectStore((s) => s.archiveWorktree);

  const [dialog, setDialog] = useState<DialogMode>(null);
  const [worktreeProjectId, setWorktreeProjectId] = useState<string | null>(null);
  const [setupProject, setSetupProject] = useState<{
    id: string;
    name: string;
  } | null>(null);
  const [menu, setMenu] = useState<ContextMenu | null>(null);
  const [renamingChatId, setRenamingChatId] = useState<string | null>(null);

  useEffect(() => {
    load();
  }, [load]);

  // Dismiss the context menu on any outside interaction.
  useEffect(() => {
    if (!menu) return;
    const close = () => setMenu(null);
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setMenu(null);
    };
    window.addEventListener("click", close);
    window.addEventListener("scroll", close, true);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("click", close);
      window.removeEventListener("scroll", close, true);
      window.removeEventListener("keydown", onKey);
    };
  }, [menu]);

  const handleSplitDrag = useCallback(
    (dy: number) => {
      const height = bodyRef.current?.clientHeight ?? 0;
      if (height <= 0 || !onSplitDrag) return;
      onSplitDrag(dy, height);
    },
    [onSplitDrag],
  );

  return (
    <aside className="sidebar" style={width != null ? { width } : undefined}>
      <UserMenu />
      <div className="sidebar-body" ref={bodyRef}>
        <div className="new-project" style={{ flex: `${topRatio} 1 0` }}>
          <div className="section-header">
            <span>Projects</span>
          </div>
          <div className="project-actions">
            <button className="primary-btn" onClick={() => setDialog("create")}>
              <IconFolderPlus size={15} stroke={2} />
              Create Project
            </button>
            <button className="ghost-btn full" onClick={() => setDialog("open")}>
              <IconFolderOpen size={15} stroke={2} />
              Open Existing
            </button>
            <div className="project-actions-row">
              <button className="ghost-btn" onClick={() => setDialog("connect")}>
                <IconPlug size={15} stroke={2} />
                Apps
              </button>
              <button className="ghost-btn" onClick={() => setDialog("harness")}>
                <IconRobot size={15} stroke={2} />
                Harnesses
              </button>
            </div>
          </div>
        </div>

        <ResizeHandle orientation="horizontal" onDrag={handleSplitDrag} />

        <div className="projects" style={{ flex: `${1 - topRatio} 1 0` }}>
        {projects.length === 0 ? (
          <div className="projects-empty">
            No projects yet. Create or open one to get started.
          </div>
        ) : (
          projects.map((p) => {
            const isActiveProject = activeId === p.id;
            const activeWtId = isActiveProject ? p.activeWorktreeId : null;
            // Archived worktrees are hidden here (shown in a separate section).
            const activeWorktrees = p.worktrees.filter((w) => !w.archived);
            return (
              <div key={p.id} className="project-group">
                <div
                  className={`project-row ${isActiveProject && !activeWorktrees.length ? "active" : ""} ${isActiveProject ? "project-selected" : ""}`}
                  onClick={() => select(p.id)}
                  onContextMenu={(e) => {
                    e.preventDefault();
                    setMenu({
                      kind: "project",
                      id: p.id,
                      name: p.name,
                      x: e.clientX,
                      y: e.clientY,
                    });
                  }}
                  title={p.path}
                >
                  <ProjectGithubAvatar path={p.path} active={isActiveProject} />
                  <div className="meta">
                    <div className="name">{p.name}</div>
                    {activeWorktrees.length > 0 && (
                      <div className="sub">
                        {activeWorktrees.length} worktree
                        {activeWorktrees.length === 1 ? "" : "s"}
                      </div>
                    )}
                  </div>
                  <button
                    className="icon-btn project-plus"
                    type="button"
                    title="New worktree"
                    onClick={(e) => {
                      e.stopPropagation();
                      setWorktreeProjectId(p.id);
                    }}
                  >
                    <IconPlus size={14} stroke={2} />
                  </button>
                </div>

                {activeWorktrees.length > 0 && (
                  <div className="worktree-list">
                    {activeWorktrees.map((wt) => {
                      const isActive = isActiveProject && activeWtId === wt.id;
                      return (
                        <div key={wt.id}>
                          <div
                            className={`worktree-row ${isActive ? "active" : ""}`}
                            onClick={() => void selectWorktree(p.id, wt.id)}
                            onContextMenu={(e) => {
                              e.preventDefault();
                              e.stopPropagation();
                              setMenu({
                                kind: "worktree",
                                projectId: p.id,
                                worktreeId: wt.id,
                                name: wt.name,
                                archived: false,
                                x: e.clientX,
                                y: e.clientY,
                              });
                            }}
                            title={wt.path}
                          >
                            <IconGitBranch
                              size={13}
                              stroke={1.75}
                              className="worktree-icon"
                            />
                            <div className="meta">
                              <div className="name">{wt.name}</div>
                              <div className="sub">{wt.branch}</div>
                            </div>
                            <WorktreeStatusDot worktreePath={wt.path} />
                          </div>
                          <WorktreeChats
                            projectId={p.id}
                            worktreeId={wt.id}
                            worktreePath={wt.path}
                            onOpenMenu={setMenu}
                            renamingChatId={renamingChatId}
                            onRenameDone={() => setRenamingChatId(null)}
                          />
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            );
          })
        )}
        {error && <div className="projects-error">{error}</div>}
      </div>
      </div>

      {menu && (
        <div
          className="context-menu"
          style={{ top: menu.y, left: menu.x }}
          onClick={(e) => e.stopPropagation()}
        >
          {menu.kind === "project" ? (
            <>
              <button
                className="context-menu-item"
                onClick={() => {
                  setSetupProject({ id: menu.id, name: menu.name });
                  setMenu(null);
                }}
              >
                <IconTerminal2 size={14} stroke={1.75} />
                Setup script…
              </button>
              <button
                className="context-menu-item danger"
                onClick={() => {
                  remove(menu.id);
                  setMenu(null);
                }}
              >
                <IconTrash size={14} stroke={1.75} />
                Remove from list
              </button>
            </>
          ) : menu.kind === "chat" ? (
            <>
              <button
                className="context-menu-item"
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
                onClick={() => {
                  const { worktreePath, chatId, title } = menu;
                  setMenu(null);
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
            </>
          ) : (
            <>
              {!menu.archived && (
                <button
                  className="context-menu-item"
                  onClick={() => {
                    const { projectId, worktreeId } = menu;
                    setMenu(null);
                    const project = useProjectStore
                      .getState()
                      .projects.find((p) => p.id === projectId);
                    const wt = project?.worktrees.find((w) => w.id === worktreeId);
                    if (!wt) return;
                    void selectWorktree(projectId, worktreeId);
                    useCenterViewStore.getState().openPrTab(wt.path);
                  }}
                >
                  <IconGitPullRequest size={14} stroke={1.75} />
                  View pull request
                </button>
              )}
              {!menu.archived && (
                <button
                  className="context-menu-item"
                  onClick={() => {
                    void archiveWorktree(menu.projectId, menu.worktreeId);
                    setMenu(null);
                  }}
                >
                  <IconArchive size={14} stroke={1.75} />
                  Archive worktree
                </button>
              )}
              <button
                className="context-menu-item danger"
                onClick={() => {
                  const { projectId, worktreeId, name } = menu;
                  setMenu(null);
                  void (async () => {
                    const ok = await confirmDelete(
                      `Delete worktree "${name}" and its branch? This cannot be undone.`,
                      "Remove worktree",
                    );
                    if (ok) await removeWorktree(projectId, worktreeId);
                  })();
                }}
              >
                <IconTrash size={14} stroke={1.75} />
                Remove worktree
              </button>
            </>
          )}
        </div>
      )}

      {dialog === "connect" ? (
        <ConnectAppDialog onClose={() => setDialog(null)} />
      ) : dialog === "harness" ? (
        <Suspense fallback={null}>
          <ConnectHarnessDialog onClose={() => setDialog(null)} />
        </Suspense>
      ) : (
        dialog && (
          <ProjectDialog mode={dialog} onClose={() => setDialog(null)} />
        )
      )}

      {worktreeProjectId && (
        <CreateWorktreeDialog
          projectId={worktreeProjectId}
          onClose={() => setWorktreeProjectId(null)}
        />
      )}

      {setupProject && (
        <SetupScriptDialog
          projectId={setupProject.id}
          projectName={setupProject.name}
          onClose={() => setSetupProject(null)}
        />
      )}

    </aside>
  );
}
