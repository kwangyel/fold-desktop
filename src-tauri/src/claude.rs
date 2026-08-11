use std::io::{Read, Write};
use std::path::{Path, PathBuf};
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

/// Resolved `claude` / `node` paths, cached so status checks don't re-probe.
static CLAUDE_BIN: BinCache = BinCache::new();
static NODE_BIN: BinCache = BinCache::new();

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ClaudeStatus {
    installed: bool,
    authenticated: bool,
    method: Option<String>,
    /// Set when the credential store could not be read at all (as opposed to
    /// being readable and empty), so the UI can explain why login never lands.
    credential_error: Option<String>,
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

/// Resolve the `claude` binary, reusing the cached path when it is still fresh.
fn resolve_claude_bin() -> Option<PathBuf> {
    CLAUDE_BIN.get(probe_claude_bin)
}

/// Resolve the `claude` binary to an absolute path when possible.
///
/// macOS GUI / Tauri apps often inherit a stripped PATH that omits shell-only
/// dirs like `~/.local/bin` (where the Claude Code installer puts the binary).
/// Search PATH first, then common install locations. Expensive — always go
/// through `resolve_claude_bin` so the result is cached.
fn probe_claude_bin() -> Option<PathBuf> {
    // 1) Plain PATH lookup (works when launched from a configured shell).
    if crate::proc::version_ok("claude") {
        return Some(crate::proc::which("claude").unwrap_or_else(|| PathBuf::from("claude")));
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

/// Outcome of the non-interactive credential probe.
enum Credentials {
    Found,
    Missing,
    /// The store exists but we could not read it — typically a macOS keychain
    /// ACL that excludes `/usr/bin/security`, where the OS prompts (or refuses)
    /// instead of answering. Reported to the user, because otherwise a machine
    /// that *is* logged in looks permanently logged out.
    Unreadable(String),
}

/// Non-interactive credential probe (no TTY). Mirrors Conductor: reuse the
/// machine's Claude Code login — keychain on macOS, credentials file elsewhere.
fn subscription_credentials() -> Credentials {
    #[cfg(target_os = "macos")]
    {
        let user = std::env::var("USER").unwrap_or_default();
        let probe = crate::proc::output_with_timeout(
            Command::new("security").args([
                "find-generic-password",
                "-a",
                &user,
                "-s",
                "Claude Code-credentials",
                "-w",
            ]),
            Duration::from_secs(10),
        );
        match probe {
            Ok(out) if out.success() => Credentials::Found,
            // The tool says so explicitly when there is simply no login yet.
            Ok(out) if out.stderr.contains("could not be found") => Credentials::Missing,
            Ok(out) => Credentials::Unreadable(format!(
                "Could not read the Claude Code keychain item: {}",
                out.stderr.trim()
            )),
            Err(e) => Credentials::Unreadable(format!("Keychain lookup failed: {e}")),
        }
    }
    #[cfg(not(target_os = "macos"))]
    {
        let home = std::env::var("HOME")
            .or_else(|_| std::env::var("USERPROFILE"))
            .ok();
        let found = home
            .map(|h| PathBuf::from(h).join(".claude").join(".credentials.json").is_file())
            .unwrap_or(false);
        if found {
            Credentials::Found
        } else {
            Credentials::Missing
        }
    }
}

/// Report whether the Claude Code CLI is installed and authenticated.
/// `force` re-probes for the CLI instead of reusing the cached path — used when
/// the user explicitly rechecks after installing it.
#[tauri::command]
pub async fn claude_status(force: Option<bool>) -> Result<ClaudeStatus, String> {
    tauri::async_runtime::spawn_blocking(move || status_blocking(force))
        .await
        .map_err(|e| format!("claude_status failed: {e}"))?
}

fn status_blocking(force: Option<bool>) -> Result<ClaudeStatus, String> {
    if force.unwrap_or(false) {
        CLAUDE_BIN.clear();
    }
    let installed = is_installed();
    if !installed {
        return Ok(ClaudeStatus {
            installed: false,
            authenticated: false,
            method: None,
            credential_error: None,
        });
    }

    if let Some(method) = env_auth_method() {
        return Ok(ClaudeStatus {
            installed: true,
            authenticated: true,
            method: Some(method.to_string()),
            credential_error: None,
        });
    }

    match subscription_credentials() {
        Credentials::Found => Ok(ClaudeStatus {
            installed: true,
            authenticated: true,
            method: Some("subscription".to_string()),
            credential_error: None,
        }),
        Credentials::Missing => Ok(ClaudeStatus {
            installed: true,
            authenticated: false,
            method: None,
            credential_error: None,
        }),
        Credentials::Unreadable(message) => Ok(ClaudeStatus {
            installed: true,
            authenticated: false,
            method: None,
            credential_error: Some(message),
        }),
    }
}

/// Start an interactive Claude Code login in a PTY (Ink TUI requires a real TTY).
/// Credentials persist to the machine keychain / credential store — nothing is
/// saved app-side. The frontend should wait for TUI readiness before writing
/// `/login\r` (a fixed delay often lands in a not-yet-ready readline).
#[tauri::command(async)]
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
        120,
        36,
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
#[tauri::command(async)]
pub fn claude_login_cancel(state: State<'_, AppState>) -> Result<(), String> {
    let mut slot = state.claude_login.lock().map_err(|e| e.to_string())?;
    let _ = slot.take();
    Ok(())
}

/// Stream a child pipe's bytes to the frontend channel on a background thread.
fn stream_pipe<R: Read + Send + 'static>(reader: R, on_output: Channel) {
    crate::stream::pipe_to_channel(reader, on_output);
}

/// Resolve the Fold project root (directory with `package.json` + `scripts/`).
/// Cached — the walk hits the filesystem once per directory level and the root
/// cannot change while the app is running.
fn project_root() -> Option<PathBuf> {
    static CACHED: std::sync::OnceLock<Option<PathBuf>> = std::sync::OnceLock::new();
    CACHED.get_or_init(probe_project_root).clone()
}

fn probe_project_root() -> Option<PathBuf> {
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

/// Resolve `node`, reusing the cached path (probing spawns `node --version`).
pub fn resolve_node_bin() -> Option<PathBuf> {
    NODE_BIN.get(probe_node_bin)
}

fn probe_node_bin() -> Option<PathBuf> {
    if crate::proc::version_ok("node") {
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

/// Claude.ai plan session usage from the Agent SDK (`getUsage`) — the 5-hour
/// and weekly quota windows behind `/usage`.
///
/// Context-window usage is intentionally absent: this command runs a throwaway
/// SDK session, so its context reading would describe that session rather than
/// the user's chat. The `claude-agent.mjs` sidecar reports the real thing.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ClaudeUsageStatus {
    session: Option<serde_json::Value>,
    /// Why `session` is empty, when the script could say.
    #[serde(default)]
    error: Option<String>,
}

/// Fetch Claude plan session usage without running an agent turn.
#[tauri::command]
pub async fn claude_usage_status(worktree: Option<String>) -> Result<ClaudeUsageStatus, String> {
    tauri::async_runtime::spawn_blocking(move || usage_status_blocking(worktree))
        .await
        .map_err(|e| format!("claude_usage_status failed: {e}"))?
}

fn usage_status_blocking(worktree: Option<String>) -> Result<ClaudeUsageStatus, String> {
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
    let mut cwd_used = root.display().to_string();
    if let Some(wt) = worktree.filter(|s| !s.is_empty()) {
        let worktree_path = PathBuf::from(&wt);
        if worktree_path.is_dir() {
            cwd_used = wt.clone();
            cmd.arg(wt);
        }
    }

    // This path is invisible from the UI (a failure just leaves the meters
    // empty), so trace every run — root, target cwd, timing and outcome.
    let started = std::time::Instant::now();
    eprintln!("[fold][usage] spawn {} in {cwd_used}", script.display());

    let output = crate::proc::output_with_handshake(
        &mut cmd,
        USAGE_CONNECT_TIMEOUT,
        USAGE_QUERY_TIMEOUT,
        USAGE_READY_MARKER,
    )
    .map_err(|e| {
        eprintln!("[fold][usage] failed after {:?}: {e}", started.elapsed());
        format!("failed to run claude-usage: {e}")
    })?;

    eprintln!(
        "[fold][usage] exited {} after {:?}",
        output.code,
        started.elapsed()
    );

    if !output.success() {
        eprintln!("[fold][usage] stderr: {}", output.stderr.trim());
        return Err(format!(
            "claude-usage failed ({}): {}",
            output.code,
            output.stderr.trim()
        ));
    }

    // NDJSON: the handshake line comes first, the result is the last one.
    let result_line = output
        .stdout
        .lines()
        .map(str::trim)
        .filter(|l| !l.is_empty() && !l.contains(USAGE_READY_MARKER))
        .next_back()
        .ok_or_else(|| "claude-usage produced no result line".to_string())?;

    serde_json::from_str(result_line).map_err(|e| {
        format!(
            "failed to parse usage status: {e}; stdout={}",
            result_line.chars().take(200).collect::<String>()
        )
    })
}

/// How long a successfully fetched model catalog is reused. The SDK query
/// boots the Claude Code CLI, so re-running it on every picker open is pure
/// latency for a list that changes at release cadence.
const MODEL_CACHE_TTL: Duration = Duration::from_secs(600);

/// The SDK scripts talk to the network; cap them so a stall can never wedge the
/// harness refresh that awaits them.
const SDK_SCRIPT_TIMEOUT: Duration = Duration::from_secs(10);

/// The usage script's wall time is almost entirely spent booting the Claude
/// Code CLI and waiting for its control channel (~20s cold); the usage calls
/// themselves return in milliseconds. So it is timed in two phases around the
/// `fold_usage_ready` handshake rather than under one deadline — the shared 10s
/// `SDK_SCRIPT_TIMEOUT` used to kill it mid-connect, every time.
const USAGE_CONNECT_TIMEOUT: Duration = Duration::from_secs(45);

/// Budget for `getContextUsage` + `getUsage` once the control channel is live.
const USAGE_QUERY_TIMEOUT: Duration = Duration::from_secs(15);

/// Handshake line the usage script prints when its SDK session is ready.
const USAGE_READY_MARKER: &str = "fold_usage_ready";

static MODEL_CACHE: std::sync::Mutex<Option<(std::time::Instant, Vec<ClaudeModelInfo>)>> =
    std::sync::Mutex::new(None);

/// List Claude Code models via the Agent SDK (`supportedModels()`).
/// Cached for `MODEL_CACHE_TTL`; there is no static frontend fallback, so
/// failing fast here is better than blocking the harness refresh.
#[tauri::command]
pub async fn claude_list_models() -> Result<Vec<ClaudeModelInfo>, String> {
    tauri::async_runtime::spawn_blocking(move || list_models_blocking())
        .await
        .map_err(|e| format!("claude_list_models failed: {e}"))?
}

fn list_models_blocking() -> Result<Vec<ClaudeModelInfo>, String> {
    if let Ok(cache) = MODEL_CACHE.lock() {
        if let Some((at, models)) = cache.as_ref() {
            if at.elapsed() < MODEL_CACHE_TTL {
                return Ok(models.clone());
            }
        }
    }

    // Packaged builds ship no `scripts/` directory — don't pay a Node lookup
    // and spawn just to fail; the caller surfaces the error in the picker.
    let root = project_root().ok_or_else(|| {
        "Fold project root not found (need package.json + scripts/list-claude-models.mjs)"
            .to_string()
    })?;
    let script = root.join("scripts").join("list-claude-models.mjs");
    if !script.is_file() {
        return Err(format!("list-claude-models script missing: {}", script.display()));
    }
    let node = resolve_node_bin().ok_or_else(|| "Node.js not found (required to query Claude Agent SDK)".to_string())?;

    let output = crate::proc::output_with_timeout(
        Command::new(&node).arg(&script).current_dir(&root),
        SDK_SCRIPT_TIMEOUT,
    )
    .map_err(|e| format!("failed to run list-claude-models: {e}"))?;

    if !output.success() {
        return Err(format!(
            "list-claude-models failed ({}): {}",
            output.code,
            output.stderr.trim()
        ));
    }

    let models: Vec<ClaudeModelInfo> =
        serde_json::from_str(output.stdout.trim()).map_err(|e| {
            format!(
                "failed to parse model catalog: {e}; stdout={}",
                output.stdout.chars().take(200).collect::<String>()
            )
        })?;

    if let Ok(mut cache) = MODEL_CACHE.lock() {
        *cache = Some((std::time::Instant::now(), models.clone()));
    }
    Ok(models)
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

/// Keep Fold-generated Cursor MCP config out of `git status` / commits.
///
/// Uses the repo-local exclude file (`.git/info/exclude`) so we don't dirty the
/// project's committed `.gitignore`. No-op when the path is already ignored.
fn ensure_cursor_mcp_git_excluded(worktree: &str) {
    let root = Path::new(worktree);
    const PATTERN: &str = ".cursor/mcp.json";

    let already_ignored = Command::new("git")
        .args(["check-ignore", "-q", "--", PATTERN])
        .current_dir(root)
        .status()
        .map(|s| s.success())
        .unwrap_or(false);
    if already_ignored {
        return;
    }

    let exclude_out = Command::new("git")
        .args(["rev-parse", "--git-path", "info/exclude"])
        .current_dir(root)
        .output()
        .ok();
    let Some(exclude_out) = exclude_out else {
        return;
    };
    if !exclude_out.status.success() {
        return;
    }
    let rel = String::from_utf8_lossy(&exclude_out.stdout).trim().to_string();
    if rel.is_empty() {
        return;
    }
    let exclude_path = {
        let candidate = PathBuf::from(&rel);
        if candidate.is_absolute() {
            candidate
        } else {
            root.join(candidate)
        }
    };

    if let Some(parent) = exclude_path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }

    let existing = std::fs::read_to_string(&exclude_path).unwrap_or_default();
    let already_listed = existing.lines().any(|line| {
        let trimmed = line.trim();
        trimmed == PATTERN || trimmed == ".cursor/" || trimmed == ".cursor"
    });
    if already_listed {
        return;
    }

    let mut next = existing;
    if !next.is_empty() && !next.ends_with('\n') {
        next.push('\n');
    }
    if !next.contains("# Fold") {
        next.push_str("# Fold — local Cursor MCP config (do not commit)\n");
    }
    next.push_str(PATTERN);
    next.push('\n');
    let _ = std::fs::write(&exclude_path, next);
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

    // Still used by Cursor — just keep it out of commits / the Changes list.
    ensure_cursor_mcp_git_excluded(worktree);
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
#[tauri::command(async)]
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

    // Register the cancel flag before the child is spawned. Commands run
    // concurrently, so a cancel issued while the agent is still starting must
    // find a flag to set — otherwise the run would keep going after the UI has
    // already returned to idle.
    let cancel = Arc::new(AtomicBool::new(false));
    state
        .claude_agents
        .lock()
        .map_err(|e| e.to_string())?
        .insert(session_id.clone(), cancel.clone());
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
#[tauri::command(async)]
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
