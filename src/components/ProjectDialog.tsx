import { useEffect, useState } from "react";
import { IconFolder, IconGitBranch, IconAlertTriangle } from "@tabler/icons-react";
import { isGitRepo, pickFolder } from "../lib/projects";
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

  const [name, setName] = useState("");
  const [folder, setFolder] = useState("");
  const [createGithub, setCreateGithub] = useState(false);
  const [initGit, setInitGit] = useState(false);
  // null = not checked yet (open mode, no folder chosen).
  const [isRepo, setIsRepo] = useState<boolean | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Close on Escape.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const title = mode === "create" ? "Create Project" : "Open Existing Project";
  const preview =
    mode === "create" && folder && name.trim()
      ? `${folder.replace(/[\\/]+$/, "")}/${name.trim()}`
      : "";

  const canSubmit =
    mode === "create"
      ? Boolean(folder && name.trim())
      : Boolean(folder) && (isRepo === true || initGit);

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
  }

  async function submit() {
    if (!canSubmit || busy) return;
    setBusy(true);
    setError(null);
    try {
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
                          onChange={(e) => setInitGit(e.target.checked)}
                        />
                        <span>Initialize a git repository here</span>
                      </label>
                    </div>
                  )}
                </>
              )}
            </>
          )}

          <label className="checkbox-row">
            <input
              type="checkbox"
              checked={createGithub}
              onChange={(e) => setCreateGithub(e.target.checked)}
            />
            <span>
              Also create on GitHub <em>(coming soon)</em>
            </span>
          </label>

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
