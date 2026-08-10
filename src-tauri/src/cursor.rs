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

use crate::bin_cache::BinCache;
use crate::AppState;

/// Resolved `Cursor Agent` CLI path, cached so status checks don't re-probe PATH.
static CURSOR_BIN: BinCache = BinCache::new();

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
    #[serde(default)]
    items: Vec<ApiModel>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ApiModel {
    id: String,
    /// Some catalog entries omit this; fall back to `id`.
    #[serde(default)]
    display_name: String,
    #[serde(default)]
    description: Option<String>,
    #[serde(default)]
    parameters: Option<Vec<ApiModelParam>>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ApiModelParam {
    id: String,
    #[serde(default)]
    values: Option<Vec<ApiParamValue>>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
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

/// Resolve the Cursor Agent CLI, reusing the cached path when still fresh.
fn resolve_agent_bin() -> Option<PathBuf> {
    CURSOR_BIN.get(probe_agent_bin)
}

/// Resolve the Cursor Agent CLI (`agent` / `cursor-agent`).
fn probe_agent_bin() -> Option<PathBuf> {
    for name in ["agent", "cursor-agent"] {
        if crate::proc::probe_ok(name, "--help") {
            return Some(crate::proc::which(name).unwrap_or_else(|| PathBuf::from(name)));
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
        if crate::proc::probe_ok(&resolved, "--help") {
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

fn http_client_with_timeout(timeout: Duration) -> Result<reqwest::blocking::Client, String> {
    reqwest::blocking::Client::builder()
        .timeout(timeout)
        .build()
        .map_err(|e| format!("failed to build HTTP client: {e}"))
}

fn api_get_json<T: for<'de> Deserialize<'de>>(api_key: &str, path: &str) -> Result<T, String> {
    api_get_json_with_timeout(api_key, path, Duration::from_secs(30))
}

fn api_get_json_with_timeout<T: for<'de> Deserialize<'de>>(
    api_key: &str,
    path: &str,
    timeout: Duration,
) -> Result<T, String> {
    let client = http_client_with_timeout(timeout)?;
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

fn normalize_effort_level(raw: &str) -> String {
    match raw.trim().to_lowercase().as_str() {
        "extra" | "x-high" | "xhigh" => "xhigh".to_string(),
        "ultra" | "ultracode" => "ultracode".to_string(),
        "med" => "medium".to_string(),
        "min" | "minimal" => "minimal".to_string(),
        other => other.to_string(),
    }
}

fn cursor_model_with_effort(model: &str, effort: Option<&str>) -> String {
    let Some(effort) = effort.filter(|s| !s.is_empty()) else {
        return model.to_string();
    };
    if model.contains('[') {
        return model.to_string();
    }
    let wire = match effort {
        "ultracode" => "xhigh",
        other => other,
    };
    format!("{model}[effort={wire}]")
}

fn map_model(m: ApiModel) -> CursorModelInfo {
    let params = m.parameters.unwrap_or_default();
    let supports_fast = params.iter().any(|p| p.id == "fast");
    let effort_param = params.iter().find(|p| {
        p.id == "effort" || p.id == "reasoning_effort" || p.id.contains("effort")
    });
    let effort_levels = effort_param.and_then(|p| {
        p.values.as_ref().map(|vals| {
            vals.iter()
                .map(|v| normalize_effort_level(&v.value))
                .collect::<Vec<_>>()
        })
    });
    let supports_effort = effort_levels
        .as_ref()
        .map(|l| !l.is_empty())
        .unwrap_or(false);
    let display_name = if m.display_name.trim().is_empty() {
        m.id.clone()
    } else {
        m.display_name
    };
    let description = m
        .description
        .filter(|s| !s.trim().is_empty())
        .unwrap_or_else(|| display_name.clone());

    let supports_auto = m.id.contains("auto");
    CursorModelInfo {
        value: m.id.clone(),
        resolved_model: Some(m.id),
        display_name,
        description,
        supports_effort: supports_effort.then_some(true),
        supported_effort_levels: effort_levels,
        supports_adaptive_thinking: None,
        supports_fast_mode: supports_fast.then_some(true),
        supports_auto_mode: supports_auto.then_some(true),
    }
}

fn stream_pipe<R: Read + Send + 'static>(reader: R, on_output: Channel) {
    crate::stream::pipe_to_channel(reader, on_output);
}

/// Status uses the **saved** API key only so Disconnect always clears connection.
#[tauri::command]
pub async fn cursor_status(app: AppHandle, force: Option<bool>) -> Result<CursorStatus, String> {
    tauri::async_runtime::spawn_blocking(move || status_blocking(&app, force))
        .await
        .map_err(|e| format!("cursor_status failed: {e}"))?
}

fn status_blocking(app: &AppHandle, force: Option<bool>) -> Result<CursorStatus, String> {
    if force.unwrap_or(false) {
        CURSOR_BIN.clear();
    }
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
pub async fn cursor_connect(app: AppHandle, api_key: String) -> Result<CursorStatus, String> {
    tauri::async_runtime::spawn_blocking(move || connect_blocking(&app, api_key))
        .await
        .map_err(|e| format!("cursor_connect failed: {e}"))?
}

fn connect_blocking(app: &AppHandle, api_key: String) -> Result<CursorStatus, String> {
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
    // New key → drop any catalog fetched under a previous account.
    if let Ok(mut cache) = MODEL_CACHE.lock() {
        *cache = None;
    }

    Ok(CursorStatus {
        authenticated: true,
        method: Some("apiKey".to_string()),
        api_key_name: me.api_key_name,
        user_email: me.user_email,
        cli_installed: resolve_agent_bin().is_some(),
    })
}

/// Remove the saved Cursor API key so the harness disconnects.
#[tauri::command(async)]
pub fn cursor_disconnect(app: AppHandle) -> Result<CursorStatus, String> {
    write_file(&app, &CursorFile::default())?;
    if let Ok(mut cache) = MODEL_CACHE.lock() {
        *cache = None;
    }
    status_blocking(&app, None)
}

/// How long a successful `GET /v1/models` response is reused. The catalog
/// changes infrequently; re-hitting the network on every picker open is what
/// pushed us past the frontend timeout into the static fallback.
const MODEL_CACHE_TTL: Duration = Duration::from_secs(600);

/// Bound the models request so a slow network cannot wedge harness refresh,
/// but leave enough headroom that a normal API round-trip completes.
const MODELS_HTTP_TIMEOUT: Duration = Duration::from_secs(15);

static MODEL_CACHE: std::sync::Mutex<Option<(std::time::Instant, Vec<CursorModelInfo>)>> =
    std::sync::Mutex::new(None);

/// List models from `GET /v1/models` using the saved API key.
///
/// `spawn_blocking`, not `#[tauri::command(async)]`: the body blocks on a
/// network round-trip, and `(async)` would run it on an async-runtime worker
/// thread. Those workers are shared with every other blocking command (git,
/// `gh`, harness CLI probes), so a busy startup can leave this one queued far
/// longer than the request itself takes.
#[tauri::command]
pub async fn cursor_list_models(app: AppHandle) -> Result<Vec<CursorModelInfo>, String> {
    tauri::async_runtime::spawn_blocking(move || list_models_blocking(&app))
        .await
        .map_err(|e| format!("cursor model lookup failed: {e}"))?
}

fn list_models_blocking(app: &AppHandle) -> Result<Vec<CursorModelInfo>, String> {
    if let Ok(cache) = MODEL_CACHE.lock() {
        if let Some((at, models)) = cache.as_ref() {
            if at.elapsed() < MODEL_CACHE_TTL && !models.is_empty() {
                return Ok(models.clone());
            }
        }
    }

    let key = saved_api_key(app)?.ok_or_else(|| "No Cursor API key configured".to_string())?;
    let started = std::time::Instant::now();
    let response: ModelsResponse =
        api_get_json_with_timeout(&key, "/v1/models", MODELS_HTTP_TIMEOUT)?;
    eprintln!("[fold][cursor] GET /v1/models took {:?}", started.elapsed());
    let models: Vec<CursorModelInfo> = response.items.into_iter().map(map_model).collect();
    if models.is_empty() {
        return Err("Cursor API returned an empty model catalog".to_string());
    }

    if let Ok(mut cache) = MODEL_CACHE.lock() {
        *cache = Some((std::time::Instant::now(), models.clone()));
    }
    Ok(models)
}

/// Run Cursor Agent CLI in a worktree (`agent -p --output-format stream-json`).
/// Streams NDJSON events; emits `__CURSOR_EXIT__:<code>` on exit.
#[tauri::command(async)]
pub fn cursor_agent_run(
    session_id: String,
    prompt: String,
    worktree: String,
    model: Option<String>,
    effort: Option<String>,
    plan_mode: Option<bool>,
    resume_session_id: Option<String>,
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

    // Register the cancel flag before the child is spawned. Commands run
    // concurrently, so a cancel issued while the agent is still starting must
    // find a flag to set — otherwise the run would keep going after the UI has
    // already returned to idle.
    let cancel = Arc::new(AtomicBool::new(false));
    state
        .cursor_agents
        .lock()
        .map_err(|e| e.to_string())?
        .insert(session_id.clone(), cancel.clone());

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
        args.push(cursor_model_with_effort(
            &m,
            effort.as_deref(),
        ));
    }
    // Continue the chat the previous turn created, so the agent keeps its
    // history. The id comes from the `system`/`init` event's `session_id`.
    if let Some(chat_id) = resume_session_id.filter(|s| !s.is_empty()) {
        args.push("--resume".into());
        args.push(chat_id);
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

    Ok(())
}

#[tauri::command(async)]
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


#[cfg(test)]
mod cursor_models_api_tests {
    use super::*;

    #[test]
    fn parses_live_v1_models_fixture() {
        let raw = std::fs::read_to_string("/tmp/cursor-models.json")
            .expect("missing /tmp/cursor-models.json — fetch GET /v1/models first");
        let parsed: ModelsResponse =
            serde_json::from_str(&raw).expect("ModelsResponse deserialize");
        assert!(
            parsed.items.len() >= 30,
            "expected full Cursor catalog, got {}",
            parsed.items.len()
        );
        let models: Vec<CursorModelInfo> = parsed.items.into_iter().map(map_model).collect();
        assert!(models.iter().any(|m| m.value == "composer-2.5"));
        assert!(models.iter().any(|m| m.value == "claude-sonnet-5"));
        assert!(models.iter().any(|m| m.value == "default"));
        // Must not look like the 3-item static fallback.
        assert!(models.len() > 3);
    }
}

#[cfg(test)]
mod cursor_live_api_tests {
    use super::*;

    /// Diagnostic: exercise the real HTTP path (reqwest build + auth + parse)
    /// with the saved key. `cargo test -- --ignored live_v1_models`.
    #[test]
    #[ignore]
    fn live_v1_models() {
        let path = format!(
            "{}/Library/Application Support/com.fold.dev/cursor.json",
            std::env::var("HOME").unwrap()
        );
        let Ok(raw) = std::fs::read_to_string(&path) else {
            println!("skipped: no saved key at {path}");
            return;
        };
        let file: CursorFile = serde_json::from_str(&raw).unwrap();
        let key = file.api_key.expect("cursor.json has no apiKey");
        let res: Result<ModelsResponse, String> =
            api_get_json_with_timeout(&key, "/v1/models", MODELS_HTTP_TIMEOUT);
        match res {
            Ok(r) => {
                let models: Vec<CursorModelInfo> =
                    r.items.into_iter().map(map_model).collect();
                println!("OK: {} models; first={:?}", models.len(), models.first().map(|m| &m.value));
                assert!(!models.is_empty());
            }
            Err(e) => panic!("cursor /v1/models failed: {e}"),
        }
    }
}
