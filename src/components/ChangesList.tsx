import { useEffect, useRef, useState } from "react";
import { ChangedFile, discardFile } from "../lib/git";
import { generateCommitMessage } from "../lib/generateCommitMessage";
import { openDiffForPath } from "../lib/diffActions";
import { useChangesStore } from "../store/changesStore";
import { useCenterViewStore } from "../store/centerViewStore";
import "./ChangesList.css";

const STATUS_LABELS: Record<ChangedFile["status"], string> = {
  modified: "M",
  added: "A",
  deleted: "D",
};

export default function ChangesList() {
  const changes = useChangesStore((state) => state.changes);
  const loading = useChangesStore((state) => state.loading);
  const error = useChangesStore((state) => state.error);
  const readPaths = useChangesStore((state) => state.readPaths);
  const commitMessage = useChangesStore((state) => state.commitMessage);
  const committing = useChangesStore((state) => state.committing);
  const generatingMessage = useChangesStore((state) => state.generatingMessage);
  const refresh = useChangesStore((state) => state.refresh);
  const toggleRead = useChangesStore((state) => state.toggleRead);
  const setCommitMessage = useChangesStore((state) => state.setCommitMessage);
  const setGeneratingMessage = useChangesStore(
    (state) => state.setGeneratingMessage,
  );
  const stageFile = useChangesStore((state) => state.stageFile);
  const unstageFile = useChangesStore((state) => state.unstageFile);
  const stageAll = useChangesStore((state) => state.stageAll);
  const unstageAll = useChangesStore((state) => state.unstageAll);
  const commit = useChangesStore((state) => state.commit);
  const commitAndPush = useChangesStore((state) => state.commitAndPush);

  const [menuOpen, setMenuOpen] = useState(false);
  const messageRef = useRef<HTMLTextAreaElement>(null);

  const activeTabId = useCenterViewStore((state) => state.activeTabId);
  const tabs = useCenterViewStore((state) => state.tabs);
  const closeDiffTab = useCenterViewStore((state) => state.closeDiffTab);
  const activeDiffPath = tabs.find(
    (tab) => tab.id === activeTabId && tab.type === "diff",
  )?.filePath;

  const staged = changes.filter((c) => c.staged);
  const unstaged = changes.filter((c) => !c.staged);
  const canCommit =
    staged.length > 0 && commitMessage.trim().length > 0 && !committing;

  useEffect(() => {
    refresh();
  }, [refresh]);

  useEffect(() => {
    const el = messageRef.current;
    if (!el) return;
    el.style.height = "0px";
    el.style.height = `${Math.min(el.scrollHeight, 72)}px`;
  }, [commitMessage]);

  useEffect(() => {
    if (!menuOpen) return;
    const close = () => setMenuOpen(false);
    window.addEventListener("click", close);
    return () => window.removeEventListener("click", close);
  }, [menuOpen]);

  const handleSelect = (file: ChangedFile) => {
    void openDiffForPath(file.path);
  };

  const handleDiscard = async (e: React.MouseEvent, file: ChangedFile) => {
    e.stopPropagation();
    const ok = window.confirm(
      `Discard changes to ${file.path}? This cannot be undone.`,
    );
    if (!ok) return;
    try {
      await discardFile(file.path, file.isUntracked);
    } catch (err) {
      window.alert(`Failed to discard: ${err}`);
      return;
    }
    if (activeDiffPath === file.path) closeDiffTab();
    await refresh();
  };

  const handleGenerate = async () => {
    setGeneratingMessage(true);
    try {
      const message = await generateCommitMessage();
      setCommitMessage(message);
    } catch (err) {
      useChangesStore.setState({ error: String(err) });
    } finally {
      setGeneratingMessage(false);
    }
  };

  const renderRow = (file: ChangedFile) => {
    const isRead = readPaths.has(file.path);
    const rowKey = `${file.staged ? "s" : "u"}:${file.path}`;
    return (
      <div
        key={rowKey}
        className={`change-row ${activeDiffPath === file.path ? "selected" : ""} ${
          isRead ? "read" : ""
        }`}
        onClick={() => handleSelect(file)}
      >
        <span className={`change-status status-${file.status}`}>
          {STATUS_LABELS[file.status]}
        </span>
        <span className="change-path" title={file.path}>
          {file.path}
        </span>
        <span className="change-stats">
          {file.additions > 0 && (
            <span className="stat-add">+{file.additions}</span>
          )}
          {file.deletions > 0 && (
            <span className="stat-del">-{file.deletions}</span>
          )}
        </span>
        <div className="change-actions">
          {file.staged ? (
            <button
              className="change-action"
              title="Unstage"
              onClick={(e) => {
                e.stopPropagation();
                void unstageFile(file.path);
              }}
            >
              −
            </button>
          ) : (
            <button
              className="change-action"
              title="Stage"
              onClick={(e) => {
                e.stopPropagation();
                void stageFile(file.path);
              }}
            >
              +
            </button>
          )}
          <button
            className="change-action"
            title={isRead ? "Mark as unread" : "Mark as read"}
            onClick={(e) => {
              e.stopPropagation();
              toggleRead(file.path);
            }}
          >
            {isRead ? "○" : "●"}
          </button>
          {!file.staged && (
            <button
              className="change-action discard"
              title="Discard changes"
              onClick={(e) => void handleDiscard(e, file)}
            >
              ↺
            </button>
          )}
        </div>
      </div>
    );
  };

  return (
    <div className="changes-list">
      <div className="commit-box">
        <div className="commit-message-row">
          <textarea
            ref={messageRef}
            className="commit-message"
            placeholder="Message"
            value={commitMessage}
            rows={1}
            onChange={(e) => setCommitMessage(e.target.value)}
            disabled={committing}
          />
          <button
            className="commit-star"
            title="Generate Commit Message"
            disabled={generatingMessage || committing || staged.length === 0}
            onClick={() => void handleGenerate()}
          >
            {generatingMessage ? "…" : "★"}
          </button>
        </div>
        <div className="commit-actions">
          <div className="commit-split">
            <button
              className="commit-main"
              disabled={!canCommit}
              onClick={() => void commit()}
            >
              {committing ? "Committing…" : "Commit"}
            </button>
            <button
              className="commit-arrow"
              disabled={!canCommit}
              aria-label="Commit options"
              onClick={(e) => {
                e.stopPropagation();
                setMenuOpen((v) => !v);
              }}
            >
              ▾
            </button>
          </div>
          {menuOpen && canCommit && (
            <div className="commit-dropdown">
              <button
                className="commit-dropdown-item"
                onClick={(e) => {
                  e.stopPropagation();
                  setMenuOpen(false);
                  void commitAndPush();
                }}
              >
                Commit & Push
              </button>
            </div>
          )}
        </div>
      </div>

      {error && <div className="changes-error">{error}</div>}

      {staged.length > 0 && (
        <div className="changes-section">
          <div className="changes-header">
            <span className="changes-count">
              Staged Changes · {staged.length}
            </span>
            <div className="changes-header-actions">
              <button
                className="changes-refresh"
                onClick={() => void unstageAll()}
                title="Unstage All Changes"
              >
                −
              </button>
            </div>
          </div>
          {staged.map(renderRow)}
        </div>
      )}

      <div className="changes-section">
        <div className="changes-header">
          <span className="changes-count">
            {loading
              ? "Loading…"
              : unstaged.length === 0 && staged.length === 0
                ? "No changes"
                : `Changes · ${unstaged.length}`}
          </span>
          <div className="changes-header-actions">
            {unstaged.length > 0 && (
              <button
                className="changes-refresh"
                onClick={() => void stageAll()}
                title="Stage All Changes"
              >
                +
              </button>
            )}
            <button
              className="changes-refresh"
              onClick={() => void refresh()}
              title="Refresh"
            >
              ⟳
            </button>
          </div>
        </div>
        {!loading && unstaged.length === 0 && staged.length === 0 && !error && (
          <div className="changes-empty">No changes</div>
        )}
        {unstaged.map(renderRow)}
      </div>
    </div>
  );
}
