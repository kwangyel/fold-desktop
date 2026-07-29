import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import { isTauri } from "./git";

export interface Project {
  id: string;
  name: string;
  path: string;
  createdOnGithub: boolean;
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
  return invoke<ProjectsState>("list_projects");
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
    };
    mockState = {
      projects: [...mockState.projects, project],
      activeId: project.id,
    };
    return project;
  }
  return invoke<Project>("create_project", { parent, name, createGithub });
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
    };
    mockState = {
      projects: [...mockState.projects, project],
      activeId: project.id,
    };
    return project;
  }
  return invoke<Project>("open_project", { path, name, createGithub, initGit });
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

export async function removeProject(id: string): Promise<ProjectsState> {
  if (!isTauri()) {
    const projects = mockState.projects.filter((p) => p.id !== id);
    const activeId =
      mockState.activeId === id ? projects[0]?.id ?? null : mockState.activeId;
    mockState = { projects, activeId };
    return mockState;
  }
  return invoke<ProjectsState>("remove_project", { id });
}
