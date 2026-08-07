//! Codex harness via local `codex` CLI.
//!
//! Auth reuses machine credentials (`codex login` / `~/.codex/auth.json` /
//! `OPENAI_API_KEY` / `CODEX_API_KEY`). Chat runs use
//! `codex exec --json` in the worktree.
//!
//! @see https://developers.openai.com/codex/cli/reference
//! @see https://developers.openai.com/codex/noninteractive

use std::io::Read;
use std::path::PathBuf;
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::thread;
use std::time::Duration;

use serde::{Deserialize, Serialize};
use tauri::ipc::{Channel, InvokeResponseBody};
use tauri::State;

use crate::bin_cache::BinCache;
use crate::pty::PtySession;
use crate::AppState;

/// Resolved `codex` CLI path, cached so status checks don't re-probe PATH.
static CODEX_BIN: BinCache = BinCache::new();

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CodexStatus {
    installed: bool,
    authenticated: bool,
    /// `"subscription"` | `"apiKey"` when authenticated.
    method: Option<String>,
}

/// Model catalog entry shaped like Claude / Cursor `ModelInfo`.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CodexModelInfo {
    value: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    resolved_model: Option<String>,
    display_name: String,
    description: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    supports_effort: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    supported_effort_levels: Option<Vec<String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    supports_adaptive_thinking: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    supports_fast_mode: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    supports_auto_mode: Option<bool>,
}

fn home_dir() -> Option<PathBuf> {
    std::env::var_os("HOME")
        .or_else(|| std::env::var_os("USERPROFILE"))
        .map(PathBuf::from)
}

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

/// Resolve the codex CLI, reusing the cached path when still fresh.
fn resolve_codex_bin() -> Option<PathBuf> {
    CODEX_BIN.get(probe_codex_bin)
}

/// Resolve the `codex` binary (PATH + common install dirs + Conductor bins).
fn probe_codex_bin() -> Option<PathBuf> {
    if crate::proc::version_ok("codex") {
        return Some(crate::proc::which("codex").unwrap_or_else(|| PathBuf::from("codex")));
    }

    let mut candidates: Vec<PathBuf> = Vec::new();
    if let Some(home) = home_dir() {
        candidates.push(home.join(".local/bin/codex"));
        candidates.push(home.join("bin/codex"));
        candidates.push(home.join(".npm-global/bin/codex"));
        candidates.push(home.join(".bun/bin/codex"));
        candidates.push(home.join(".cargo/bin/codex"));
        candidates.push(
            home.join("Library/Application Support/com.conductor.app/bin/codex"),
        );
    }
    candidates.push(PathBuf::from("/opt/homebrew/bin/codex"));
    candidates.push(PathBuf::from("/usr/local/bin/codex"));

    if let Some(path) = std::env::var_os("PATH") {
        for dir in std::env::split_paths(&path) {
            candidates.push(dir.join("codex"));
        }
    }

    // PATH entries repeat and symlink onto each other; verifying the same
    // binary twice means paying another CLI startup for nothing.
    let mut tried: Vec<PathBuf> = Vec::new();
    for candidate in candidates {
        if !is_executable(&candidate) {
            continue;
        }
        let resolved = std::fs::canonicalize(&candidate).unwrap_or(candidate);
        if tried.contains(&resolved) {
            continue;
        }
        tried.push(resolved.clone());
        if crate::proc::version_ok(&resolved) {
            return Some(resolved);
        }
    }

    None
}

fn is_installed() -> bool {
    resolve_codex_bin().is_some()
}

fn env_auth_method() -> Option<&'static str> {
    let has_codex = std::env::var("CODEX_API_KEY")
        .ok()
        .filter(|s| !s.is_empty())
        .is_some();
    let has_openai = std::env::var("OPENAI_API_KEY")
        .ok()
        .filter(|s| !s.is_empty())
        .is_some();
    if has_codex || has_openai {
        Some("apiKey")
    } else {
        None
    }
}

/// File-based credentials (`cli_auth_credentials_store = "file"`).
fn auth_file_present() -> bool {
    let codex_home = std::env::var_os("CODEX_HOME")
        .map(PathBuf::from)
        .or_else(|| home_dir().map(|h| h.join(".codex")));
    codex_home
        .map(|h| h.join("auth.json").is_file())
        .unwrap_or(false)
}

/// `codex login status` exits 0 when credentials are present. Bounded: this
/// runs inside a status check the UI is waiting on.
fn login_status_ok(bin: &std::path::Path) -> bool {
    crate::proc::status_ok_with_timeout(
        Command::new(bin).args(["login", "status"]),
        Duration::from_secs(10),
    )
}

#[tauri::command]
pub async fn codex_status(force: Option<bool>) -> Result<CodexStatus, String> {
    tauri::async_runtime::spawn_blocking(move || status_blocking(force))
        .await
        .map_err(|e| format!("codex_status failed: {e}"))?
}

fn status_blocking(force: Option<bool>) -> Result<CodexStatus, String> {
    if force.unwrap_or(false) {
        CODEX_BIN.clear();
    }
    let installed = is_installed();
    if !installed {
        return Ok(CodexStatus {
            installed: false,
            authenticated: false,
            method: None,
        });
    }

    if let Some(method) = env_auth_method() {
        return Ok(CodexStatus {
            installed: true,
            authenticated: true,
            method: Some(method.to_string()),
        });
    }

    let bin = resolve_codex_bin().ok_or_else(|| "Codex CLI not found".to_string())?;
    // Prefer the cheap auth.json check before spawning `codex login status`.
    if auth_file_present() || login_status_ok(&bin) {
        return Ok(CodexStatus {
            installed: true,
            authenticated: true,
            // File/keychain login is typically ChatGPT subscription auth.
            method: Some("subscription".to_string()),
        });
    }

    Ok(CodexStatus {
        installed: true,
        authenticated: false,
        method: None,
    })
}

/// Start interactive `codex login` in a PTY (browser OAuth / device auth).
#[tauri::command(async)]
pub fn codex_login(on_output: Channel, state: State<'_, AppState>) -> Result<(), String> {
    {
        let mut slot = state.codex_login.lock().map_err(|e| e.to_string())?;
        let _ = slot.take();
    }

    let bin = resolve_codex_bin().ok_or_else(|| {
        "Codex CLI not found. Install with `npm i -g @openai/codex` \
         (https://developers.openai.com/codex/cli)"
            .to_string()
    })?;

    let session = PtySession::spawn_command(
        bin.to_str().ok_or("invalid codex path")?,
        &["login"],
        100,
        28,
        None,
        on_output,
    )?;
    *state.codex_login.lock().map_err(|e| e.to_string())? = Some(session);
    Ok(())
}

#[tauri::command]
pub fn codex_login_write(data: String, state: State<'_, AppState>) -> Result<(), String> {
    let mut slot = state.codex_login.lock().map_err(|e| e.to_string())?;
    if let Some(session) = slot.as_mut() {
        session.write(data.as_bytes())?;
    }
    Ok(())
}

#[tauri::command(async)]
pub fn codex_login_cancel(state: State<'_, AppState>) -> Result<(), String> {
    let mut slot = state.codex_login.lock().map_err(|e| e.to_string())?;
    let _ = slot.take();
    Ok(())
}

/// Codex has no `models` CLI — return a documented catalog for the picker.
#[tauri::command(async)]
pub fn codex_list_models() -> Result<Vec<CodexModelInfo>, String> {
    Ok(vec![
        CodexModelInfo {
            value: "gpt-5.4".into(),
            resolved_model: Some("gpt-5.4".into()),
            display_name: "GPT-5.4".into(),
            description: "GPT-5.4 · Default Codex coding model".into(),
            supports_effort: Some(true),
            supported_effort_levels: Some(vec![
                "low".into(),
                "medium".into(),
                "high".into(),
                "xhigh".into(),
            ]),
            supports_adaptive_thinking: None,
            supports_fast_mode: Some(true),
            supports_auto_mode: None,
        },
        CodexModelInfo {
            value: "gpt-5.4-mini".into(),
            resolved_model: Some("gpt-5.4-mini".into()),
            display_name: "GPT-5.4 Mini".into(),
            description: "GPT-5.4 Mini · Faster, lighter coding tasks".into(),
            supports_effort: Some(true),
            supported_effort_levels: Some(vec![
                "low".into(),
                "medium".into(),
                "high".into(),
            ]),
            supports_adaptive_thinking: None,
            supports_fast_mode: None,
            supports_auto_mode: None,
        },
        CodexModelInfo {
            value: "gpt-5.5".into(),
            resolved_model: Some("gpt-5.5".into()),
            display_name: "GPT-5.5".into(),
            description: "GPT-5.5 · Latest Codex model when available".into(),
            supports_effort: Some(true),
            supported_effort_levels: Some(vec![
                "low".into(),
                "medium".into(),
                "high".into(),
                "xhigh".into(),
            ]),
            supports_adaptive_thinking: None,
            supports_fast_mode: None,
            supports_auto_mode: None,
        },
        CodexModelInfo {
            value: "o3".into(),
            resolved_model: Some("o3".into()),
            display_name: "o3".into(),
            description: "o3 · Strong reasoning for complex tasks".into(),
            supports_effort: Some(true),
            supported_effort_levels: Some(vec![
                "low".into(),
                "medium".into(),
                "high".into(),
            ]),
            supports_adaptive_thinking: None,
            supports_fast_mode: None,
            supports_auto_mode: None,
        },
    ])
}

fn stream_pipe<R: Read + Send + 'static>(reader: R, on_output: Channel) {
    crate::stream::pipe_to_channel(reader, on_output);
}

/// Quote a value as a TOML basic string for `codex -c key=value` overrides.
fn toml_str(value: &str) -> String {
    format!("\"{}\"", value.replace('\\', "\\\\").replace('"', "\\\""))
}

/// Run `codex exec --json` in a worktree. Emits `__CODEX_EXIT__:<code>` on exit.
#[tauri::command(async)]
pub fn codex_agent_run(
    session_id: String,
    prompt: String,
    worktree: String,
    model: Option<String>,
    effort: Option<String>,
    on_output: Channel,
    state: State<'_, AppState>,
) -> Result<(), String> {
    if let Some(prev) = state
        .codex_agents
        .lock()
        .map_err(|e| e.to_string())?
        .remove(&session_id)
    {
        prev.store(true, Ordering::SeqCst);
    }

    // Register the cancel flag before the child is spawned. Commands run
    // concurrently, so a cancel issued while the agent is still starting must
    // find a flag to set — otherwise the run would keep going after the UI has
    // already returned to idle.
    let cancel = Arc::new(AtomicBool::new(false));
    state
        .codex_agents
        .lock()
        .map_err(|e| e.to_string())?
        .insert(session_id.clone(), cancel.clone());

    let status = status_blocking(None)?;
    if !status.authenticated {
        return Err(
            "Codex is not authenticated. Open Connect Harness and log in.".to_string(),
        );
    }

    let bin = resolve_codex_bin().ok_or_else(|| "Codex CLI not found".to_string())?;
    let worktree_path = PathBuf::from(&worktree);
    if !worktree_path.is_dir() {
        return Err(format!("worktree path does not exist: {worktree}"));
    }

    // workspace-write so the agent can edit files in the Fold worktree.
    let mut args: Vec<String> = vec![
        "exec".into(),
        "--json".into(),
        "--sandbox".into(),
        "workspace-write".into(),
        "-C".into(),
        worktree.clone(),
    ];
    if let Some(m) = model.filter(|s| !s.is_empty()) {
        args.push("-m".into());
        args.push(m);
    }
    if let Some(e) = effort.filter(|s| !s.is_empty()) {
        args.push("-c".into());
        args.push(format!("model_reasoning_effort={}", toml_str(&e)));
    }

    // Register Fold's `fold_ask_user` MCP tool so Codex can ask the user
    // clarifying questions. Codex accepts MCP servers as per-run config
    // overrides, so this needs no config file on disk.
    let fold_mcp = if let Some((node, script)) = crate::claude::resolve_fold_mcp_server() {
        args.push("-c".into());
        args.push(format!("mcp_servers.fold.command={}", toml_str(&node)));
        args.push("-c".into());
        args.push(format!(
            "mcp_servers.fold.args=[{}, {}]",
            toml_str(&script),
            toml_str(&worktree)
        ));
        true
    } else {
        false
    };

    let run_prompt = if fold_mcp {
        crate::claude::with_fold_ask_hint(&prompt)
    } else {
        prompt.clone()
    };
    args.push(run_prompt);

    let mut child = Command::new(&bin)
        .args(&args)
        .current_dir(&worktree_path)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("failed to start Codex agent: {e}"))?;

    if let Some(out) = child.stdout.take() {
        stream_pipe(out, on_output.clone());
    }
    if let Some(err) = child.stderr.take() {
        stream_pipe(err, on_output.clone());
    }

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

        let marker = format!("\n__CODEX_EXIT__:{exit_code}\n");
        let _ = exit_channel.send(InvokeResponseBody::Raw(marker.into_bytes()));
    });

    Ok(())
}

#[tauri::command(async)]
pub fn codex_agent_cancel(session_id: String, state: State<'_, AppState>) -> Result<(), String> {
    if let Some(cancel) = state
        .codex_agents
        .lock()
        .map_err(|e| e.to_string())?
        .remove(&session_id)
    {
        cancel.store(true, Ordering::SeqCst);
    }
    Ok(())
}
