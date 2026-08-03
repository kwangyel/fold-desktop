use std::io::Read;
use std::path::PathBuf;
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::thread;
use std::time::Duration;

use serde::Serialize;
use tauri::ipc::{Channel, InvokeResponseBody};
use tauri::State;

use crate::pty::PtySession;
use crate::AppState;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ClaudeStatus {
    installed: bool,
    authenticated: bool,
    method: Option<String>,
}

fn home_dir() -> Option<PathBuf> {
    std::env::var_os("HOME")
        .or_else(|| std::env::var_os("USERPROFILE"))
        .map(PathBuf::from)
}

/// Whether a path looks like an executable we can launch.
fn is_executable(path: &std::path::Path) -> bool {
    if !path.is_file() {
        return false;
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        path.metadata()
            .map(|m| m.permissions().mode() & 0o111 != 0)
            .unwrap_or(false)
    }
    #[cfg(not(unix))]
    {
        true
    }
}

/// Resolve the `claude` binary to an absolute path when possible.
///
/// macOS GUI / Tauri apps often inherit a stripped PATH that omits shell-only
/// dirs like `~/.local/bin` (where the Claude Code installer puts the binary).
/// Search PATH first, then common install locations.
fn resolve_claude_bin() -> Option<PathBuf> {
    // 1) Plain PATH lookup (works when launched from a configured shell).
    if Command::new("claude")
        .arg("--version")
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .map(|s| s.success())
        .unwrap_or(false)
    {
        if let Ok(which) = Command::new("which").arg("claude").output() {
            if which.status.success() {
                let path = String::from_utf8_lossy(&which.stdout).trim().to_string();
                if !path.is_empty() {
                    return Some(PathBuf::from(path));
                }
            }
        }
        return Some(PathBuf::from("claude"));
    }

    // 2) Well-known install locations the CLI installer / package managers use.
    let mut candidates: Vec<PathBuf> = Vec::new();
    if let Some(home) = home_dir() {
        candidates.push(home.join(".local/bin/claude"));
        candidates.push(home.join("bin/claude"));
        candidates.push(home.join(".npm-global/bin/claude"));
        candidates.push(home.join(".bun/bin/claude"));
        candidates.push(home.join(".cargo/bin/claude"));
        candidates.push(home.join("homebrew/bin/claude"));
    }
    candidates.push(PathBuf::from("/opt/homebrew/bin/claude"));
    candidates.push(PathBuf::from("/usr/local/bin/claude"));

    // Also probe every PATH entry (covers Conductor-injected bins etc.).
    if let Some(path) = std::env::var_os("PATH") {
        for dir in std::env::split_paths(&path) {
            candidates.push(dir.join("claude"));
        }
    }

    for candidate in candidates {
        if !is_executable(&candidate) {
            continue;
        }
        let resolved = std::fs::canonicalize(&candidate).unwrap_or(candidate);
        let ok = Command::new(&resolved)
            .arg("--version")
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status()
            .map(|s| s.success())
            .unwrap_or(false);
        if ok {
            return Some(resolved);
        }
    }

    None
}

fn is_installed() -> bool {
    resolve_claude_bin().is_some()
}

fn env_auth_method() -> Option<&'static str> {
    let has_api = std::env::var("ANTHROPIC_API_KEY")
        .ok()
        .filter(|s| !s.is_empty())
        .is_some();
    let has_oauth = std::env::var("CLAUDE_CODE_OAUTH_TOKEN")
        .ok()
        .filter(|s| !s.is_empty())
        .is_some();
    if has_api || has_oauth {
        Some("apiKey")
    } else {
        None
    }
}

/// Non-interactive credential probe (no TTY). Mirrors Conductor: reuse the
/// machine's Claude Code login — keychain on macOS, credentials file elsewhere.
fn subscription_authenticated() -> bool {
    #[cfg(target_os = "macos")]
    {
        let user = std::env::var("USER").unwrap_or_default();
        Command::new("security")
            .args([
                "find-generic-password",
                "-a",
                &user,
                "-s",
                "Claude Code-credentials",
                "-w",
            ])
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status()
            .map(|s| s.success())
            .unwrap_or(false)
    }
    #[cfg(not(target_os = "macos"))]
    {
        let home = std::env::var("HOME")
            .or_else(|_| std::env::var("USERPROFILE"))
            .ok();
        home.map(|h| PathBuf::from(h).join(".claude").join(".credentials.json").is_file())
            .unwrap_or(false)
    }
}

/// Report whether the Claude Code CLI is installed and authenticated.
#[tauri::command]
pub fn claude_status() -> Result<ClaudeStatus, String> {
    let installed = is_installed();
    if !installed {
        return Ok(ClaudeStatus {
            installed: false,
            authenticated: false,
            method: None,
        });
    }

    if let Some(method) = env_auth_method() {
        return Ok(ClaudeStatus {
            installed: true,
            authenticated: true,
            method: Some(method.to_string()),
        });
    }

    if subscription_authenticated() {
        return Ok(ClaudeStatus {
            installed: true,
            authenticated: true,
            method: Some("subscription".to_string()),
        });
    }

    Ok(ClaudeStatus {
        installed: true,
        authenticated: false,
        method: None,
    })
}

/// Start an interactive Claude Code login in a PTY (Ink TUI requires a real TTY).
/// Credentials persist to the machine keychain / credential store — nothing is
/// saved app-side. The frontend should write `/login\r` shortly after spawn.
#[tauri::command]
pub fn claude_login(on_output: Channel, state: State<'_, AppState>) -> Result<(), String> {
    // Drop any prior login session (Drop kills the child).
    {
        let mut slot = state.claude_login.lock().map_err(|e| e.to_string())?;
        let _ = slot.take();
    }

    let bin = resolve_claude_bin().ok_or_else(|| {
        "Claude Code CLI not found. Install it from https://docs.anthropic.com/en/docs/claude-code"
            .to_string()
    })?;

    let session = PtySession::spawn_command(
        bin.to_str().ok_or("invalid claude path")?,
        &[],
        100,
        28,
        None,
        on_output,
    )?;
    *state.claude_login.lock().map_err(|e| e.to_string())? = Some(session);
    Ok(())
}

/// Write bytes to the in-progress login PTY (user keystrokes or `/login\r`).
#[tauri::command]
pub fn claude_login_write(data: String, state: State<'_, AppState>) -> Result<(), String> {
    let mut slot = state.claude_login.lock().map_err(|e| e.to_string())?;
    if let Some(session) = slot.as_mut() {
        session.write(data.as_bytes())?;
    }
    Ok(())
}

/// Stop an in-progress login flow by dropping the PTY session.
#[tauri::command]
pub fn claude_login_cancel(state: State<'_, AppState>) -> Result<(), String> {
    let mut slot = state.claude_login.lock().map_err(|e| e.to_string())?;
    let _ = slot.take();
    Ok(())
}

/// Stream a child pipe's bytes to the frontend channel on a background thread.
fn stream_pipe<R: Read + Send + 'static>(mut reader: R, on_output: Channel) {
    thread::spawn(move || {
        let mut buf = [0u8; 4096];
        loop {
            match reader.read(&mut buf) {
                Ok(0) => break,
                Ok(n) => {
                    if on_output
                        .send(InvokeResponseBody::Raw(buf[..n].to_vec()))
                        .is_err()
                    {
                        break;
                    }
                }
                Err(_) => break,
            }
        }
    });
}

/// Run a Claude Code agent in a worktree via `claude -p … --output-format stream-json`.
/// Streams NDJSON events to the channel; emits `__CLAUDE_EXIT__:<code>` on exit.
#[tauri::command]
pub fn claude_agent_run(
    session_id: String,
    prompt: String,
    worktree: String,
    model: Option<String>,
    on_output: Channel,
    state: State<'_, AppState>,
) -> Result<(), String> {
    // Cancel any prior run for this session.
    if let Some(prev) = state
        .claude_agents
        .lock()
        .map_err(|e| e.to_string())?
        .remove(&session_id)
    {
        prev.store(true, Ordering::SeqCst);
    }

    let bin = resolve_claude_bin().ok_or_else(|| "Claude Code CLI not found".to_string())?;

    let worktree_path = PathBuf::from(&worktree);
    if !worktree_path.is_dir() {
        return Err(format!("worktree path does not exist: {worktree}"));
    }

    let mut args: Vec<String> = vec![
        "-p".into(),
        prompt,
        "--output-format".into(),
        "stream-json".into(),
        "--verbose".into(),
        "--permission-mode".into(),
        "acceptEdits".into(),
    ];
    if let Some(m) = model.filter(|s| !s.is_empty()) {
        args.push("--model".into());
        args.push(m);
    }

    let mut child = Command::new(&bin)
        .args(&args)
        .current_dir(&worktree_path)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("failed to start claude agent: {e}"))?;

    if let Some(out) = child.stdout.take() {
        stream_pipe(out, on_output.clone());
    }
    if let Some(err) = child.stderr.take() {
        stream_pipe(err, on_output.clone());
    }

    let cancel = Arc::new(AtomicBool::new(false));
    let cancel_monitor = cancel.clone();
    let exit_channel = on_output;
    thread::spawn(move || {
        let exit_code = loop {
            if cancel_monitor.load(Ordering::SeqCst) {
                let _ = child.kill();
                let _ = child.wait();
                break -1;
            }
            match child.try_wait() {
                Ok(Some(status)) => break status.code().unwrap_or(-1),
                Ok(None) => thread::sleep(Duration::from_millis(150)),
                Err(_) => break -1,
            }
        };

        let marker = format!("\n__CLAUDE_EXIT__:{exit_code}\n");
        let _ = exit_channel.send(InvokeResponseBody::Raw(marker.into_bytes()));
    });

    state
        .claude_agents
        .lock()
        .map_err(|e| e.to_string())?
        .insert(session_id, cancel);
    Ok(())
}

/// Cancel a running Claude Code agent for the given session.
#[tauri::command]
pub fn claude_agent_cancel(session_id: String, state: State<'_, AppState>) -> Result<(), String> {
    if let Some(cancel) = state
        .claude_agents
        .lock()
        .map_err(|e| e.to_string())?
        .remove(&session_id)
    {
        cancel.store(true, Ordering::SeqCst);
    }
    Ok(())
}
