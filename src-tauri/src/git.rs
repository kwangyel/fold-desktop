use std::path::{Path, PathBuf};
use std::process::Command;

use serde::Serialize;
use tauri::State;

use crate::AppState;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ChangedFile {
    path: String,
    status: String,
    additions: u32,
    deletions: u32,
    is_untracked: bool,
    staged: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileDiff {
    original: String,
    modified: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DirEntry {
    name: String,
    /// Repo-relative path (POSIX separators).
    path: String,
    is_dir: bool,
}

/// Resolve the repository root. When a project is selected, its directory is the
/// root; otherwise fall back to `git rev-parse --show-toplevel` from the app
/// process working directory.
fn repo_root(state: &State<'_, AppState>) -> Result<PathBuf, String> {
    if let Some(active) = state
        .active_project
        .lock()
        .map_err(|e| e.to_string())?
        .clone()
    {
        return Ok(active);
    }

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

/// Resolve a path under the active worktree. Paths under `.fold/` are redirected
/// to the sibling Fold data directory (see `fold_paths`) so plans/asks never
/// land inside the git worktree.
fn safe_join(root: &Path, rel: &str) -> Result<PathBuf, String> {
    crate::fold_paths::resolve_under_worktree(root, rel)
}

/// Run a git command in the repo root and return stdout as a string.
fn git_in_root(root: &Path, args: &[&str]) -> Result<std::process::Output, String> {
    Command::new("git")
        .args(args)
        .current_dir(root)
        .output()
        .map_err(|e| format!("failed to run git: {e}"))
}

fn parse_numstat(stdout: &str) -> std::collections::HashMap<String, (u32, u32)> {
    let mut stats = std::collections::HashMap::new();
    for line in stdout.lines() {
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
    stats
}

fn status_from_code(code: char, is_untracked: bool) -> String {
    if is_untracked || code == 'A' || code == '?' {
        "added".to_string()
    } else if code == 'D' {
        "deleted".to_string()
    } else {
        "modified".to_string()
    }
}

fn git_stderr(output: &std::process::Output) -> String {
    String::from_utf8_lossy(&output.stderr).trim().to_string()
}

/// Stop counting lines past this much of a file. An untracked directory can
/// hold very large files (build output, dumps, media); the changes list only
/// needs a line count for the "+N" badge, so reading gigabytes to render it is
/// never worth it.
const MAX_LINE_COUNT_BYTES: u64 = 2 * 1024 * 1024;

/// Line count for an untracked file, streamed and capped.
///
/// Reads bytes rather than `read_to_string`, so binary files don't cost a UTF-8
/// validation pass and no file is ever fully buffered in memory.
fn count_lines(path: &Path) -> u32 {
    use std::io::{BufReader, Read};

    let Ok(file) = std::fs::File::open(path) else {
        return 0;
    };
    let mut reader = BufReader::new(file.take(MAX_LINE_COUNT_BYTES));
    let mut buf = [0u8; 16 * 1024];
    let mut lines: u32 = 0;
    loop {
        match reader.read(&mut buf) {
            Ok(0) => break,
            Ok(n) => {
                lines = lines.saturating_add(
                    buf[..n].iter().filter(|b| **b == b'\n').count() as u32
                );
            }
            Err(_) => break,
        }
    }
    lines
}

/// List uncommitted changes split into staged and unstaged/untracked rows.
/// A partially staged file may appear twice (once per side).
#[tauri::command(async)]
pub fn git_changes(state: State<'_, AppState>) -> Result<Vec<ChangedFile>, String> {
    let root = repo_root(&state)?;

    let staged_numstat = git_in_root(&root, &["diff", "--cached", "--numstat"])?;
    let staged_stats = if staged_numstat.status.success() {
        parse_numstat(&String::from_utf8_lossy(&staged_numstat.stdout))
    } else {
        std::collections::HashMap::new()
    };

    let unstaged_numstat = git_in_root(&root, &["diff", "--numstat"])?;
    let unstaged_stats = if unstaged_numstat.status.success() {
        parse_numstat(&String::from_utf8_lossy(&unstaged_numstat.stdout))
    } else {
        std::collections::HashMap::new()
    };

    let status = git_in_root(
        &root,
        &["status", "--porcelain=v1", "--untracked-files=all"],
    )?;
    if !status.status.success() {
        return Err(git_stderr(&status));
    }

    let mut files = Vec::new();
    for line in String::from_utf8_lossy(&status.stdout).lines() {
        if line.len() < 3 {
            continue;
        }
        let index_code = line.as_bytes()[0] as char;
        let worktree_code = line.as_bytes()[1] as char;
        let mut rest = line[3..].to_string();
        // Renames/copies are printed as "old -> new"; keep the new path.
        if let Some(idx) = rest.find(" -> ") {
            rest = rest[idx + 4..].to_string();
        }
        let path = rest;
        let is_untracked = index_code == '?' && worktree_code == '?';

        // Staged: index column has a real status (not space / untracked).
        if !is_untracked && index_code != ' ' && index_code != '?' {
            let (additions, deletions) = staged_stats.get(&path).copied().unwrap_or((0, 0));
            files.push(ChangedFile {
                path: path.clone(),
                status: status_from_code(index_code, false),
                additions,
                deletions,
                is_untracked: false,
                staged: true,
            });
        }

        // Unstaged / untracked: worktree column dirty, or untracked.
        if is_untracked || (worktree_code != ' ' && worktree_code != '?') {
            let (additions, deletions) = if is_untracked {
                (count_lines(&root.join(&path)), 0)
            } else {
                unstaged_stats.get(&path).copied().unwrap_or((0, 0))
            };
            files.push(ChangedFile {
                path,
                status: status_from_code(if is_untracked { '?' } else { worktree_code }, is_untracked),
                additions,
                deletions,
                is_untracked,
                staged: false,
            });
        }
    }

    Ok(files)
}

#[tauri::command(async)]
pub fn git_stage(path: String, state: State<'_, AppState>) -> Result<(), String> {
    let root = repo_root(&state)?;
    let _ = safe_join(&root, &path)?;
    let output = git_in_root(&root, &["add", "--", &path])?;
    if !output.status.success() {
        return Err(git_stderr(&output));
    }
    Ok(())
}

#[tauri::command(async)]
pub fn git_unstage(path: String, state: State<'_, AppState>) -> Result<(), String> {
    let root = repo_root(&state)?;
    let _ = safe_join(&root, &path)?;
    let output = git_in_root(&root, &["restore", "--staged", "--", &path])?;
    if !output.status.success() {
        return Err(git_stderr(&output));
    }
    Ok(())
}

#[tauri::command(async)]
pub fn git_stage_all(state: State<'_, AppState>) -> Result<(), String> {
    let root = repo_root(&state)?;
    let output = git_in_root(&root, &["add", "-A"])?;
    if !output.status.success() {
        return Err(git_stderr(&output));
    }
    Ok(())
}

#[tauri::command(async)]
pub fn git_unstage_all(state: State<'_, AppState>) -> Result<(), String> {
    let root = repo_root(&state)?;
    let output = git_in_root(&root, &["reset", "HEAD"])?;
    if !output.status.success() {
        return Err(git_stderr(&output));
    }
    Ok(())
}

#[tauri::command(async)]
pub fn git_commit(message: String, state: State<'_, AppState>) -> Result<(), String> {
    let root = repo_root(&state)?;
    let trimmed = message.trim();
    if trimmed.is_empty() {
        return Err("commit message is empty".to_string());
    }
    let output = git_in_root(&root, &["commit", "-m", trimmed])?;
    if !output.status.success() {
        return Err(git_stderr(&output));
    }
    Ok(())
}

#[tauri::command(async)]
pub fn git_push(state: State<'_, AppState>) -> Result<(), String> {
    let root = repo_root(&state)?;
    let output = git_in_root(&root, &["push"])?;
    if !output.status.success() {
        return Err(git_stderr(&output));
    }
    Ok(())
}

/// Staged diff text for AI commit-message generation (truncated).
#[tauri::command(async)]
pub fn git_staged_diff(state: State<'_, AppState>) -> Result<String, String> {
    let root = repo_root(&state)?;
    let output = git_in_root(&root, &["diff", "--cached"])?;
    if !output.status.success() {
        return Err(git_stderr(&output));
    }
    let mut diff = String::from_utf8_lossy(&output.stdout).to_string();
    const MAX: usize = 48_000;
    if diff.len() > MAX {
        diff.truncate(MAX);
        diff.push_str("\n\n… (diff truncated)");
    }
    Ok(diff)
}

/// Return the HEAD version (original) and working-tree version (modified) of a file.
#[tauri::command(async)]
pub fn git_file_diff(path: String, state: State<'_, AppState>) -> Result<FileDiff, String> {
    let root = repo_root(&state)?;
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
/// files are restored from the index (staged changes are left alone).
#[tauri::command(async)]
pub fn git_discard(
    path: String,
    is_untracked: bool,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let root = repo_root(&state)?;
    let abs = safe_join(&root, &path)?;

    if is_untracked {
        std::fs::remove_file(&abs).map_err(|e| format!("failed to delete file: {e}"))?;
        return Ok(());
    }

    let output = git_in_root(&root, &["restore", "--worktree", "--", &path])?;
    if !output.status.success() {
        return Err(String::from_utf8_lossy(&output.stderr).trim().to_string());
    }
    Ok(())
}

/// List the entries of a repo-relative directory (`""` = project root),
/// folders first then files, both alphabetical. Skips the `.git` directory.
#[tauri::command(async)]
pub fn list_dir(path: String, state: State<'_, AppState>) -> Result<Vec<DirEntry>, String> {
    let root = repo_root(&state)?;
    let dir = if path.is_empty() {
        root.clone()
    } else {
        safe_join(&root, &path)?
    };

    let mut entries = Vec::new();
    for entry in std::fs::read_dir(&dir).map_err(|e| format!("failed to read dir: {e}"))? {
        let entry = entry.map_err(|e| e.to_string())?;
        let name = entry.file_name().to_string_lossy().to_string();
        // Hide VCS and any leftover in-worktree Fold data from the explorer.
        if name == ".git" || name == ".fold" {
            continue;
        }
        let is_dir = entry.file_type().map(|t| t.is_dir()).unwrap_or(false);
        let rel = if path.is_empty() {
            name.clone()
        } else {
            format!("{}/{}", path.trim_end_matches('/'), name)
        };
        entries.push(DirEntry { name, path: rel, is_dir });
    }

    entries.sort_by(|a, b| match (a.is_dir, b.is_dir) {
        (true, false) => std::cmp::Ordering::Less,
        (false, true) => std::cmp::Ordering::Greater,
        _ => a.name.to_lowercase().cmp(&b.name.to_lowercase()),
    });
    Ok(entries)
}

/// Read a repo-relative file from disk.
#[tauri::command(async)]
pub fn read_file(path: String, state: State<'_, AppState>) -> Result<String, String> {
    let root = repo_root(&state)?;
    let abs = safe_join(&root, &path)?;
    std::fs::read_to_string(&abs).map_err(|e| format!("failed to read file: {e}"))
}

/// Write a repo-relative file to disk.
#[tauri::command(async)]
pub fn write_file(
    path: String,
    content: String,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let root = repo_root(&state)?;
    let abs = safe_join(&root, &path)?;
    // Create parent directories so callers can write into new subtrees such as
    // the Fold plans/asks dirs without a separate mkdir step.
    if let Some(parent) = abs.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|e| format!("failed to create directory: {e}"))?;
    }
    std::fs::write(&abs, content).map_err(|e| format!("failed to write file: {e}"))
}

/// Write raw bytes to a repo-relative path (used for pasted/attached images).
#[tauri::command(async)]
pub fn write_bytes(
    path: String,
    bytes: Vec<u8>,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let root = repo_root(&state)?;
    let abs = safe_join(&root, &path)?;
    if let Some(parent) = abs.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|e| format!("failed to create directory: {e}"))?;
    }
    std::fs::write(&abs, bytes).map_err(|e| format!("failed to write file: {e}"))
}

/// Current HEAD commit SHA for the repo at `path`. Empty on a repo with no
/// commits yet.
#[tauri::command(async)]
pub fn git_head_commit(path: String) -> Result<String, String> {
    let output = git_in_root(Path::new(&path), &["rev-parse", "HEAD"])?;
    if !output.status.success() {
        // A fresh repo with no commits is not an error for our purposes.
        return Ok(String::new());
    }
    Ok(String::from_utf8_lossy(&output.stdout).trim().to_string())
}

/// Number of files that differ between `base` and the current working tree.
/// Used to tell whether an implementation run actually changed anything.
#[tauri::command(async)]
pub fn git_changed_since(path: String, base: String) -> Result<u32, String> {
    let root = Path::new(&path);
    let mut changed: std::collections::HashSet<String> = std::collections::HashSet::new();

    if !base.is_empty() {
        let output = git_in_root(root, &["diff", "--name-only", &base])?;
        if output.status.success() {
            for line in String::from_utf8_lossy(&output.stdout).lines() {
                if !line.trim().is_empty() {
                    changed.insert(line.trim().to_string());
                }
            }
        }
    }

    // Untracked files never show up in `git diff`, so count them separately.
    let untracked = git_in_root(root, &["ls-files", "--others", "--exclude-standard"])?;
    if untracked.status.success() {
        for line in String::from_utf8_lossy(&untracked.stdout).lines() {
            if !line.trim().is_empty() {
                changed.insert(line.trim().to_string());
            }
        }
    }

    Ok(changed.len() as u32)
}

/// List local branch names for the repo at `path`.
#[tauri::command(async)]
pub fn git_list_branches(path: String) -> Result<Vec<String>, String> {
    let output = Command::new("git")
        .args(["branch", "--format=%(refname:short)"])
        .current_dir(&path)
        .output()
        .map_err(|e| format!("failed to run git branch: {e}"))?;
    if !output.status.success() {
        return Err(String::from_utf8_lossy(&output.stderr).trim().to_string());
    }
    let branches = String::from_utf8_lossy(&output.stdout)
        .lines()
        .map(|l| l.trim().to_string())
        .filter(|l| !l.is_empty())
        .collect();
    Ok(branches)
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MergeReadiness {
    /// Current branch checked out at `path`.
    current_branch: String,
    /// Working tree or index has uncommitted changes.
    dirty: bool,
    /// Commits on the current branch that are not on `target_branch`.
    ahead_count: u32,
    /// Whether a merge into `target_branch` would conflict.
    has_conflicts: bool,
    /// True when clean, ahead > 0, not on target, and no conflicts.
    safe_to_merge: bool,
    /// Human-readable reason when not safe (empty when safe).
    reason: String,
}

fn git_stdout_trim(root: &Path, args: &[&str]) -> Result<String, String> {
    let output = git_in_root(root, args)?;
    if !output.status.success() {
        return Err(git_stderr(&output));
    }
    Ok(String::from_utf8_lossy(&output.stdout).trim().to_string())
}

fn branch_exists(root: &Path, branch: &str) -> bool {
    git_in_root(root, &["rev-parse", "--verify", "--quiet", branch])
        .map(|o| o.status.success())
        .unwrap_or(false)
}

/// Whether merging `ours` into `theirs` would conflict (checked via merge-tree).
fn merge_would_conflict(root: &Path, theirs: &str, ours: &str) -> Result<bool, String> {
    // Git 2.38+: exit 0 = clean, exit 1 = conflicts. Other codes are errors /
    // unsupported flags — fall through instead of treating them as conflicts.
    let modern = git_in_root(
        root,
        &["merge-tree", "--write-tree", "--no-messages", theirs, ours],
    )?;
    match modern.status.code() {
        Some(0) => return Ok(false),
        Some(1) => return Ok(true),
        _ => {}
    }

    // Older Git: classic three-way merge-tree prints conflict hunks to stdout.
    let base = match git_stdout_trim(root, &["merge-base", theirs, ours]) {
        Ok(b) => b,
        Err(_) => return Ok(false),
    };
    let classic = git_in_root(root, &["merge-tree", &base, theirs, ours])?;
    if !classic.status.success() {
        // merge-tree unavailable — don't block; the real merge will surface it.
        return Ok(false);
    }
    let out = String::from_utf8_lossy(&classic.stdout);
    Ok(out.contains("changed in both") || out.contains("CONFLICT"))
}

/// Porcelain path from a `git status --porcelain` line (skips the XY prefix).
fn porcelain_path(line: &str) -> &str {
    let rest = line.get(3..).unwrap_or("").trim();
    if let Some(idx) = rest.find(" -> ") {
        &rest[idx + 4..]
    } else {
        rest
    }
}

/// Fold writes `.cursor/mcp.json` for the Cursor harness; it must not keep the
/// local "Commit changes" button stuck after the user has committed real work.
fn is_fold_local_path(path: &str) -> bool {
    path == ".cursor" || path.starts_with(".cursor/")
}

/// Inspect whether the branch at `path` is ready to merge into `target_branch`.
#[tauri::command(async)]
pub fn git_merge_readiness(
    path: String,
    target_branch: String,
) -> Result<MergeReadiness, String> {
    let root = Path::new(&path);
    let target = target_branch.trim();
    if target.is_empty() {
        return Err("target branch is empty".to_string());
    }
    if !branch_exists(root, target) {
        return Ok(MergeReadiness {
            current_branch: String::new(),
            dirty: false,
            ahead_count: 0,
            has_conflicts: false,
            safe_to_merge: false,
            reason: format!("Target branch '{target}' does not exist"),
        });
    }

    let current_branch = git_stdout_trim(root, &["rev-parse", "--abbrev-ref", "HEAD"])?;
    if current_branch == "HEAD" {
        return Ok(MergeReadiness {
            current_branch,
            dirty: false,
            ahead_count: 0,
            has_conflicts: false,
            safe_to_merge: false,
            reason: "Detached HEAD — check out a branch first".to_string(),
        });
    }
    if current_branch == target {
        return Ok(MergeReadiness {
            current_branch,
            dirty: false,
            ahead_count: 0,
            has_conflicts: false,
            safe_to_merge: false,
            reason: format!("Already on '{target}'"),
        });
    }

    let status = git_in_root(root, &["status", "--porcelain"])?;
    if !status.status.success() {
        return Err(git_stderr(&status));
    }
    let dirty = String::from_utf8_lossy(&status.stdout)
        .lines()
        .any(|line| {
            let p = porcelain_path(line);
            !p.is_empty() && !is_fold_local_path(p)
        });

    let ahead_raw = git_stdout_trim(root, &["rev-list", "--count", &format!("{target}..HEAD")])?;
    let ahead_count: u32 = ahead_raw.parse().unwrap_or(0);

    // Conflict check is independent of worktree dirtiness — uncommitted files
    // don't affect whether the commits can merge into the target.
    let has_conflicts = if ahead_count > 0 {
        merge_would_conflict(root, target, "HEAD")?
    } else {
        false
    };

    let (safe_to_merge, reason) = if ahead_count == 0 {
        (false, format!("No commits to merge into '{target}'"))
    } else if has_conflicts {
        (false, format!("Cannot merge — conflicts with '{target}'"))
    } else {
        (true, String::new())
    };

    Ok(MergeReadiness {
        current_branch,
        dirty,
        ahead_count,
        has_conflicts,
        safe_to_merge,
        reason,
    })
}

/// Merge `source_branch` into `target_branch` in the main checkout at `repo_path`.
///
/// Worktrees keep the feature branch checked out, so the merge must run against
/// the main repo. When the main checkout is dirty (common with `__pycache__`
/// etc.), we merge in a temporary detached worktree and update the branch ref
/// so local junk never blocks the merge.
#[tauri::command(async)]
pub fn git_merge_to_target(
    repo_path: String,
    source_branch: String,
    target_branch: String,
) -> Result<(), String> {
    let root = Path::new(&repo_path);
    let source = source_branch.trim();
    let target = target_branch.trim();
    if source.is_empty() || target.is_empty() {
        return Err("source and target branch are required".to_string());
    }
    if source == target {
        return Err("cannot merge a branch into itself".to_string());
    }
    if !branch_exists(root, source) {
        return Err(format!("source branch '{source}' does not exist"));
    }
    if !branch_exists(root, target) {
        return Err(format!("target branch '{target}' does not exist"));
    }

    if merge_would_conflict(root, target, source)? {
        return Err(format!(
            "Cannot merge — '{source}' conflicts with '{target}'. Resolve conflicts first."
        ));
    }

    let status = git_in_root(root, &["status", "--porcelain"])?;
    if !status.status.success() {
        return Err(git_stderr(&status));
    }
    let main_dirty = !String::from_utf8_lossy(&status.stdout).trim().is_empty();

    if main_dirty {
        return merge_in_temp_worktree(root, source, target);
    }

    let head = git_stdout_trim(root, &["rev-parse", "--abbrev-ref", "HEAD"])?;
    if head != target {
        let co = git_in_root(root, &["checkout", target])?;
        if !co.status.success() {
            return Err(format!(
                "Cannot merge — main checkout is on '{head}', not '{target}': {}",
                git_stderr(&co)
            ));
        }
    }

    let merge = git_in_root(root, &["merge", "--no-edit", source])?;
    if merge.status.success() {
        return Ok(());
    }
    let err = git_stderr(&merge);
    let stdout = String::from_utf8_lossy(&merge.stdout).trim().to_string();
    let _ = git_in_root(root, &["merge", "--abort"]);
    let detail = if !err.is_empty() {
        err
    } else if !stdout.is_empty() {
        stdout
    } else {
        format!("git merge {source} failed")
    };
    Err(format!("Cannot merge — {detail}"))
}

/// Merge `source` into `target` inside a temporary detached worktree, then point
/// `refs/heads/<target>` at the result. Leaves the main checkout's dirty files alone.
fn merge_in_temp_worktree(root: &Path, source: &str, target: &str) -> Result<(), String> {
    let target_oid = git_stdout_trim(root, &["rev-parse", target])?;
    let tmp = std::env::temp_dir().join(format!(
        "fold-merge-{}-{}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_millis())
            .unwrap_or(0)
    ));
    let tmp_s = tmp.to_string_lossy().to_string();

    let add = git_in_root(
        root,
        &["worktree", "add", "--detach", &tmp_s, &target_oid],
    )?;
    if !add.status.success() {
        return Err(format!(
            "Cannot merge — failed to create temp worktree: {}",
            git_stderr(&add)
        ));
    }

    let cleanup = || {
        let _ = git_in_root(root, &["worktree", "remove", "--force", &tmp_s]);
        let _ = std::fs::remove_dir_all(&tmp);
    };

    let merge = Command::new("git")
        .args(["merge", "--no-edit", source])
        .current_dir(&tmp)
        .output()
        .map_err(|e| {
            cleanup();
            format!("failed to run git merge: {e}")
        })?;
    if !merge.status.success() {
        let err = git_stderr(&merge);
        let stdout = String::from_utf8_lossy(&merge.stdout).trim().to_string();
        let _ = Command::new("git")
            .args(["merge", "--abort"])
            .current_dir(&tmp)
            .output();
        cleanup();
        let detail = if !err.is_empty() {
            err
        } else if !stdout.is_empty() {
            stdout
        } else {
            format!("git merge {source} failed")
        };
        return Err(format!("Cannot merge — {detail}"));
    }

    let new_oid = Command::new("git")
        .args(["rev-parse", "HEAD"])
        .current_dir(&tmp)
        .output()
        .map_err(|e| {
            cleanup();
            format!("failed to read merge result: {e}")
        })?;
    if !new_oid.status.success() {
        cleanup();
        return Err(git_stderr(&new_oid));
    }
    let new_oid = String::from_utf8_lossy(&new_oid.stdout).trim().to_string();

    let update = git_in_root(
        root,
        &["update-ref", &format!("refs/heads/{target}"), &new_oid],
    )?;
    cleanup();
    if !update.status.success() {
        return Err(format!(
            "Cannot merge — failed to update '{target}': {}",
            git_stderr(&update)
        ));
    }
    Ok(())
}

/// Rebase the branch checked out at `path` onto `target_branch`.
#[tauri::command(async)]
pub fn git_rebase_onto_target(path: String, target_branch: String) -> Result<(), String> {
    let root = Path::new(&path);
    let target = target_branch.trim();
    if target.is_empty() {
        return Err("target branch is empty".to_string());
    }
    if !branch_exists(root, target) {
        return Err(format!("target branch '{target}' does not exist"));
    }

    let status = git_in_root(root, &["status", "--porcelain"])?;
    if !status.status.success() {
        return Err(git_stderr(&status));
    }
    // Ignore Fold-local paths so `.cursor/mcp.json` doesn't block rebase.
    let dirty = String::from_utf8_lossy(&status.stdout).lines().any(|line| {
        let p = porcelain_path(line);
        !p.is_empty() && !is_fold_local_path(p)
    });
    if dirty {
        return Err("Cannot rebase — uncommitted changes. Commit or stash first.".to_string());
    }

    let current = git_stdout_trim(root, &["rev-parse", "--abbrev-ref", "HEAD"])?;
    if current == target {
        return Err(format!("already on '{target}'"));
    }

    let rebase = git_in_root(root, &["rebase", target])?;
    if !rebase.status.success() {
        let _ = git_in_root(root, &["rebase", "--abort"]);
        let err = git_stderr(&rebase);
        return Err(if err.is_empty() {
            format!("Cannot rebase onto '{target}'")
        } else {
            format!("Cannot rebase — {err}")
        });
    }
    Ok(())
}
