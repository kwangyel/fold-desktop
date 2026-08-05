use std::path::PathBuf;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager};

/// Persisted authentication state. Currently just the backend-issued JWT; the
/// frontend decodes the token payload for display (user id, email, username).
#[derive(Serialize, Deserialize, Clone, Default)]
#[serde(rename_all = "camelCase")]
pub struct AuthFile {
    token: Option<String>,
}

/// Path to the persisted `auth.json` inside the app config directory
/// (mirrors the `projects.json` handling in `projects.rs`).
fn auth_file(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_config_dir()
        .map_err(|e| format!("failed to resolve config dir: {e}"))?;
    std::fs::create_dir_all(&dir).map_err(|e| format!("failed to create config dir: {e}"))?;
    Ok(dir.join("auth.json"))
}

fn read_file(app: &AppHandle) -> Result<AuthFile, String> {
    let path = auth_file(app)?;
    match std::fs::read_to_string(&path) {
        Ok(contents) => {
            serde_json::from_str(&contents).map_err(|e| format!("failed to parse auth.json: {e}"))
        }
        Err(_) => Ok(AuthFile::default()),
    }
}

fn write_file(app: &AppHandle, data: &AuthFile) -> Result<(), String> {
    let path = auth_file(app)?;
    let contents =
        serde_json::to_string_pretty(data).map_err(|e| format!("failed to serialize auth: {e}"))?;
    std::fs::write(&path, contents).map_err(|e| format!("failed to write auth.json: {e}"))
}

/// Persist the backend session token (JWT).
#[tauri::command(async)]
pub fn auth_save_token(app: AppHandle, token: String) -> Result<(), String> {
    write_file(&app, &AuthFile { token: Some(token) })
}

/// Read the persisted session token, if any.
#[tauri::command(async)]
pub fn auth_get_token(app: AppHandle) -> Result<Option<String>, String> {
    Ok(read_file(&app)?.token)
}

/// Clear the persisted session token (sign out).
#[tauri::command(async)]
pub fn auth_clear_token(app: AppHandle) -> Result<(), String> {
    write_file(&app, &AuthFile::default())
}
