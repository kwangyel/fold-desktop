import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import { isTauri } from "./git";

export interface Worktree {
  id: string;
  name: string;
  branch: string;
  path: string;
  /** Archived worktrees keep their branch but their folder has been deleted. */
  archived: boolean;
}

export interface Project {
  id: string;
  name: string;
  path: string;
  createdOnGithub: boolean;
  hasGithubRemote: boolean;
  worktrees: Worktree[];
  activeWorktreeId: string | null;
}

export interface ProjectsState {
  projects: Project[];
  activeId: string | null;
}

// --- Browser fallback (no Tauri) ---------------------------------------------
// Folder picking and disk persistence are unavailable outside Tauri, so keep a
// small in-memory list to keep the UI functional during `vite` dev.

let mockState: ProjectsState = { projects: [], activeId: null };

function basename(path: string): string {
  const parts = path.replace(/[\\/]+$/, "").split(/[\\/]/);
  return parts[parts.length - 1] || path;
}

function normalizeProject(p: Project): Project {
  return {
    ...p,
    worktrees: p.worktrees ?? [],
    activeWorktreeId: p.activeWorktreeId ?? null,
  };
}

/** Absolute path the explorer/terminal should use — only the active worktree. */
export function workspacePath(project: Project): string | null {
  const active = project.activeWorktreeId
    ? project.worktrees.find((w) => w.id === project.activeWorktreeId)
    : undefined;
  return active?.path ?? null;
}

// --- Public API --------------------------------------------------------------

/** Open a native folder picker. Returns the chosen absolute path, or null. */
export async function pickFolder(title?: string): Promise<string | null> {
  if (!isTauri()) {
    const entered = window.prompt(title ?? "Folder path");
    return entered && entered.trim() ? entered.trim() : null;
  }
  const selected = await open({ directory: true, multiple: false, title });
  return typeof selected === "string" ? selected : null;
}

export async function listProjects(): Promise<ProjectsState> {
  if (!isTauri()) return mockState;
  const state = await invoke<ProjectsState>("list_projects");
  return {
    projects: state.projects.map(normalizeProject),
    activeId: state.activeId,
  };
}

export async function createProject(
  parent: string,
  name: string,
  createGithub: boolean,
): Promise<Project> {
  if (!isTauri()) {
    const project: Project = {
      id: `p${Date.now()}`,
      name: name.trim(),
      path: `${parent.replace(/[\\/]+$/, "")}/${name.trim()}`,
      createdOnGithub: createGithub,
      worktrees: [],
      activeWorktreeId: null,
    };
    mockState = {
      projects: [...mockState.projects, project],
      activeId: project.id,
    };
    return project;
  }
  return normalizeProject(
    await invoke<Project>("create_project", { parent, name, createGithub }),
  );
}

export async function openProject(
  path: string,
  name: string,
  createGithub: boolean,
  initGit: boolean,
): Promise<Project> {
  if (!isTauri()) {
    const project: Project = {
      id: `p${Date.now()}`,
      name: name.trim() || basename(path),
      path,
      createdOnGithub: createGithub,
      worktrees: [],
      activeWorktreeId: null,
    };
    mockState = {
      projects: [...mockState.projects, project],
      activeId: project.id,
    };
    return project;
  }
  return normalizeProject(
    await invoke<Project>("open_project", { path, name, createGithub, initGit }),
  );
}

/** Whether the folder is already a git repository. */
export async function isGitRepo(path: string): Promise<boolean> {
  if (!isTauri()) return true;
  return invoke<boolean>("is_git_repo", { path });
}

export async function setActiveProject(id: string): Promise<void> {
  if (!isTauri()) {
    mockState = { ...mockState, activeId: id };
    return;
  }
  await invoke("set_active_project", { id });
}

export async function createWorktree(
  projectId: string,
  name: string,
  branch?: string,
): Promise<Project> {
  if (!isTauri()) {
    const project = mockState.projects.find((p) => p.id === projectId);
    if (!project) throw new Error("project not found");
    const slug = name.trim().toLowerCase().replace(/\s+/g, "-") || "workspace";
    const worktree: Worktree = {
      id: `w${Date.now()}`,
      name: name.trim(),
      branch: branch?.trim() || `ws/${slug}`,
      path: `${project.path}-workspaces/${slug}`,
      archived: false,
    };
    const updated: Project = {
      ...project,
      worktrees: [...project.worktrees, worktree],
      activeWorktreeId: worktree.id,
    };
    mockState = {
      projects: mockState.projects.map((p) => (p.id === projectId ? updated : p)),
      activeId: projectId,
    };
    return updated;
  }
  return normalizeProject(
    await invoke<Project>("create_worktree", {
      projectId,
      name,
      branch: branch || null,
    }),
  );
}

export async function setActiveWorktree(
  projectId: string,
  worktreeId: string,
): Promise<Project> {
  if (!isTauri()) {
    const project = mockState.projects.find((p) => p.id === projectId);
    if (!project) throw new Error("project not found");
    const updated: Project = { ...project, activeWorktreeId: worktreeId };
    mockState = {
      projects: mockState.projects.map((p) => (p.id === projectId ? updated : p)),
      activeId: projectId,
    };
    return updated;
  }
  return normalizeProject(
    await invoke<Project>("set_active_worktree", { projectId, worktreeId }),
  );
}

export async function removeWorktree(
  projectId: string,
  worktreeId: string,
): Promise<Project> {
  if (!isTauri()) {
    const project = mockState.projects.find((p) => p.id === projectId);
    if (!project) throw new Error("project not found");
    const worktrees = project.worktrees.filter((w) => w.id !== worktreeId);
    const updated: Project = {
      ...project,
      worktrees,
      activeWorktreeId:
        project.activeWorktreeId === worktreeId
          ? worktrees[0]?.id ?? null
          : project.activeWorktreeId,
    };
    mockState = {
      projects: mockState.projects.map((p) => (p.id === projectId ? updated : p)),
      activeId: mockState.activeId,
    };
    return updated;
  }
  return normalizeProject(
    await invoke<Project>("remove_worktree", { projectId, worktreeId }),
  );
}

export async function archiveWorktree(
  projectId: string,
  worktreeId: string,
): Promise<Project> {
  if (!isTauri()) {
    const project = mockState.projects.find((p) => p.id === projectId);
    if (!project) throw new Error("project not found");
    const worktrees = project.worktrees.map((w) =>
      w.id === worktreeId ? { ...w, archived: true } : w,
    );
    const updated: Project = {
      ...project,
      worktrees,
      activeWorktreeId:
        project.activeWorktreeId === worktreeId ? null : project.activeWorktreeId,
    };
    mockState = {
      projects: mockState.projects.map((p) => (p.id === projectId ? updated : p)),
      activeId: mockState.activeId,
    };
    return updated;
  }
  return normalizeProject(
    await invoke<Project>("archive_worktree", { projectId, worktreeId }),
  );
}

export async function removeProject(id: string): Promise<ProjectsState> {
  if (!isTauri()) {
    const projects = mockState.projects.filter((p) => p.id !== id);
    const activeId =
      mockState.activeId === id ? projects[0]?.id ?? null : mockState.activeId;
    mockState = { projects, activeId };
    return mockState;
  }
  const state = await invoke<ProjectsState>("remove_project", { id });
  return {
    projects: state.projects.map(normalizeProject),
    activeId: state.activeId,
  };
}
