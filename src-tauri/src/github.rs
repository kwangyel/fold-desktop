use std::io::Read;
use std::path::PathBuf;
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, OnceLock};
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

fn is_executable(path: &std::path::Path) -> bool {
    path.is_file()
}

fn home_dir() -> Option<PathBuf> {
    std::env::var_os("HOME")
        .or_else(|| std::env::var_os("USERPROFILE"))
        .map(PathBuf::from)
}

/// Resolve the `gh` executable.
///
/// macOS GUI / Tauri apps often inherit a stripped PATH that omits Homebrew and
/// Conductor-injected bins. Search PATH first, then common install locations
/// (same approach as the agent CLI resolvers).
fn gh_bin() -> String {
    static CACHED: OnceLock<String> = OnceLock::new();
    CACHED
        .get_or_init(|| {
            if Command::new("gh")
                .arg("--version")
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .status()
                .map(|s| s.success())
                .unwrap_or(false)
            {
                if let Ok(which) = Command::new("which").arg("gh").output() {
                    if which.status.success() {
                        let path = String::from_utf8_lossy(&which.stdout).trim().to_string();
                        if !path.is_empty() {
                            return path;
                        }
                    }
                }
                return "gh".to_string();
            }

            let mut candidates: Vec<PathBuf> = Vec::new();
            if let Some(home) = home_dir() {
                candidates.push(home.join(".local/bin/gh"));
                candidates.push(home.join("bin/gh"));
                candidates.push(
                    home.join("Library/Application Support/com.conductor.app/bin/gh"),
                );
                candidates.push(home.join(".bun/bin/gh"));
            }
            candidates.push(PathBuf::from("/opt/homebrew/bin/gh"));
            candidates.push(PathBuf::from("/usr/local/bin/gh"));

            if let Some(path) = std::env::var_os("PATH") {
                for dir in std::env::split_paths(&path) {
                    candidates.push(dir.join("gh"));
                }
            }

            for candidate in candidates {
                if !is_executable(&candidate) {
                    continue;
                }
                let resolved = std::fs::canonicalize(&candidate).unwrap_or(candidate);
                if Command::new(&resolved)
                    .arg("--version")
                    .stdout(Stdio::null())
                    .stderr(Stdio::null())
                    .status()
                    .map(|s| s.success())
                    .unwrap_or(false)
                {
                    return resolved.to_string_lossy().to_string();
                }
            }

            "gh".to_string()
        })
        .clone()
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

/// Check if the git repo at `path` has a GitHub remote as `origin`.
pub fn detect_github_remote(path: &str) -> bool {
    Command::new("git")
        .args(["remote", "get-url", "origin"])
        .current_dir(path)
        .output()
        .map(|o| {
            o.status.success()
                && String::from_utf8_lossy(&o.stdout).contains("github.com")
        })
        .unwrap_or(false)
}

/// Expose GitHub remote detection to the frontend.
#[tauri::command]
pub fn git_github_remote(path: String) -> bool {
    detect_github_remote(&path)
}

/// Open the GitHub PR creation page in the browser via `gh pr create --web`.
#[tauri::command]
pub fn gh_pr_create_web(worktree_path: String) -> Result<(), String> {
    Command::new(gh_bin())
        .args(["pr", "create", "--web"])
        .current_dir(&worktree_path)
        .spawn()
        .map_err(|e| format!("failed to run gh pr create --web: {e}"))?;
    Ok(())
}

/// Fetch the PR associated with the current branch as raw JSON (parsed on the
/// frontend). When no PR exists for the branch, `gh` exits non-zero — we return
/// an error whose message starts with `NO_PR` so the caller can distinguish
/// "no PR yet" from a genuine failure.
#[tauri::command]
pub fn gh_pr_view(worktree_path: String) -> Result<String, String> {
    let output = Command::new(gh_bin())
        .args([
            "pr",
            "view",
            "--json",
            "number,title,body,state,author,headRefName,baseRefName,url,isDraft,mergeable,files,additions,deletions,changedFiles",
        ])
        .current_dir(&worktree_path)
        .output()
        .map_err(|e| format!("failed to run gh pr view: {e}"))?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        if stderr.contains("no pull requests found")
            || stderr.contains("no open pull requests")
        {
            return Err(format!("NO_PR: {}", stderr.trim()));
        }
        return Err(stderr.trim().to_string());
    }
    Ok(String::from_utf8_lossy(&output.stdout).to_string())
}

/// Resolve the repository's preferred merge method, preferring squash, then a
/// merge commit, then rebase — mirroring the repo's actual GitHub settings.
#[tauri::command]
pub fn gh_pr_merge_method(worktree_path: String) -> Result<String, String> {
    let output = Command::new(gh_bin())
        .args([
            "repo",
            "view",
            "--json",
            "mergeCommitAllowed,squashMergeAllowed,rebaseMergeAllowed",
        ])
        .current_dir(&worktree_path)
        .output()
        .map_err(|e| format!("failed to run gh repo view: {e}"))?;
    if !output.status.success() {
        return Err(String::from_utf8_lossy(&output.stderr).trim().to_string());
    }
    let json = String::from_utf8_lossy(&output.stdout);
    let value: serde_json::Value =
        serde_json::from_str(&json).map_err(|e| e.to_string())?;
    let allowed = |key: &str| value.get(key).and_then(|v| v.as_bool()).unwrap_or(false);
    let method = if allowed("squashMergeAllowed") {
        "squash"
    } else if allowed("mergeCommitAllowed") {
        "merge"
    } else if allowed("rebaseMergeAllowed") {
        "rebase"
    } else {
        "squash"
    };
    Ok(method.to_string())
}

/// Merge the PR for the current branch using the given method
/// (`squash` | `merge` | `rebase`). On failure the `gh` stderr is returned so
/// the UI can surface conflicts or permission errors. The branch is retained;
/// worktree cleanup is handled separately by the archive flow.
#[tauri::command]
pub fn gh_pr_merge(worktree_path: String, method: String) -> Result<(), String> {
    let method_flag = match method.as_str() {
        "squash" => "--squash",
        "merge" => "--merge",
        "rebase" => "--rebase",
        other => return Err(format!("unknown merge method: {other}")),
    };
    let output = Command::new(gh_bin())
        .args(["pr", "merge", method_flag, "--delete-branch=false"])
        .current_dir(&worktree_path)
        .output()
        .map_err(|e| format!("failed to run gh pr merge: {e}"))?;
    if !output.status.success() {
        return Err(String::from_utf8_lossy(&output.stderr).trim().to_string());
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
