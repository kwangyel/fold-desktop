import { lazy, Suspense, useCallback, useEffect, useRef, useState } from "react";
import {
  IconFolderPlus,
  IconFolderOpen,
  IconBrandGithub,
  IconTrash,
  IconArchive,
  IconPlus,
  IconGitBranch,
  IconPlug,
  IconRobot,
} from "@tabler/icons-react";
import { confirm } from "@tauri-apps/plugin-dialog";
import { useProjectStore } from "../store/projectStore";
import { isTauri } from "../lib/git";
import { pickWorktreeName } from "../lib/worktreeNames";
import ProjectDialog from "./ProjectDialog";
import ConnectAppDialog from "./ConnectAppDialog";
import UserMenu from "./UserMenu";
import ResizeHandle from "./ResizeHandle";

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
    };

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
  const addWorktree = useProjectStore((s) => s.addWorktree);
  const remove = useProjectStore((s) => s.remove);
  const removeWorktree = useProjectStore((s) => s.removeWorktree);
  const archiveWorktree = useProjectStore((s) => s.archiveWorktree);

  const [dialog, setDialog] = useState<DialogMode>(null);
  const [creatingId, setCreatingId] = useState<string | null>(null);
  const [menu, setMenu] = useState<ContextMenu | null>(null);

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

  async function createWorktree(projectId: string) {
    if (creatingId) return;
    const project = useProjectStore.getState().projects.find((p) => p.id === projectId);
    if (!project) return;

    const name = pickWorktreeName(project.worktrees.map((w) => w.name));
    setCreatingId(projectId);
    try {
      await addWorktree(projectId, name);
    } catch {
      // Error is stored on the project store for display.
    } finally {
      setCreatingId(null);
    }
  }

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
            <button className="ghost-btn full" onClick={() => setDialog("connect")}>
              <IconPlug size={15} stroke={2} />
              Connect App
            </button>
            <button className="ghost-btn full" onClick={() => setDialog("harness")}>
              <IconRobot size={15} stroke={2} />
              Connect Harness
            </button>
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
            const isCreating = creatingId === p.id;
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
                  <span
                    className={`status-dot ${isActiveProject ? "" : "idle"}`}
                  />
                  <div className="meta">
                    <div className="name">{p.name}</div>
                    <div className="sub">
                      {activeWorktrees.length > 0
                        ? `${activeWorktrees.length} worktree${activeWorktrees.length === 1 ? "" : "s"}`
                        : p.path}
                    </div>
                  </div>
                  {p.createdOnGithub && (
                    <IconBrandGithub
                      size={14}
                      className="gh-badge"
                      title="Marked for GitHub"
                    />
                  )}
                  <button
                    className="icon-btn project-plus"
                    type="button"
                    title="New worktree"
                    disabled={isCreating}
                    onClick={(e) => {
                      e.stopPropagation();
                      void createWorktree(p.id);
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
                        <div
                          key={wt.id}
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
          ) : (
            <>
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
    </aside>
  );
}
