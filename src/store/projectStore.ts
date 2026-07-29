import { create } from "zustand";
import {
  Project,
  createProject,
  listProjects,
  openProject,
  removeProject,
  setActiveProject,
} from "../lib/projects";
import { useChangesStore } from "./changesStore";

type ProjectStore = {
  projects: Project[];
  activeId: string | null;
  loading: boolean;
  error: string | null;
  load: () => Promise<void>;
  create: (parent: string, name: string, createGithub: boolean) => Promise<void>;
  open: (
    path: string,
    name: string,
    createGithub: boolean,
    initGit: boolean,
  ) => Promise<void>;
  select: (id: string) => Promise<void>;
  remove: (id: string) => Promise<void>;
};

/** Re-read the newly active project's git state. */
function refreshChanges() {
  useChangesStore.getState().refresh();
}

export const useProjectStore = create<ProjectStore>((set, get) => ({
  projects: [],
  activeId: null,
  loading: false,
  error: null,

  load: async () => {
    set({ loading: true, error: null });
    try {
      const { projects, activeId } = await listProjects();
      set({ projects, activeId, loading: false });
      if (activeId) refreshChanges();
    } catch (e) {
      set({ error: String(e), loading: false });
    }
  },

  create: async (parent, name, createGithub) => {
    set({ error: null });
    try {
      const project = await createProject(parent, name, createGithub);
      set((s) => ({
        projects: [...s.projects, project],
        activeId: project.id,
      }));
      refreshChanges();
    } catch (e) {
      set({ error: String(e) });
      throw e;
    }
  },

  open: async (path, name, createGithub, initGit) => {
    set({ error: null });
    try {
      const project = await openProject(path, name, createGithub, initGit);
      set((s) => ({
        // Avoid duplicating an already-registered path.
        projects: s.projects.some((p) => p.id === project.id)
          ? s.projects
          : [...s.projects, project],
        activeId: project.id,
      }));
      refreshChanges();
    } catch (e) {
      set({ error: String(e) });
      throw e;
    }
  },

  select: async (id) => {
    if (get().activeId === id) return;
    try {
      await setActiveProject(id);
      set({ activeId: id });
      refreshChanges();
    } catch (e) {
      set({ error: String(e) });
    }
  },

  remove: async (id) => {
    try {
      const { projects, activeId } = await removeProject(id);
      set({ projects, activeId });
      refreshChanges();
    } catch (e) {
      set({ error: String(e) });
    }
  },
}));
