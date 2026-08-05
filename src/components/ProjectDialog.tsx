import { useEffect, useRef, useState } from "react";
import {
  IconFolder,
  IconGitBranch,
  IconAlertTriangle,
  IconBrandGithub,
  IconLoader2,
  IconChevronDown,
  IconLock,
  IconSearch,
} from "@tabler/icons-react";
import { isGitRepo, pickFolder } from "../lib/projects";
import { gitGithubRemote } from "../lib/git";
import {
  defaultCloneParent,
  ghListOwners,
  ghListRepos,
  ghRepoNameCheck,
  type GhOwner,
  type GhRepo,
  type GhRepoNameCheck,
} from "../lib/github";
import { useGithubStore } from "../store/githubStore";
import { useProjectStore } from "../store/projectStore";
import "./ProjectDialog.css";

type Mode = "create" | "open";
type OpenSource = "local" | "github";

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
  const cloneFromGithub = useProjectStore((s) => s.cloneFromGithub);
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

  // Open-from-GitHub state.
  const [openSource, setOpenSource] = useState<OpenSource>("local");
  const [owners, setOwners] = useState<GhOwner[]>([]);
  const [ownersLoading, setOwnersLoading] = useState(false);
  const [selectedOwner, setSelectedOwner] = useState<GhOwner | null>(null);
  const [ownerMenuOpen, setOwnerMenuOpen] = useState(false);
  const ownerMenuRef = useRef<HTMLDivElement>(null);
  const [repoQuery, setRepoQuery] = useState("");
  const [repos, setRepos] = useState<GhRepo[]>([]);
  const [reposLoading, setReposLoading] = useState(false);
  const [reposError, setReposError] = useState<string | null>(null);
  const [cloneParent, setCloneParent] = useState("");
  const [cloningFullName, setCloningFullName] = useState<string | null>(null);

  // Refresh gh auth when the dialog opens.
  useEffect(() => {
    void refreshGithub();
  }, [refreshGithub]);

  // Resolve default clone destination once when opening from GitHub.
  useEffect(() => {
    if (mode !== "open" || openSource !== "github" || cloneParent) return;
    let cancelled = false;
    void (async () => {
      try {
        const parent = await defaultCloneParent();
        if (!cancelled) setCloneParent(parent);
      } catch {
        // Leave empty; user can still pick a folder.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [mode, openSource, cloneParent]);

  // Load owners when switching to GitHub and auth is ready.
  useEffect(() => {
    if (mode !== "open" || openSource !== "github" || !ghAuthenticated) {
      return;
    }
    let cancelled = false;
    setOwnersLoading(true);
    void (async () => {
      try {
        const list = await ghListOwners();
        if (cancelled) return;
        setOwners(list);
        setSelectedOwner((prev) => {
          if (prev && list.some((o) => o.login === prev.login)) return prev;
          return list[0] ?? null;
        });
        setOwnersLoading(false);
      } catch (e) {
        if (!cancelled) {
          setOwners([]);
          setSelectedOwner(null);
          setOwnersLoading(false);
          setError(String(e));
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [mode, openSource, ghAuthenticated]);

  // Debounced repo list / search for the selected owner.
  useEffect(() => {
    if (mode !== "open" || openSource !== "github" || !selectedOwner) {
      setRepos([]);
      setReposError(null);
      setReposLoading(false);
      return;
    }
    let cancelled = false;
    setReposLoading(true);
    setReposError(null);
    const timer = window.setTimeout(() => {
      void (async () => {
        try {
          const list = await ghListRepos(
            selectedOwner.login,
            repoQuery,
            5,
            selectedOwner.kind,
          );
          if (!cancelled) {
            setRepos(list);
            setReposLoading(false);
          }
        } catch (e) {
          if (!cancelled) {
            setRepos([]);
            setReposError(String(e));
            setReposLoading(false);
          }
        }
      })();
    }, repoQuery.trim() ? 350 : 0);

    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [mode, openSource, selectedOwner, repoQuery]);

  // Close owner dropdown on outside click / Escape.
  useEffect(() => {
    if (!ownerMenuOpen) return;
    const onPointer = (e: MouseEvent) => {
      if (!ownerMenuRef.current?.contains(e.target as Node)) {
        setOwnerMenuOpen(false);
      }
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOwnerMenuOpen(false);
    };
    window.addEventListener("mousedown", onPointer);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("mousedown", onPointer);
      window.removeEventListener("keydown", onKey);
    };
  }, [ownerMenuOpen]);

  // Close on Escape (unless owner menu is open — handled above).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !ownerMenuOpen) onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose, ownerMenuOpen]);

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

  const showLocalOpen = mode === "open" && openSource === "local";
  const showGithubOpen = mode === "open" && openSource === "github";

  // Show create-on-GitHub for new projects, or existing projects without a
  // GitHub remote (once a folder is chosen and git is present / will be inited).
  const showCreateGithub =
    mode === "create" ||
    (showLocalOpen &&
      folder !== "" &&
      hasGithubRemote === false &&
      (isRepo === true || initGit));

  const githubBlocked =
    createGithub &&
    (nameChecking ||
      !ghAuthenticated ||
      (effectiveName !== "" && nameCheck !== null && !nameCheck.available));

  const canSubmit =
    mode === "create"
      ? Boolean(folder && name.trim()) && !githubBlocked
      : showLocalOpen
        ? Boolean(folder) && (isRepo === true || initGit) && !githubBlocked
        : false;

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

  async function chooseCloneParent() {
    setError(null);
    const picked = await pickFolder("Clone into folder");
    if (picked) setCloneParent(picked);
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

  async function cloneRepo(repo: GhRepo) {
    if (busy || cloningFullName) return;
    if (!cloneParent) {
      setError("Choose a folder to clone into");
      return;
    }
    setCloningFullName(repo.fullName);
    setBusy(true);
    setError(null);
    try {
      await cloneFromGithub(repo.fullName, cloneParent, repo.name);
      onClose();
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
      setCloningFullName(null);
    }
  }

  return (
    <div className="dialog-overlay" onMouseDown={onClose}>
      <div
        className={`dialog${showGithubOpen ? " dialog-wide" : ""}`}
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="dialog-header">{title}</div>

        <div className={`dialog-body${showGithubOpen ? " dialog-body-scroll" : ""}`}>
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
              <div className="source-tabs" role="tablist">
                <button
                  type="button"
                  role="tab"
                  aria-selected={openSource === "local"}
                  className={`source-tab${openSource === "local" ? " active" : ""}`}
                  onClick={() => {
                    setOpenSource("local");
                    setError(null);
                  }}
                >
                  <IconFolder size={14} stroke={1.75} />
                  Local folder
                </button>
                <button
                  type="button"
                  role="tab"
                  aria-selected={openSource === "github"}
                  className={`source-tab${openSource === "github" ? " active" : ""}`}
                  onClick={() => {
                    setOpenSource("github");
                    setError(null);
                  }}
                >
                  <IconBrandGithub size={14} stroke={1.75} />
                  From GitHub
                </button>
              </div>

              {showLocalOpen && (
                <>
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

              {showGithubOpen && (
                <>
                  {ghChecking ? (
                    <span className="github-check muted">
                      <IconLoader2 size={14} stroke={1.75} className="spin" />
                      Checking GitHub connection…
                    </span>
                  ) : !ghAuthenticated ? (
                    <div className="git-status warn">
                      <div className="git-status-line">
                        <IconBrandGithub size={15} stroke={1.75} />
                        <span>Connect GitHub via Connect App first</span>
                      </div>
                    </div>
                  ) : (
                    <>
                      <div className="field">
                        <label>Account / organization</label>
                        <div className="owner-picker" ref={ownerMenuRef}>
                          <button
                            type="button"
                            className="owner-picker-trigger"
                            disabled={ownersLoading || owners.length === 0}
                            aria-haspopup="listbox"
                            aria-expanded={ownerMenuOpen}
                            onClick={() => setOwnerMenuOpen((v) => !v)}
                          >
                            {selectedOwner ? (
                              <>
                                <img
                                  className="owner-avatar"
                                  src={selectedOwner.avatarUrl}
                                  alt=""
                                  width={20}
                                  height={20}
                                />
                                <span className="owner-picker-label">
                                  @{selectedOwner.login}
                                  {selectedOwner.kind === "org" ? (
                                    <em>Organization</em>
                                  ) : (
                                    <em>You</em>
                                  )}
                                </span>
                              </>
                            ) : (
                              <span className="owner-picker-label muted-label">
                                {ownersLoading ? "Loading…" : "No accounts"}
                              </span>
                            )}
                            {ownersLoading ? (
                              <IconLoader2 size={14} stroke={1.75} className="spin" />
                            ) : (
                              <IconChevronDown size={14} stroke={2} />
                            )}
                          </button>
                          {ownerMenuOpen && owners.length > 0 && (
                            <div className="owner-picker-menu" role="listbox">
                              {owners.map((owner) => {
                                const active = selectedOwner?.login === owner.login;
                                return (
                                  <button
                                    key={owner.login}
                                    type="button"
                                    role="option"
                                    aria-selected={active}
                                    className={`owner-picker-option${active ? " active" : ""}`}
                                    onClick={() => {
                                      setSelectedOwner(owner);
                                      setOwnerMenuOpen(false);
                                      setRepoQuery("");
                                    }}
                                  >
                                    <img
                                      className="owner-avatar"
                                      src={owner.avatarUrl}
                                      alt=""
                                      width={22}
                                      height={22}
                                    />
                                    <span className="owner-option-text">
                                      <span>@{owner.login}</span>
                                      <em>
                                        {owner.kind === "org"
                                          ? "Organization"
                                          : "Personal"}
                                      </em>
                                    </span>
                                  </button>
                                );
                              })}
                            </div>
                          )}
                        </div>
                      </div>

                      <div className="field">
                        <label>Search repositories</label>
                        <div className="repo-search">
                          <IconSearch size={15} stroke={1.75} />
                          <input
                            placeholder="Filter by name…"
                            value={repoQuery}
                            onChange={(e) => setRepoQuery(e.target.value)}
                            disabled={!selectedOwner}
                          />
                        </div>
                      </div>

                      <div className="repo-list-section">
                        <div className="env-section-label">
                          {repoQuery.trim()
                            ? "Matching repositories"
                            : "Recent repositories"}
                        </div>
                        <div className="repo-list">
                          {reposLoading ? (
                            <div className="repo-empty">
                              <IconLoader2 size={14} stroke={1.75} className="spin" />
                              Loading repositories…
                            </div>
                          ) : reposError ? (
                            <div className="repo-empty warn-text">{reposError}</div>
                          ) : repos.length === 0 ? (
                            <div className="repo-empty">
                              {repoQuery.trim()
                                ? "No repositories match that search"
                                : "No repositories found"}
                            </div>
                          ) : (
                            repos.map((repo) => {
                              const cloning = cloningFullName === repo.fullName;
                              return (
                                <button
                                  key={repo.fullName}
                                  type="button"
                                  className="repo-row"
                                  disabled={busy}
                                  onClick={() => void cloneRepo(repo)}
                                  title={`Clone ${repo.fullName}`}
                                >
                                  <div className="repo-row-main">
                                    <span className="repo-name">{repo.name}</span>
                                    {repo.private && (
                                      <span title="Private" className="repo-private">
                                        <IconLock size={12} stroke={1.75} />
                                      </span>
                                    )}
                                  </div>
                                  {repo.description && (
                                    <span className="repo-desc">{repo.description}</span>
                                  )}
                                  <span className="repo-meta">
                                    {cloning ? (
                                      <>
                                        <IconLoader2
                                          size={12}
                                          stroke={1.75}
                                          className="spin"
                                        />
                                        Cloning…
                                      </>
                                    ) : (
                                      repo.fullName
                                    )}
                                  </span>
                                </button>
                              );
                            })
                          )}
                        </div>
                      </div>

                      <div className="field">
                        <label>Clone into</label>
                        <div className="folder-picker">
                          <input
                            readOnly
                            placeholder="Default Fold projects folder"
                            value={cloneParent}
                            onClick={chooseCloneParent}
                          />
                          <button
                            className="ghost-btn"
                            type="button"
                            onClick={chooseCloneParent}
                          >
                            Choose…
                          </button>
                        </div>
                        {cloneParent && selectedOwner && (
                          <div className="dialog-preview">
                            Repos clone to{" "}
                            <code>
                              {cloneParent.replace(/[\\/]+$/, "")}/&lt;repo&gt;
                            </code>
                          </div>
                        )}
                      </div>
                    </>
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
          {!showGithubOpen && (
            <button
              className="primary-btn"
              type="button"
              disabled={!canSubmit || busy}
              onClick={submit}
            >
              {busy ? "Working…" : mode === "create" ? "Create" : "Open"}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
