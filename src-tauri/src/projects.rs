use std::path::{Path, PathBuf};
use std::process::Command;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager, State};

use crate::github::{clone_github_repo, create_private_github_repo, detect_github_remote};
use crate::AppState;

#[derive(Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct Worktree {
    id: String,
    name: String,
    branch: String,
    path: String,
    /// Archived worktrees keep their branch but have their folder deleted.
    #[serde(default)]
    archived: bool,
}

#[derive(Serialize, Deserialize, Clone, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum TransferMode {
    Symlink,
    Copy,
}

/// Relative path under the main checkout to symlink or copy into a new worktree.
#[derive(Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct EnvTransfer {
    path: String,
    mode: TransferMode,
}

/// Last create-dialog selections remembered for the next worktree in this project.
#[derive(Serialize, Deserialize, Clone, Default)]
#[serde(rename_all = "camelCase")]
pub struct WorktreeEnvDefaults {
    #[serde(default)]
    symlink_envs: bool,
    #[serde(default)]
    transfers: Vec<EnvTransfer>,
}

#[derive(Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct WorktreeEnvScan {
    dirs: Vec<String>,
    files: Vec<String>,
    defaults: Option<WorktreeEnvDefaults>,
}

#[derive(Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct Project {
    id: String,
    name: String,
    /// Original repository checkout (source for `git worktree add`).
    path: String,
    created_on_github: bool,
    #[serde(default)]
    has_github_remote: bool,
    #[serde(default)]
    worktrees: Vec<Worktree>,
    #[serde(default)]
    active_worktree_id: Option<String>,
    #[serde(default)]
    worktree_env_defaults: Option<WorktreeEnvDefaults>,
}

#[derive(Serialize, Deserialize, Clone, Default)]
#[serde(rename_all = "camelCase")]
pub struct ProjectsFile {
    projects: Vec<Project>,
    active_id: Option<String>,
}

/// Path to the persisted `projects.json` inside the app config directory.
fn projects_file(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_config_dir()
        .map_err(|e| format!("failed to resolve config dir: {e}"))?;
    std::fs::create_dir_all(&dir).map_err(|e| format!("failed to create config dir: {e}"))?;
    Ok(dir.join("projects.json"))
}

fn read_file(app: &AppHandle) -> Result<ProjectsFile, String> {
    let path = projects_file(app)?;
    match std::fs::read_to_string(&path) {
        Ok(contents) => {
            serde_json::from_str(&contents).map_err(|e| format!("failed to parse projects.json: {e}"))
        }
        Err(_) => Ok(ProjectsFile::default()),
    }
}

fn write_file(app: &AppHandle, data: &ProjectsFile) -> Result<(), String> {
    let path = projects_file(app)?;
    let contents =
        serde_json::to_string_pretty(data).map_err(|e| format!("failed to serialize projects: {e}"))?;
    std::fs::write(&path, contents).map_err(|e| format!("failed to write projects.json: {e}"))
}

/// Reflect the active workspace path into the shared runtime state.
///
/// Important: this must be the *worktree* directory (isolated copy), never the
/// common parent folder that contains multiple worktrees. Explorer + terminal
/// both read this path.
fn set_active_path(state: &State<'_, AppState>, path: Option<PathBuf>) -> Result<(), String> {
    *state.active_project.lock().map_err(|e| e.to_string())? = path;
    Ok(())
}

fn find_project<'a>(data: &'a ProjectsFile, id: &str) -> Option<&'a Project> {
    data.projects.iter().find(|p| p.id == id)
}

fn find_project_mut<'a>(data: &'a mut ProjectsFile, id: &str) -> Option<&'a mut Project> {
    data.projects.iter_mut().find(|p| p.id == id)
}

/// Resolve the path that explorer/terminal should use for a project.
/// Only an explicit active worktree counts — never the main checkout or a
/// sibling worktree fallback.
fn workspace_path(project: &Project) -> Option<PathBuf> {
    let id = project.active_worktree_id.as_ref()?;
    project
        .worktrees
        .iter()
        .find(|w| &w.id == id)
        .map(|wt| PathBuf::from(&wt.path))
}

/// Load the persisted active project into runtime state (called at startup).
pub fn load_active(app: &AppHandle, state: &State<'_, AppState>) -> Result<(), String> {
    let data = read_file(app)?;
    let path = data
        .active_id
        .as_ref()
        .and_then(|id| find_project(&data, id))
        .and_then(workspace_path);
    set_active_path(state, path)
}

fn new_id(prefix: &str) -> String {
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    format!("{prefix}{nanos}")
}

fn git_init(dir: &Path) -> Result<(), String> {
    let output = Command::new("git")
        .args(["init"])
        .current_dir(dir)
        .output()
        .map_err(|e| format!("failed to run git init: {e}"))?;
    if !output.status.success() {
        return Err(String::from_utf8_lossy(&output.stderr).trim().to_string());
    }
    Ok(())
}

fn git_in(dir: &Path, args: &[&str]) -> Result<std::process::Output, String> {
    Command::new("git")
        .args(args)
        .current_dir(dir)
        .output()
        .map_err(|e| format!("failed to run git {}: {e}", args.join(" ")))
}

fn git_ok(dir: &Path, args: &[&str]) -> bool {
    git_in(dir, args).map(|o| o.status.success()).unwrap_or(false)
}

fn git_stdout(dir: &Path, args: &[&str]) -> Result<String, String> {
    let output = git_in(dir, args)?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        return Err(if stderr.is_empty() {
            format!("git {} failed", args.join(" "))
        } else {
            stderr
        });
    }
    Ok(String::from_utf8_lossy(&output.stdout).trim().to_string())
}

fn commit_all(repo: &Path, message: &str) -> Result<(), String> {
    let add = git_in(repo, &["add", "-A"])?;
    if !add.status.success() {
        let stderr = String::from_utf8_lossy(&add.stderr).trim().to_string();
        return Err(if stderr.is_empty() {
            "git add failed".to_string()
        } else {
            stderr
        });
    }
    let commit = git_in(
        repo,
        &[
            "-c",
            "user.email=fold@local",
            "-c",
            "user.name=Fold",
            "commit",
            "--allow-empty",
            "-m",
            message,
        ],
    )?;
    if !commit.status.success() {
        let stderr = String::from_utf8_lossy(&commit.stderr).trim().to_string();
        return Err(if stderr.is_empty() {
            "failed to create commit for worktree".to_string()
        } else {
            stderr
        });
    }
    Ok(())
}

/// Prefer `main`, then `master`, then current `HEAD`.
fn default_base_ref(repo: &Path) -> String {
    for candidate in ["main", "master"] {
        if git_ok(repo, &["rev-parse", "--verify", candidate]) {
            return candidate.to_string();
        }
    }
    "HEAD".to_string()
}

/// Ref new worktrees should branch from. When the repo has an `origin` remote,
/// fetch the base branch first and prefer the freshly-updated `origin/<base>`
/// so new worktrees start from the latest remote commit instead of a stale
/// local branch. The fetch is best-effort — offline/auth failures fall back to
/// the local base ref.
fn resolve_base_ref(repo: &Path) -> String {
    let base = default_base_ref(repo);
    if base == "HEAD" {
        return base;
    }
    if git_ok(repo, &["remote", "get-url", "origin"]) {
        // Creating a worktree waits on this fetch, so keep it as small as
        // possible (no tags) and give up on a stalled connection instead of
        // hanging the dialog — a stale base is better than never finishing.
        let _ = git_in(
            repo,
            &[
                "-c",
                "http.lowSpeedLimit=1000",
                "-c",
                "http.lowSpeedTime=15",
                "fetch",
                "--no-tags",
                "--quiet",
                "origin",
                &base,
            ],
        );
        let remote_ref = format!("origin/{base}");
        if git_ok(repo, &["rev-parse", "--verify", &remote_ref]) {
            return remote_ref;
        }
    }
    base
}

fn head_tree_is_empty(repo: &Path) -> bool {
    match git_stdout(repo, &["ls-tree", "-r", "--name-only", "HEAD"]) {
        Ok(names) => names.is_empty(),
        Err(_) => true,
    }
}

fn working_tree_has_files(repo: &Path) -> bool {
    let Ok(entries) = std::fs::read_dir(repo) else {
        return false;
    };
    entries.filter_map(|e| e.ok()).any(|e| e.file_name() != *".git")
}

/// Make sure the repo has a commit that includes the project files so a new
/// worktree is not an empty checkout.
fn ensure_base_commit(repo: &Path) -> Result<(), String> {
    let has_head = git_ok(repo, &["rev-parse", "--verify", "HEAD"]);
    if !has_head {
        // Fresh repo: commit whatever is on disk (may be empty).
        return commit_all(repo, "Initial commit");
    }
    // Recover from an empty root commit when files exist but were never added.
    if head_tree_is_empty(repo) && working_tree_has_files(repo) {
        return commit_all(repo, "Add project files");
    }
    Ok(())
}

/// Sanitize a name for use as a folder / branch segment.
fn sanitize_slug(name: &str) -> String {
    let mut out = String::new();
    for ch in name.trim().chars() {
        if ch.is_ascii_alphanumeric() || ch == '-' || ch == '_' {
            out.push(ch.to_ascii_lowercase());
        } else if ch.is_whitespace() || ch == '/' {
            if !out.ends_with('-') {
                out.push('-');
            }
        }
    }
    let trimmed = out.trim_matches('-').to_string();
    if trimmed.is_empty() {
        "workspace".to_string()
    } else {
        trimmed
    }
}

/// True when a local branch ref already exists (`refs/heads/<branch>`).
fn local_branch_exists(repo: &Path, branch: &str) -> bool {
    git_ok(
        repo,
        &["show-ref", "--verify", "--quiet", &format!("refs/heads/{branch}")],
    )
}

/// True when any remote-tracking ref ends with `/<branch>` (e.g. `origin/ws/foo`).
fn remote_branch_exists(repo: &Path, branch: &str) -> Result<bool, String> {
    let output = git_in(repo, &[
        "for-each-ref",
        "--format=%(refname:short)",
        "refs/remotes",
    ])?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        return Err(if stderr.is_empty() {
            "git for-each-ref failed".to_string()
        } else {
            stderr
        });
    }
    let stdout = String::from_utf8_lossy(&output.stdout);
    Ok(stdout.lines().any(|line| {
        let short = line.trim();
        short
            .split_once('/')
            .is_some_and(|(_, name)| name == branch)
    }))
}

/// Shared parent for all worktrees of a project:
/// `~/fold/workspaces/<project-slug>/`
fn workspaces_root(project_name: &str) -> Result<PathBuf, String> {
    let home = std::env::var("HOME")
        .or_else(|_| std::env::var("USERPROFILE"))
        .map_err(|_| "could not resolve home directory".to_string())?;
    let root = PathBuf::from(home)
        .join("fold")
        .join("workspaces")
        .join(sanitize_slug(project_name));
    std::fs::create_dir_all(&root).map_err(|e| format!("failed to create workspaces dir: {e}"))?;
    Ok(root)
}

/// Returns true when `rel` is ignored by git (via `.gitignore` or global excludes).
fn is_gitignored(repo: &Path, rel: &Path) -> bool {
    let rel_str = rel.to_string_lossy();
    git_in(repo, &["check-ignore", "-q", "--", rel_str.as_ref()])
        .map(|o| o.status.success())
        .unwrap_or(false)
}

/// Known environment directories that are usually gitignored and expensive to recreate.
const ENV_DIRS: &[&str] = &[
    "node_modules",
    ".venv",
    "venv",
    "env",
    "target",
    "vendor",
    ".next",
    "dist",
    "build",
    ".turbo",
    ".pnpm-store",
    "Pods",
    ".gradle",
    "__pycache__",
    ".dart_tool",
    ".nuxt",
    ".output",
    ".svelte-kit",
    "bower_components",
    ".parcel-cache",
    ".cache",
];

/// Known env / secrets files that are usually gitignored.
const ENV_FILES: &[&str] = &[
    ".env",
    ".env.local",
    ".env.development",
    ".env.development.local",
    ".env.production",
    ".env.production.local",
    ".env.test",
    ".env.test.local",
];

/// Reject absolute paths and `..` so transfers stay under the main checkout.
fn validate_relative_path(rel: &str) -> Result<PathBuf, String> {
    let trimmed = rel.trim();
    if trimmed.is_empty() {
        return Err("transfer path is empty".to_string());
    }
    let path = Path::new(trimmed);
    if path.is_absolute() {
        return Err(format!("transfer path must be relative: {trimmed}"));
    }
    for component in path.components() {
        match component {
            std::path::Component::Normal(_) => {}
            std::path::Component::CurDir => {}
            _ => {
                return Err(format!("invalid transfer path: {trimmed}"));
            }
        }
    }
    Ok(path.to_path_buf())
}

/// Ensure `candidate` resolves inside `root` (after joining).
fn resolve_under(root: &Path, rel: &Path) -> Result<PathBuf, String> {
    let joined = root.join(rel);
    let root_canon = root
        .canonicalize()
        .map_err(|e| format!("failed to resolve {}: {e}", root.display()))?;
    // Source may not exist yet for dest; canonicalize parent + append when needed.
    let resolved = if joined.exists() {
        joined
            .canonicalize()
            .map_err(|e| format!("failed to resolve {}: {e}", joined.display()))?
    } else {
        let parent = joined.parent().unwrap_or(root);
        let parent_canon = if parent.exists() {
            parent
                .canonicalize()
                .map_err(|e| format!("failed to resolve {}: {e}", parent.display()))?
        } else {
            return Err(format!("{} does not exist", joined.display()));
        };
        let name = joined
            .file_name()
            .ok_or_else(|| format!("invalid path: {}", joined.display()))?;
        parent_canon.join(name)
    };
    if !resolved.starts_with(&root_canon) {
        return Err(format!(
            "transfer path escapes project root: {}",
            rel.display()
        ));
    }
    Ok(resolved)
}

fn apply_env_transfers(main: &Path, dest: &Path, transfers: &[EnvTransfer]) -> Result<(), String> {
    for transfer in transfers {
        let rel = validate_relative_path(&transfer.path)?;
        let src = resolve_under(main, &rel)?;
        if !src.exists() {
            return Err(format!("{} does not exist in main checkout", rel.display()));
        }

        let dest_path = dest.join(&rel);
        if let Some(parent) = dest_path.parent() {
            std::fs::create_dir_all(parent)
                .map_err(|e| format!("failed to create {}: {e}", parent.display()))?;
        }
        let dest_exists = dest_path.exists() || dest_path.symlink_metadata().is_ok();

        match transfer.mode {
            TransferMode::Symlink => {
                // Only symlink gitignored paths — tracked dirs/files are already
                // checked out into the worktree and would collide.
                if !is_gitignored(main, &rel) {
                    continue;
                }
                if dest_exists {
                    return Err(format!(
                        "{} already exists in worktree",
                        dest_path.display()
                    ));
                }
                std::os::unix::fs::symlink(&src, &dest_path).map_err(|e| {
                    format!(
                        "failed to symlink {} → {}: {e}",
                        src.display(),
                        dest_path.display()
                    )
                })?;
            }
            TransferMode::Copy => {
                // Tracked files are already in the worktree from `git worktree add`.
                if dest_exists {
                    continue;
                }
                if src.is_dir() {
                    return Err(format!(
                        "cannot copy directory {} (use symlink for env folders)",
                        rel.display()
                    ));
                }
                std::fs::copy(&src, &dest_path).map_err(|e| {
                    format!(
                        "failed to copy {} → {}: {e}",
                        src.display(),
                        dest_path.display()
                    )
                })?;
            }
        }
    }
    Ok(())
}

fn remove_worktree_dir(path: &Path) {
    let _ = std::fs::remove_dir_all(path);
}

/// Create an isolated git worktree under the common project folder, starting
/// from the project's main branch so all committed files are checked out.
fn add_worktree(repo: &Path, dest: &Path, branch: &str) -> Result<(), String> {
    if dest.exists() {
        return Err(format!("{} already exists", dest.display()));
    }
    if let Some(parent) = dest.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|e| format!("failed to create worktree parent: {e}"))?;
    }

    let base = resolve_base_ref(repo);
    let dest_s = dest.to_string_lossy().to_string();

    // New branch from the latest main/master (full file tree), checked out in
    // `dest`. `resolve_base_ref` fetches origin first when a remote exists.
    let output = git_in(
        repo,
        &["worktree", "add", "-b", branch, &dest_s, &base],
    )?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        return Err(if stderr.is_empty() {
            "git worktree add failed".to_string()
        } else {
            stderr
        });
    }
    Ok(())
}

#[tauri::command(async)]
pub fn list_projects(app: AppHandle) -> Result<ProjectsFile, String> {
    read_file(&app)
}

#[tauri::command(async)]
pub fn create_project(
    app: AppHandle,
    parent: String,
    name: String,
    create_github: bool,
    state: State<'_, AppState>,
) -> Result<Project, String> {
    let name = name.trim();
    if name.is_empty() {
        return Err("project name is required".to_string());
    }
    let dir = Path::new(&parent).join(name);
    if dir.exists() {
        return Err(format!("{} already exists", dir.display()));
    }
    std::fs::create_dir_all(&dir).map_err(|e| format!("failed to create folder: {e}"))?;
    if let Err(e) = git_init(&dir) {
        let _ = std::fs::remove_dir_all(&dir);
        return Err(e);
    }

    let path = dir.to_string_lossy().to_string();
    let mut has_github_remote = false;
    if create_github {
        if let Err(e) = create_private_github_repo(&path, name) {
            let _ = std::fs::remove_dir_all(&dir);
            return Err(e);
        }
        has_github_remote = true;
    }

    let project = Project {
        id: new_id("p"),
        name: name.to_string(),
        path,
        created_on_github: create_github,
        has_github_remote,
        worktrees: Vec::new(),
        active_worktree_id: None,
        worktree_env_defaults: None,
    };

    let mut data = read_file(&app)?;
    data.projects.push(project.clone());
    data.active_id = Some(project.id.clone());
    write_file(&app, &data)?;
    // No worktree yet — explorer/terminal stay empty until one is created.
    set_active_path(&state, None)?;
    Ok(project)
}

/// Whether `path` is (or is inside) a git working tree.
#[tauri::command(async)]
pub fn is_git_repo(path: String) -> bool {
    PathBuf::from(&path).join(".git").exists()
}

#[tauri::command(async)]
pub fn open_project(
    app: AppHandle,
    path: String,
    name: String,
    create_github: bool,
    init_git: bool,
    state: State<'_, AppState>,
) -> Result<Project, String> {
    let dir = PathBuf::from(&path);
    if !dir.is_dir() {
        return Err(format!("{} is not a folder", dir.display()));
    }
    let name = name.trim();
    let name = if name.is_empty() {
        dir.file_name()
            .map(|n| n.to_string_lossy().to_string())
            .unwrap_or_else(|| "project".to_string())
    } else {
        name.to_string()
    };

    // Only git repositories may be opened; initialize on request.
    if !dir.join(".git").exists() {
        if init_git {
            git_init(&dir)?;
        } else {
            return Err("folder is not a git repository".to_string());
        }
    }

    let mut data = read_file(&app)?;
    // Reuse the existing entry if this path is already registered.
    if let Some(existing) = data.projects.iter().find(|p| p.path == path).cloned() {
        data.active_id = Some(existing.id.clone());
        write_file(&app, &data)?;
        set_active_path(&state, workspace_path(&existing))?;
        return Ok(existing);
    }

    let project_path = dir.to_string_lossy().to_string();
    let mut has_github_remote = detect_github_remote(&project_path);
    let mut created_on_github = false;

    // Only create a GitHub repo when requested and the project has no remote yet.
    if create_github && !has_github_remote {
        create_private_github_repo(&project_path, &name)?;
        has_github_remote = true;
        created_on_github = true;
    } else if create_github && has_github_remote {
        // Remote already present — treat as success without recreating.
        created_on_github = false;
    }

    let project = Project {
        id: new_id("p"),
        name,
        has_github_remote,
        path: project_path,
        created_on_github,
        worktrees: Vec::new(),
        active_worktree_id: None,
        worktree_env_defaults: None,
    };
    data.projects.push(project.clone());
    data.active_id = Some(project.id.clone());
    write_file(&app, &data)?;
    set_active_path(&state, None)?;
    Ok(project)
}

/// Clone a GitHub repository into `parent/<repo>` and register it as a project.
#[tauri::command(async)]
pub fn clone_github_project(
    app: AppHandle,
    full_name: String,
    parent: String,
    name: Option<String>,
    state: State<'_, AppState>,
) -> Result<Project, String> {
    let path = clone_github_repo(&full_name, &parent)?;
    let display_name = name
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(|s| s.to_string())
        .unwrap_or_else(|| {
            PathBuf::from(&path)
                .file_name()
                .map(|n| n.to_string_lossy().to_string())
                .unwrap_or_else(|| "project".to_string())
        });
    open_project(app, path, display_name, false, false, state)
}

#[tauri::command(async)]
pub fn set_active_project(
    app: AppHandle,
    id: String,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let mut data = read_file(&app)?;
    let project = find_project(&data, &id)
        .cloned()
        .ok_or_else(|| "project not found".to_string())?;
    data.active_id = Some(id);
    write_file(&app, &data)?;
    set_active_path(&state, workspace_path(&project))
}

/// Detect known env dirs/files in the main checkout and return saved defaults.
#[tauri::command(async)]
pub fn scan_worktree_env(app: AppHandle, project_id: String) -> Result<WorktreeEnvScan, String> {
    let data = read_file(&app)?;
    let project = find_project(&data, &project_id)
        .ok_or_else(|| "project not found".to_string())?;
    let root = PathBuf::from(&project.path);
    if !root.is_dir() {
        return Err("project path is not a folder".to_string());
    }

    let mut dirs = Vec::new();
    for name in ENV_DIRS {
        let rel = Path::new(name);
        let candidate = root.join(rel);
        if candidate.is_dir() && is_gitignored(&root, rel) {
            dirs.push((*name).to_string());
        }
    }

    let mut files = Vec::new();
    for name in ENV_FILES {
        let rel = Path::new(name);
        let candidate = root.join(rel);
        if candidate.is_file() && is_gitignored(&root, rel) {
            files.push((*name).to_string());
        }
    }

    Ok(WorktreeEnvScan {
        dirs,
        files,
        defaults: project.worktree_env_defaults.clone(),
    })
}

/// Create a new branch + worktree under the common project folder and activate it.
#[tauri::command(async)]
pub fn create_worktree(
    app: AppHandle,
    project_id: String,
    name: String,
    branch: Option<String>,
    transfers: Option<Vec<EnvTransfer>>,
    symlink_envs: Option<bool>,
    save_defaults: Option<bool>,
    state: State<'_, AppState>,
) -> Result<Project, String> {
    let name = name.trim();
    if name.is_empty() {
        return Err("worktree name is required".to_string());
    }
    let slug = sanitize_slug(name);
    let branch_name = branch
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(|s| s.to_string())
        .unwrap_or_else(|| format!("ws/{slug}"));
    let transfers = transfers.unwrap_or_default();
    let save_defaults = save_defaults.unwrap_or(false);
    let symlink_envs = symlink_envs.unwrap_or(false);

    let mut data = read_file(&app)?;
    let project = find_project_mut(&mut data, &project_id)
        .ok_or_else(|| "project not found".to_string())?;

    let repo = PathBuf::from(&project.path);
    if !repo.join(".git").exists() {
        return Err("project is not a git repository".to_string());
    }
    ensure_base_commit(&repo)?;

    if project.worktrees.iter().any(|w| sanitize_slug(&w.name) == slug) {
        return Err(format!("worktree \"{name}\" already exists"));
    }

    if local_branch_exists(&repo, &branch_name) {
        return Err(format!("branch \"{branch_name}\" already exists"));
    }
    if remote_branch_exists(&repo, &branch_name)? {
        return Err(format!(
            "branch \"{branch_name}\" already exists on a remote"
        ));
    }

    let dest = workspaces_root(&project.name)?.join(&slug);
    if project.worktrees.iter().any(|w| w.path == dest.to_string_lossy()) {
        return Err(format!("worktree already registered at {}", dest.display()));
    }

    add_worktree(&repo, &dest, &branch_name)?;

    if let Err(e) = apply_env_transfers(&repo, &dest, &transfers) {
        // Roll back the half-created worktree so the user can retry cleanly.
        let _ = git_in(&repo, &["worktree", "remove", "--force", &dest.to_string_lossy()]);
        crate::fold_paths::remove_fold_data_dir(&dest);
        remove_worktree_dir(&dest);
        return Err(e);
    }

    let worktree = Worktree {
        id: new_id("w"),
        name: name.to_string(),
        branch: branch_name,
        // Absolute path to the isolated copy — this is what explorer/terminal use.
        path: dest.to_string_lossy().to_string(),
        archived: false,
    };

    project.worktrees.push(worktree.clone());
    project.active_worktree_id = Some(worktree.id.clone());
    if save_defaults {
        project.worktree_env_defaults = Some(WorktreeEnvDefaults {
            symlink_envs,
            transfers: transfers.clone(),
        });
    }
    let updated = project.clone();

    data.active_id = Some(project_id);
    write_file(&app, &data)?;
    // Point runtime state at the worktree folder itself (not the common parent).
    set_active_path(&state, Some(dest))?;
    Ok(updated)
}

/// Select a worktree within a project; explorer + terminal follow its path.
#[tauri::command(async)]
pub fn set_active_worktree(
    app: AppHandle,
    project_id: String,
    worktree_id: String,
    state: State<'_, AppState>,
) -> Result<Project, String> {
    let mut data = read_file(&app)?;
    let project = find_project_mut(&mut data, &project_id)
        .ok_or_else(|| "project not found".to_string())?;

    let wt = project
        .worktrees
        .iter()
        .find(|w| w.id == worktree_id)
        .cloned()
        .ok_or_else(|| "worktree not found".to_string())?;

    project.active_worktree_id = Some(worktree_id);
    let updated = project.clone();
    data.active_id = Some(project_id);
    write_file(&app, &data)?;
    set_active_path(&state, Some(PathBuf::from(&wt.path)))?;
    Ok(updated)
}

#[tauri::command(async)]
pub fn remove_project(
    app: AppHandle,
    id: String,
    state: State<'_, AppState>,
) -> Result<ProjectsFile, String> {
    let mut data = read_file(&app)?;
    data.projects.retain(|p| p.id != id);
    if data.active_id.as_deref() == Some(id.as_str()) {
        data.active_id = data.projects.first().map(|p| p.id.clone());
    }
    write_file(&app, &data)?;
    let path = data
        .active_id
        .as_ref()
        .and_then(|aid| find_project(&data, aid))
        .and_then(workspace_path);
    set_active_path(&state, path)?;
    Ok(data)
}

/// Remove a worktree from the project list (and from git's worktree registry).
#[tauri::command(async)]
pub fn remove_worktree(
    app: AppHandle,
    project_id: String,
    worktree_id: String,
    state: State<'_, AppState>,
) -> Result<Project, String> {
    let mut data = read_file(&app)?;
    let project = find_project_mut(&mut data, &project_id)
        .ok_or_else(|| "project not found".to_string())?;

    let idx = project
        .worktrees
        .iter()
        .position(|w| w.id == worktree_id)
        .ok_or_else(|| "worktree not found".to_string())?;
    let removed = project.worktrees.remove(idx);

    let removed_was_active = project.active_worktree_id.as_deref() == Some(worktree_id.as_str());
    if removed_was_active {
        // Do not fall back to main or another worktree — clear selection.
        project.active_worktree_id = None;
    }

    // Best-effort: unregister + delete the worktree folder, then delete the
    // branch (force, since it may hold unmerged commits). This also handles
    // removing an already-archived worktree — the folder is gone, but the
    // `branch -D` still fires. Also drop the sibling Fold data dir (plans/asks).
    let repo = PathBuf::from(&project.path);
    let wt_path = PathBuf::from(&removed.path);
    crate::fold_paths::remove_fold_data_dir(&wt_path);
    let _ = git_in(&repo, &["worktree", "remove", "--force", &removed.path]);
    let _ = std::fs::remove_dir_all(&wt_path);
    let _ = git_in(&repo, &["worktree", "prune"]);
    let _ = git_in(&repo, &["branch", "-D", &removed.branch]);

    let updated = project.clone();
    write_file(&app, &data)?;
    set_active_path(
        &state,
        if removed_was_active {
            None
        } else {
            workspace_path(&updated)
        },
    )?;
    Ok(updated)
}

/// Archive a worktree: keep the entry and its git branch, but delete the
/// isolated folder and unregister it from git. One-way (no restore in the UI).
#[tauri::command(async)]
pub fn archive_worktree(
    app: AppHandle,
    project_id: String,
    worktree_id: String,
    state: State<'_, AppState>,
) -> Result<Project, String> {
    let mut data = read_file(&app)?;
    let project = find_project_mut(&mut data, &project_id)
        .ok_or_else(|| "project not found".to_string())?;

    let wt = project
        .worktrees
        .iter_mut()
        .find(|w| w.id == worktree_id)
        .ok_or_else(|| "worktree not found".to_string())?;
    wt.archived = true;
    let path = wt.path.clone();

    let removed_was_active = project.active_worktree_id.as_deref() == Some(worktree_id.as_str());
    if removed_was_active {
        // Do not fall back to main or another worktree — clear selection.
        project.active_worktree_id = None;
    }

    // Best-effort: unregister + delete the worktree folder, but KEEP the branch.
    // Also drop the sibling Fold data dir (plans/asks) for this worktree.
    let repo = PathBuf::from(&project.path);
    let wt_path = PathBuf::from(&path);
    crate::fold_paths::remove_fold_data_dir(&wt_path);
    let _ = git_in(&repo, &["worktree", "remove", "--force", &path]);
    let _ = std::fs::remove_dir_all(&wt_path);
    let _ = git_in(&repo, &["worktree", "prune"]);

    let updated = project.clone();
    write_file(&app, &data)?;
    set_active_path(
        &state,
        if removed_was_active {
            None
        } else {
            workspace_path(&updated)
        },
    )?;
    Ok(updated)
}
