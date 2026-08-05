import { useEffect, useState } from "react";
import {
  IconFolder,
  IconGitBranch,
  IconAlertTriangle,
  IconBrandGithub,
  IconLoader2,
} from "@tabler/icons-react";
import { isGitRepo, pickFolder } from "../lib/projects";
import { gitGithubRemote } from "../lib/git";
import { ghRepoNameCheck, type GhRepoNameCheck } from "../lib/github";
import { useGithubStore } from "../store/githubStore";
import { useProjectStore } from "../store/projectStore";
import "./ProjectDialog.css";

type Mode = "create" | "open";

function basename(path: string): string {
  const parts = path.replace(/[\\/]+$/, "").split(/[\\/]/);
  return parts[parts.length - 1] || path;
}

export default function ProjectDialog({
  mode,
  onClose,
}: {
  mode: Mode;
  onClose: () => void;
}) {
  const create = useProjectStore((s) => s.create);
  const open = useProjectStore((s) => s.open);
  const ghAuthenticated = useGithubStore((s) => s.authenticated);
  const ghUsername = useGithubStore((s) => s.username);
  const ghChecking = useGithubStore((s) => s.checking);
  const refreshGithub = useGithubStore((s) => s.refresh);

  const [name, setName] = useState("");
  const [folder, setFolder] = useState("");
  const [createGithub, setCreateGithub] = useState(false);
  const [initGit, setInitGit] = useState(false);
  // null = not checked yet (open mode, no folder chosen).
  const [isRepo, setIsRepo] = useState<boolean | null>(null);
  const [hasGithubRemote, setHasGithubRemote] = useState<boolean | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [nameCheck, setNameCheck] = useState<GhRepoNameCheck | null>(null);
  const [nameChecking, setNameChecking] = useState(false);

  // Refresh gh auth when the dialog opens.
  useEffect(() => {
    void refreshGithub();
  }, [refreshGithub]);

  // Close on Escape.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  // Debounced GitHub name availability check while "create on GitHub" is on.
  const effectiveName =
    name.trim() || (mode === "open" && folder ? basename(folder) : "");

  useEffect(() => {
    if (!createGithub) {
      setNameCheck(null);
      setNameChecking(false);
      return;
    }
    if (!effectiveName) {
      setNameCheck(null);
      setNameChecking(false);
      return;
    }
    if (!ghAuthenticated) {
      setNameCheck({
        available: false,
        message: "Connect GitHub via Connect App before creating a repository",
        owner: null,
      });
      setNameChecking(false);
      return;
    }

    let cancelled = false;
    setNameChecking(true);
    const timer = window.setTimeout(() => {
      void (async () => {
        try {
          const result = await ghRepoNameCheck(effectiveName);
          if (!cancelled) {
            setNameCheck(result);
            setNameChecking(false);
          }
        } catch (e) {
          if (!cancelled) {
            setNameCheck({
              available: false,
              message: String(e),
              owner: null,
            });
            setNameChecking(false);
          }
        }
      })();
    }, 400);

    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [createGithub, effectiveName, ghAuthenticated]);

  const title = mode === "create" ? "Create Project" : "Open Existing Project";
  const preview =
    mode === "create" && folder && name.trim()
      ? `${folder.replace(/[\\/]+$/, "")}/${name.trim()}`
      : "";

  // Show create-on-GitHub for new projects, or existing projects without a
  // GitHub remote (once a folder is chosen and git is present / will be inited).
  const showCreateGithub =
    mode === "create" ||
    (mode === "open" &&
      folder !== "" &&
      hasGithubRemote === false &&
      (isRepo === true || initGit));

  const githubBlocked =
    createGithub &&
    (nameChecking ||
      !ghAuthenticated ||
      (effectiveName !== "" && nameCheck !== null && !nameCheck.available));

  const canSubmit =
    (mode === "create"
      ? Boolean(folder && name.trim())
      : Boolean(folder) && (isRepo === true || initGit)) && !githubBlocked;

  async function chooseCreateParent() {
    setError(null);
    const picked = await pickFolder("Parent folder");
    if (picked) setFolder(picked);
  }

  async function chooseOpenFolder() {
    setError(null);
    const picked = await pickFolder("Project folder");
    if (!picked) return;
    setFolder(picked);
    if (!name.trim()) setName(basename(picked));
    const repo = await isGitRepo(picked);
    setIsRepo(repo);
    setInitGit(false);
    setHasGithubRemote(null);
    setCreateGithub(false);
    if (repo) {
      const ghRemote = await gitGithubRemote(picked);
      setHasGithubRemote(ghRemote);
    } else {
      // Not a repo yet — no remote; user can init + optionally create on GitHub.
      setHasGithubRemote(false);
    }
  }

  async function submit() {
    if (!canSubmit || busy) return;
    setBusy(true);
    setError(null);
    try {
      // Final name check right before create to avoid races.
      if (createGithub && effectiveName) {
        const check = await ghRepoNameCheck(effectiveName);
        setNameCheck(check);
        if (!check.available) {
          setError(check.message ?? "Repository name is not available on GitHub");
          return;
        }
      }
      if (mode === "create") {
        await create(folder, name.trim(), createGithub);
      } else {
        await open(folder, name.trim(), createGithub, initGit);
      }
      onClose();
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="dialog-overlay" onMouseDown={onClose}>
      <div className="dialog" onMouseDown={(e) => e.stopPropagation()}>
        <div className="dialog-header">{title}</div>

        <div className="dialog-body">
          {mode === "create" ? (
            <>
              <div className="field">
                <label>Project name</label>
                <input
                  autoFocus
                  placeholder="my-project"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                />
              </div>

              <div className="field">
                <label>Parent folder</label>
                <div className="folder-picker">
                  <input
                    readOnly
                    placeholder="No folder selected"
                    value={folder}
                    onClick={chooseCreateParent}
                  />
                  <button className="ghost-btn" type="button" onClick={chooseCreateParent}>
                    Choose…
                  </button>
                </div>
              </div>

              {preview && (
                <div className="dialog-preview">
                  Will create <code>{preview}</code>
                </div>
              )}
            </>
          ) : (
            <>
              {/* Folder selection is the primary action when opening. */}
              <button
                className="folder-drop"
                type="button"
                onClick={chooseOpenFolder}
              >
                <IconFolder size={18} stroke={1.75} />
                <span>{folder || "Choose a project folder…"}</span>
              </button>

              {folder && (
                <>
                  <div className="field">
                    <label>Project name</label>
                    <input
                      placeholder="Defaults to folder name"
                      value={name}
                      onChange={(e) => setName(e.target.value)}
                    />
                  </div>

                  {isRepo === true && (
                    <div className="git-status ok">
                      <IconGitBranch size={15} stroke={1.75} />
                      <span>Git repository detected</span>
                    </div>
                  )}

                  {isRepo === true && hasGithubRemote === true && (
                    <div className="git-status ok">
                      <IconBrandGithub size={15} stroke={1.75} />
                      <span>GitHub remote detected</span>
                    </div>
                  )}

                  {isRepo === false && (
                    <div className="git-status warn">
                      <div className="git-status-line">
                        <IconAlertTriangle size={15} stroke={1.75} />
                        <span>This folder is not a git repository</span>
                      </div>
                      <label className="checkbox-row">
                        <input
                          type="checkbox"
                          checked={initGit}
                          onChange={(e) => {
                            const next = e.target.checked;
                            setInitGit(next);
                            if (!next) setCreateGithub(false);
                          }}
                        />
                        <span>Initialize a git repository here</span>
                      </label>
                    </div>
                  )}
                </>
              )}
            </>
          )}

          {showCreateGithub && (
            <div className="github-create">
              <label className="checkbox-row">
                <input
                  type="checkbox"
                  checked={createGithub}
                  disabled={ghChecking}
                  onChange={(e) => setCreateGithub(e.target.checked)}
                />
                <span>Also create on GitHub</span>
              </label>

              {createGithub && (
                <div className="github-create-hint">
                  {ghChecking ? (
                    <span className="github-check muted">
                      <IconLoader2 size={14} stroke={1.75} className="spin" />
                      Checking GitHub connection…
                    </span>
                  ) : !ghAuthenticated ? (
                    <span className="github-check warn-text">
                      Connect GitHub via Connect App first
                    </span>
                  ) : nameChecking ? (
                    <span className="github-check muted">
                      <IconLoader2 size={14} stroke={1.75} className="spin" />
                      Checking name availability…
                    </span>
                  ) : nameCheck && !nameCheck.available ? (
                    <span className="github-check warn-text">
                      {nameCheck.message ?? "Name is not available on GitHub"}
                    </span>
                  ) : nameCheck?.available ? (
                    <span className="github-check ok-text">
                      Will create private repo
                      {nameCheck.owner || ghUsername
                        ? ` @${nameCheck.owner ?? ghUsername}/${effectiveName}`
                        : ""}
                    </span>
                  ) : effectiveName ? null : (
                    <span className="github-check muted">
                      Enter a project name to check availability
                    </span>
                  )}
                </div>
              )}
            </div>
          )}

          {error && <div className="dialog-error">{error}</div>}
        </div>

        <div className="dialog-footer">
          <button className="ghost-btn" type="button" onClick={onClose}>
            Cancel
          </button>
          <button
            className="primary-btn"
            type="button"
            disabled={!canSubmit || busy}
            onClick={submit}
          >
            {busy ? "Working…" : mode === "create" ? "Create" : "Open"}
          </button>
        </div>
      </div>
    </div>
  );
}
