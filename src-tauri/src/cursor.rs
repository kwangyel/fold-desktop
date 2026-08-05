//! Cursor harness via Cloud Agents API key + local `agent` CLI.
//!
//! Connect/auth uses the Cloud Agents API (`GET /v1/me`, `GET /v1/models`).
//! Chat runs use the Cursor Agent CLI (`agent -p --output-format stream-json`)
//! with the saved API key — same local-worktree pattern as Claude Code.
//!
//! @see https://cursor.com/docs/api
//! @see https://cursor.com/docs/cli/using
//! @see https://cursor.com/docs/cli/reference/output-format

use std::io::Read;
use std::path::PathBuf;
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::thread;
use std::time::Duration;

use serde::{Deserialize, Serialize};
use tauri::ipc::{Channel, InvokeResponseBody};
use tauri::{AppHandle, Manager, State};

use crate::AppState;

const API_BASE: &str = "https://api.cursor.com";

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CursorStatus {
    /// True only when a key is saved in app config (disconnect clears it).
    authenticated: bool,
    /// `"apiKey"` when authenticated.
    method: Option<String>,
    api_key_name: Option<String>,
    user_email: Option<String>,
    /// Whether the Cursor Agent CLI (`agent`) is on PATH / known install dirs.
    cli_installed: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CursorModelInfo {
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

#[derive(Serialize, Deserialize, Clone, Default)]
#[serde(rename_all = "camelCase")]
struct CursorFile {
    api_key: Option<String>,
    api_key_name: Option<String>,
    user_email: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct MeResponse {
    api_key_name: Option<String>,
    user_email: Option<String>,
}

#[derive(Deserialize)]
struct ModelsResponse {
    items: Vec<ApiModel>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ApiModel {
    id: String,
    display_name: String,
    description: Option<String>,
    parameters: Option<Vec<ApiModelParam>>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ApiModelParam {
    id: String,
    values: Option<Vec<ApiParamValue>>,
}

#[derive(Deserialize)]
struct ApiParamValue {
    value: String,
}

fn cursor_file(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_config_dir()
        .map_err(|e| format!("failed to resolve config dir: {e}"))?;
    std::fs::create_dir_all(&dir).map_err(|e| format!("failed to create config dir: {e}"))?;
    Ok(dir.join("cursor.json"))
}

fn read_file(app: &AppHandle) -> Result<CursorFile, String> {
    let path = cursor_file(app)?;
    match std::fs::read_to_string(&path) {
        Ok(contents) => serde_json::from_str(&contents)
            .map_err(|e| format!("failed to parse cursor.json: {e}")),
        Err(_) => Ok(CursorFile::default()),
    }
}

fn write_file(app: &AppHandle, data: &CursorFile) -> Result<(), String> {
    let path = cursor_file(app)?;
    let contents = serde_json::to_string_pretty(data)
        .map_err(|e| format!("failed to serialize cursor config: {e}"))?;
    std::fs::write(&path, contents).map_err(|e| format!("failed to write cursor.json: {e}"))
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

fn home_dir() -> Option<PathBuf> {
    std::env::var_os("HOME")
        .or_else(|| std::env::var_os("USERPROFILE"))
        .map(PathBuf::from)
}

/// Resolve the Cursor Agent CLI (`agent` / `cursor-agent`).
fn resolve_agent_bin() -> Option<PathBuf> {
    for name in ["agent", "cursor-agent"] {
        if Command::new(name)
            .arg("--help")
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status()
            .map(|s| s.success())
            .unwrap_or(false)
        {
            if let Ok(which) = Command::new("which").arg(name).output() {
                if which.status.success() {
                    let path = String::from_utf8_lossy(&which.stdout).trim().to_string();
                    if !path.is_empty() {
                        return Some(PathBuf::from(path));
                    }
                }
            }
            return Some(PathBuf::from(name));
        }
    }

    let mut candidates: Vec<PathBuf> = Vec::new();
    if let Some(home) = home_dir() {
        candidates.push(home.join(".local/bin/agent"));
        candidates.push(home.join(".local/bin/cursor-agent"));
        candidates.push(home.join(".cursor/bin/agent"));
        candidates.push(home.join("bin/agent"));
    }
    candidates.push(PathBuf::from("/opt/homebrew/bin/agent"));
    candidates.push(PathBuf::from("/usr/local/bin/agent"));

    if let Some(path) = std::env::var_os("PATH") {
        for dir in std::env::split_paths(&path) {
            candidates.push(dir.join("agent"));
            candidates.push(dir.join("cursor-agent"));
        }
    }

    for candidate in candidates {
        if !is_executable(&candidate) {
            continue;
        }
        let resolved = std::fs::canonicalize(&candidate).unwrap_or(candidate);
        let ok = Command::new(&resolved)
            .arg("--help")
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

fn saved_api_key(app: &AppHandle) -> Result<Option<String>, String> {
    Ok(read_file(app)?
        .api_key
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty()))
}

fn http_client() -> Result<reqwest::blocking::Client, String> {
    reqwest::blocking::Client::builder()
        .timeout(std::time::Duration::from_secs(30))
        .build()
        .map_err(|e| format!("failed to build HTTP client: {e}"))
}

fn api_get_json<T: for<'de> Deserialize<'de>>(api_key: &str, path: &str) -> Result<T, String> {
    let client = http_client()?;
    let url = format!("{API_BASE}{path}");
    let res = client
        .get(&url)
        .basic_auth(api_key, Some(""))
        .send()
        .map_err(|e| format!("Cursor API request failed: {e}"))?;

    let status = res.status();
    if status == reqwest::StatusCode::UNAUTHORIZED {
        return Err("Invalid Cursor API key".to_string());
    }
    if status == reqwest::StatusCode::FORBIDDEN {
        return Err("Cursor API key lacks permission for this endpoint".to_string());
    }
    if status == reqwest::StatusCode::TOO_MANY_REQUESTS {
        return Err("Cursor API rate limit exceeded. Try again shortly.".to_string());
    }
    if !status.is_success() {
        let body = res.text().unwrap_or_default();
        return Err(format!(
            "Cursor API error (HTTP {status}): {}",
            body.chars().take(200).collect::<String>()
        ));
    }

    res.json::<T>()
        .map_err(|e| format!("failed to parse Cursor API response: {e}"))
}

fn validate_api_key(api_key: &str) -> Result<MeResponse, String> {
    api_get_json::<MeResponse>(api_key, "/v1/me")
}

fn map_model(m: ApiModel) -> CursorModelInfo {
    let params = m.parameters.unwrap_or_default();
    let supports_fast = params.iter().any(|p| p.id == "fast");
    let effort_param = params.iter().find(|p| {
        p.id == "effort" || p.id == "reasoning_effort" || p.id.contains("effort")
    });
    let effort_levels = effort_param.and_then(|p| {
        p.values
            .as_ref()
            .map(|vals| vals.iter().map(|v| v.value.clone()).collect::<Vec<_>>())
    });
    let supports_effort = effort_levels
        .as_ref()
        .map(|l| !l.is_empty())
        .unwrap_or(false);
    let description = m
        .description
        .filter(|s| !s.trim().is_empty())
        .unwrap_or_else(|| m.display_name.clone());

    let supports_auto = m.id.contains("auto");
    CursorModelInfo {
        value: m.id.clone(),
        resolved_model: Some(m.id),
        display_name: m.display_name,
        description,
        supports_effort: supports_effort.then_some(true),
        supported_effort_levels: effort_levels,
        supports_adaptive_thinking: None,
        supports_fast_mode: supports_fast.then_some(true),
        supports_auto_mode: supports_auto.then_some(true),
    }
}

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

/// Status uses the **saved** API key only so Disconnect always clears connection.
#[tauri::command]
pub fn cursor_status(app: AppHandle) -> Result<CursorStatus, String> {
    let file = read_file(&app)?;
    let cli_installed = resolve_agent_bin().is_some();
    if let Some(key) = file.api_key.as_ref().filter(|s| !s.trim().is_empty()) {
        let _ = key;
        return Ok(CursorStatus {
            authenticated: true,
            method: Some("apiKey".to_string()),
            api_key_name: file.api_key_name,
            user_email: file.user_email,
            cli_installed,
        });
    }
    Ok(CursorStatus {
        authenticated: false,
        method: None,
        api_key_name: None,
        user_email: None,
        cli_installed,
    })
}

/// Validate `api_key` against `GET /v1/me` and persist it on success.
#[tauri::command]
pub fn cursor_connect(app: AppHandle, api_key: String) -> Result<CursorStatus, String> {
    let key = api_key.trim().to_string();
    if key.is_empty() {
        return Err("API key is required".to_string());
    }

    let me = validate_api_key(&key)?;
    write_file(
        &app,
        &CursorFile {
            api_key: Some(key),
            api_key_name: me.api_key_name.clone(),
            user_email: me.user_email.clone(),
        },
    )?;

    Ok(CursorStatus {
        authenticated: true,
        method: Some("apiKey".to_string()),
        api_key_name: me.api_key_name,
        user_email: me.user_email,
        cli_installed: resolve_agent_bin().is_some(),
    })
}

/// Remove the saved Cursor API key so the harness disconnects.
#[tauri::command]
pub fn cursor_disconnect(app: AppHandle) -> Result<CursorStatus, String> {
    write_file(&app, &CursorFile::default())?;
    cursor_status(app)
}

/// List models from `GET /v1/models` using the saved API key.
#[tauri::command]
pub fn cursor_list_models(app: AppHandle) -> Result<Vec<CursorModelInfo>, String> {
    let key = saved_api_key(&app)?.ok_or_else(|| "No Cursor API key configured".to_string())?;
    let response = api_get_json::<ModelsResponse>(&key, "/v1/models")?;
    Ok(response.items.into_iter().map(map_model).collect())
}

/// Run Cursor Agent CLI in a worktree (`agent -p --output-format stream-json`).
/// Streams NDJSON events; emits `__CURSOR_EXIT__:<code>` on exit.
#[tauri::command]
pub fn cursor_agent_run(
    session_id: String,
    prompt: String,
    worktree: String,
    model: Option<String>,
    plan_mode: Option<bool>,
    on_output: Channel,
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<(), String> {
    if let Some(prev) = state
        .cursor_agents
        .lock()
        .map_err(|e| e.to_string())?
        .remove(&session_id)
    {
        prev.store(true, Ordering::SeqCst);
    }

    let api_key = saved_api_key(&app)?.ok_or_else(|| {
        "Cursor is not connected. Add an API key in Connect Harness.".to_string()
    })?;

    let bin = resolve_agent_bin().ok_or_else(|| {
        "Cursor Agent CLI not found. Install from https://cursor.com/docs/cli/overview \
         (`curl https://cursor.com/install -fsS | bash`)."
            .to_string()
    })?;

    let worktree_path = PathBuf::from(&worktree);
    if !worktree_path.is_dir() {
        return Err(format!("worktree path does not exist: {worktree}"));
    }

    let fold_mcp = crate::claude::ensure_cursor_fold_mcp(&worktree);
    let run_prompt = if fold_mcp {
        crate::claude::with_fold_ask_hint(&prompt)
    } else {
        prompt.clone()
    };

    // Mirror Claude: non-interactive print mode with stream-json + auto-approve tools.
    let mut args: Vec<String> = vec![
        "-p".into(),
        run_prompt,
        "--output-format".into(),
        "stream-json".into(),
        "--stream-partial-output".into(),
        "--force".into(),
        "--trust".into(),
        "--workspace".into(),
        worktree.clone(),
        "--api-key".into(),
        api_key,
    ];
    if let Some(m) = model.filter(|s| !s.is_empty()) {
        args.push("--model".into());
        args.push(m);
    }
    // Intentionally do NOT pass `--mode plan`. In non-interactive `-p` mode,
    // Cursor's native plan mode calls `create_plan` and then hangs waiting for
    // a UI client that never responds (confirmed Cursor CLI bug). Fold instead
    // uses a soft plan prompt (see `buildCursorPlanPrompt`) so the agent writes
    // the plan to the Fold data dir and exits normally.
    let _planning = plan_mode.unwrap_or(false);
    if fold_mcp {
        args.push("--approve-mcps".into());
    }

    let mut child = Command::new(&bin)
        .args(&args)
        .current_dir(&worktree_path)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("failed to start Cursor agent: {e}"))?;

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

        let marker = format!("\n__CURSOR_EXIT__:{exit_code}\n");
        let _ = exit_channel.send(InvokeResponseBody::Raw(marker.into_bytes()));
    });

    state
        .cursor_agents
        .lock()
        .map_err(|e| e.to_string())?
        .insert(session_id, cancel);
    Ok(())
}

#[tauri::command]
pub fn cursor_agent_cancel(session_id: String, state: State<'_, AppState>) -> Result<(), String> {
    if let Some(cancel) = state
        .cursor_agents
        .lock()
        .map_err(|e| e.to_string())?
        .remove(&session_id)
    {
        cancel.store(true, Ordering::SeqCst);
    }
    Ok(())
}
