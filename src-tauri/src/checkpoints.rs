//! Per-turn worktree checkpoints.
//!
//! Each agent turn snapshots the working tree (tracked + untracked, gitignored
//! files skipped) into a git commit hanging off `refs/fold/checkpoints/…`.
//! HEAD and the user's index are not touched, so the snapshot is independent
//! of commits. Restoring a checkpoint writes those files back and deletes
//! anything created after it — including later turns, so turn 1 can be rolled
//! back without first rolling back turn 2.

use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::process::{Command, Output};

use crate::chats;
use crate::fold_paths;

/// Snapshot the worktree and return the commit SHA.
#[tauri::command(async)]
pub fn checkpoint_create(worktree: String) -> Result<String, String> {
    let root = Path::new(&worktree);
    if !root.is_dir() {
        return Err("worktree path does not exist".to_string());
    }
    create_checkpoint(root)
}

/// Restore the worktree to `sha`, drop later transcript rows, and forget
/// harness sessions so the next prompt starts a fresh agent conversation.
#[tauri::command(async)]
pub fn checkpoint_rollback(
    worktree: String,
    chat_id: String,
    message_id: String,
    sha: String,
) -> Result<(), String> {
    let root = Path::new(&worktree);
    if !root.is_dir() {
        return Err("worktree path does not exist".to_string());
    }
    if let Err(err) = restore_checkpoint(root, &sha) {
        eprintln!("[fold][checkpoint] restore {sha} failed: {err}");
        return Err(err);
    }
    let dropped = match chats::truncate_after(&worktree, &chat_id, &message_id) {
        Ok(dropped) => dropped,
        Err(err) => {
            eprintln!("[fold][checkpoint] truncate chat {chat_id} failed: {err}");
            return Err(err);
        }
    };
    drop_checkpoint_refs(root, &dropped);
    Ok(())
}

/// Delete checkpoint refs for a worktree (archive / remove cleanup).
///
/// Refs live in the shared object database, so `repo` should be a path git
/// can still resolve (the main checkout) — the worktree folder may already
/// be gone. `worktree` is only used to compute the ref prefix.
pub fn drop_worktree_checkpoint_refs(repo: &Path, worktree: &Path) {
    let prefix = ref_prefix(worktree);
    let Ok(output) = git(
        repo,
        &["for-each-ref", "--format=%(refname)", &prefix],
    ) else {
        return;
    };
    if !output.status.success() {
        return;
    }
    for line in String::from_utf8_lossy(&output.stdout).lines() {
        let name = line.trim();
        if !name.is_empty() {
            let _ = git(repo, &["update-ref", "-d", name]);
        }
    }
}

fn create_checkpoint(root: &Path) -> Result<String, String> {
    let index = temp_index_path(root)?;
    let _ = std::fs::remove_file(&index);

    // Seed the temp index from HEAD so tracked files are in the tree even
    // when they match the worktree (a clean checkout). No HEAD yet is fine.
    let _ = git_with_index(root, &index, &["read-tree", "HEAD"]);
    let add = git_with_index(root, &index, &["add", "-A"])?;
    if !add.status.success() {
        let _ = std::fs::remove_file(&index);
        return Err(git_err(&add, "failed to snapshot worktree"));
    }

    let tree_out = git_with_index(root, &index, &["write-tree"])?;
    let _ = std::fs::remove_file(&index);
    if !tree_out.status.success() {
        return Err(git_err(&tree_out, "failed to write checkpoint tree"));
    }
    let tree = String::from_utf8_lossy(&tree_out.stdout).trim().to_string();
    if tree.is_empty() {
        return Err("checkpoint tree was empty".to_string());
    }

    let mut commit = Command::new("git");
    commit
        .args(["commit-tree", &tree, "-m", "fold checkpoint"])
        .current_dir(root)
        .env("GIT_AUTHOR_NAME", "Fold")
        .env("GIT_AUTHOR_EMAIL", "fold@localhost")
        .env("GIT_COMMITTER_NAME", "Fold")
        .env("GIT_COMMITTER_EMAIL", "fold@localhost");
    if let Ok(head) = git_stdout(root, &["rev-parse", "HEAD"]) {
        if !head.is_empty() {
            commit.args(["-p", &head]);
        }
    }
    let commit_out = commit
        .output()
        .map_err(|e| format!("failed to create checkpoint commit: {e}"))?;
    if !commit_out.status.success() {
        return Err(git_err(&commit_out, "failed to create checkpoint commit"));
    }
    let sha = String::from_utf8_lossy(&commit_out.stdout).trim().to_string();
    if sha.is_empty() {
        return Err("checkpoint commit produced no SHA".to_string());
    }

    let refname = checkpoint_ref(root, &sha);
    let update = git(root, &["update-ref", &refname, &sha])?;
    if !update.status.success() {
        return Err(git_err(&update, "failed to store checkpoint ref"));
    }
    Ok(sha)
}

fn restore_checkpoint(root: &Path, sha: &str) -> Result<(), String> {
    if sha.is_empty() {
        return Err("checkpoint SHA is empty".to_string());
    }
    let kind = git(root, &["cat-file", "-t", sha])?;
    if !kind.status.success() {
        return Err(format!("checkpoint {sha} was not found"));
    }

    let snapshot = ls_zero(root, &["ls-tree", "-r", "-z", "--name-only", sha])?;

    // Force-write through a temp index. `git checkout SHA -- .` refuses to
    // overwrite untracked files — the usual case after an agent turn, since
    // those files were never committed and the snapshot captured them anyway.
    // A temp index also avoids fighting the live index.lock.
    let index = temp_index_path(root)?;
    let _ = std::fs::remove_file(&index);
    let read = git_with_index(root, &index, &["read-tree", sha])?;
    if !read.status.success() {
        let _ = std::fs::remove_file(&index);
        return Err(git_err(&read, "failed to read checkpoint tree"));
    }
    for path in &snapshot {
        prepare_path_for_file(root, path);
    }
    let checkout = git_with_index(root, &index, &["checkout-index", "--all", "--force"])?;
    let _ = std::fs::remove_file(&index);
    if !checkout.status.success() {
        return Err(git_err(&checkout, "failed to restore checkpoint files"));
    }

    // Index may still hold staged files from the agent; put it back to HEAD
    // so status reflects the restored worktree against the current branch.
    let _ = git(root, &["reset", "-q"]);

    let current = ls_zero(
        root,
        &["ls-files", "-z", "-c", "-o", "--exclude-standard"],
    )?;
    for path in current {
        if snapshot.contains(&path) {
            continue;
        }
        remove_worktree_file(root, &path);
    }
    Ok(())
}

fn drop_checkpoint_refs(root: &Path, shas: &[String]) {
    for sha in shas {
        if sha.is_empty() {
            continue;
        }
        let refname = checkpoint_ref(root, sha);
        let _ = git(root, &["update-ref", "-d", &refname]);
    }
}

fn temp_index_path(root: &Path) -> Result<PathBuf, String> {
    let dir = fold_paths::fold_data_dir(root).ok_or_else(|| {
        "could not resolve Fold data directory for worktree".to_string()
    })?;
    std::fs::create_dir_all(&dir)
        .map_err(|e| format!("failed to create Fold data directory: {e}"))?;
    Ok(dir.join("checkpoint.index"))
}

fn worktree_ref_slug(root: &Path) -> String {
    root.file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_else(|| "worktree".to_string())
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || c == '-' || c == '_' {
                c
            } else {
                '-'
            }
        })
        .collect()
}

fn ref_prefix(root: &Path) -> String {
    format!("refs/fold/checkpoints/{}/", worktree_ref_slug(root))
}

fn checkpoint_ref(root: &Path, sha: &str) -> String {
    format!("refs/fold/checkpoints/{}/{}", worktree_ref_slug(root), sha)
}

fn git(root: &Path, args: &[&str]) -> Result<Output, String> {
    Command::new("git")
        .args(args)
        .current_dir(root)
        .output()
        .map_err(|e| format!("failed to run git {}: {e}", args.join(" ")))
}

fn git_with_index(root: &Path, index: &Path, args: &[&str]) -> Result<Output, String> {
    Command::new("git")
        .args(args)
        .current_dir(root)
        .env("GIT_INDEX_FILE", index)
        .output()
        .map_err(|e| format!("failed to run git {}: {e}", args.join(" ")))
}

fn git_stdout(root: &Path, args: &[&str]) -> Result<String, String> {
    let output = git(root, args)?;
    if !output.status.success() {
        return Err(git_err(&output, &format!("git {}", args.join(" "))));
    }
    Ok(String::from_utf8_lossy(&output.stdout).trim().to_string())
}

fn git_stderr(output: &Output) -> String {
    String::from_utf8_lossy(&output.stderr).trim().to_string()
}

fn git_err(output: &Output, fallback: &str) -> String {
    let err = git_stderr(output);
    if err.is_empty() {
        fallback.to_string()
    } else {
        err
    }
}

fn ls_zero(root: &Path, args: &[&str]) -> Result<HashSet<String>, String> {
    let output = git(root, args)?;
    if !output.status.success() {
        return Err(git_err(&output, &format!("git {}", args.join(" "))));
    }
    let mut files = HashSet::new();
    for name in output.stdout.split(|b| *b == 0) {
        if name.is_empty() {
            continue;
        }
        let path = String::from_utf8_lossy(name).replace('\\', "/");
        if path.is_empty() || path.starts_with('/') || path.split('/').any(|p| p == "..") {
            continue;
        }
        files.insert(path);
    }
    Ok(files)
}

/// Make `rel` writable as a file: drop a directory at that path, or a file
/// sitting where a parent directory needs to be.
fn prepare_path_for_file(root: &Path, rel: &str) {
    let dest = root.join(rel);
    if dest.is_dir() && !dest.is_symlink() {
        let _ = std::fs::remove_dir_all(&dest);
    }
    let mut current = dest.parent().map(|p| p.to_path_buf());
    while let Some(dir) = current {
        if dir == root {
            break;
        }
        if dir.is_file() || dir.is_symlink() {
            let _ = std::fs::remove_file(&dir);
            break;
        }
        current = dir.parent().map(|p| p.to_path_buf());
    }
}

fn remove_worktree_file(root: &Path, rel: &str) {
    let path = root.join(rel);
    if path.is_file() || path.is_symlink() {
        let _ = std::fs::remove_file(&path);
    } else if path.is_dir() {
        let _ = std::fs::remove_dir_all(&path);
    }
    let mut current = path.parent().map(|p| p.to_path_buf());
    while let Some(dir) = current {
        if dir == root {
            break;
        }
        match std::fs::remove_dir(&dir) {
            Ok(()) => current = dir.parent().map(|p| p.to_path_buf()),
            Err(_) => break,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::sync::atomic::{AtomicU64, Ordering};
    use std::time::{SystemTime, UNIX_EPOCH};

    static TEST_SEQ: AtomicU64 = AtomicU64::new(0);

    fn git_ok(root: &Path, args: &[&str]) {
        let out = git(root, args).expect("git spawn");
        assert!(
            out.status.success(),
            "git {} failed: {}",
            args.join(" "),
            git_stderr(&out)
        );
    }

    fn tmp_repo() -> PathBuf {
        let stamp = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or(0);
        let seq = TEST_SEQ.fetch_add(1, Ordering::Relaxed);
        let dir = std::env::temp_dir().join(format!(
            "fold-checkpoint-{}-{}-{}",
            std::process::id(),
            stamp,
            seq
        ));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        git_ok(&dir, &["init", "-q"]);
        git_ok(&dir, &["config", "user.email", "fold@test"]);
        git_ok(&dir, &["config", "user.name", "Fold Test"]);
        fs::write(dir.join("keep.txt"), "base\n").unwrap();
        git_ok(&dir, &["add", "keep.txt"]);
        git_ok(&dir, &["commit", "-m", "init"]);
        dir
    }

    fn cleanup(dir: &Path) {
        if let Some(data) = fold_paths::fold_data_dir(dir) {
            let _ = fs::remove_dir_all(&data);
        }
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn restore_reverts_tracked_edit_and_added_file() {
        let repo = tmp_repo();
        let sha = create_checkpoint(&repo).expect("snapshot");

        fs::write(repo.join("keep.txt"), "edited\n").unwrap();
        fs::write(repo.join("new.txt"), "added\n").unwrap();

        restore_checkpoint(&repo, &sha).expect("restore");

        assert_eq!(fs::read_to_string(repo.join("keep.txt")).unwrap(), "base\n");
        assert!(!repo.join("new.txt").exists());
        cleanup(&repo);
    }

    #[test]
    fn restore_brings_back_deleted_untracked_file() {
        let repo = tmp_repo();
        fs::write(repo.join("scratch.txt"), "wip\n").unwrap();
        let sha = create_checkpoint(&repo).expect("snapshot");

        fs::remove_file(repo.join("scratch.txt")).unwrap();
        restore_checkpoint(&repo, &sha).expect("restore");

        assert_eq!(
            fs::read_to_string(repo.join("scratch.txt")).unwrap(),
            "wip\n"
        );
        cleanup(&repo);
    }

    #[test]
    fn earlier_checkpoint_restores_without_rolling_back_later_first() {
        let repo = tmp_repo();
        let first = create_checkpoint(&repo).expect("first snapshot");

        fs::write(repo.join("keep.txt"), "turn1\n").unwrap();
        let _second = create_checkpoint(&repo).expect("second snapshot");
        fs::write(repo.join("keep.txt"), "turn2\n").unwrap();
        fs::write(repo.join("later.txt"), "turn2-file\n").unwrap();

        restore_checkpoint(&repo, &first).expect("restore turn 1");

        assert_eq!(fs::read_to_string(repo.join("keep.txt")).unwrap(), "base\n");
        assert!(!repo.join("later.txt").exists());
        cleanup(&repo);
    }

    #[test]
    fn restore_overwrites_untracked_files_still_in_the_worktree() {
        let repo = tmp_repo();
        fs::create_dir_all(repo.join("db/migrations")).unwrap();
        fs::write(repo.join("db/migrations/001.sql"), "before\n").unwrap();
        fs::write(repo.join("scratch.txt"), "wip\n").unwrap();
        let sha = create_checkpoint(&repo).expect("snapshot");

        fs::write(repo.join("db/migrations/001.sql"), "after\n").unwrap();
        fs::write(repo.join("db/migrations/002.sql"), "newer\n").unwrap();
        fs::write(repo.join("scratch.txt"), "changed\n").unwrap();

        restore_checkpoint(&repo, &sha).expect("restore");

        assert_eq!(
            fs::read_to_string(repo.join("db/migrations/001.sql")).unwrap(),
            "before\n"
        );
        assert_eq!(fs::read_to_string(repo.join("scratch.txt")).unwrap(), "wip\n");
        assert!(!repo.join("db/migrations/002.sql").exists());
        let staged = git_stdout(&repo, &["diff", "--cached", "--name-only"]).unwrap();
        assert!(staged.is_empty(), "restore left files staged: {staged}");
        cleanup(&repo);
    }
}
