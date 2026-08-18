import { create } from "zustand";
import {
  Project,
  CreateWorktreeOptions,
  ArchiveWorktreeOptions,
  DeleteWorktreeOptions,
  archiveWorktree,
  cloneGithubProject,
  createProject,
  createWorktree,
  listProjects,
  openProject,
  removeProject,
  removeWorktree,
  setActiveProject,
  setActiveWorktree,
  workspacePath,
} from "../lib/projects";
import { useChangesStore } from "./changesStore";
import { useReviewCommentsStore } from "./reviewCommentsStore";
import { useChatSessionStore } from "./chatSessionStore";
import { useAgentStatusStore } from "./agentStatusStore";
import { useTerminalStore } from "./terminalStore";
import { syncChatTabsForWorktree } from "../lib/chatTabs";
import { buildSetupCommand, getSetupTerminalInfo } from "../lib/setup";

type ProjectStore = {
  projects: Project[];
  activeId: string | null;
  loading: boolean;
  error: string | null;
  /** Absolute path explorer + terminal should use (active worktree or project). */
  activePath: string | null;
  load: () => Promise<void>;
  create: (parent: string, name: string, createGithub: boolean) => Promise<void>;
  open: (
    path: string,
    name: string,
    createGithub: boolean,
    initGit: boolean,
  ) => Promise<void>;
  cloneFromGithub: (
    fullName: string,
    parent: string,
    name?: string,
  ) => Promise<void>;
  select: (id: string) => Promise<void>;
  selectWorktree: (projectId: string, worktreeId: string) => Promise<void>;
  addWorktree: (
    projectId: string,
    name: string,
    options?: CreateWorktreeOptions,
  ) => Promise<void>;
  remove: (id: string) => Promise<void>;
  removeWorktree: (
    projectId: string,
    worktreeId: string,
    options?: DeleteWorktreeOptions,
  ) => Promise<void>;
  archiveWorktree: (
    projectId: string,
    worktreeId: string,
    options?: ArchiveWorktreeOptions,
  ) => Promise<string | null>;
};

function activePathFrom(projects: Project[], activeId: string | null): string | null {
  if (!activeId) return null;
  const project = projects.find((p) => p.id === activeId);
  return project ? workspacePath(project) : null;
}

/** Re-read the newly active project's git state. */
function refreshChanges() {
  useChangesStore.getState().refresh();
}

function onWorkspaceSwitch() {
  const activePath = useProjectStore.getState().activePath;
  // Chats are stored per worktree, so the open tabs follow the switch.
  void syncChatTabsForWorktree(activePath);
  refreshChanges();
  // Review comments live beside each worktree; reload for the new one.
  void useReviewCommentsStore.getState().refresh();
}

/** Chat lists for every live worktree, so the chats menu can show them. */
function refreshChatIndex(projects: Project[]) {
  const paths = projects.flatMap((p) =>
    p.worktrees.filter((w) => !w.archived).map((w) => w.path),
  );
  void useChatSessionStore.getState().refreshAll(paths);
}

function replaceProject(projects: Project[], updated: Project): Project[] {
  return projects.map((p) => (p.id === updated.id ? updated : p));
}

export const useProjectStore = create<ProjectStore>((set, get) => ({
  projects: [],
  activeId: null,
  activePath: null,
  loading: false,
  error: null,

  load: async () => {
    set({ loading: true, error: null });
    try {
      const { projects, activeId } = await listProjects();
      const activePath = activePathFrom(projects, activeId);
      set({
        projects,
        activeId,
        activePath,
        loading: false,
      });
      void syncChatTabsForWorktree(activePath);
      refreshChatIndex(projects);
      // Defer git status so the sidebar paints before three git subprocesses run.
      if (activeId) {
        const schedule =
          typeof window !== "undefined" && "requestIdleCallback" in window
            ? (cb: () => void) => window.requestIdleCallback(cb, { timeout: 2000 })
            : (cb: () => void) => window.setTimeout(cb, 300);
        schedule(() => refreshChanges());
      }
    } catch (e) {
      set({ error: String(e), loading: false });
    }
  },

  create: async (parent, name, createGithub) => {
    set({ error: null });
    try {
      const project = await createProject(parent, name, createGithub);
      set((s) => {
        const projects = [...s.projects, project];
        return {
          projects,
          activeId: project.id,
          activePath: workspacePath(project),
        };
      });
      onWorkspaceSwitch();
    } catch (e) {
      set({ error: String(e) });
      throw e;
    }
  },

  open: async (path, name, createGithub, initGit) => {
    set({ error: null });
    try {
      const project = await openProject(path, name, createGithub, initGit);
      set((s) => {
        const projects = s.projects.some((p) => p.id === project.id)
          ? replaceProject(s.projects, project)
          : [...s.projects, project];
        return {
          projects,
          activeId: project.id,
          activePath: workspacePath(project),
        };
      });
      onWorkspaceSwitch();
    } catch (e) {
      set({ error: String(e) });
      throw e;
    }
  },

  cloneFromGithub: async (fullName, parent, name) => {
    set({ error: null });
    try {
      const project = await cloneGithubProject(fullName, parent, name);
      set((s) => {
        const projects = s.projects.some((p) => p.id === project.id)
          ? replaceProject(s.projects, project)
          : [...s.projects, project];
        return {
          projects,
          activeId: project.id,
          activePath: workspacePath(project),
        };
      });
      onWorkspaceSwitch();
    } catch (e) {
      set({ error: String(e) });
      throw e;
    }
  },

  select: async (id) => {
    if (get().activeId === id) return;
    try {
      await setActiveProject(id);
      const project = get().projects.find((p) => p.id === id);
      set({
        activeId: id,
        activePath: project ? workspacePath(project) : null,
      });
      onWorkspaceSwitch();
    } catch (e) {
      set({ error: String(e) });
    }
  },

  selectWorktree: async (projectId, worktreeId) => {
    const current = get().projects.find((p) => p.id === projectId);
    if (
      current &&
      get().activeId === projectId &&
      current.activeWorktreeId === worktreeId
    ) {
      return;
    }
    try {
      const updated = await setActiveWorktree(projectId, worktreeId);
      set((s) => ({
        projects: replaceProject(s.projects, updated),
        activeId: projectId,
        activePath: workspacePath(updated),
      }));
      onWorkspaceSwitch();
    } catch (e) {
      set({ error: String(e) });
      throw e;
    }
  },

  addWorktree: async (projectId, name, options) => {
    set({ error: null });
    try {
      const updated = await createWorktree(projectId, name, options);
      set((s) => ({
        projects: replaceProject(s.projects, updated),
        activeId: projectId,
        activePath: workspacePath(updated),
      }));
      onWorkspaceSwitch();
      // Fire-and-forget: run setup in a new right-panel terminal tab.
      const worktreeId = updated.activeWorktreeId;
      if (worktreeId) {
        void (async () => {
          try {
            const info = await getSetupTerminalInfo(projectId, worktreeId);
            if (!info) return;
            useTerminalStore.getState().open({
              label: `Setup · ${info.worktreeName}`,
              cwd: info.worktreePath,
              command: buildSetupCommand(info),
            });
          } catch {
            // Setup is best-effort; worktree create already succeeded.
          }
        })();
      }
    } catch (e) {
      set({ error: String(e) });
      throw e;
    }
  },

  remove: async (id) => {
    try {
      const { projects, activeId } = await removeProject(id);
      set({
        projects,
        activeId,
        activePath: activePathFrom(projects, activeId),
      });
      onWorkspaceSwitch();
    } catch (e) {
      set({ error: String(e) });
    }
  },

  removeWorktree: async (projectId, worktreeId, options) => {
    try {
      const previous = get().projects.find((p) => p.id === projectId);
      const removedWasActive = previous?.activeWorktreeId === worktreeId;
      // The backend deletes the whole `.fold/<worktree>` dir — chats.db with
      // it — so the cached chat list has to go too.
      const removedPath = previous?.worktrees.find(
        (w) => w.id === worktreeId,
      )?.path;
      const { project: updated } = await removeWorktree(
        projectId,
        worktreeId,
        options,
      );
      if (removedPath) {
        useChatSessionStore.getState().forget(removedPath);
        useAgentStatusStore.getState().clearWorktree(removedPath);
      }
      set((s) => ({
        projects: replaceProject(s.projects, updated),
        activeId: s.activeId ?? projectId,
        // Cleared when the active worktree was removed — no main/sibling fallback.
        activePath: removedWasActive ? null : workspacePath(updated),
      }));
      onWorkspaceSwitch();
    } catch (e) {
      set({ error: String(e) });
      throw e;
    }
  },

  archiveWorktree: async (projectId, worktreeId, options) => {
    try {
      const previous = get().projects.find((p) => p.id === projectId);
      const archivedWasActive = previous?.activeWorktreeId === worktreeId;
      const archivedPath = previous?.worktrees.find(
        (w) => w.id === worktreeId,
      )?.path;
      const { project: updated, rescueRef } = await archiveWorktree(
        projectId,
        worktreeId,
        options,
      );
      // Archiving deletes the worktree folder and its `.fold` data too.
      if (archivedPath) {
        useChatSessionStore.getState().forget(archivedPath);
        useAgentStatusStore.getState().clearWorktree(archivedPath);
      }
      set((s) => ({
        projects: replaceProject(s.projects, updated),
        activeId: s.activeId ?? projectId,
        // Cleared when the active worktree was archived — no main/sibling fallback.
        activePath: archivedWasActive ? null : workspacePath(updated),
      }));
      onWorkspaceSwitch();
      return rescueRef ?? null;
    } catch (e) {
      set({ error: String(e) });
      throw e;
    }
  },
}));
