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

/// Parse the GitHub owner (user or org) from a remote URL.
fn parse_github_owner(url: &str) -> Option<String> {
    let url = url.trim();
    let path = if let Some(rest) = url.strip_prefix("git@github.com:") {
        rest
    } else if let Some(rest) = url.strip_prefix("ssh://git@github.com/") {
        rest
    } else if let Some(idx) = url.find("github.com/") {
        &url[idx + "github.com/".len()..]
    } else if let Some(idx) = url.find("github.com:") {
        &url[idx + "github.com:".len()..]
    } else {
        return None;
    };

    let owner = path.split('/').next()?.trim_end_matches(".git");
    if owner.is_empty() {
        None
    } else {
        Some(owner.to_string())
    }
}

/// Return the GitHub owner for `origin`, if the repo has a GitHub remote.
pub fn github_owner_from_remote(path: &str) -> Option<String> {
    let output = Command::new("git")
        .args(["remote", "get-url", "origin"])
        .current_dir(path)
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }
    let url = String::from_utf8_lossy(&output.stdout);
    if !url.contains("github.com") {
        return None;
    }
    parse_github_owner(&url)
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GithubRepoOwner {
    login: String,
    avatar_url: String,
}

fn github_repo_owner_via_gh(path: &str) -> Option<GithubRepoOwner> {
    let output = Command::new(gh_bin())
        .args(["repo", "view", "--json", "owner"])
        .current_dir(path)
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }
    let json: serde_json::Value =
        serde_json::from_str(&String::from_utf8_lossy(&output.stdout)).ok()?;
    let owner = json.get("owner")?;
    let login = owner.get("login")?.as_str()?.to_string();
    // `gh` often returns only `{ id, login }` for owner — build the avatar URL ourselves.
    let avatar_url = owner
        .get("avatarUrl")
        .and_then(|v| v.as_str())
        .map(|s| s.to_string())
        .unwrap_or_else(|| format!("https://avatars.githubusercontent.com/{login}?s=64"));
    Some(GithubRepoOwner { login, avatar_url })
}

/// Resolve the GitHub repo owner and avatar URL for the repo at `path`.
pub fn github_repo_owner(path: &str) -> Option<GithubRepoOwner> {
    if !detect_github_remote(path) {
        return None;
    }
    if let Some(owner) = github_repo_owner_via_gh(path) {
        return Some(owner);
    }
    let login = github_owner_from_remote(path)?;
    Some(GithubRepoOwner {
        login: login.clone(),
        avatar_url: format!("https://avatars.githubusercontent.com/{login}?s=64"),
    })
}

/// Expose GitHub remote detection to the frontend.
#[tauri::command]
pub fn git_github_remote(path: String) -> bool {
    detect_github_remote(&path)
}

/// Expose GitHub owner lookup for a repo's `origin` remote.
#[tauri::command]
pub fn git_github_owner(path: String) -> Option<String> {
    github_owner_from_remote(&path)
}

/// Expose GitHub repo owner + avatar for the repo at `path`.
#[tauri::command]
pub fn git_github_repo_owner(path: String) -> Option<GithubRepoOwner> {
    github_repo_owner(&path)
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

/// Result of checking whether a repository name can be created under the
/// authenticated GitHub account.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GhRepoNameCheck {
    available: bool,
    /// Human-readable reason when `available` is false, or auth/format issues.
    message: Option<String>,
    /// Authenticated GitHub login that would own the new repo.
    owner: Option<String>,
}

/// Validate GitHub repository name rules (subset of GitHub's constraints).
fn validate_github_repo_name(name: &str) -> Option<&'static str> {
    if name.is_empty() {
        return Some("Repository name is required");
    }
    if name.len() > 100 {
        return Some("Repository name must be 100 characters or fewer");
    }
    if name == "." || name == ".." {
        return Some("Repository name is invalid");
    }
    if name.ends_with(".git") {
        return Some("Repository name cannot end with .git");
    }
    if !name
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_' || c == '.')
    {
        return Some(
            "Repository name may only contain letters, numbers, hyphens, underscores, and periods",
        );
    }
    None
}

/// Whether `name` can be created as a new private repo for the authenticated user.
#[tauri::command]
pub fn gh_repo_name_check(name: String) -> Result<GhRepoNameCheck, String> {
    let name = name.trim();
    if let Some(msg) = validate_github_repo_name(name) {
        return Ok(GhRepoNameCheck {
            available: false,
            message: Some(msg.to_string()),
            owner: None,
        });
    }

    let status = gh_auth_status()?;
    let Some(owner) = status.username else {
        return Ok(GhRepoNameCheck {
            available: false,
            message: Some(
                "Connect GitHub via Connect App before creating a repository".to_string(),
            ),
            owner: None,
        });
    };

    // 404 / Not Found ⇒ name is free under this owner.
    let endpoint = format!("repos/{owner}/{name}");
    let output = gh(&["api", &endpoint])?;
    if output.status.success() {
        return Ok(GhRepoNameCheck {
            available: false,
            message: Some(format!("@{owner}/{name} already exists on GitHub")),
            owner: Some(owner),
        });
    }

    let stderr = String::from_utf8_lossy(&output.stderr);
    let stdout = String::from_utf8_lossy(&output.stdout);
    let body = format!("{stderr}\n{stdout}");
    // gh prints HTTP 404 in stderr for missing repos.
    if body.contains("404") || body.contains("Not Found") || body.contains("not found") {
        return Ok(GhRepoNameCheck {
            available: true,
            message: None,
            owner: Some(owner),
        });
    }
    // Invalid names can yield 422 / 400 from the GitHub API.
    if body.contains("422") || body.contains("400") || body.contains("name already exists") {
        let detail = stderr.trim();
        return Ok(GhRepoNameCheck {
            available: false,
            message: Some(if detail.is_empty() {
                format!("'{name}' cannot be used as a GitHub repository name")
            } else {
                detail.to_string()
            }),
            owner: Some(owner),
        });
    }

    Err(if stderr.trim().is_empty() {
        format!("failed to check repository name availability for {name}")
    } else {
        stderr.trim().to_string()
    })
}

/// Create a private GitHub repository from an existing local git repo at `path`,
/// named `name`, with `origin` pointing at the new remote. Pushes when the
/// local repo already has commits.
pub fn create_private_github_repo(path: &str, name: &str) -> Result<(), String> {
    let name = name.trim();
    let check = gh_repo_name_check(name.to_string())?;
    if !check.available {
        return Err(check
            .message
            .unwrap_or_else(|| format!("'{name}' is not available on GitHub")));
    }

    if detect_github_remote(path) {
        return Err("project already has a GitHub remote".to_string());
    }

    // `gh repo create --remote origin` fails if any origin remote already exists.
    let origin_exists = Command::new("git")
        .args(["remote", "get-url", "origin"])
        .current_dir(path)
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .map(|s| s.success())
        .unwrap_or(false);
    if origin_exists {
        return Err(
            "project already has an origin remote; remove it before creating on GitHub"
                .to_string(),
        );
    }

    let has_commits = Command::new("git")
        .args(["rev-parse", "HEAD"])
        .current_dir(path)
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .map(|s| s.success())
        .unwrap_or(false);

    let mut args = vec![
        "repo",
        "create",
        name,
        "--private",
        "--source",
        path,
        "--remote",
        "origin",
    ];
    if has_commits {
        args.push("--push");
    }

    let output = Command::new(gh_bin())
        .args(&args)
        .output()
        .map_err(|e| format!("failed to run gh repo create: {e}"))?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        return Err(if stderr.is_empty() {
            "gh repo create failed".to_string()
        } else {
            stderr
        });
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
