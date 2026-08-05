import { useEffect, useState } from "react";
import AssistantMarkdown from "./AssistantMarkdown";
import { useCenterViewStore } from "../store/centerViewStore";
import { useProjectStore } from "../store/projectStore";
import {
  ghPrMerge,
  ghPrMergeMethod,
  invalidatePrCache,
  openExternal,
  type PrInfo,
  type PrMergeMethod,
} from "../lib/github";
import "./PrView.css";

const MERGE_LABEL: Record<PrMergeMethod, string> = {
  squash: "Squash & merge",
  merge: "Merge pull request",
  rebase: "Rebase & merge",
};

export default function PrView({ tabId }: { tabId: string }) {
  const tab = useCenterViewStore((s) => s.tabs.find((t) => t.id === tabId));
  const setPrMerged = useCenterViewStore((s) => s.setPrMerged);

  const activeId = useProjectStore((s) => s.activeId);
  const activeWorktreeId = useProjectStore((s) => {
    const proj = s.projects.find((p) => p.id === s.activeId);
    return proj?.activeWorktreeId ?? null;
  });
  const archiveWorktree = useProjectStore((s) => s.archiveWorktree);

  const [method, setMethod] = useState<PrMergeMethod>("squash");
  const [merging, setMerging] = useState(false);
  const [archiving, setArchiving] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  const worktreePath = tab?.prWorktreePath;

  useEffect(() => {
    if (!worktreePath) return;
    ghPrMergeMethod(worktreePath).then(setMethod).catch(() => {});
  }, [worktreePath]);

  if (!tab) return null;

  if (tab.prLoading) {
    return <div className="pr-view-status">Loading pull request…</div>;
  }

  const info = tab.prInfo;
  if (!info) {
    return (
      <div className="pr-view-status pr-view-error">
        {tab.prError ?? "No pull request found for this branch."}
      </div>
    );
  }

  const merged = info.state === "MERGED";

  const handleMerge = async () => {
    if (!worktreePath) return;
    setMerging(true);
    setActionError(null);
    try {
      await ghPrMerge(worktreePath, method);
      // The cached "open PR for this branch" answer is now stale.
      invalidatePrCache(worktreePath);
      setPrMerged(tabId);
    } catch (e) {
      setActionError(String(e));
    } finally {
      setMerging(false);
    }
  };

  const handleArchive = async () => {
    if (!activeId || !activeWorktreeId) {
      setActionError("No active worktree to archive.");
      return;
    }
    setArchiving(true);
    setActionError(null);
    try {
      await archiveWorktree(activeId, activeWorktreeId);
    } catch (e) {
      setActionError(String(e));
      setArchiving(false);
    }
  };

  return (
    <div className="pr-view">
      <div className="pr-view-topbar">
        <div className="pr-view-title-row">
          <span className={`pr-state-badge pr-state-${info.state.toLowerCase()}`}>
            {info.state.toLowerCase()}
          </span>
          <span className="pr-view-title">
            {info.title} <span className="pr-view-number">#{info.number}</span>
          </span>
        </div>
        <div className="pr-view-actions">
          {merged ? (
            <button
              type="button"
              className="pr-btn pr-btn-archive"
              onClick={handleArchive}
              disabled={archiving}
            >
              {archiving ? "Archiving…" : "Archive worktree"}
            </button>
          ) : (
            <button
              type="button"
              className="pr-btn pr-btn-merge"
              onClick={handleMerge}
              disabled={merging}
            >
              {merging ? "Merging…" : MERGE_LABEL[method]}
            </button>
          )}
        </div>
      </div>

      <div className="pr-view-body">
        {actionError && <div className="pr-view-action-error">{actionError}</div>}

        <div className="pr-view-meta">
          <span className="pr-branch">{info.baseRefName}</span>
          <span className="pr-branch-arrow">←</span>
          <span className="pr-branch">{info.headRefName}</span>
          {info.author && <span className="pr-meta-item">by {info.author.login}</span>}
          <span className="pr-meta-item pr-additions">+{info.additions}</span>
          <span className="pr-meta-item pr-deletions">−{info.deletions}</span>
          <span className="pr-meta-item">{info.changedFiles} files changed</span>
          <button
            type="button"
            className="pr-open-github"
            onClick={() => void openExternal(info.url)}
          >
            Open on GitHub
          </button>
        </div>

        <div className="pr-view-description">
          {info.body.trim() ? (
            <AssistantMarkdown content={info.body} />
          ) : (
            <span className="pr-view-empty">No description provided.</span>
          )}
        </div>

        <ChangedFiles files={info.files} />
      </div>
    </div>
  );
}

function ChangedFiles({ files }: { files: PrInfo["files"] }) {
  if (!files || files.length === 0) return null;
  return (
    <div className="pr-files">
      <div className="pr-files-header">Changed files ({files.length})</div>
      <ul className="pr-files-list">
        {files.map((file) => (
          <li key={file.path} className="pr-file-row">
            <span className="pr-file-path">{file.path}</span>
            <span className="pr-file-counts">
              <span className="pr-additions">+{file.additions}</span>
              <span className="pr-deletions">−{file.deletions}</span>
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}
