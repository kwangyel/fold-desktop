mod git;
mod pty;

use std::collections::HashMap;
use std::sync::Mutex;


use tauri::ipc::Channel;
use tauri::State;

struct AppState {
    sessions: Mutex<HashMap<String, pty::PtySession>>,
}

impl Default for AppState {
    fn default() -> Self {
        Self {
            sessions: Mutex::new(HashMap::new()),
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
    let session = pty::PtySession::spawn(&pty::default_shell(), cols, rows, on_output)?;
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
        .manage(AppState::default())
        .invoke_handler(tauri::generate_handler![
            pty_spawn,
            pty_write,
            pty_resize,
            pty_kill,
            git::git_changes,
            git::git_file_diff,
            git::git_discard,
            git::read_file,
            git::write_file
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
