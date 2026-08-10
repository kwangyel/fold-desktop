//! Per-worktree chat persistence.
//!
//! Each worktree gets its own SQLite database inside its Fold data directory:
//!
//! ```text
//! ~/fold/workspaces/<project>/.fold/<worktree>/chats.db
//! ```
//!
//! Keeping one database per worktree means archiving or removing a worktree
//! needs no chat-specific cleanup — `fold_paths::remove_fold_data_dir` already
//! deletes the whole directory, taking `chats.db` (and its WAL sidecars) with
//! it.
//!
//! Unlike `git::read_file` / `git::write_file`, every command here takes an
//! explicit `worktree` rather than resolving against the active project, so the
//! sidebar can list chats for worktrees the user is not currently working in.

use std::path::{Path, PathBuf};

use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};

/// Row in the sidebar's per-worktree chat list.
#[derive(Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ChatSummary {
    pub id: String,
    pub title: String,
    pub harness: String,
    pub model: Option<String>,
    pub created_at: i64,
    pub updated_at: i64,
    pub message_count: i64,
}

/// Chat metadata written when a draft chat receives its first prompt.
#[derive(Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ChatMeta {
    pub id: String,
    pub title: String,
    pub harness: String,
    pub model: Option<String>,
    pub effort: Option<String>,
    pub created_at: i64,
    pub updated_at: i64,
}

/// A harness session id bound to a chat. One row per harness, so switching back
/// to a previously used harness resumes its own session rather than starting over.
#[derive(Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ChatSession {
    pub harness: String,
    pub session_id: String,
}

/// One persisted transcript entry. Mirrors the frontend `Message` type; the
/// list-valued fields are stored as JSON text.
#[derive(Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ChatMessage {
    pub id: String,
    pub seq: i64,
    pub role: String,
    pub content: String,
    pub tool_name: Option<String>,
    pub tool_status: Option<String>,
    pub detail: Option<String>,
    pub tool_output: Option<String>,
    /// JSON array of strings.
    pub file_paths: Option<String>,
    /// JSON array of attachment chips.
    pub attachments: Option<String>,
    pub timestamp: i64,
}

/// Everything needed to rehydrate a chat tab.
#[derive(Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ChatRecord {
    pub meta: ChatMeta,
    pub sessions: Vec<ChatSession>,
    pub messages: Vec<ChatMessage>,
}

fn db_path(worktree: &str) -> Result<PathBuf, String> {
    let dir = crate::fold_paths::fold_data_dir(Path::new(worktree))
        .ok_or_else(|| "could not resolve Fold data directory for worktree".to_string())?;
    Ok(dir.join("chats.db"))
}

/// Open (creating if needed) the chat database for a worktree.
///
/// Connections are opened per call rather than cached: a worktree can be
/// archived or removed at any time, and a cached handle would keep the deleted
/// file alive and later write it back.
fn open(worktree: &str) -> Result<Connection, String> {
    let path = db_path(worktree)?;
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|e| format!("failed to create Fold data directory: {e}"))?;
    }
    let conn = Connection::open(&path).map_err(|e| format!("failed to open chat store: {e}"))?;
    conn.execute_batch(
        "PRAGMA journal_mode = WAL;
         PRAGMA foreign_keys = ON;
         CREATE TABLE IF NOT EXISTS chats (
           id         TEXT PRIMARY KEY,
           title      TEXT NOT NULL,
           harness    TEXT NOT NULL,
           model      TEXT,
           effort     TEXT,
           created_at INTEGER NOT NULL,
           updated_at INTEGER NOT NULL
         );
         CREATE TABLE IF NOT EXISTS chat_sessions (
           chat_id    TEXT NOT NULL,
           harness    TEXT NOT NULL,
           session_id TEXT NOT NULL,
           updated_at INTEGER NOT NULL,
           PRIMARY KEY (chat_id, harness),
           FOREIGN KEY (chat_id) REFERENCES chats(id) ON DELETE CASCADE
         );
         CREATE TABLE IF NOT EXISTS messages (
           chat_id     TEXT NOT NULL,
           id          TEXT NOT NULL,
           seq         INTEGER NOT NULL,
           role        TEXT NOT NULL,
           content     TEXT,
           tool_name   TEXT,
           tool_status TEXT,
           detail      TEXT,
           tool_output TEXT,
           file_paths  TEXT,
           attachments TEXT,
           timestamp   INTEGER NOT NULL,
           PRIMARY KEY (chat_id, id),
           FOREIGN KEY (chat_id) REFERENCES chats(id) ON DELETE CASCADE
         );
         CREATE INDEX IF NOT EXISTS idx_messages_chat_seq ON messages(chat_id, seq);",
    )
    .map_err(|e| format!("failed to initialise chat store: {e}"))?;
    Ok(conn)
}

/// Chats for a worktree, newest first. Returns empty when the worktree has no
/// database yet rather than erroring — most worktrees never get one.
#[tauri::command(async)]
pub fn chat_list(worktree: String) -> Result<Vec<ChatSummary>, String> {
    if !db_path(&worktree)?.is_file() {
        return Ok(Vec::new());
    }
    let conn = open(&worktree)?;
    let mut stmt = conn
        .prepare(
            "SELECT c.id, c.title, c.harness, c.model, c.created_at, c.updated_at,
                    (SELECT COUNT(*) FROM messages m WHERE m.chat_id = c.id)
             FROM chats c
             ORDER BY c.updated_at DESC",
        )
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([], |row| {
            Ok(ChatSummary {
                id: row.get(0)?,
                title: row.get(1)?,
                harness: row.get(2)?,
                model: row.get(3)?,
                created_at: row.get(4)?,
                updated_at: row.get(5)?,
                message_count: row.get(6)?,
            })
        })
        .map_err(|e| e.to_string())?;
    rows.collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())
}

/// Full chat (metadata, harness sessions, ordered transcript).
#[tauri::command(async)]
pub fn chat_load(worktree: String, chat_id: String) -> Result<Option<ChatRecord>, String> {
    if !db_path(&worktree)?.is_file() {
        return Ok(None);
    }
    let conn = open(&worktree)?;

    let meta = conn
        .query_row(
            "SELECT id, title, harness, model, effort, created_at, updated_at
             FROM chats WHERE id = ?1",
            params![chat_id],
            |row| {
                Ok(ChatMeta {
                    id: row.get(0)?,
                    title: row.get(1)?,
                    harness: row.get(2)?,
                    model: row.get(3)?,
                    effort: row.get(4)?,
                    created_at: row.get(5)?,
                    updated_at: row.get(6)?,
                })
            },
        )
        .optional()
        .map_err(|e| e.to_string())?;

    let Some(meta) = meta else {
        return Ok(None);
    };

    let mut sess_stmt = conn
        .prepare("SELECT harness, session_id FROM chat_sessions WHERE chat_id = ?1")
        .map_err(|e| e.to_string())?;
    let sessions = sess_stmt
        .query_map(params![chat_id], |row| {
            Ok(ChatSession {
                harness: row.get(0)?,
                session_id: row.get(1)?,
            })
        })
        .map_err(|e| e.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())?;

    let mut msg_stmt = conn
        .prepare(
            "SELECT id, seq, role, content, tool_name, tool_status, detail,
                    tool_output, file_paths, attachments, timestamp
             FROM messages WHERE chat_id = ?1 ORDER BY seq ASC",
        )
        .map_err(|e| e.to_string())?;
    let messages = msg_stmt
        .query_map(params![chat_id], |row| {
            Ok(ChatMessage {
                id: row.get(0)?,
                seq: row.get(1)?,
                role: row.get(2)?,
                content: row.get::<_, Option<String>>(3)?.unwrap_or_default(),
                tool_name: row.get(4)?,
                tool_status: row.get(5)?,
                detail: row.get(6)?,
                tool_output: row.get(7)?,
                file_paths: row.get(8)?,
                attachments: row.get(9)?,
                timestamp: row.get(10)?,
            })
        })
        .map_err(|e| e.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())?;

    Ok(Some(ChatRecord {
        meta,
        sessions,
        messages,
    }))
}

/// Insert or update a chat row. Called once when a draft is first sent, then on
/// title / model changes.
#[tauri::command(async)]
pub fn chat_upsert(worktree: String, meta: ChatMeta) -> Result<(), String> {
    let conn = open(&worktree)?;
    conn.execute(
        "INSERT INTO chats (id, title, harness, model, effort, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
         ON CONFLICT(id) DO UPDATE SET
           title = excluded.title,
           harness = excluded.harness,
           model = excluded.model,
           effort = excluded.effort,
           updated_at = excluded.updated_at",
        params![
            meta.id,
            meta.title,
            meta.harness,
            meta.model,
            meta.effort,
            meta.created_at,
            meta.updated_at
        ],
    )
    .map_err(|e| format!("failed to save chat: {e}"))?;
    Ok(())
}

/// Upsert a batch of transcript rows and bump the chat's `updated_at`.
///
/// Streaming rewrites the same message row many times, so callers debounce and
/// send only the rows that changed since the last flush.
#[tauri::command(async)]
pub fn chat_save_messages(
    worktree: String,
    chat_id: String,
    messages: Vec<ChatMessage>,
) -> Result<(), String> {
    if messages.is_empty() {
        return Ok(());
    }
    let mut conn = open(&worktree)?;
    let tx = conn.transaction().map_err(|e| e.to_string())?;
    {
        let mut stmt = tx
            .prepare(
                "INSERT INTO messages (chat_id, id, seq, role, content, tool_name,
                                       tool_status, detail, tool_output, file_paths,
                                       attachments, timestamp)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)
                 ON CONFLICT(chat_id, id) DO UPDATE SET
                   seq = excluded.seq,
                   role = excluded.role,
                   content = excluded.content,
                   tool_name = excluded.tool_name,
                   tool_status = excluded.tool_status,
                   detail = excluded.detail,
                   tool_output = excluded.tool_output,
                   file_paths = excluded.file_paths,
                   attachments = excluded.attachments,
                   timestamp = excluded.timestamp",
            )
            .map_err(|e| e.to_string())?;
        for m in &messages {
            stmt.execute(params![
                chat_id,
                m.id,
                m.seq,
                m.role,
                m.content,
                m.tool_name,
                m.tool_status,
                m.detail,
                m.tool_output,
                m.file_paths,
                m.attachments,
                m.timestamp
            ])
            .map_err(|e| format!("failed to save message: {e}"))?;
        }
        let newest = messages.iter().map(|m| m.timestamp).max().unwrap_or(0);
        tx.execute(
            "UPDATE chats SET updated_at = MAX(updated_at, ?2) WHERE id = ?1",
            params![chat_id, newest],
        )
        .map_err(|e| e.to_string())?;
    }
    tx.commit().map_err(|e| e.to_string())?;
    Ok(())
}

/// Bind a harness session id to a chat so the next turn can resume it.
#[tauri::command(async)]
pub fn chat_set_session(
    worktree: String,
    chat_id: String,
    harness: String,
    session_id: String,
    updated_at: i64,
) -> Result<(), String> {
    let conn = open(&worktree)?;
    conn.execute(
        "INSERT INTO chat_sessions (chat_id, harness, session_id, updated_at)
         VALUES (?1, ?2, ?3, ?4)
         ON CONFLICT(chat_id, harness) DO UPDATE SET
           session_id = excluded.session_id,
           updated_at = excluded.updated_at",
        params![chat_id, harness, session_id, updated_at],
    )
    .map_err(|e| format!("failed to save chat session: {e}"))?;
    Ok(())
}

/// Forget a harness session (used when a resume is rejected by the harness).
#[tauri::command(async)]
pub fn chat_clear_session(
    worktree: String,
    chat_id: String,
    harness: String,
) -> Result<(), String> {
    let conn = open(&worktree)?;
    conn.execute(
        "DELETE FROM chat_sessions WHERE chat_id = ?1 AND harness = ?2",
        params![chat_id, harness],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command(async)]
pub fn chat_rename(worktree: String, chat_id: String, title: String) -> Result<(), String> {
    let conn = open(&worktree)?;
    conn.execute(
        "UPDATE chats SET title = ?2 WHERE id = ?1",
        params![chat_id, title],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command(async)]
pub fn chat_delete(worktree: String, chat_id: String) -> Result<(), String> {
    if !db_path(&worktree)?.is_file() {
        return Ok(());
    }
    let conn = open(&worktree)?;
    // Sessions and messages go with the chat via ON DELETE CASCADE.
    conn.execute("DELETE FROM chats WHERE id = ?1", params![chat_id])
        .map_err(|e| e.to_string())?;
    Ok(())
}
