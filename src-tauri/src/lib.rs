mod auth;
mod claude;
mod codex;
mod cursor;
mod git;
mod github;
mod opencode;
mod projects;
mod pty;

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::atomic::AtomicBool;
use std::sync::{Arc, Mutex};


use tauri::ipc::Channel;
use tauri::{Manager, State};

pub struct AppState {
    pub sessions: Mutex<HashMap<String, pty::PtySession>>,
    /// Absolute path of the currently selected project, if any.
    pub active_project: Mutex<Option<PathBuf>>,
    /// Cancel flag for an in-progress `gh auth login`; setting it stops the
    /// monitored child. `None` when no login flow is running.
    pub gh_login: Mutex<Option<Arc<AtomicBool>>>,
    /// Interactive Claude Code login PTY (dropped to cancel / kill).
    pub claude_login: Mutex<Option<pty::PtySession>>,
    /// Per-session cancel flags for concurrent Claude Code agent runs.
    pub claude_agents: Mutex<HashMap<String, Arc<AtomicBool>>>,
    /// Stdin handles for running Claude Code agent sidecars, so the frontend can
    /// answer `canUseTool` requests (plan approval, clarifying questions).
    pub claude_agent_stdin: Mutex<HashMap<String, std::process::ChildStdin>>,
    /// Per-session cancel flags for concurrent Cursor agent runs.
    pub cursor_agents: Mutex<HashMap<String, Arc<AtomicBool>>>,
    /// Interactive Codex login PTY (dropped to cancel / kill).
    pub codex_login: Mutex<Option<pty::PtySession>>,
    /// Per-session cancel flags for concurrent Codex agent runs.
    pub codex_agents: Mutex<HashMap<String, Arc<AtomicBool>>>,
    /// Interactive OpenCode login PTY (dropped to cancel / kill).
    pub opencode_login: Mutex<Option<pty::PtySession>>,
    /// Per-session cancel flags for concurrent OpenCode agent runs.
    pub opencode_agents: Mutex<HashMap<String, Arc<AtomicBool>>>,
}

impl Default for AppState {
    fn default() -> Self {
        Self {
            sessions: Mutex::new(HashMap::new()),
            active_project: Mutex::new(None),
            gh_login: Mutex::new(None),
            claude_login: Mutex::new(None),
            claude_agents: Mutex::new(HashMap::new()),
            claude_agent_stdin: Mutex::new(HashMap::new()),
            cursor_agents: Mutex::new(HashMap::new()),
            codex_login: Mutex::new(None),
            codex_agents: Mutex::new(HashMap::new()),
            opencode_login: Mutex::new(None),
            opencode_agents: Mutex::new(HashMap::new()),
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
    let builder = tauri::Builder::default();

    // Single-instance must be registered FIRST (before deep-link) so that when
    // the browser opens the `com.fold.dev://` deep link and the OS launches a
    // second copy of the app, that copy forwards the URL to the already-running
    // instance and then exits — instead of leaving a duplicate window open.
    // The `deep-link` feature makes the plugin forward the callback URL (from
    // argv on Windows/Linux, from the launch event on macOS) to the primary
    // instance's deep-link `onOpenUrl` listener. We also focus the existing
    // window so it comes to the front.
    #[cfg(desktop)]
    let builder = builder.plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| {
        if let Some(window) = app.get_webview_window("main") {
            let _ = window.show();
            let _ = window.unminimize();
            let _ = window.set_focus();
        }
    }));

    builder
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_deep_link::init())
        .plugin(tauri_plugin_http::init())
        // Block browser-like shortcuts (DevTools, reload, find, print, …)
        // and the default right-click menu so the app feels native. Custom
        // React context menus (e.g. Sidebar) still work — they render their
        // own UI; this only suppresses the webview's Inspect Element menu.
        .plugin(tauri_plugin_prevent_default::init())
        .manage(AppState::default())
        .setup(|app| {
            // Restore the last active project into runtime state on launch.
            let handle = app.handle().clone();
            let state = app.state::<AppState>();
            if let Err(e) = projects::load_active(&handle, &state) {
                eprintln!("failed to load active project: {e}");
            }

            // Register the `com.fold.dev://` scheme at runtime so it resolves
            // during `tauri dev` (in release the installer registers it).
            #[cfg(any(target_os = "windows", target_os = "linux"))]
            {
                use tauri_plugin_deep_link::DeepLinkExt;
                if let Err(e) = app.deep_link().register_all() {
                    eprintln!("failed to register deep link scheme: {e}");
                }
            }

            if let Some(window) = app.get_webview_window("main") {
                #[cfg(target_os = "macos")]
                {
                    use window_vibrancy::{
                        apply_vibrancy, NSVisualEffectMaterial, NSVisualEffectState,
                    };
                    let _ = apply_vibrancy(
                        &window,
                        NSVisualEffectMaterial::ContentBackground,
                        Some(NSVisualEffectState::FollowsWindowActiveState),
                        Some(10.0),
                    );
                }

                #[cfg(target_os = "windows")]
                {
                    use window_vibrancy::apply_blur;
                    let _ = apply_blur(&window, Some((30, 30, 34, 255)));
                }
            }

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            pty_spawn,
            pty_write,
            pty_resize,
            pty_kill,
            git::git_list_branches,
            git::git_changes,
            git::git_file_diff,
            git::git_discard,
            git::git_stage,
            git::git_unstage,
            git::git_stage_all,
            git::git_unstage_all,
            git::git_commit,
            git::git_push,
            git::git_staged_diff,
            git::list_dir,
            git::read_file,
            git::write_file,
            git::git_head_commit,
            git::git_changed_since,
            projects::list_projects,
            projects::create_project,
            projects::open_project,
            projects::is_git_repo,
            projects::set_active_project,
            projects::scan_worktree_env,
            projects::create_worktree,
            projects::set_active_worktree,
            projects::remove_project,
            projects::remove_worktree,
            projects::archive_worktree,
            github::gh_auth_status,
            github::gh_auth_login,
            github::gh_auth_cancel,
            github::gh_auth_logout,
            github::git_github_remote,
            github::gh_pr_create_web,
            github::gh_pr_view,
            github::gh_pr_merge_method,
            github::gh_pr_merge,
            github::open_external,
            claude::claude_status,
            claude::claude_login,
            claude::claude_login_write,
            claude::claude_login_cancel,
            claude::claude_list_models,
            claude::claude_agent_run,
            claude::claude_agent_respond,
            claude::claude_agent_cancel,
            cursor::cursor_status,
            cursor::cursor_connect,
            cursor::cursor_disconnect,
            cursor::cursor_list_models,
            cursor::cursor_agent_run,
            cursor::cursor_agent_cancel,
            codex::codex_status,
            codex::codex_login,
            codex::codex_login_write,
            codex::codex_login_cancel,
            codex::codex_list_models,
            codex::codex_agent_run,
            codex::codex_agent_cancel,
            opencode::opencode_status,
            opencode::opencode_login,
            opencode::opencode_login_write,
            opencode::opencode_login_cancel,
            opencode::opencode_list_models,
            opencode::opencode_agent_run,
            opencode::opencode_agent_cancel,
            auth::auth_save_token,
            auth::auth_get_token,
            auth::auth_clear_token
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
