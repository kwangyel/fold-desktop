import { useEffect } from "react";
import { ChangedFile, discardFile } from "../lib/git";
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
  const refresh = useChangesStore((state) => state.refresh);
  const toggleRead = useChangesStore((state) => state.toggleRead);

  const activeTabId = useCenterViewStore((state) => state.activeTabId);
  const tabs = useCenterViewStore((state) => state.tabs);
  const closeDiffTab = useCenterViewStore((state) => state.closeDiffTab);
  const activeDiffPath = tabs.find(
    (tab) => tab.id === activeTabId && tab.type === "diff",
  )?.filePath;

  useEffect(() => {
    refresh();
  }, [refresh]);

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

  return (
    <div className="changes-list">
      <div className="changes-header">
        <span className="changes-count">
          {loading ? "Loading…" : `${changes.length} changed files`}
        </span>
        <button
          className="changes-refresh"
          onClick={() => void refresh()}
          title="Refresh"
        >
          ⟳
        </button>
      </div>
      {error && <div className="changes-error">{error}</div>}
      {!loading && changes.length === 0 && !error && (
        <div className="changes-empty">No changes</div>
      )}
      {changes.map((file) => {
        const isRead = readPaths.has(file.path);
        return (
          <div
            key={file.path}
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
              <button
                className="change-action discard"
                title="Discard changes"
                onClick={(e) => void handleDiscard(e, file)}
              >
                ↺
              </button>
            </div>
          </div>
        );
      })}
    </div>
  );
}
