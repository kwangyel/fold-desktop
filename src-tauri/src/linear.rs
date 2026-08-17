//! Linear integration via OAuth 2.0 (PKCE) + GraphQL.
//!
//! Connect opens Linear's authorize page in the browser and waits on a
//! loopback callback — same "click Connect" shape as GitHub in Apps.
//! Tokens live in `linear.json` under the app config dir.
//!
//! Register Fold as a Linear OAuth2 application with callback:
//! `http://127.0.0.1:17352/callback`
//! @see https://linear.app/developers/oauth-2-0-authentication

use std::collections::HashMap;
use std::io::{Read, Write};
use std::net::{TcpListener, TcpStream};
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::thread;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use base64::Engine;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use tauri::{AppHandle, Manager, State};

use crate::AppState;

const API_URL: &str = "https://api.linear.app/graphql";
const AUTHORIZE_URL: &str = "https://linear.app/oauth/authorize";
const TOKEN_URL: &str = "https://api.linear.app/oauth/token";
const REVOKE_URL: &str = "https://api.linear.app/oauth/revoke";
const HTTP_TIMEOUT: Duration = Duration::from_secs(30);
const LOGIN_TIMEOUT: Duration = Duration::from_secs(5 * 60);
const DEFAULT_ISSUE_LIMIT: i64 = 25;
const MAX_ISSUE_LIMIT: i64 = 50;

/// Loopback used as the OAuth redirect. Must match the Linear OAuth app exactly.
const LOOPBACK_HOST: &str = "127.0.0.1";
const LOOPBACK_PORT: u16 = 17352;
const LOOPBACK_PATH: &str = "/callback";

/// Public Linear OAuth client ID for Fold. Override at runtime with
/// `FOLD_LINEAR_CLIENT_ID` if you need to point at a different OAuth app.
const BAKED_LINEAR_CLIENT_ID: &str = "afb074afd4b45de67eda7251dbd1cefa";

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LinearStatus {
    authenticated: bool,
    user_name: Option<String>,
    user_email: Option<String>,
    organization_name: Option<String>,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct LinearIssue {
    id: String,
    identifier: String,
    title: String,
    description: Option<String>,
    url: String,
    state_name: Option<String>,
    state_type: Option<String>,
    state_color: Option<String>,
    team_key: Option<String>,
    team_name: Option<String>,
    assignee_name: Option<String>,
    priority_label: Option<String>,
}

#[derive(Serialize, Deserialize, Clone, Default)]
#[serde(rename_all = "camelCase")]
struct LinearFile {
    /// OAuth access token (PKCE). Preferred over `api_key`.
    access_token: Option<String>,
    refresh_token: Option<String>,
    /// Unix seconds when `access_token` expires.
    expires_at: Option<i64>,
    /// Legacy personal API key; still honored if no OAuth token is saved.
    api_key: Option<String>,
    user_name: Option<String>,
    user_email: Option<String>,
    organization_name: Option<String>,
}

#[derive(Deserialize)]
struct GraphqlResponse<T> {
    data: Option<T>,
    #[serde(default)]
    errors: Vec<GraphqlError>,
}

#[derive(Deserialize)]
struct GraphqlError {
    message: String,
}

#[derive(Deserialize)]
struct ViewerData {
    viewer: Viewer,
}

#[derive(Deserialize)]
struct Viewer {
    name: Option<String>,
    email: Option<String>,
    organization: Option<Organization>,
}

#[derive(Deserialize)]
struct Organization {
    name: Option<String>,
}

#[derive(Deserialize)]
struct IssuesData {
    issues: IssueConnection,
}

#[derive(Deserialize)]
struct SearchIssuesData {
    #[serde(rename = "searchIssues")]
    search_issues: IssueConnection,
}

#[derive(Deserialize)]
struct IssueData {
    issue: Option<ApiIssue>,
}

#[derive(Deserialize)]
struct IssueConnection {
    #[serde(default)]
    nodes: Vec<ApiIssue>,
}

#[derive(Deserialize)]
struct ApiIssue {
    id: String,
    identifier: String,
    title: String,
    description: Option<String>,
    url: String,
    #[serde(rename = "priorityLabel")]
    priority_label: Option<String>,
    state: Option<ApiState>,
    team: Option<ApiTeam>,
    assignee: Option<ApiUser>,
}

#[derive(Deserialize)]
struct ApiState {
    name: Option<String>,
    #[serde(rename = "type")]
    state_type: Option<String>,
    color: Option<String>,
}

#[derive(Deserialize)]
struct ApiTeam {
    key: Option<String>,
    name: Option<String>,
}

#[derive(Deserialize)]
struct ApiUser {
    name: Option<String>,
}

#[derive(Deserialize)]
struct TokenResponse {
    access_token: Option<String>,
    refresh_token: Option<String>,
    expires_in: Option<i64>,
    error: Option<String>,
    error_description: Option<String>,
}

fn redirect_uri() -> String {
    format!("http://{LOOPBACK_HOST}:{LOOPBACK_PORT}{LOOPBACK_PATH}")
}

fn linear_client_id() -> String {
    std::env::var("FOLD_LINEAR_CLIENT_ID")
        .ok()
        .map(|id| id.trim().to_string())
        .filter(|id| !id.is_empty())
        .unwrap_or_else(|| BAKED_LINEAR_CLIENT_ID.to_string())
}

fn linear_file(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_config_dir()
        .map_err(|e| format!("failed to resolve config dir: {e}"))?;
    std::fs::create_dir_all(&dir).map_err(|e| format!("failed to create config dir: {e}"))?;
    Ok(dir.join("linear.json"))
}

fn read_file(app: &AppHandle) -> Result<LinearFile, String> {
    let path = linear_file(app)?;
    match std::fs::read_to_string(&path) {
        Ok(contents) => serde_json::from_str(&contents)
            .map_err(|e| format!("failed to parse linear.json: {e}")),
        Err(_) => Ok(LinearFile::default()),
    }
}

fn write_file(app: &AppHandle, data: &LinearFile) -> Result<(), String> {
    let path = linear_file(app)?;
    let contents = serde_json::to_string_pretty(data)
        .map_err(|e| format!("failed to serialize linear config: {e}"))?;
    std::fs::write(&path, contents).map_err(|e| format!("failed to write linear.json: {e}"))
}

fn status_from_file(file: &LinearFile) -> LinearStatus {
    LinearStatus {
        authenticated: has_credentials(file),
        user_name: file.user_name.clone(),
        user_email: file.user_email.clone(),
        organization_name: file.organization_name.clone(),
    }
}

fn has_credentials(file: &LinearFile) -> bool {
    file.access_token
        .as_ref()
        .is_some_and(|s| !s.trim().is_empty())
        || file.api_key.as_ref().is_some_and(|s| !s.trim().is_empty())
}

fn now_unix() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

fn authorization_value(file: &LinearFile) -> Result<String, String> {
    if let Some(token) = file
        .access_token
        .as_ref()
        .map(|s| s.trim())
        .filter(|s| !s.is_empty())
    {
        return Ok(format!("Bearer {token}"));
    }
    if let Some(key) = file
        .api_key
        .as_ref()
        .map(|s| s.trim())
        .filter(|s| !s.is_empty())
    {
        return Ok(key.to_string());
    }
    Err("Linear is not connected. Connect Linear in Apps.".to_string())
}

fn http_client() -> Result<reqwest::blocking::Client, String> {
    reqwest::blocking::Client::builder()
        .timeout(HTTP_TIMEOUT)
        .build()
        .map_err(|e| format!("failed to build HTTP client: {e}"))
}

fn url_encode(s: &str) -> String {
    let mut out = String::new();
    for b in s.bytes() {
        match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                out.push(b as char)
            }
            _ => out.push_str(&format!("%{b:02X}")),
        }
    }
    out
}

fn random_url_token(nbytes: usize) -> Result<String, String> {
    let mut bytes = vec![0u8; nbytes];
    getrandom::getrandom(&mut bytes).map_err(|e| format!("failed to generate random token: {e}"))?;
    Ok(URL_SAFE_NO_PAD.encode(bytes))
}

fn pkce_challenge(verifier: &str) -> String {
    let hash = Sha256::digest(verifier.as_bytes());
    URL_SAFE_NO_PAD.encode(hash)
}

fn parse_query(query: &str) -> HashMap<String, String> {
    let mut out = HashMap::new();
    for pair in query.split('&') {
        if pair.is_empty() {
            continue;
        }
        let mut parts = pair.splitn(2, '=');
        let key = parts.next().unwrap_or("");
        let value = parts.next().unwrap_or("");
        out.insert(url_decode(key), url_decode(value));
    }
    out
}

fn url_decode(s: &str) -> String {
    let bytes = s.as_bytes();
    let mut out = Vec::new();
    let mut i = 0;
    while i < bytes.len() {
        match bytes[i] {
            b'+' => {
                out.push(b' ');
                i += 1;
            }
            b'%' if i + 2 < bytes.len() => {
                let hex = &s[i + 1..i + 3];
                if let Ok(v) = u8::from_str_radix(hex, 16) {
                    out.push(v);
                    i += 3;
                } else {
                    out.push(b'%');
                    i += 1;
                }
            }
            b => {
                out.push(b);
                i += 1;
            }
        }
    }
    String::from_utf8_lossy(&out).into_owned()
}

fn write_http_page(stream: &mut TcpStream, status: &str, body: &str) {
    let response = format!(
        "HTTP/1.1 {status}\r\nContent-Type: text/html; charset=utf-8\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
        body.len()
    );
    let _ = stream.write_all(response.as_bytes());
}

fn success_page() -> &'static str {
    "<!doctype html><meta charset=utf-8><title>Fold</title>\
     <body style=\"font-family:system-ui;padding:48px;text-align:center;color:#111\">\
     <h1>Connected to Linear</h1><p>You can close this tab and return to Fold.</p>"
}

fn error_page(message: &str) -> String {
    format!(
        "<!doctype html><meta charset=utf-8><title>Fold</title>\
         <body style=\"font-family:system-ui;padding:48px;text-align:center;color:#111\">\
         <h1>Linear sign-in didn’t finish</h1><p>{}</p>",
        html_escape(message)
    )
}

fn html_escape(s: &str) -> String {
    s.replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
}

/// Wait for Linear to redirect the browser to the loopback callback.
fn wait_for_callback(
    expected_state: &str,
    cancel: &AtomicBool,
) -> Result<String, String> {
    let listener = TcpListener::bind((LOOPBACK_HOST, LOOPBACK_PORT)).map_err(|e| {
        format!(
            "could not listen on http://{LOOPBACK_HOST}:{LOOPBACK_PORT} for Linear login: {e}"
        )
    })?;
    listener
        .set_nonblocking(true)
        .map_err(|e| format!("failed to set login socket non-blocking: {e}"))?;

    let deadline = SystemTime::now() + LOGIN_TIMEOUT;
    loop {
        if cancel.load(Ordering::SeqCst) {
            return Err("cancelled".to_string());
        }
        if SystemTime::now() > deadline {
            return Err("Linear login timed out. Try Connect again.".to_string());
        }
        match listener.accept() {
            Ok((mut stream, _)) => match handle_callback_conn(&mut stream, expected_state) {
                Ok(code) => return Ok(code),
                Err(e) if e == "not-callback" => continue,
                Err(e) => return Err(e),
            },
            Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => {
                thread::sleep(Duration::from_millis(100));
            }
            Err(e) => return Err(format!("Linear login listener failed: {e}")),
        }
    }
}

fn handle_callback_conn(stream: &mut TcpStream, expected_state: &str) -> Result<String, String> {
    stream
        .set_read_timeout(Some(Duration::from_secs(5)))
        .ok();
    let mut buf = [0u8; 4096];
    let n = stream.read(&mut buf).unwrap_or(0);
    let req = String::from_utf8_lossy(&buf[..n]);
    let first = req.lines().next().unwrap_or("");
    let path = first.split_whitespace().nth(1).unwrap_or("");
    let (route, query) = path.split_once('?').unwrap_or((path, ""));
    if route != LOOPBACK_PATH {
        write_http_page(stream, "404 Not Found", &error_page("Unexpected callback path."));
        return Err("not-callback".to_string());
    }
    let params = parse_query(query);
    if let Some(err) = params.get("error") {
        let desc = params
            .get("error_description")
            .cloned()
            .unwrap_or_else(|| err.clone());
        write_http_page(stream, "400 Bad Request", &error_page(&desc));
        return Err(desc);
    }
    let state = params.get("state").cloned().unwrap_or_default();
    if state != expected_state {
        write_http_page(
            stream,
            "400 Bad Request",
            &error_page("Login state mismatch. Try Connect again."),
        );
        return Err("Linear login state mismatch. Try Connect again.".to_string());
    }
    let code = params.get("code").cloned().unwrap_or_default();
    if code.is_empty() {
        write_http_page(
            stream,
            "400 Bad Request",
            &error_page("Linear did not return an authorization code."),
        );
        return Err("Linear did not return an authorization code.".to_string());
    }
    write_http_page(stream, "200 OK", success_page());
    Ok(code)
}

fn post_form(url: &str, body: &str) -> Result<TokenResponse, String> {
    let client = http_client()?;
    let res = client
        .post(url)
        .header("Content-Type", "application/x-www-form-urlencoded")
        .header("Accept", "application/json")
        .body(body.to_string())
        .send()
        .map_err(|e| format!("Linear token request failed: {e}"))?;
    let status = res.status();
    let parsed = res
        .json::<TokenResponse>()
        .map_err(|e| format!("failed to parse Linear token response: {e}"))?;
    if !status.is_success() || parsed.error.is_some() {
        let msg = parsed
            .error_description
            .or(parsed.error)
            .unwrap_or_else(|| format!("HTTP {status}"));
        return Err(format!("Linear OAuth error: {msg}"));
    }
    Ok(parsed)
}

fn exchange_code(
    client_id: &str,
    code: &str,
    verifier: &str,
) -> Result<(String, Option<String>, Option<i64>), String> {
    let body = format!(
        "grant_type=authorization_code&code={}&redirect_uri={}&client_id={}&code_verifier={}",
        url_encode(code),
        url_encode(&redirect_uri()),
        url_encode(client_id),
        url_encode(verifier),
    );
    let parsed = post_form(TOKEN_URL, &body)?;
    let access = parsed
        .access_token
        .filter(|s| !s.is_empty())
        .ok_or_else(|| "Linear OAuth response missing access_token".to_string())?;
    Ok((access, parsed.refresh_token, parsed.expires_in))
}

fn refresh_access_token(
    client_id: &str,
    refresh_token: &str,
) -> Result<(String, Option<String>, Option<i64>), String> {
    let body = format!(
        "grant_type=refresh_token&refresh_token={}&client_id={}",
        url_encode(refresh_token),
        url_encode(client_id),
    );
    let parsed = post_form(TOKEN_URL, &body)?;
    let access = parsed
        .access_token
        .filter(|s| !s.is_empty())
        .ok_or_else(|| "Linear refresh response missing access_token".to_string())?;
    Ok((
        access,
        parsed.refresh_token.or(Some(refresh_token.to_string())),
        parsed.expires_in,
    ))
}

fn apply_tokens(
    file: &mut LinearFile,
    access: String,
    refresh: Option<String>,
    expires_in: Option<i64>,
) {
    file.access_token = Some(access);
    if let Some(refresh) = refresh.filter(|s| !s.is_empty()) {
        file.refresh_token = Some(refresh);
    }
    file.expires_at = expires_in.map(|secs| now_unix() + secs.max(0));
    file.api_key = None;
}

fn ensure_fresh_token(app: &AppHandle, file: &mut LinearFile) -> Result<(), String> {
    let Some(refresh) = file
        .refresh_token
        .as_ref()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
    else {
        return Ok(());
    };
    let expiring = file
        .expires_at
        .is_some_and(|exp| exp <= now_unix() + 60);
    if !expiring {
        return Ok(());
    }
    let client_id = linear_client_id();
    let (access, new_refresh, expires_in) = refresh_access_token(&client_id, &refresh)?;
    apply_tokens(file, access, new_refresh, expires_in);
    write_file(app, file)
}

fn revoke_token(token: &str) {
    let body = format!(
        "token={}&token_type_hint=access_token",
        url_encode(token)
    );
    let _ = post_form(REVOKE_URL, &body);
}

fn graphql<T: for<'de> Deserialize<'de>>(
    authorization: &str,
    query: &str,
    variables: Value,
) -> Result<T, String> {
    let client = http_client()?;
    let res = client
        .post(API_URL)
        .header("Authorization", authorization)
        .header("Content-Type", "application/json")
        .json(&json!({ "query": query, "variables": variables }))
        .send()
        .map_err(|e| format!("Linear API request failed: {e}"))?;

    let status = res.status();
    if status == reqwest::StatusCode::UNAUTHORIZED {
        return Err("unauthorized".to_string());
    }
    if status == reqwest::StatusCode::FORBIDDEN {
        return Err("Linear token lacks permission for this request".to_string());
    }
    if status == reqwest::StatusCode::TOO_MANY_REQUESTS {
        return Err("Linear API rate limit exceeded. Try again shortly.".to_string());
    }
    if !status.is_success() {
        let body = res.text().unwrap_or_default();
        return Err(format!(
            "Linear API error (HTTP {status}): {}",
            body.chars().take(200).collect::<String>()
        ));
    }

    let parsed = res
        .json::<GraphqlResponse<T>>()
        .map_err(|e| format!("failed to parse Linear API response: {e}"))?;
    if let Some(err) = parsed.errors.first() {
        let msg = err.message.trim();
        let lower = msg.to_ascii_lowercase();
        if lower.contains("unauthor") || lower.contains("not authenticated") {
            return Err("unauthorized".to_string());
        }
        return Err(format!("Linear API error: {msg}"));
    }
    parsed
        .data
        .ok_or_else(|| "Linear API returned no data".to_string())
}

fn graphql_authed<T: for<'de> Deserialize<'de>>(
    app: &AppHandle,
    query: &str,
    variables: Value,
) -> Result<T, String> {
    let mut file = read_file(app)?;
    ensure_fresh_token(app, &mut file)?;
    let auth = authorization_value(&file)?;
    match graphql::<T>(&auth, query, variables.clone()) {
        Ok(data) => Ok(data),
        Err(e) if e == "unauthorized" => {
            if let Some(refresh) = file
                .refresh_token
                .as_ref()
                .map(|s| s.trim().to_string())
                .filter(|s| !s.is_empty())
            {
                let client_id = linear_client_id();
                let (access, new_refresh, expires_in) =
                    refresh_access_token(&client_id, &refresh)?;
                apply_tokens(&mut file, access, new_refresh, expires_in);
                write_file(app, &file)?;
                let auth = authorization_value(&file)?;
                return graphql::<T>(&auth, query, variables).map_err(|err| {
                    if err == "unauthorized" {
                        "Linear authorization expired. Reconnect in Apps.".to_string()
                    } else {
                        err
                    }
                });
            }
            Err("Linear authorization expired. Reconnect in Apps.".to_string())
        }
        Err(e) => Err(e),
    }
}

const VIEWER_QUERY: &str = r#"
query FoldViewer {
  viewer {
    name
    email
    organization { name }
  }
}
"#;

const ISSUE_FIELDS: &str = r#"
  id
  identifier
  title
  description
  url
  priorityLabel
  state { name type color }
  team { key name }
  assignee { name }
"#;

fn issues_query() -> String {
    format!(
        r#"
query FoldIssues($first: Int, $filter: IssueFilter) {{
  issues(first: $first, filter: $filter, orderBy: updatedAt) {{
    nodes {{
      {ISSUE_FIELDS}
    }}
  }}
}}
"#
    )
}

fn search_issues_query() -> String {
    format!(
        r#"
query FoldSearchIssues($term: String!, $first: Int) {{
  searchIssues(term: $term, first: $first) {{
    nodes {{
      {ISSUE_FIELDS}
    }}
  }}
}}
"#
    )
}

fn issue_query() -> String {
    format!(
        r#"
query FoldIssue($id: String!) {{
  issue(id: $id) {{
    {ISSUE_FIELDS}
  }}
}}
"#
    )
}

fn fetch_viewer(
    authorization: &str,
) -> Result<(Option<String>, Option<String>, Option<String>), String> {
    let data: ViewerData = graphql(authorization, VIEWER_QUERY, json!({}))?;
    Ok((
        data.viewer.name,
        data.viewer.email,
        data.viewer.organization.and_then(|o| o.name),
    ))
}

fn map_issue(issue: ApiIssue) -> LinearIssue {
    LinearIssue {
        id: issue.id,
        identifier: issue.identifier,
        title: issue.title,
        description: issue.description,
        url: issue.url,
        state_name: issue.state.as_ref().and_then(|s| s.name.clone()),
        state_type: issue.state.as_ref().and_then(|s| s.state_type.clone()),
        state_color: issue.state.as_ref().and_then(|s| s.color.clone()),
        team_key: issue.team.as_ref().and_then(|t| t.key.clone()),
        team_name: issue.team.as_ref().and_then(|t| t.name.clone()),
        assignee_name: issue.assignee.and_then(|a| a.name),
        priority_label: issue.priority_label,
    }
}

fn assigned_open_filter() -> Value {
    json!({
        "assignee": { "isMe": { "eq": true } },
        "state": { "type": { "nin": ["completed", "canceled"] } }
    })
}

fn identifier_lookup(query: &str) -> Option<String> {
    let trimmed = query.trim();
    let (team, number) = trimmed.split_once('-')?;
    if team.is_empty() || number.is_empty() {
        return None;
    }
    if !team.chars().all(|c| c.is_ascii_alphanumeric()) {
        return None;
    }
    if !number.chars().all(|c| c.is_ascii_digit()) {
        return None;
    }
    Some(trimmed.to_ascii_uppercase())
}

fn clamp_limit(first: Option<i64>) -> i64 {
    first
        .unwrap_or(DEFAULT_ISSUE_LIMIT)
        .clamp(1, MAX_ISSUE_LIMIT)
}

fn title_search_filter(term: &str) -> Value {
    json!({
        "title": { "containsIgnoreCase": term },
        "state": { "type": { "nin": ["completed", "canceled"] } }
    })
}

fn list_issues_blocking(
    app: &AppHandle,
    query: Option<String>,
    first: Option<i64>,
) -> Result<Vec<LinearIssue>, String> {
    let limit = clamp_limit(first);
    let term = query.unwrap_or_default();
    let trimmed = term.trim();

    if trimmed.is_empty() {
        let data: IssuesData = graphql_authed(
            app,
            &issues_query(),
            json!({ "first": limit, "filter": assigned_open_filter() }),
        )?;
        return Ok(data.issues.nodes.into_iter().map(map_issue).collect());
    }

    if let Some(identifier) = identifier_lookup(trimmed) {
        if let Some(issue) = get_issue_blocking(app, &identifier)? {
            return Ok(vec![issue]);
        }
    }

    match graphql_authed::<SearchIssuesData>(
        app,
        &search_issues_query(),
        json!({ "term": trimmed, "first": limit }),
    ) {
        Ok(data) => Ok(data
            .search_issues
            .nodes
            .into_iter()
            .map(map_issue)
            .collect()),
        Err(e) => {
            let lower = e.to_ascii_lowercase();
            if lower.contains("cannot query field") || lower.contains("unknown field") {
                let data: IssuesData = graphql_authed(
                    app,
                    &issues_query(),
                    json!({ "first": limit, "filter": title_search_filter(trimmed) }),
                )?;
                return Ok(data.issues.nodes.into_iter().map(map_issue).collect());
            }
            Err(e)
        }
    }
}

fn get_issue_blocking(app: &AppHandle, id: &str) -> Result<Option<LinearIssue>, String> {
    match graphql_authed::<IssueData>(app, &issue_query(), json!({ "id": id })) {
        Ok(data) => Ok(data.issue.map(map_issue)),
        Err(e) => {
            let lower = e.to_ascii_lowercase();
            if lower.contains("entity not found") || lower.contains("could not find") {
                Ok(None)
            } else {
                Err(e)
            }
        }
    }
}

#[derive(Deserialize)]
struct CloseIssueData {
    issue: Option<CloseApiIssue>,
}

#[derive(Deserialize)]
struct CloseApiIssue {
    id: String,
    state: Option<ApiState>,
    team: Option<CloseApiTeam>,
}

#[derive(Deserialize)]
struct CloseApiTeam {
    states: Option<StateConnection>,
}

#[derive(Deserialize)]
struct StateConnection {
    #[serde(default)]
    nodes: Vec<ApiWorkflowState>,
}

#[derive(Deserialize, Clone)]
struct ApiWorkflowState {
    id: String,
    name: Option<String>,
    #[serde(rename = "type")]
    state_type: Option<String>,
}

#[derive(Deserialize)]
struct IssueUpdateData {
    #[serde(rename = "issueUpdate")]
    issue_update: IssueUpdatePayload,
}

#[derive(Deserialize)]
struct IssueUpdatePayload {
    success: Option<bool>,
}

const CLOSE_ISSUE_QUERY: &str = r#"
query FoldIssueClose($id: String!) {
  issue(id: $id) {
    id
    state { name type color }
    team {
      states(first: 50) {
        nodes { id name type }
      }
    }
  }
}
"#;

const CLOSE_ISSUE_MUTATION: &str = r#"
mutation FoldIssueClose($id: String!, $stateId: String!) {
  issueUpdate(id: $id, input: { stateId: $stateId }) {
    success
  }
}
"#;

fn pick_completed_state(states: &[ApiWorkflowState]) -> Option<&ApiWorkflowState> {
    let completed: Vec<&ApiWorkflowState> = states
        .iter()
        .filter(|s| {
            s.state_type
                .as_deref()
                .is_some_and(|t| t.eq_ignore_ascii_case("completed"))
        })
        .collect();
    completed
        .iter()
        .copied()
        .find(|s| {
            let name = s.name.as_deref().unwrap_or("").to_ascii_lowercase();
            name == "done" || name == "completed" || name == "closed"
        })
        .or_else(|| completed.first().copied())
}

fn write_scope_hint(error: &str) -> String {
    let lower = error.to_ascii_lowercase();
    if lower.contains("write")
        || lower.contains("permission")
        || lower.contains("forbidden")
        || lower.contains("not authorized")
        || lower.contains("scope")
    {
        return format!(
            "{error} Reconnect Linear in Apps so Fold can close issues (write access)."
        );
    }
    error.to_string()
}

fn close_issue_blocking(app: &AppHandle, id: &str) -> Result<(), String> {
    let trimmed = id.trim();
    if trimmed.is_empty() {
        return Err("Linear issue id is required".to_string());
    }

    let data: CloseIssueData = graphql_authed(app, CLOSE_ISSUE_QUERY, json!({ "id": trimmed }))
        .map_err(|e| write_scope_hint(&e))?;
    let issue = data
        .issue
        .ok_or_else(|| format!("Linear issue not found: {trimmed}"))?;

    let state_type = issue
        .state
        .as_ref()
        .and_then(|s| s.state_type.as_deref())
        .unwrap_or("");
    if state_type.eq_ignore_ascii_case("completed")
        || state_type.eq_ignore_ascii_case("canceled")
    {
        return Ok(());
    }

    let states: Vec<ApiWorkflowState> = issue
        .team
        .and_then(|t| t.states)
        .map(|s| s.nodes)
        .unwrap_or_default();
    let completed = pick_completed_state(&states).ok_or_else(|| {
        "No completed workflow state found for this Linear team".to_string()
    })?;

    let updated: IssueUpdateData = graphql_authed(
        app,
        CLOSE_ISSUE_MUTATION,
        json!({ "id": issue.id, "stateId": completed.id }),
    )
    .map_err(|e| write_scope_hint(&e))?;
    if updated.issue_update.success.unwrap_or(false) {
        return Ok(());
    }
    Err("Linear did not confirm the issue was closed".to_string())
}

fn connect_blocking(app: &AppHandle, cancel: Arc<AtomicBool>) -> Result<LinearStatus, String> {
    let client_id = linear_client_id();
    let state = random_url_token(16)?;
    let verifier = random_url_token(32)?;
    let challenge = pkce_challenge(&verifier);
    let auth_url = format!(
        "{AUTHORIZE_URL}?response_type=code&client_id={}&redirect_uri={}&scope={}&state={}&code_challenge={}&code_challenge_method=S256&actor=user&prompt=consent",
        url_encode(&client_id),
        url_encode(&redirect_uri()),
        url_encode("read,write"),
        url_encode(&state),
        url_encode(&challenge),
    );
    crate::github::open_external(auth_url)?;
    let code = wait_for_callback(&state, &cancel)?;
    let (access, refresh, expires_in) = exchange_code(&client_id, &code, &verifier)?;
    let (user_name, user_email, organization_name) =
        fetch_viewer(&format!("Bearer {access}"))?;
    let file = LinearFile {
        access_token: Some(access),
        refresh_token: refresh,
        expires_at: expires_in.map(|secs| now_unix() + secs.max(0)),
        api_key: None,
        user_name: user_name.clone(),
        user_email: user_email.clone(),
        organization_name: organization_name.clone(),
    };
    write_file(app, &file)?;
    Ok(LinearStatus {
        authenticated: true,
        user_name,
        user_email,
        organization_name,
    })
}

/// Status uses the **saved** credentials only so Disconnect always clears connection.
#[tauri::command]
pub async fn linear_status(app: AppHandle) -> Result<LinearStatus, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let file = read_file(&app)?;
        Ok(status_from_file(&file))
    })
    .await
    .map_err(|e| format!("linear_status failed: {e}"))?
}

/// Open Linear in the browser and complete PKCE OAuth on the loopback callback.
#[tauri::command]
pub async fn linear_connect(
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<LinearStatus, String> {
    let cancel = Arc::new(AtomicBool::new(false));
    {
        let mut slot = state
            .linear_login
            .lock()
            .map_err(|e| e.to_string())?;
        if let Some(prev) = slot.as_ref() {
            prev.store(true, Ordering::SeqCst);
        }
        *slot = Some(cancel.clone());
    }
    let result = tauri::async_runtime::spawn_blocking({
        let app = app.clone();
        let cancel = cancel.clone();
        move || connect_blocking(&app, cancel)
    })
    .await
    .map_err(|e| format!("linear_connect failed: {e}"))?;
    if let Ok(mut slot) = state.linear_login.lock() {
        *slot = None;
    }
    result
}

/// Stop an in-flight Linear browser login.
#[tauri::command]
pub async fn linear_connect_cancel(state: State<'_, AppState>) -> Result<(), String> {
    if let Some(flag) = state
        .linear_login
        .lock()
        .map_err(|e| e.to_string())?
        .as_ref()
    {
        flag.store(true, Ordering::SeqCst);
    }
    Ok(())
}

/// Revoke the saved Linear token and clear local credentials.
#[tauri::command]
pub async fn linear_disconnect(app: AppHandle) -> Result<LinearStatus, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let file = read_file(&app).unwrap_or_default();
        if let Some(token) = file
            .access_token
            .as_ref()
            .map(|s| s.trim())
            .filter(|s| !s.is_empty())
        {
            revoke_token(token);
        }
        write_file(&app, &LinearFile::default())?;
        Ok(LinearStatus {
            authenticated: false,
            user_name: None,
            user_email: None,
            organization_name: None,
        })
    })
    .await
    .map_err(|e| format!("linear_disconnect failed: {e}"))?
}

/// Search or list Linear issues the connected account can see.
#[tauri::command]
pub async fn linear_list_issues(
    app: AppHandle,
    query: Option<String>,
    first: Option<i64>,
) -> Result<Vec<LinearIssue>, String> {
    tauri::async_runtime::spawn_blocking(move || list_issues_blocking(&app, query, first))
        .await
        .map_err(|e| format!("linear_list_issues failed: {e}"))?
}

/// Fetch one issue by UUID or identifier (e.g. `KIN-25`).
#[tauri::command]
pub async fn linear_get_issue(app: AppHandle, id: String) -> Result<Option<LinearIssue>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let trimmed = id.trim();
        if trimmed.is_empty() {
            return Ok(None);
        }
        get_issue_blocking(&app, trimmed)
    })
    .await
    .map_err(|e| format!("linear_get_issue failed: {e}"))?
}

/// Move a Linear issue to its team's completed workflow state.
#[tauri::command]
pub async fn linear_close_issue(app: AppHandle, id: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || close_issue_blocking(&app, &id))
        .await
        .map_err(|e| format!("linear_close_issue failed: {e}"))?
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn identifier_lookup_accepts_team_number() {
        assert_eq!(identifier_lookup("kin-25").as_deref(), Some("KIN-25"));
        assert_eq!(identifier_lookup(" ENG-104 ").as_deref(), Some("ENG-104"));
        assert_eq!(identifier_lookup("linear integration"), None);
        assert_eq!(identifier_lookup("25"), None);
    }

    #[test]
    fn clamp_limit_bounds_page_size() {
        assert_eq!(clamp_limit(None), DEFAULT_ISSUE_LIMIT);
        assert_eq!(clamp_limit(Some(0)), 1);
        assert_eq!(clamp_limit(Some(500)), MAX_ISSUE_LIMIT);
    }

    #[test]
    fn pkce_challenge_is_base64url_sha256() {
        let challenge = pkce_challenge("test-verifier");
        assert!(!challenge.contains('+') && !challenge.contains('/'));
        assert_eq!(challenge.len(), 43);
    }

    #[test]
    fn parse_query_decodes_callback() {
        let q = parse_query("code=abc%2Fdef&state=xyz");
        assert_eq!(q.get("code").map(String::as_str), Some("abc/def"));
        assert_eq!(q.get("state").map(String::as_str), Some("xyz"));
    }

    #[test]
    fn map_issue_flattens_nested_fields() {
        let issue = map_issue(ApiIssue {
            id: "abc".into(),
            identifier: "KIN-25".into(),
            title: "Linear integration".into(),
            description: Some("Connect Linear".into()),
            url: "https://linear.app/x/issue/KIN-25".into(),
            priority_label: Some("High".into()),
            state: Some(ApiState {
                name: Some("Backlog".into()),
                state_type: Some("backlog".into()),
                color: Some("#bec2c8".into()),
            }),
            team: Some(ApiTeam {
                key: Some("KIN".into()),
                name: Some("Kinley".into()),
            }),
            assignee: Some(ApiUser {
                name: Some("Kinley".into()),
            }),
        });
        assert_eq!(issue.identifier, "KIN-25");
        assert_eq!(issue.state_name.as_deref(), Some("Backlog"));
        assert_eq!(issue.team_key.as_deref(), Some("KIN"));
        assert_eq!(issue.assignee_name.as_deref(), Some("Kinley"));
    }

    fn state(id: &str, name: &str, state_type: &str) -> ApiWorkflowState {
        ApiWorkflowState {
            id: id.into(),
            name: Some(name.into()),
            state_type: Some(state_type.into()),
        }
    }

    #[test]
    fn pick_completed_state_prefers_done() {
        let states = vec![
            state("1", "In Progress", "started"),
            state("2", "Done", "completed"),
            state("3", "Canceled", "canceled"),
        ];
        assert_eq!(pick_completed_state(&states).map(|s| s.id.as_str()), Some("2"));
    }

    #[test]
    fn pick_completed_state_falls_back_to_first_completed() {
        let states = vec![
            state("1", "Todo", "unstarted"),
            state("2", "Shipped", "completed"),
        ];
        assert_eq!(pick_completed_state(&states).map(|s| s.id.as_str()), Some("2"));
    }

    #[test]
    fn pick_completed_state_none_when_missing() {
        let states = vec![state("1", "Todo", "unstarted")];
        assert!(pick_completed_state(&states).is_none());
    }
}
