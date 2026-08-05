import { create } from "zustand";
import {
  Project,
  CreateWorktreeOptions,
  archiveWorktree,
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
import { useCenterViewStore } from "./centerViewStore";

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
  select: (id: string) => Promise<void>;
  selectWorktree: (projectId: string, worktreeId: string) => Promise<void>;
  addWorktree: (
    projectId: string,
    name: string,
    options?: CreateWorktreeOptions,
  ) => Promise<void>;
  remove: (id: string) => Promise<void>;
  removeWorktree: (projectId: string, worktreeId: string) => Promise<void>;
  archiveWorktree: (projectId: string, worktreeId: string) => Promise<void>;
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
  useCenterViewStore.getState().closeWorkspaceTabs();
  refreshChanges();
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
      set({
        projects,
        activeId,
        activePath: activePathFrom(projects, activeId),
        loading: false,
      });
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

  removeWorktree: async (projectId, worktreeId) => {
    try {
      const previous = get().projects.find((p) => p.id === projectId);
      const removedWasActive = previous?.activeWorktreeId === worktreeId;
      const updated = await removeWorktree(projectId, worktreeId);
      set((s) => ({
        projects: replaceProject(s.projects, updated),
        activeId: s.activeId ?? projectId,
        // Cleared when the active worktree was removed — no main/sibling fallback.
        activePath: removedWasActive ? null : workspacePath(updated),
      }));
      onWorkspaceSwitch();
    } catch (e) {
      set({ error: String(e) });
    }
  },

  archiveWorktree: async (projectId, worktreeId) => {
    try {
      const previous = get().projects.find((p) => p.id === projectId);
      const archivedWasActive = previous?.activeWorktreeId === worktreeId;
      const updated = await archiveWorktree(projectId, worktreeId);
      set((s) => ({
        projects: replaceProject(s.projects, updated),
        activeId: s.activeId ?? projectId,
        // Cleared when the active worktree was archived — no main/sibling fallback.
        activePath: archivedWasActive ? null : workspacePath(updated),
      }));
      onWorkspaceSwitch();
    } catch (e) {
      set({ error: String(e) });
    }
  },
}));
