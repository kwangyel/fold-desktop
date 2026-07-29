use std::path::{Path, PathBuf};
use std::process::Command;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager, State};

use crate::AppState;

#[derive(Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct Project {
    id: String,
    name: String,
    path: String,
    created_on_github: bool,
}

#[derive(Serialize, Deserialize, Clone, Default)]
#[serde(rename_all = "camelCase")]
pub struct ProjectsFile {
    projects: Vec<Project>,
    active_id: Option<String>,
}

/// Path to the persisted `projects.json` inside the app config directory.
fn projects_file(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_config_dir()
        .map_err(|e| format!("failed to resolve config dir: {e}"))?;
    std::fs::create_dir_all(&dir).map_err(|e| format!("failed to create config dir: {e}"))?;
    Ok(dir.join("projects.json"))
}

fn read_file(app: &AppHandle) -> Result<ProjectsFile, String> {
    let path = projects_file(app)?;
    match std::fs::read_to_string(&path) {
        Ok(contents) => {
            serde_json::from_str(&contents).map_err(|e| format!("failed to parse projects.json: {e}"))
        }
        Err(_) => Ok(ProjectsFile::default()),
    }
}

fn write_file(app: &AppHandle, data: &ProjectsFile) -> Result<(), String> {
    let path = projects_file(app)?;
    let contents =
        serde_json::to_string_pretty(data).map_err(|e| format!("failed to serialize projects: {e}"))?;
    std::fs::write(&path, contents).map_err(|e| format!("failed to write projects.json: {e}"))
}

/// Reflect the active project's path into the shared runtime state.
fn set_active_path(state: &State<'_, AppState>, path: Option<PathBuf>) -> Result<(), String> {
    *state.active_project.lock().map_err(|e| e.to_string())? = path;
    Ok(())
}

fn find_path<'a>(data: &'a ProjectsFile, id: &str) -> Option<&'a Project> {
    data.projects.iter().find(|p| p.id == id)
}

/// Load the persisted active project into runtime state (called at startup).
pub fn load_active(app: &AppHandle, state: &State<'_, AppState>) -> Result<(), String> {
    let data = read_file(app)?;
    let path = data
        .active_id
        .as_ref()
        .and_then(|id| find_path(&data, id))
        .map(|p| PathBuf::from(&p.path));
    set_active_path(state, path)
}

fn new_id() -> String {
    // Timestamp-based id is good enough for a local list.
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    format!("p{nanos}")
}

fn git_init(dir: &Path) -> Result<(), String> {
    let output = Command::new("git")
        .args(["init"])
        .current_dir(dir)
        .output()
        .map_err(|e| format!("failed to run git init: {e}"))?;
    if !output.status.success() {
        return Err(String::from_utf8_lossy(&output.stderr).trim().to_string());
    }
    Ok(())
}

#[tauri::command]
pub fn list_projects(app: AppHandle) -> Result<ProjectsFile, String> {
    read_file(&app)
}

#[tauri::command]
pub fn create_project(
    app: AppHandle,
    parent: String,
    name: String,
    create_github: bool,
    state: State<'_, AppState>,
) -> Result<Project, String> {
    let name = name.trim();
    if name.is_empty() {
        return Err("project name is required".to_string());
    }
    let dir = Path::new(&parent).join(name);
    if dir.exists() {
        return Err(format!("{} already exists", dir.display()));
    }
    std::fs::create_dir_all(&dir).map_err(|e| format!("failed to create folder: {e}"))?;
    git_init(&dir)?;

    let project = Project {
        id: new_id(),
        name: name.to_string(),
        path: dir.to_string_lossy().to_string(),
        created_on_github: create_github,
    };

    let mut data = read_file(&app)?;
    data.projects.push(project.clone());
    data.active_id = Some(project.id.clone());
    write_file(&app, &data)?;
    set_active_path(&state, Some(dir))?;
    Ok(project)
}

/// Whether `path` is (or is inside) a git working tree.
#[tauri::command]
pub fn is_git_repo(path: String) -> bool {
    PathBuf::from(&path).join(".git").exists()
}

#[tauri::command]
pub fn open_project(
    app: AppHandle,
    path: String,
    name: String,
    create_github: bool,
    init_git: bool,
    state: State<'_, AppState>,
) -> Result<Project, String> {
    let dir = PathBuf::from(&path);
    if !dir.is_dir() {
        return Err(format!("{} is not a folder", dir.display()));
    }
    let name = name.trim();
    let name = if name.is_empty() {
        dir.file_name()
            .map(|n| n.to_string_lossy().to_string())
            .unwrap_or_else(|| "project".to_string())
    } else {
        name.to_string()
    };

    // Only git repositories may be opened; initialize on request.
    if !dir.join(".git").exists() {
        if init_git {
            git_init(&dir)?;
        } else {
            return Err("folder is not a git repository".to_string());
        }
    }

    let mut data = read_file(&app)?;
    // Reuse the existing entry if this path is already registered.
    if let Some(existing) = data.projects.iter().find(|p| p.path == path).cloned() {
        data.active_id = Some(existing.id.clone());
        write_file(&app, &data)?;
        set_active_path(&state, Some(dir))?;
        return Ok(existing);
    }

    let project = Project {
        id: new_id(),
        name,
        path: dir.to_string_lossy().to_string(),
        created_on_github: create_github,
    };
    data.projects.push(project.clone());
    data.active_id = Some(project.id.clone());
    write_file(&app, &data)?;
    set_active_path(&state, Some(dir))?;
    Ok(project)
}

#[tauri::command]
pub fn set_active_project(
    app: AppHandle,
    id: String,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let mut data = read_file(&app)?;
    let path = find_path(&data, &id)
        .map(|p| PathBuf::from(&p.path))
        .ok_or_else(|| "project not found".to_string())?;
    data.active_id = Some(id);
    write_file(&app, &data)?;
    set_active_path(&state, Some(path))
}

#[tauri::command]
pub fn remove_project(
    app: AppHandle,
    id: String,
    state: State<'_, AppState>,
) -> Result<ProjectsFile, String> {
    let mut data = read_file(&app)?;
    data.projects.retain(|p| p.id != id);
    if data.active_id.as_deref() == Some(id.as_str()) {
        data.active_id = data.projects.first().map(|p| p.id.clone());
    }
    write_file(&app, &data)?;
    let path = data
        .active_id
        .as_ref()
        .and_then(|aid| find_path(&data, aid))
        .map(|p| PathBuf::from(&p.path));
    set_active_path(&state, path)?;
    Ok(data)
}
