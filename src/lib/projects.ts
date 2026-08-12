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

export type TransferMode = "symlink" | "copy";

export interface EnvTransfer {
  path: string;
  mode: TransferMode;
}

export interface WorktreeEnvDefaults {
  symlinkEnvs: boolean;
  transfers: EnvTransfer[];
}

export interface WorktreeEnvScan {
  dirs: string[];
  files: string[];
  defaults: WorktreeEnvDefaults | null;
}

export interface CreateWorktreeOptions {
  branch?: string;
  transfers?: EnvTransfer[];
  symlinkEnvs?: boolean;
  saveDefaults?: boolean;
}

export interface Project {
  id: string;
  name: string;
  path: string;
  createdOnGithub: boolean;
  hasGithubRemote: boolean;
  worktrees: Worktree[];
  activeWorktreeId: string | null;
  worktreeEnvDefaults?: WorktreeEnvDefaults | null;
}

export interface WorktreeMutationResult {
  project: Project;
  rescueRef?: string | null;
}

export interface WorktreeDeletionRisk {
  branch: string;
  archived: boolean;
  unpushedCommits: number;
  hasUpstream: boolean;
  dirty: boolean;
  untracked: boolean;
  requiresForce: boolean;
  branchExists: boolean;
}

export interface DeleteWorktreeOptions {
  /** Save branch tip under refs/fold/rescue/… (default true). */
  createRescue?: boolean;
  /** Allow `git branch -D` after typed confirm (default false). */
  force?: boolean;
}

export interface ArchiveWorktreeOptions {
  /** Stash dirty/untracked work under refs/fold/rescue/… (default true). */
  createRescue?: boolean;
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
    worktreeEnvDefaults: p.worktreeEnvDefaults ?? null,
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
      hasGithubRemote: createGithub,
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
      hasGithubRemote: createGithub,
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

/** Clone a GitHub repo into `parent/<repo>` and register it as a project. */
export async function cloneGithubProject(
  fullName: string,
  parent: string,
  name?: string,
): Promise<Project> {
  if (!isTauri()) {
    const repo = fullName.split("/").pop() || fullName;
    const path = `${parent.replace(/[\\/]+$/, "")}/${repo}`;
    const project: Project = {
      id: `p${Date.now()}`,
      name: name?.trim() || repo,
      path,
      createdOnGithub: false,
      hasGithubRemote: true,
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
    await invoke<Project>("clone_github_project", {
      fullName,
      parent,
      name: name?.trim() ? name.trim() : null,
    }),
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

/** Open a native multi-file picker rooted at `defaultPath`. */
export async function pickFiles(
  title?: string,
  defaultPath?: string,
): Promise<string[]> {
  if (!isTauri()) {
    const entered = window.prompt(title ?? "File path");
    return entered && entered.trim() ? [entered.trim()] : [];
  }
  const selected = await open({
    directory: false,
    multiple: true,
    title,
    defaultPath,
  });
  if (selected == null) return [];
  return Array.isArray(selected) ? selected : [selected];
}

/** Make `absPath` relative to `root` if it is under root; otherwise null. */
export function relativeToRoot(root: string, absPath: string): string | null {
  const normRoot = root.replace(/[\\/]+$/, "");
  const normPath = absPath.replace(/[\\/]+$/, "");
  const rootPrefix = normRoot.endsWith("/") ? normRoot : `${normRoot}/`;
  // Case-sensitive compare is fine on macOS APFS default; paths come from the OS.
  if (normPath === normRoot) return null;
  if (!normPath.startsWith(rootPrefix) && !normPath.startsWith(normRoot + "\\")) {
    return null;
  }
  const rel = normPath.slice(normRoot.length).replace(/^[\\/]+/, "");
  if (!rel || rel.split(/[\\/]/).includes("..")) return null;
  return rel.replace(/\\/g, "/");
}

export async function scanWorktreeEnv(projectId: string): Promise<WorktreeEnvScan> {
  if (!isTauri()) {
    const project = mockState.projects.find((p) => p.id === projectId);
    return {
      dirs: [],
      files: [],
      defaults: project?.worktreeEnvDefaults ?? null,
    };
  }
  return invoke<WorktreeEnvScan>("scan_worktree_env", { projectId });
}

export async function createWorktree(
  projectId: string,
  name: string,
  options?: CreateWorktreeOptions,
): Promise<Project> {
  const branch = options?.branch;
  const transfers = options?.transfers ?? [];
  const symlinkEnvs = options?.symlinkEnvs ?? false;
  const saveDefaults = options?.saveDefaults ?? false;

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
      worktreeEnvDefaults: saveDefaults
        ? { symlinkEnvs, transfers }
        : project.worktreeEnvDefaults ?? null,
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
      transfers,
      symlinkEnvs,
      saveDefaults,
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
  options: DeleteWorktreeOptions = {},
): Promise<WorktreeMutationResult> {
  const createRescue = options.createRescue ?? true;
  const force = options.force ?? false;
  if (!isTauri()) {
    const project = mockState.projects.find((p) => p.id === projectId);
    if (!project) throw new Error("project not found");
    const target = project.worktrees.find((w) => w.id === worktreeId);
    if (!target) throw new Error("worktree not found");
    if (!target.archived) {
      throw new Error("archive the worktree before permanently deleting it");
    }
    const worktrees = project.worktrees.filter((w) => w.id !== worktreeId);
    const updated: Project = {
      ...project,
      worktrees,
      activeWorktreeId:
        project.activeWorktreeId === worktreeId
          ? null
          : project.activeWorktreeId,
    };
    mockState = {
      projects: mockState.projects.map((p) => (p.id === projectId ? updated : p)),
      activeId: mockState.activeId,
    };
    return {
      project: updated,
      rescueRef: createRescue ? `refs/fold/rescue/${target.branch}-tip-mock` : null,
    };
  }
  const result = await invoke<WorktreeMutationResult>("remove_worktree", {
    projectId,
    worktreeId,
    createRescue,
    force,
  });
  return {
    project: normalizeProject(result.project),
    rescueRef: result.rescueRef ?? null,
  };
}

export async function assessWorktreeDeletion(
  projectId: string,
  worktreeId: string,
): Promise<WorktreeDeletionRisk> {
  if (!isTauri()) {
    const project = mockState.projects.find((p) => p.id === projectId);
    const wt = project?.worktrees.find((w) => w.id === worktreeId);
    if (!wt) throw new Error("worktree not found");
    return {
      branch: wt.branch,
      archived: wt.archived,
      unpushedCommits: 0,
      hasUpstream: false,
      dirty: false,
      untracked: false,
      requiresForce: false,
      branchExists: true,
    };
  }
  return invoke<WorktreeDeletionRisk>("assess_worktree_deletion", {
    projectId,
    worktreeId,
  });
}

/** True when archive would stash dirty/untracked work (needs user confirm). */
export async function worktreeNeedsArchiveRescue(
  projectId: string,
  worktreeId: string,
): Promise<boolean> {
  const risk = await assessWorktreeDeletion(projectId, worktreeId);
  return risk.dirty || risk.untracked;
}

export async function archiveWorktree(
  projectId: string,
  worktreeId: string,
  options: ArchiveWorktreeOptions = {},
): Promise<WorktreeMutationResult> {
  const createRescue = options.createRescue ?? true;
  if (!isTauri()) {
    const project = mockState.projects.find((p) => p.id === projectId);
    if (!project) throw new Error("project not found");
    const target = project.worktrees.find((w) => w.id === worktreeId);
    if (!target) throw new Error("worktree not found");
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
    return {
      project: updated,
      rescueRef: createRescue
        ? `refs/fold/rescue/${target.branch}-wip-mock`
        : null,
    };
  }
  const result = await invoke<WorktreeMutationResult>("archive_worktree", {
    projectId,
    worktreeId,
    createRescue,
  });
  return {
    project: normalizeProject(result.project),
    rescueRef: result.rescueRef ?? null,
  };
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
