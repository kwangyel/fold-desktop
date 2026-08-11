//! Per-project worktree setup scripts.
//!
//! The script lives outside the git repo at
//! `~/fold/workspaces/<project-slug>/.fold/setup.sh` and is run in a terminal
//! tab after each new worktree is created. Removing the project deletes it.

use serde::Serialize;
use tauri::AppHandle;

use crate::fold_paths;
use crate::projects;

fn resolve_script_path(app: &AppHandle, project_id: &str) -> Result<std::path::PathBuf, String> {
    let project = projects::load_project(app, project_id)?;
    let root = projects::project_workspaces_root(&project)?;
    Ok(fold_paths::project_setup_script(&root))
}

/// Read the project's setup script, or `None` if it does not exist / is empty.
#[tauri::command(async)]
pub fn get_setup_script(app: AppHandle, project_id: String) -> Result<Option<String>, String> {
    let path = resolve_script_path(&app, &project_id)?;
    if !path.is_file() {
        return Ok(None);
    }
    let contents = std::fs::read_to_string(&path)
        .map_err(|e| format!("failed to read setup script: {e}"))?;
    if contents.trim().is_empty() {
        Ok(None)
    } else {
        Ok(Some(contents))
    }
}

/// Write or clear the project's setup script.
#[tauri::command(async)]
pub fn set_setup_script(
    app: AppHandle,
    project_id: String,
    script: Option<String>,
) -> Result<(), String> {
    let path = resolve_script_path(&app, &project_id)?;
    let empty = script
        .as_ref()
        .map(|s| s.trim().is_empty())
        .unwrap_or(true);
    if empty {
        let _ = std::fs::remove_file(&path);
        return Ok(());
    }
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|e| format!("failed to create .fold dir: {e}"))?;
    }
    let body = script.unwrap();
    std::fs::write(&path, body).map_err(|e| format!("failed to write setup script: {e}"))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o755));
    }
    Ok(())
}

/// Info needed to run setup in a terminal for a worktree.
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SetupTerminalInfo {
    pub script_path: String,
    pub worktree_path: String,
    pub project_path: String,
    pub worktree_name: String,
    pub worktree_branch: String,
}

/// Resolve setup script + worktree paths for launching in the terminal panel.
/// Returns `None` when there is no setup script.
#[tauri::command(async)]
pub fn get_setup_terminal_info(
    app: AppHandle,
    project_id: String,
    worktree_id: String,
) -> Result<Option<SetupTerminalInfo>, String> {
    let path = resolve_script_path(&app, &project_id)?;
    if !path.is_file() {
        return Ok(None);
    }
    let contents = std::fs::read_to_string(&path)
        .map_err(|e| format!("failed to read setup script: {e}"))?;
    if contents.trim().is_empty() {
        return Ok(None);
    }
    let target = projects::resolve_setup_target(&app, &project_id, &worktree_id)?;
    Ok(Some(SetupTerminalInfo {
        script_path: path.to_string_lossy().into_owned(),
        worktree_path: target.worktree_path,
        project_path: target.project_path,
        worktree_name: target.worktree_name,
        worktree_branch: target.worktree_branch,
    }))
}
