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
  IconTerminal2,
} from "@tabler/icons-react";
import { useProjectStore } from "../store/projectStore";
import { useCenterViewStore } from "../store/centerViewStore";
import { openLatestChat } from "../lib/chatTabs";
import { worktreeNeedsArchiveRescue } from "../lib/projects";
import ProjectDialog from "./ProjectDialog";
import CreateWorktreeDialog from "./CreateWorktreeDialog";
import ArchiveWorktreeDialog from "./ArchiveWorktreeDialog";
import ConnectAppDialog from "./ConnectAppDialog";
import SetupScriptDialog from "./SetupScriptDialog";
import UserMenu from "./UserMenu";
import ProjectGithubAvatar from "./ProjectGithubAvatar";
import ResizeHandle from "./ResizeHandle";
import { WorktreeStatusDot } from "./AgentStatusDot";
import ConflictChip from "./ConflictChip";
import {
  selectTargetBranch,
  useTargetBranchStore,
} from "../store/targetBranchStore";

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
  const targetBranches = useTargetBranchStore((s) => s.byProjectId);

  const [dialog, setDialog] = useState<DialogMode>(null);
  const [worktreeProjectId, setWorktreeProjectId] = useState<string | null>(null);
  const [setupProject, setSetupProject] = useState<{
    id: string;
    name: string;
  } | null>(null);
  const [archiveTarget, setArchiveTarget] = useState<{
    projectId: string;
    worktreeId: string;
    name: string;
  } | null>(null);
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
            // Archived worktrees are hidden here (managed in a separate UI).
            const activeWorktrees = p.worktrees.filter((w) => !w.archived);
            const projectTarget = selectTargetBranch(targetBranches, p.id);
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
                        <div
                          key={wt.id}
                          className={`worktree-row ${isActive ? "active" : ""}`}
                          onClick={() => {
                            void (async () => {
                              const alreadyActive = isActive;
                              try {
                                await selectWorktree(p.id, wt.id);
                              } catch {
                                return;
                              }
                              // Switching already opens the latest chat; a
                              // re-click on the active row should too.
                              if (alreadyActive) await openLatestChat(wt.path);
                            })();
                          }}
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
                          <ConflictChip
                            worktreeId={wt.id}
                            targetBranch={projectTarget}
                          />
                          <WorktreeStatusDot worktreePath={wt.path} />
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
                    const { projectId, worktreeId, name } = menu;
                    setMenu(null);
                    void (async () => {
                      try {
                        const needsRescue = await worktreeNeedsArchiveRescue(
                          projectId,
                          worktreeId,
                        );
                        if (needsRescue) {
                          setArchiveTarget({ projectId, worktreeId, name });
                          return;
                        }
                        await useProjectStore
                          .getState()
                          .archiveWorktree(projectId, worktreeId, {
                            createRescue: false,
                          });
                      } catch (e) {
                        useProjectStore.setState({ error: String(e) });
                      }
                    })();
                  }}
                >
                  <IconArchive size={14} stroke={1.75} />
                  Archive worktree
                </button>
              )}
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

      {archiveTarget && (
        <ArchiveWorktreeDialog
          projectId={archiveTarget.projectId}
          worktreeId={archiveTarget.worktreeId}
          name={archiveTarget.name}
          onClose={() => setArchiveTarget(null)}
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
