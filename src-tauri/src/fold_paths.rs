//! Paths for Fold runtime data (plans, MCP asks) that must live *outside* the
//! git worktree so they do not appear in the explorer or dirty the working tree.
//!
//! Layout (sibling of the worktree, under the same workspaces root):
//! ```text
//! ~/fold/workspaces/<project-slug>/
//!   <worktree-slug>/                 # git worktree
//!   .fold/<worktree-slug>/           # plans + asks for that worktree
//!     plans/
//!     asks/
//! ```

use std::path::{Path, PathBuf};

/// Logical prefix used by the frontend / harness prompts for Fold data.
pub const FOLD_PREFIX: &str = ".fold";

/// Absolute directory for a worktree's Fold data:
/// `{workspaces_root}/.fold/{worktree-name}/`.
pub fn fold_data_dir(worktree: &Path) -> Option<PathBuf> {
    let name = worktree.file_name()?;
    let parent = worktree.parent()?;
    Some(parent.join(FOLD_PREFIX).join(name))
}

/// Absolute `plans/` directory for Claude's `plansDirectory` setting.
pub fn fold_plans_dir(worktree: &Path) -> Option<PathBuf> {
    Some(fold_data_dir(worktree)?.join("plans"))
}

/// Resolve a path that may be either a normal worktree-relative path or a
/// Fold data path (`.fold/...`). Fold paths map to the sibling data dir, not
/// into the worktree.
///
/// Rejects absolute paths and `..` components for non-Fold paths (same rules
/// as the previous `safe_join`).
pub fn resolve_under_worktree(worktree: &Path, rel: &str) -> Result<PathBuf, String> {
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

    let norm = rel.replace('\\', "/");
    if let Some(rest) = fold_relative_rest(&norm) {
        let data = fold_data_dir(worktree).ok_or_else(|| {
            "could not resolve Fold data directory for worktree".to_string()
        })?;
        // Bulk migrate when the external dir is still empty.
        migrate_legacy_fold_dir(worktree, &data);

        let external = if rest.is_empty() {
            data.clone()
        } else {
            data.join(rest)
        };

        // Harnesses whose workspace is the git worktree (e.g. Cursor soft plan)
        // may still write into `{worktree}/.fold/...`. Lift individual files
        // across on first read/write so they leave the worktree.
        if !external.exists() {
            let legacy = if rest.is_empty() {
                worktree.join(FOLD_PREFIX)
            } else {
                worktree.join(FOLD_PREFIX).join(rest)
            };
            if legacy.is_file() {
                if let Some(parent) = external.parent() {
                    let _ = std::fs::create_dir_all(parent);
                }
                if std::fs::rename(&legacy, &external).is_err() {
                    if std::fs::copy(&legacy, &external).is_ok() {
                        let _ = std::fs::remove_file(&legacy);
                    }
                }
                // Best-effort: drop empty leftover dirs under the worktree.
                let _ = remove_empty_parents(&legacy, worktree);
            }
        }

        return Ok(external);
    }

    Ok(worktree.join(candidate))
}

/// Remove empty parent directories of `path` up to (but not including) `stop`.
fn remove_empty_parents(path: &Path, stop: &Path) {
    let mut current = path.parent().map(|p| p.to_path_buf());
    while let Some(dir) = current {
        if dir == stop {
            break;
        }
        match std::fs::remove_dir(&dir) {
            Ok(()) => current = dir.parent().map(|p| p.to_path_buf()),
            Err(_) => break,
        }
    }
}

/// Strip a leading `.fold` / `.fold/` and return the remainder (possibly empty).
fn fold_relative_rest(norm: &str) -> Option<&str> {
    if norm == FOLD_PREFIX {
        return Some("");
    }
    norm.strip_prefix(".fold/")
}

/// Move `{worktree}/.fold` → `{parent}/.fold/{name}` when the destination is
/// missing. Best-effort; failures leave the legacy dir in place.
fn migrate_legacy_fold_dir(worktree: &Path, dest: &Path) {
    let legacy = worktree.join(FOLD_PREFIX);
    if !legacy.is_dir() || dest.exists() {
        return;
    }
    if let Some(parent) = dest.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    if std::fs::rename(&legacy, dest).is_err() {
        // Cross-device rename can fail; fall back to recursive copy + remove.
        if copy_dir_recursive(&legacy, dest).is_ok() {
            let _ = std::fs::remove_dir_all(&legacy);
        }
    }
}

fn copy_dir_recursive(src: &Path, dest: &Path) -> Result<(), String> {
    std::fs::create_dir_all(dest).map_err(|e| e.to_string())?;
    for entry in std::fs::read_dir(src).map_err(|e| e.to_string())? {
        let entry = entry.map_err(|e| e.to_string())?;
        let ty = entry.file_type().map_err(|e| e.to_string())?;
        let to = dest.join(entry.file_name());
        if ty.is_dir() {
            copy_dir_recursive(&entry.path(), &to)?;
        } else {
            std::fs::copy(entry.path(), &to).map_err(|e| e.to_string())?;
        }
    }
    Ok(())
}

/// Delete the Fold data directory for a worktree (archive / remove cleanup).
pub fn remove_fold_data_dir(worktree: &Path) {
    if let Some(dir) = fold_data_dir(worktree) {
        let _ = std::fs::remove_dir_all(&dir);
    }
    // Also clear any leftover in-worktree `.fold` from before the move.
    let legacy = worktree.join(FOLD_PREFIX);
    if legacy.is_dir() {
        let _ = std::fs::remove_dir_all(&legacy);
    }
}
