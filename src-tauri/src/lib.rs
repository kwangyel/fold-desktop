mod git;
mod github;
mod projects;
mod pty;

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Mutex;


use tauri::ipc::Channel;
use tauri::{Manager, State};

pub struct AppState {
    pub sessions: Mutex<HashMap<String, pty::PtySession>>,
    /// Absolute path of the currently selected project, if any.
    pub active_project: Mutex<Option<PathBuf>>,
    /// Cancel flag for an in-progress `gh auth login`; setting it stops the
    /// monitored child. `None` when no login flow is running.
    pub gh_login: Mutex<Option<std::sync::Arc<std::sync::atomic::AtomicBool>>>,
}

impl Default for AppState {
    fn default() -> Self {
        Self {
            sessions: Mutex::new(HashMap::new()),
            active_project: Mutex::new(None),
            gh_login: Mutex::new(None),
        }
    }
}

#[tauri::command]
fn pty_spawn(
    id: String,
    cols: u16,
    rows: u16,
    on_output: Channel,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let cwd = state
        .active_project
        .lock()
        .map_err(|e| e.to_string())?
        .clone();
    let session = pty::PtySession::spawn(&pty::default_shell(), cols, rows, cwd, on_output)?;
    state
        .sessions
        .lock()
        .map_err(|e| e.to_string())?
        .insert(id, session);
    Ok(())
}

#[tauri::command]
fn pty_write(id: String, data: String, state: State<'_, AppState>) -> Result<(), String> {
    let mut sessions = state.sessions.lock().map_err(|e| e.to_string())?;
    if let Some(session) = sessions.get_mut(&id) {
        session.write(data.as_bytes())?;
    }
    Ok(())
}

#[tauri::command]
fn pty_resize(
    id: String,
    cols: u16,
    rows: u16,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let sessions = state.sessions.lock().map_err(|e| e.to_string())?;
    if let Some(session) = sessions.get(&id) {
        session.resize(cols, rows)?;
    }
    Ok(())
}

#[tauri::command]
fn pty_kill(id: String, state: State<'_, AppState>) -> Result<(), String> {
    state
        .sessions
        .lock()
        .map_err(|e| e.to_string())?
        .remove(&id);
    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .manage(AppState::default())
        .setup(|app| {
            // Restore the last active project into runtime state on launch.
            let handle = app.handle().clone();
            let state = app.state::<AppState>();
            if let Err(e) = projects::load_active(&handle, &state) {
                eprintln!("failed to load active project: {e}");
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            pty_spawn,
            pty_write,
            pty_resize,
            pty_kill,
            git::git_changes,
            git::git_file_diff,
            git::git_discard,
            git::list_dir,
            git::read_file,
            git::write_file,
            projects::list_projects,
            projects::create_project,
            projects::open_project,
            projects::is_git_repo,
            projects::set_active_project,
            projects::create_worktree,
            projects::set_active_worktree,
            projects::remove_project,
            projects::remove_worktree,
            projects::archive_worktree,
            github::gh_auth_status,
            github::gh_auth_login,
            github::gh_auth_cancel,
            github::gh_auth_logout,
            github::open_external
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
