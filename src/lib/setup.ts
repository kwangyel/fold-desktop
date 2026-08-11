import { invoke } from "@tauri-apps/api/core";
import { isTauri } from "./git";

export type SetupTerminalInfo = {
  scriptPath: string;
  worktreePath: string;
  projectPath: string;
  worktreeName: string;
  worktreeBranch: string;
};

export async function getSetupScript(projectId: string): Promise<string | null> {
  if (!isTauri()) return null;
  return invoke<string | null>("get_setup_script", { projectId });
}

export async function setSetupScript(
  projectId: string,
  script: string | null,
): Promise<void> {
  if (!isTauri()) return;
  await invoke("set_setup_script", { projectId, script });
}

export async function getSetupTerminalInfo(
  projectId: string,
  worktreeId: string,
): Promise<SetupTerminalInfo | null> {
  if (!isTauri()) return null;
  return invoke<SetupTerminalInfo | null>("get_setup_terminal_info", {
    projectId,
    worktreeId,
  });
}

/** POSIX single-quote escape for embedding a path/value in a shell command. */
export function shellSingleQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/** Build the shell command that runs a project's setup script in a worktree. */
export function buildSetupCommand(info: SetupTerminalInfo): string {
  const exports = [
    `FOLD_WORKSPACE_PATH=${shellSingleQuote(info.worktreePath)}`,
    `FOLD_ROOT_PATH=${shellSingleQuote(info.projectPath)}`,
    `FOLD_WORKSPACE_NAME=${shellSingleQuote(info.worktreeName)}`,
    `FOLD_WORKTREE_PATH=${shellSingleQuote(info.worktreePath)}`,
    `FOLD_WORKTREE_BRANCH=${shellSingleQuote(info.worktreeBranch)}`,
    `FOLD_PROJECT_PATH=${shellSingleQuote(info.projectPath)}`,
  ].join(" ");
  return `export ${exports} && source ${shellSingleQuote(info.scriptPath)}`;
}
