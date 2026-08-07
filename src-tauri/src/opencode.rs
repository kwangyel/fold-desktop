//! OpenCode harness via local `opencode` CLI.
//!
//! Auth reuses machine credentials (`opencode auth login` →
//! `~/.local/share/opencode/auth.json`). Chat runs use
//! `opencode run --format json` in the worktree.
//!
//! @see https://opencode.ai/docs/cli/
//! @see https://opencode.ai/docs/providers/

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

/// Resolved `opencode` CLI path, cached so status checks don't re-probe PATH.
static OPENCODE_BIN: BinCache = BinCache::new();

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OpenCodeStatus {
    installed: bool,
    authenticated: bool,
    /// `"apiKey"` when providers are configured in auth.json / env.
    method: Option<String>,
    /// Number of authenticated providers (best-effort).
    provider_count: u32,
}

/// Model catalog entry shaped like Claude / Cursor `ModelInfo`.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OpenCodeModelInfo {
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

/// Resolve the opencode CLI, reusing the cached path when still fresh.
fn resolve_opencode_bin() -> Option<PathBuf> {
    OPENCODE_BIN.get(probe_opencode_bin)
}

/// Resolve the `opencode` binary (PATH + common install dirs).
fn probe_opencode_bin() -> Option<PathBuf> {
    if crate::proc::version_ok("opencode") {
        return Some(crate::proc::which("opencode").unwrap_or_else(|| PathBuf::from("opencode")));
    }

    let mut candidates: Vec<PathBuf> = Vec::new();
    if let Some(home) = home_dir() {
        candidates.push(home.join(".local/bin/opencode"));
        candidates.push(home.join("bin/opencode"));
        candidates.push(home.join(".npm-global/bin/opencode"));
        candidates.push(home.join(".bun/bin/opencode"));
        candidates.push(home.join(".opencode/bin/opencode"));
        candidates.push(
            home.join("Library/Application Support/com.conductor.app/bin/opencode"),
        );
    }
    candidates.push(PathBuf::from("/opt/homebrew/bin/opencode"));
    candidates.push(PathBuf::from("/usr/local/bin/opencode"));

    if let Some(path) = std::env::var_os("PATH") {
        for dir in std::env::split_paths(&path) {
            candidates.push(dir.join("opencode"));
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
    resolve_opencode_bin().is_some()
}

/// Credentials live in XDG data dir / macOS Application Support.
fn auth_json_path() -> Option<PathBuf> {
    if let Some(xdg) = std::env::var_os("XDG_DATA_HOME") {
        return Some(PathBuf::from(xdg).join("opencode/auth.json"));
    }
    let home = home_dir()?;
    #[cfg(target_os = "macos")]
    {
        let app_support = home.join("Library/Application Support/opencode/auth.json");
        if app_support.is_file() {
            return Some(app_support);
        }
    }
    Some(home.join(".local/share/opencode/auth.json"))
}

fn count_auth_providers() -> u32 {
    let Some(path) = auth_json_path() else {
        return 0;
    };
    let Ok(contents) = std::fs::read_to_string(&path) else {
        return 0;
    };
    let Ok(value) = serde_json::from_str::<serde_json::Value>(&contents) else {
        return 0;
    };
    match value {
        serde_json::Value::Object(map) => map.len() as u32,
        serde_json::Value::Array(arr) => arr.len() as u32,
        _ => {
            if path.is_file() && !contents.trim().is_empty() {
                1
            } else {
                0
            }
        }
    }
}

/// Fall back to `opencode auth list` when the auth file shape is unknown.
fn auth_list_has_providers(bin: &std::path::Path) -> bool {
    let output = crate::proc::output_with_timeout(
        Command::new(bin).args(["auth", "list"]),
        Duration::from_secs(10),
    );
    match output {
        Ok(out) if out.success() => {
            let text = out.stdout;
            let trimmed = text.trim();
            !trimmed.is_empty()
                && !trimmed.to_lowercase().contains("no providers")
                && !trimmed.to_lowercase().contains("not authenticated")
        }
        _ => false,
    }
}

#[tauri::command]
pub async fn opencode_status(force: Option<bool>) -> Result<OpenCodeStatus, String> {
    tauri::async_runtime::spawn_blocking(move || status_blocking(force))
        .await
        .map_err(|e| format!("opencode_status failed: {e}"))?
}

fn status_blocking(force: Option<bool>) -> Result<OpenCodeStatus, String> {
    if force.unwrap_or(false) {
        OPENCODE_BIN.clear();
    }
    let installed = is_installed();
    if !installed {
        return Ok(OpenCodeStatus {
            installed: false,
            authenticated: false,
            method: None,
            provider_count: 0,
        });
    }

    let mut provider_count = count_auth_providers();
    if provider_count == 0 {
        if let Some(bin) = resolve_opencode_bin() {
            if auth_list_has_providers(&bin) {
                provider_count = 1;
            }
        }
    }

    if provider_count > 0 {
        return Ok(OpenCodeStatus {
            installed: true,
            authenticated: true,
            method: Some("apiKey".to_string()),
            provider_count,
        });
    }

    Ok(OpenCodeStatus {
        installed: true,
        authenticated: false,
        method: None,
        provider_count: 0,
    })
}

/// Start interactive `opencode auth login` in a PTY.
#[tauri::command(async)]
pub fn opencode_login(on_output: Channel, state: State<'_, AppState>) -> Result<(), String> {
    {
        let mut slot = state.opencode_login.lock().map_err(|e| e.to_string())?;
        let _ = slot.take();
    }

    let bin = resolve_opencode_bin().ok_or_else(|| {
        "OpenCode CLI not found. Install from https://opencode.ai \
         (`npm i -g opencode-ai` or curl installer)."
            .to_string()
    })?;

    let session = PtySession::spawn_command(
        bin.to_str().ok_or("invalid opencode path")?,
        &["auth", "login"],
        100,
        28,
        None,
        on_output,
    )?;
    *state.opencode_login.lock().map_err(|e| e.to_string())? = Some(session);
    Ok(())
}

#[tauri::command]
pub fn opencode_login_write(data: String, state: State<'_, AppState>) -> Result<(), String> {
    let mut slot = state.opencode_login.lock().map_err(|e| e.to_string())?;
    if let Some(session) = slot.as_mut() {
        session.write(data.as_bytes())?;
    }
    Ok(())
}

#[tauri::command(async)]
pub fn opencode_login_cancel(state: State<'_, AppState>) -> Result<(), String> {
    let mut slot = state.opencode_login.lock().map_err(|e| e.to_string())?;
    let _ = slot.take();
    Ok(())
}

fn opencode_model_supports_effort(provider: &str, model: &str) -> bool {
    let provider = provider.to_lowercase();
    let model = model.to_lowercase();
    matches!(provider.as_str(), "openai" | "anthropic" | "google" | "opencode")
        && !model.contains("instant")
        && !model.contains("nano")
}

fn opencode_effort_levels(provider: &str, model: &str) -> Option<Vec<String>> {
    if !opencode_model_supports_effort(provider, model) {
        return None;
    }
    Some(vec![
        "low".into(),
        "medium".into(),
        "high".into(),
        "xhigh".into(),
    ])
}

/// Cap `opencode models` so a hung CLI cannot wedge harness refresh.
const MODELS_TIMEOUT: Duration = Duration::from_secs(10);

/// List models via `opencode models` (`provider/model` lines).
#[tauri::command(async)]
pub fn opencode_list_models() -> Result<Vec<OpenCodeModelInfo>, String> {
    let bin = resolve_opencode_bin().ok_or_else(|| "OpenCode CLI not found".to_string())?;
    let output = crate::proc::output_with_timeout(
        Command::new(&bin).arg("models"),
        MODELS_TIMEOUT,
    )
    .map_err(|e| format!("failed to run opencode models: {e}"))?;

    if !output.success() {
        return Err(format!(
            "opencode models failed ({}): {}",
            output.code,
            output.stderr.trim()
        ));
    }

    let stdout = &output.stdout;
    let mut models = Vec::new();
    for line in stdout.lines() {
        let id = line.trim();
        if id.is_empty() || id.starts_with('#') {
            continue;
        }
        // Skip table headers / noise.
        if !id.contains('/') {
            continue;
        }
        let (provider, model) = id.split_once('/').unwrap_or(("unknown", id));
        let effort_levels = opencode_effort_levels(provider, model);
        let supports_effort = effort_levels
            .as_ref()
            .is_some_and(|levels| !levels.is_empty());
        models.push(OpenCodeModelInfo {
            value: id.to_string(),
            resolved_model: Some(id.to_string()),
            display_name: model.to_string(),
            description: format!("{provider} · {model}"),
            supports_effort: supports_effort.then_some(true),
            supported_effort_levels: effort_levels,
            supports_adaptive_thinking: None,
            supports_fast_mode: None,
            supports_auto_mode: None,
        });
    }

    if models.is_empty() {
        return Err("No OpenCode models found. Connect a provider with `opencode auth login`.".into());
    }

    Ok(models)
}

fn stream_pipe<R: Read + Send + 'static>(reader: R, on_output: Channel) {
    crate::stream::pipe_to_channel(reader, on_output);
}

/// Run `opencode run --format json` in a worktree. Emits `__OPENCODE_EXIT__:<code>`.
#[tauri::command(async)]
pub fn opencode_agent_run(
    session_id: String,
    prompt: String,
    worktree: String,
    model: Option<String>,
    effort: Option<String>,
    plan_mode: Option<bool>,
    on_output: Channel,
    state: State<'_, AppState>,
) -> Result<(), String> {
    if let Some(prev) = state
        .opencode_agents
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
        .opencode_agents
        .lock()
        .map_err(|e| e.to_string())?
        .insert(session_id.clone(), cancel.clone());

    let status = status_blocking(None)?;
    if !status.authenticated {
        return Err(
            "OpenCode is not authenticated. Open Connect Harness and log in.".to_string(),
        );
    }

    let bin = resolve_opencode_bin().ok_or_else(|| "OpenCode CLI not found".to_string())?;
    let worktree_path = PathBuf::from(&worktree);
    if !worktree_path.is_dir() {
        return Err(format!("worktree path does not exist: {worktree}"));
    }

    let planning = plan_mode.unwrap_or(false);
    let mut args: Vec<String> = vec![
        "run".into(),
        "--format".into(),
        "json".into(),
        "--dir".into(),
        worktree.clone(),
    ];
    if planning {
        // OpenCode's built-in `plan` agent is read-only: writes and bash are set
        // to `ask`. Auto-approving them would defeat that, so `--auto` is
        // deliberately omitted here.
        args.push("--agent".into());
        args.push("plan".into());
    } else {
        args.push("--auto".into());
    }
    if let Some(m) = model.filter(|s| !s.is_empty()) {
        args.push("-m".into());
        args.push(m);
    }
    if let Some(variant) = effort.filter(|s| !s.is_empty() && s != "ultracode") {
        args.push("--variant".into());
        args.push(variant);
    }

    let fold_mcp = crate::claude::resolve_fold_mcp_server().is_some();
    let run_prompt = if fold_mcp {
        crate::claude::with_fold_ask_hint(&prompt)
    } else {
        prompt.clone()
    };
    args.push(run_prompt);

    let mut cmd = Command::new(&bin);
    if let Some(config) = crate::claude::opencode_mcp_config_json(&worktree) {
        cmd.env("OPENCODE_CONFIG_CONTENT", config);
    }

    let mut child = cmd
        .args(&args)
        .current_dir(&worktree_path)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("failed to start OpenCode agent: {e}"))?;

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

        let marker = format!("\n__OPENCODE_EXIT__:{exit_code}\n");
        let _ = exit_channel.send(InvokeResponseBody::Raw(marker.into_bytes()));
    });

    Ok(())
}

#[tauri::command(async)]
pub fn opencode_agent_cancel(
    session_id: String,
    state: State<'_, AppState>,
) -> Result<(), String> {
    if let Some(cancel) = state
        .opencode_agents
        .lock()
        .map_err(|e| e.to_string())?
        .remove(&session_id)
    {
        cancel.store(true, Ordering::SeqCst);
    }
    Ok(())
}
