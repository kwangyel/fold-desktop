import { useEffect, useMemo, useState } from "react";
import { IconBrandGithub, IconPlus, IconX } from "@tabler/icons-react";
import {
  EnvTransfer,
  TransferMode,
  pickFiles,
  relativeToRoot,
  scanWorktreeEnv,
} from "../lib/projects";
import { getSetupScript } from "../lib/setup";
import { pickWorktreeName } from "../lib/worktreeNames";
import {
  makeGitHubIssueAttachment,
  makeLinearIssueAttachment,
} from "../lib/attachments";
import { queueNewChatAttachments, syncChatTabsForWorktree } from "../lib/chatTabs";
import type { Attachment } from "../store/chatStore";
import type { GhIssue } from "../lib/github";
import type { LinearIssue } from "../lib/linear";
import { useChatStore } from "../store/chatStore";
import { useCenterViewStore } from "../store/centerViewStore";
import { useGithubStore } from "../store/githubStore";
import { useLinearStore } from "../store/linearStore";
import { useProjectStore } from "../store/projectStore";
import GitHubIssuePicker from "./GitHubIssuePicker";
import LinearIssuePicker from "./LinearIssuePicker";
import LinearLogo from "./icons/LinearLogo";
import "./ProjectDialog.css";

type IssueTab = "github" | "linear";

type Props = {
  projectId: string;
  onClose: () => void;
};

export default function CreateWorktreeDialog({ projectId, onClose }: Props) {
  const project = useProjectStore((s) => s.projects.find((p) => p.id === projectId));
  const addWorktree = useProjectStore((s) => s.addWorktree);

  const existingNames = useMemo(
    () => project?.worktrees.map((w) => w.name) ?? [],
    [project],
  );

  const [name, setName] = useState(() => pickWorktreeName(existingNames));
  const [dirs, setDirs] = useState<string[]>([]);
  const [files, setFiles] = useState<string[]>([]);
  const [symlinkEnvs, setSymlinkEnvs] = useState(false);
  const [selectedDirs, setSelectedDirs] = useState<Set<string>>(new Set());
  const [fileModes, setFileModes] = useState<Record<string, TransferMode>>({});
  const [selectedFiles, setSelectedFiles] = useState<Set<string>>(new Set());
  const [customFiles, setCustomFiles] = useState<string[]>([]);
  const [saveDefaults, setSaveDefaults] = useState(true);
  const [hasSetupScript, setHasSetupScript] = useState(false);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [linearIssue, setLinearIssue] = useState<LinearIssue | null>(null);
  const [githubIssue, setGithubIssue] = useState<GhIssue | null>(null);
  const [issueTab, setIssueTab] = useState<IssueTab>("github");
  const linearConnected = useLinearStore((s) => s.authenticated);
  const githubConnected = useGithubStore((s) => s.authenticated);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  useEffect(() => {
    void useLinearStore.getState().refresh();
    void useGithubStore.getState().refresh();
  }, []);

  // Default the active issue tab to whichever provider is connected.
  useEffect(() => {
    if (githubConnected) setIssueTab("github");
    else if (linearConnected) setIssueTab("linear");
  }, [githubConnected, linearConnected]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
      setError(null);
      try {
        const [scan, setup] = await Promise.all([
          scanWorktreeEnv(projectId),
          getSetupScript(projectId),
        ]);
        if (cancelled) return;
        setDirs(scan.dirs);
        setFiles(scan.files);
        setHasSetupScript(Boolean(setup?.trim()));

        const defaults = scan.defaults;
        const hasDefaults = defaults != null;
        const defaultPaths = new Set(defaults?.transfers.map((t) => t.path) ?? []);
        const modeByPath = new Map(
          defaults?.transfers.map((t) => [t.path, t.mode] as const) ?? [],
        );

        const nextDirs = new Set<string>();
        if (hasDefaults) {
          for (const d of scan.dirs) {
            if (defaults?.symlinkEnvs && defaultPaths.has(d)) nextDirs.add(d);
          }
          setSymlinkEnvs(Boolean(defaults?.symlinkEnvs && scan.dirs.length > 0));
        } else if (scan.dirs.length > 0) {
          for (const d of scan.dirs) nextDirs.add(d);
          setSymlinkEnvs(true);
        } else {
          setSymlinkEnvs(false);
        }
        setSelectedDirs(nextDirs);

        const nextFileModes: Record<string, TransferMode> = {};
        const nextSelectedFiles = new Set<string>();
        for (const f of scan.files) {
          nextFileModes[f] = modeByPath.get(f) ?? "copy";
          if (defaultPaths.has(f)) nextSelectedFiles.add(f);
        }
        setFileModes(nextFileModes);
        setSelectedFiles(nextSelectedFiles);

        const known = new Set([...scan.dirs, ...scan.files]);
        const customs =
          defaults?.transfers
            .filter((t) => t.mode === "copy" && !known.has(t.path))
            .map((t) => t.path) ?? [];
        setCustomFiles(customs);
      } catch (e) {
        if (!cancelled) setError(String(e));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [projectId]);

  const canSubmit = Boolean(name.trim()) && !busy && !loading;

  function toggleDir(path: string) {
    setSelectedDirs((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  }

  function toggleFile(path: string) {
    setSelectedFiles((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  }

  function setFileMode(path: string, mode: TransferMode) {
    setFileModes((prev) => ({ ...prev, [path]: mode }));
  }

  function removeCustom(path: string) {
    setCustomFiles((prev) => prev.filter((p) => p !== path));
  }

  async function addCustomFiles() {
    if (!project) return;
    setError(null);
    const picked = await pickFiles("Copy into worktree", project.path);
    if (picked.length === 0) return;
    const rels: string[] = [];
    for (const abs of picked) {
      const rel = relativeToRoot(project.path, abs);
      if (!rel) {
        setError(`File must be inside the project: ${abs}`);
        return;
      }
      rels.push(rel);
    }
    setCustomFiles((prev) => {
      const next = [...prev];
      for (const rel of rels) {
        if (!next.includes(rel) && !dirs.includes(rel) && !files.includes(rel)) {
          next.push(rel);
        }
      }
      return next;
    });
  }

  function buildTransfers(): EnvTransfer[] {
    const transfers: EnvTransfer[] = [];
    if (symlinkEnvs) {
      for (const d of selectedDirs) {
        transfers.push({ path: d, mode: "symlink" });
      }
    }
    for (const f of selectedFiles) {
      transfers.push({ path: f, mode: fileModes[f] ?? "copy" });
    }
    for (const c of customFiles) {
      transfers.push({ path: c, mode: "copy" });
    }
    return transfers;
  }

  async function submit() {
    if (!canSubmit) return;
    setBusy(true);
    setError(null);
    try {
      await addWorktree(projectId, name.trim(), {
        transfers: buildTransfers(),
        symlinkEnvs,
        saveDefaults,
      });
      const attachments: Attachment[] = [];
      if (githubIssue) {
        attachments.push(await makeGitHubIssueAttachment(githubIssue));
      }
      if (linearIssue) {
        attachments.push(await makeLinearIssueAttachment(linearIssue));
      }
      if (attachments.length > 0) {
        const path = useProjectStore.getState().activePath;
        if (path) {
          queueNewChatAttachments(path, attachments);
          await syncChatTabsForWorktree(path);
          const tab = useCenterViewStore
            .getState()
            .tabs.find((t) => t.type === "chat" && t.worktreePath === path);
          if (tab) {
            for (const attachment of attachments) {
              const existing = useChatStore.getState().tabs[tab.id];
              const already = existing?.attachments.some(
                (a) => a.name === attachment.name && a.path === attachment.path,
              );
              if (!already) {
                useChatStore.getState().addAttachment(tab.id, attachment);
              }
            }
            await useChatStore.getState().sendPrompt(tab.id, "");
          }
        }
      }
      onClose();
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }

  if (!project) return null;

  return (
    <div className="dialog-overlay" onMouseDown={onClose}>
      <div
        className="dialog dialog-wide"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="dialog-header">New worktree</div>

        <div className="dialog-body dialog-body-scroll">
          {(githubConnected || linearConnected) && (
            <div className="field">
              <label>Attach issue</label>
              {githubConnected && linearConnected && (
                <div className="source-tabs">
                  <button
                    type="button"
                    className={`source-tab ${issueTab === "github" ? "active" : ""}`}
                    onClick={() => setIssueTab("github")}
                  >
                    <IconBrandGithub size={14} stroke={1.75} />
                    GitHub
                  </button>
                  <button
                    type="button"
                    className={`source-tab ${issueTab === "linear" ? "active" : ""}`}
                    onClick={() => setIssueTab("linear")}
                  >
                    <LinearLogo size={14} />
                    Linear
                  </button>
                </div>
              )}
              {githubConnected && (issueTab === "github" || !linearConnected) && (
                <GitHubIssuePicker
                  repoPath={project.path}
                  selected={githubIssue}
                  onSelect={setGithubIssue}
                />
              )}
              {linearConnected && (issueTab === "linear" || !githubConnected) && (
                <LinearIssuePicker
                  selected={linearIssue}
                  onSelect={setLinearIssue}
                />
              )}
            </div>
          )}

          <div className="field">
            <label>Worktree name</label>
            <input
              autoFocus
              placeholder="amsterdam"
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
          </div>

          {loading ? (
            <div className="dialog-preview">Scanning environment files…</div>
          ) : (
            <>
              <div className="env-section">
                <label className="checkbox-row">
                  <input
                    type="checkbox"
                    checked={symlinkEnvs}
                    disabled={dirs.length === 0}
                    onChange={(e) => setSymlinkEnvs(e.target.checked)}
                  />
                  <span>Symlink environments</span>
                </label>
                {dirs.length === 0 ? (
                  <div className="env-empty">No gitignored env folders found in main.</div>
                ) : (
                  <div className={`env-list ${symlinkEnvs ? "" : "disabled"}`}>
                    {dirs.map((d) => (
                      <label key={d} className="checkbox-row env-row">
                        <input
                          type="checkbox"
                          checked={selectedDirs.has(d)}
                          disabled={!symlinkEnvs}
                          onChange={() => toggleDir(d)}
                        />
                        <span className="env-path">{d}</span>
                        <em>symlink</em>
                      </label>
                    ))}
                  </div>
                )}
              </div>

              <div className="env-section">
                <div className="env-section-label">Environment files</div>
                {files.length === 0 ? (
                  <div className="env-empty">No gitignored .env files found in main.</div>
                ) : (
                  <div className="env-list">
                    {files.map((f) => (
                      <div key={f} className="env-row env-file-row">
                        <label className="checkbox-row">
                          <input
                            type="checkbox"
                            checked={selectedFiles.has(f)}
                            onChange={() => toggleFile(f)}
                          />
                          <span className="env-path">{f}</span>
                        </label>
                        <select
                          className="env-mode"
                          value={fileModes[f] ?? "copy"}
                          disabled={!selectedFiles.has(f)}
                          onChange={(e) =>
                            setFileMode(f, e.target.value as TransferMode)
                          }
                        >
                          <option value="copy">Copy</option>
                          <option value="symlink">Symlink</option>
                        </select>
                      </div>
                    ))}
                  </div>
                )}
              </div>

              <div className="env-section">
                <div className="env-section-label">Additional files to copy</div>
                {customFiles.length > 0 && (
                  <div className="env-list">
                    {customFiles.map((c) => (
                      <div key={c} className="env-row env-file-row">
                        <span className="env-path">{c}</span>
                        <button
                          type="button"
                          className="icon-btn"
                          title="Remove"
                          onClick={() => removeCustom(c)}
                        >
                          <IconX size={14} stroke={2} />
                        </button>
                      </div>
                    ))}
                  </div>
                )}
                <button
                  type="button"
                  className="ghost-btn env-add-btn"
                  onClick={() => void addCustomFiles()}
                >
                  <IconPlus size={14} stroke={2} />
                  Add files from main…
                </button>
              </div>

              <label className="checkbox-row">
                <input
                  type="checkbox"
                  checked={saveDefaults}
                  onChange={(e) => setSaveDefaults(e.target.checked)}
                />
                <span>Remember for future worktrees</span>
              </label>

              <div className="env-section">
                <div className="env-section-label">Setup script</div>
                <div className="env-empty">
                  {hasSetupScript
                    ? "Setup script will run after create."
                    : "No setup script — configure in project settings (right-click project → Setup script…)."}
                </div>
              </div>
            </>
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
            disabled={!canSubmit}
            onClick={() => void submit()}
          >
            {busy ? "Creating…" : "Create"}
          </button>
        </div>
      </div>
    </div>
  );
}
