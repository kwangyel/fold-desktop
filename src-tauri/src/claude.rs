use std::io::{Read, Write};
use std::path::PathBuf;
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::thread;
use std::time::Duration;

use serde::{Deserialize, Serialize};
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

/// Model catalog entry from the Claude Agent SDK (`supportedModels()`).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ClaudeModelInfo {
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

/// Resolve the Fold project root (directory with `package.json` + `scripts/`).
fn project_root() -> Option<PathBuf> {
    let manifest = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    if let Some(parent) = manifest.parent() {
        if parent.join("package.json").is_file() {
            return Some(parent.to_path_buf());
        }
    }
    // Walk up from the current working directory (packaged / alternate launch).
    if let Ok(mut dir) = std::env::current_dir() {
        loop {
            if dir.join("package.json").is_file()
                && dir.join("scripts").join("list-claude-models.mjs").is_file()
            {
                return Some(dir);
            }
            if !dir.pop() {
                break;
            }
        }
    }
    None
}

fn resolve_node_bin() -> Option<PathBuf> {
    if Command::new("node")
        .arg("--version")
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .map(|s| s.success())
        .unwrap_or(false)
    {
        return Some(PathBuf::from("node"));
    }
    for candidate in [
        "/usr/local/bin/node",
        "/opt/homebrew/bin/node",
        "/usr/bin/node",
    ] {
        let path = PathBuf::from(candidate);
        if is_executable(&path) {
            return Some(path);
        }
    }
    None
}

/// Context-window + plan session usage from the Agent SDK (`getContextUsage` /
/// `getUsage`). Same data the status bar shows after an agent turn.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ClaudeUsageStatus {
    context: Option<serde_json::Value>,
    session: Option<serde_json::Value>,
}

/// Fetch Claude Code context + session usage without running an agent turn.
#[tauri::command]
pub fn claude_usage_status(worktree: Option<String>) -> Result<ClaudeUsageStatus, String> {
    let root = project_root().ok_or_else(|| {
        "Fold project root not found (need package.json + scripts/claude-usage.mjs)".to_string()
    })?;
    let script = root.join("scripts").join("claude-usage.mjs");
    if !script.is_file() {
        return Err(format!("claude-usage script missing: {}", script.display()));
    }
    let node = resolve_node_bin().ok_or_else(|| {
        "Node.js not found (required to query Claude Agent SDK)".to_string()
    })?;

    let mut cmd = Command::new(&node);
    cmd.arg(&script).current_dir(&root).stdout(Stdio::piped()).stderr(Stdio::piped());
    if let Some(wt) = worktree.filter(|s| !s.is_empty()) {
        let worktree_path = PathBuf::from(&wt);
        if worktree_path.is_dir() {
            cmd.arg(wt);
        }
    }

    let output = cmd
        .output()
        .map_err(|e| format!("failed to run claude-usage: {e}"))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!(
            "claude-usage failed ({}): {}",
            output.status,
            stderr.trim()
        ));
    }

    let stdout = String::from_utf8_lossy(&output.stdout);
    serde_json::from_str(stdout.trim()).map_err(|e| {
        format!(
            "failed to parse usage status: {e}; stdout={}",
            stdout.chars().take(200).collect::<String>()
        )
    })
}

/// List Claude Code models via the Agent SDK (`supportedModels()`).
#[tauri::command]
pub fn claude_list_models() -> Result<Vec<ClaudeModelInfo>, String> {
    let root = project_root().ok_or_else(|| {
        "Fold project root not found (need package.json + scripts/list-claude-models.mjs)"
            .to_string()
    })?;
    let script = root.join("scripts").join("list-claude-models.mjs");
    if !script.is_file() {
        return Err(format!("list-claude-models script missing: {}", script.display()));
    }
    let node = resolve_node_bin().ok_or_else(|| "Node.js not found (required to query Claude Agent SDK)".to_string())?;

    let output = Command::new(&node)
        .arg(&script)
        .current_dir(&root)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .output()
        .map_err(|e| format!("failed to run list-claude-models: {e}"))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!(
            "list-claude-models failed ({}): {}",
            output.status,
            stderr.trim()
        ));
    }

    let stdout = String::from_utf8_lossy(&output.stdout);
    serde_json::from_str(stdout.trim()).map_err(|e| {
        format!(
            "failed to parse model catalog: {e}; stdout={}",
            stdout.chars().take(200).collect::<String>()
        )
    })
}

/// Short system hint prepended to harness prompts when Fold's MCP server is
/// registered, so agents know to ask structured questions instead of guessing.
pub const FOLD_ASK_USER_HINT: &str =
    "When you need the user to choose among several valid approaches or clarify \
     an ambiguous requirement, use the fold_ask_user MCP tool with multiple-choice \
     options. Do not guess — ask first.";

/// Prepend the fold_ask_user hint to a user prompt.
pub fn with_fold_ask_hint(prompt: &str) -> String {
    format!("{}\n\n{}", FOLD_ASK_USER_HINT, prompt.trim())
}

/// Inline OpenCode config JSON registering Fold's stdio MCP server for one run.
pub fn opencode_mcp_config_json(worktree: &str) -> Option<String> {
    let (node, script) = resolve_fold_mcp_server()?;
    serde_json::to_string(&serde_json::json!({
        "mcp": {
            "fold": {
                "type": "local",
                "command": [node, script, worktree],
                "enabled": true
            }
        }
    }))
    .ok()
}

/// Merge Fold's stdio MCP server into `<worktree>/.cursor/mcp.json`. Returns
/// `true` when the server was registered (Node + script are available).
pub fn ensure_cursor_fold_mcp(worktree: &str) -> bool {
    let (node, script) = match resolve_fold_mcp_server() {
        Some(v) => v,
        None => return false,
    };

    let cursor_dir = PathBuf::from(worktree).join(".cursor");
    if std::fs::create_dir_all(&cursor_dir).is_err() {
        return false;
    }
    let mcp_path = cursor_dir.join("mcp.json");

    let mut config: serde_json::Value = if mcp_path.is_file() {
        std::fs::read_to_string(&mcp_path)
            .ok()
            .and_then(|raw| serde_json::from_str(&raw).ok())
            .unwrap_or_else(|| serde_json::json!({ "mcpServers": {} }))
    } else {
        serde_json::json!({ "mcpServers": {} })
    };

    if !config.get("mcpServers").is_some() {
        config["mcpServers"] = serde_json::json!({});
    }
    if let Some(servers) = config.get_mut("mcpServers").and_then(|s| s.as_object_mut()) {
        servers.insert(
            "fold".to_string(),
            serde_json::json!({
                "command": node,
                "args": [script, worktree]
            }),
        );
    }

    if std::fs::write(
        &mcp_path,
        format!("{}\n", serde_json::to_string_pretty(&config).unwrap_or_default()),
    )
    .is_err()
    {
        return false;
    }
    true
}

/// Resolve `(node, fold-mcp-server.mjs)` for harnesses that need Fold's
/// `fold_ask_user` MCP tool to ask the user clarifying questions. Returns
/// `None` when Node or the script is unavailable, in which case the harness
/// simply runs without the tool.
pub fn resolve_fold_mcp_server() -> Option<(String, String)> {
    let root = project_root()?;
    let script = root.join("scripts").join("fold-mcp-server.mjs");
    if !script.is_file() {
        return None;
    }
    let node = resolve_node_bin()?;
    Some((
        node.to_str()?.to_string(),
        script.to_str()?.to_string(),
    ))
}

/// Run a Claude Code agent in a worktree via the Agent SDK sidecar
/// (`scripts/claude-agent.mjs`).
///
/// The SDK is used rather than `claude -p` because `ExitPlanMode` and
/// `AskUserQuestion` are only enabled when a `canUseTool` callback is present;
/// in the CLI's headless mode they are absent from the session tool list.
///
/// Streams NDJSON events to the channel; emits `__CLAUDE_EXIT__:<code>` on exit.
#[tauri::command]
pub fn claude_agent_run(
    session_id: String,
    prompt: String,
    worktree: String,
    model: Option<String>,
    effort: Option<String>,
    fast_mode: Option<bool>,
    permission_mode: Option<String>,
    resume_session_id: Option<String>,
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
    state
        .claude_agent_stdin
        .lock()
        .map_err(|e| e.to_string())?
        .remove(&session_id);

    let worktree_path = PathBuf::from(&worktree);
    if !worktree_path.is_dir() {
        return Err(format!("worktree path does not exist: {worktree}"));
    }

    let root = project_root().ok_or_else(|| {
        "Fold project root not found (need package.json + scripts/claude-agent.mjs)".to_string()
    })?;
    let script = root.join("scripts").join("claude-agent.mjs");
    if !script.is_file() {
        return Err(format!("claude-agent sidecar missing: {}", script.display()));
    }
    let node = resolve_node_bin()
        .ok_or_else(|| "Node.js not found (required to run the Claude Agent SDK)".to_string())?;

    // Absolute plans dir outside the worktree so plan files never appear in
    // the explorer / working tree. Create it up front so the SDK can write.
    let plans_dir = crate::fold_paths::fold_plans_dir(&worktree_path).ok_or_else(|| {
        "could not resolve Fold plans directory for worktree".to_string()
    })?;
    std::fs::create_dir_all(&plans_dir)
        .map_err(|e| format!("failed to create plans directory: {e}"))?;

    let config = serde_json::json!({
        "prompt": prompt,
        "cwd": worktree,
        "model": model.filter(|s| !s.is_empty()),
        "effort": effort.filter(|s| !s.is_empty()),
        "fastMode": fast_mode.unwrap_or(false),
        "permissionMode": permission_mode.filter(|s| !s.is_empty()),
        "resumeSessionId": resume_session_id.filter(|s| !s.is_empty()),
        "plansDirectory": plans_dir.to_string_lossy(),
    });

    let mut child = Command::new(&node)
        .arg(&script)
        // Run the sidecar from the Fold project root so it resolves the SDK from
        // node_modules; the agent's own working directory is `cwd` in the config.
        .current_dir(&root)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("failed to start claude agent sidecar: {e}"))?;

    let mut stdin = child
        .stdin
        .take()
        .ok_or_else(|| "failed to open claude agent stdin".to_string())?;
    writeln!(stdin, "{config}").map_err(|e| format!("failed to send agent config: {e}"))?;
    stdin
        .flush()
        .map_err(|e| format!("failed to flush agent config: {e}"))?;

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
        .insert(session_id.clone(), cancel);
    state
        .claude_agent_stdin
        .lock()
        .map_err(|e| e.to_string())?
        .insert(session_id, stdin);
    Ok(())
}

/// Answer a pending `canUseTool` request (plan approval, clarifying questions,
/// edit approval) for a running Claude Code agent.
#[tauri::command]
pub fn claude_agent_respond(
    session_id: String,
    response: String,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let mut slot = state.claude_agent_stdin.lock().map_err(|e| e.to_string())?;
    let stdin = slot
        .get_mut(&session_id)
        .ok_or_else(|| format!("no running Claude agent for session {session_id}"))?;
    writeln!(stdin, "{response}").map_err(|e| format!("failed to send agent response: {e}"))?;
    stdin
        .flush()
        .map_err(|e| format!("failed to flush agent response: {e}"))?;
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
    state
        .claude_agent_stdin
        .lock()
        .map_err(|e| e.to_string())?
        .remove(&session_id);
    Ok(())
}
