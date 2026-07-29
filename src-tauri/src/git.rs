use std::path::{Path, PathBuf};
use std::process::Command;

use serde::Serialize;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ChangedFile {
    path: String,
    status: String,
    additions: u32,
    deletions: u32,
    is_untracked: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileDiff {
    original: String,
    modified: String,
}

/// Resolve the repository root by running `git rev-parse --show-toplevel`
/// from the app process working directory.
fn repo_root() -> Result<PathBuf, String> {
    let output = Command::new("git")
        .args(["rev-parse", "--show-toplevel"])
        .output()
        .map_err(|e| format!("failed to run git: {e}"))?;

    if !output.status.success() {
        return Err(String::from_utf8_lossy(&output.stderr).trim().to_string());
    }

    let root = String::from_utf8_lossy(&output.stdout).trim().to_string();
    if root.is_empty() {
        return Err("not inside a git repository".to_string());
    }
    Ok(PathBuf::from(root))
}

/// Reject absolute paths and any path that tries to escape the repo root.
fn safe_join(root: &Path, rel: &str) -> Result<PathBuf, String> {
    let candidate = Path::new(rel);
    if candidate.is_absolute() {
        return Err("absolute paths are not allowed".to_string());
    }
    if candidate
        .components()
        .any(|c| matches!(c, std::path::Component::ParentDir))
    {
        return Err("path traversal is not allowed".to_string());
    }
    Ok(root.join(candidate))
}

/// Run a git command in the repo root and return stdout as a string.
fn git_in_root(root: &Path, args: &[&str]) -> Result<std::process::Output, String> {
    Command::new("git")
        .args(args)
        .current_dir(root)
        .output()
        .map_err(|e| format!("failed to run git: {e}"))
}

/// List all uncommitted changes (staged + unstaged + untracked) vs HEAD.
#[tauri::command]
pub fn git_changes() -> Result<Vec<ChangedFile>, String> {
    let root = repo_root()?;

    // Line-count deltas vs HEAD for tracked files.
    let numstat = git_in_root(&root, &["diff", "HEAD", "--numstat"])?;
    let mut stats: std::collections::HashMap<String, (u32, u32)> = std::collections::HashMap::new();
    if numstat.status.success() {
        for line in String::from_utf8_lossy(&numstat.stdout).lines() {
            let mut parts = line.split('\t');
            let adds = parts.next().unwrap_or("0");
            let dels = parts.next().unwrap_or("0");
            let path = parts.next().unwrap_or("").to_string();
            if path.is_empty() {
                continue;
            }
            // Binary files report "-"; treat as 0.
            let adds = adds.parse::<u32>().unwrap_or(0);
            let dels = dels.parse::<u32>().unwrap_or(0);
            stats.insert(path, (adds, dels));
        }
    }

    let status = git_in_root(
        &root,
        &["status", "--porcelain=v1", "--untracked-files=all"],
    )?;
    if !status.status.success() {
        return Err(String::from_utf8_lossy(&status.stderr).trim().to_string());
    }

    let mut files = Vec::new();
    for line in String::from_utf8_lossy(&status.stdout).lines() {
        if line.len() < 3 {
            continue;
        }
        let code = &line[0..2];
        let mut rest = line[3..].to_string();
        // Renames/copies are printed as "old -> new"; keep the new path.
        if let Some(idx) = rest.find(" -> ") {
            rest = rest[idx + 4..].to_string();
        }
        let path = rest;

        let is_untracked = code == "??";
        let status_label = if is_untracked || code.contains('A') {
            "added"
        } else if code.contains('D') {
            "deleted"
        } else {
            "modified"
        }
        .to_string();

        let (additions, deletions) = if is_untracked {
            // numstat does not cover untracked files; count lines on disk.
            let count = std::fs::read_to_string(root.join(&path))
                .map(|c| c.lines().count() as u32)
                .unwrap_or(0);
            (count, 0)
        } else {
            stats.get(&path).copied().unwrap_or((0, 0))
        };

        files.push(ChangedFile {
            path,
            status: status_label,
            additions,
            deletions,
            is_untracked,
        });
    }

    Ok(files)
}

/// Return the HEAD version (original) and working-tree version (modified) of a file.
#[tauri::command]
pub fn git_file_diff(path: String) -> Result<FileDiff, String> {
    let root = repo_root()?;
    let abs = safe_join(&root, &path)?;

    // Original = contents at HEAD. Empty for newly added files.
    let show = git_in_root(&root, &["show", &format!("HEAD:{path}")])?;
    let original = if show.status.success() {
        String::from_utf8_lossy(&show.stdout).to_string()
    } else {
        String::new()
    };

    // Modified = working-tree contents. Empty for deleted files.
    let modified = std::fs::read_to_string(&abs).unwrap_or_default();

    Ok(FileDiff { original, modified })
}

/// Discard working-tree changes for a file. Untracked files are deleted; tracked
/// files are restored from HEAD (both staged and unstaged changes are reverted).
#[tauri::command]
pub fn git_discard(path: String, is_untracked: bool) -> Result<(), String> {
    let root = repo_root()?;
    let abs = safe_join(&root, &path)?;

    if is_untracked {
        std::fs::remove_file(&abs).map_err(|e| format!("failed to delete file: {e}"))?;
        return Ok(());
    }

    let output = git_in_root(&root, &["restore", "--staged", "--worktree", "--", &path])?;
    if !output.status.success() {
        return Err(String::from_utf8_lossy(&output.stderr).trim().to_string());
    }
    Ok(())
}

/// Read a repo-relative file from disk.
#[tauri::command]
pub fn read_file(path: String) -> Result<String, String> {
    let root = repo_root()?;
    let abs = safe_join(&root, &path)?;
    std::fs::read_to_string(&abs).map_err(|e| format!("failed to read file: {e}"))
}

/// Write a repo-relative file to disk.
#[tauri::command]
pub fn write_file(path: String, content: String) -> Result<(), String> {
    let root = repo_root()?;
    let abs = safe_join(&root, &path)?;
    std::fs::write(&abs, content).map_err(|e| format!("failed to write file: {e}"))
}
