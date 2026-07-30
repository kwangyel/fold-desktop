use std::io::Read;
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::thread;
use std::time::Duration;

use serde::Serialize;
use tauri::ipc::{Channel, InvokeResponseBody};
use tauri::State;

use crate::AppState;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GhStatus {
    authenticated: bool,
    username: Option<String>,
}

/// Resolve the `gh` executable. Plain `"gh"` relies on inherited PATH, which
/// matches how the existing `git` commands are invoked.
fn gh_bin() -> &'static str {
    "gh"
}

fn gh(args: &[&str]) -> Result<std::process::Output, String> {
    Command::new(gh_bin())
        .args(args)
        .output()
        .map_err(|e| format!("failed to run gh {}: {e}", args.join(" ")))
}

/// Report whether the user is logged into GitHub via `gh`, and if so as whom.
/// `gh api user --jq .login` prints the account login and exits 0 only when a
/// valid token exists.
#[tauri::command]
pub fn gh_auth_status() -> Result<GhStatus, String> {
    let output = gh(&["api", "user", "--jq", ".login"])?;
    if !output.status.success() {
        return Ok(GhStatus {
            authenticated: false,
            username: None,
        });
    }
    let login = String::from_utf8_lossy(&output.stdout).trim().to_string();
    if login.is_empty() {
        return Ok(GhStatus {
            authenticated: false,
            username: None,
        });
    }
    Ok(GhStatus {
        authenticated: true,
        username: Some(login),
    })
}

/// Log out of GitHub, removing gh's stored credentials for github.com. Scoped
/// to the currently active account when one is known so the flag is
/// unambiguous (and thus non-interactive).
#[tauri::command]
pub fn gh_auth_logout() -> Result<(), String> {
    let mut args = vec!["auth", "logout", "--hostname", "github.com"];
    let login = gh(&["api", "user", "--jq", ".login"])
        .ok()
        .filter(|o| o.status.success())
        .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string())
        .filter(|s| !s.is_empty());
    if let Some(user) = login.as_deref() {
        args.push("--user");
        args.push(user);
    }
    let output = gh(&args)?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        return Err(if stderr.is_empty() {
            "gh auth logout failed".to_string()
        } else {
            stderr
        });
    }
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

/// Start the browser (device) OAuth login and stream its output.
///
/// Run without a TTY (stdin = null) on purpose: in that mode `gh auth login
/// --web` skips all interactive prompts, prints the one-time code + device URL
/// (to stderr) and polls GitHub automatically until authorized. We capture both
/// stdout and stderr.
///
/// Crucially, we never kill the process on success — gh must be allowed to run
/// to completion so it fully persists the credentials (keychain + git config).
/// A monitor thread owns the child, reaps it when it exits naturally, and only
/// kills it if the shared cancel flag is set (via `gh_auth_cancel`).
///
/// When the child exits (naturally or via cancel), a sentinel line
/// `__GH_EXIT__:<code>` is sent on the channel so the frontend can stop waiting.
#[tauri::command]
pub fn gh_auth_login(on_output: Channel, state: State<'_, AppState>) -> Result<(), String> {
    // Cancel any prior login flow still in progress.
    if let Some(prev) = state.gh_login.lock().map_err(|e| e.to_string())?.take() {
        prev.store(true, Ordering::SeqCst);
    }

    let mut child = Command::new(gh_bin())
        .args([
            "auth",
            "login",
            "--hostname",
            "github.com",
            "--git-protocol",
            "https",
            "--web",
        ])
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("failed to start gh auth login: {e}"))?;

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

        // Tell the frontend the process is done so it can stop the spinner if
        // auth never completed (timeout / cancel / gh error).
        let marker = format!("\n__GH_EXIT__:{exit_code}\n");
        let _ = exit_channel.send(InvokeResponseBody::Raw(marker.into_bytes()));
    });

    *state.gh_login.lock().map_err(|e| e.to_string())? = Some(cancel);
    Ok(())
}

/// Stop an in-progress login flow (used when the user cancels/closes the
/// dialog before authorizing). Never called on success.
#[tauri::command]
pub fn gh_auth_cancel(state: State<'_, AppState>) -> Result<(), String> {
    if let Some(cancel) = state.gh_login.lock().map_err(|e| e.to_string())?.take() {
        cancel.store(true, Ordering::SeqCst);
    }
    Ok(())
}

/// Open a URL in the user's default web browser.
#[tauri::command]
pub fn open_external(url: String) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    let mut cmd = {
        let mut c = Command::new("open");
        c.arg(&url);
        c
    };
    #[cfg(target_os = "windows")]
    let mut cmd = {
        let mut c = Command::new("cmd");
        c.args(["/C", "start", "", &url]);
        c
    };
    #[cfg(all(unix, not(target_os = "macos")))]
    let mut cmd = {
        let mut c = Command::new("xdg-open");
        c.arg(&url);
        c
    };

    cmd.spawn()
        .map_err(|e| format!("failed to open browser: {e}"))?;
    Ok(())
}
