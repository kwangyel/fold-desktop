import { useEffect, useRef, useState } from "react";
import MonotoneFileIcon from "./fileIcons/MonotoneFileIcon";
import { resolveFileIconKind } from "./fileIcons/fileIconMap";
import { useCenterViewStore } from "../store/centerViewStore";
import { useProjectStore } from "../store/projectStore";
import { DirEntry, listDir } from "../lib/git";
import "./FileExplorer.css";

interface FileTreeNodeProps {
  entry: DirEntry;
  depth: number;
}

function FileTreeNode({ entry, depth }: FileTreeNodeProps) {
  const [expanded, setExpanded] = useState(false);
  const [children, setChildren] = useState<DirEntry[] | null>(null);
  const clickTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const openFileTab = useCenterViewStore((state) => state.openFileTab);
  const activeTabId = useCenterViewStore((state) => state.activeTabId);
  const tabs = useCenterViewStore((state) => state.tabs);
  const activeEditorPath = tabs.find(
    (tab) => tab.id === activeTabId && tab.type === "editor",
  )?.filePath;
  const isOpen = tabs.some(
    (tab) => tab.type === "editor" && tab.filePath === entry.path,
  );

  const handleFileClick = () => {
    if (clickTimerRef.current) clearTimeout(clickTimerRef.current);
    clickTimerRef.current = setTimeout(() => {
      openFileTab(entry.path, false);
      clickTimerRef.current = null;
    }, 200);
  };

  const handleFileDoubleClick = () => {
    if (clickTimerRef.current) {
      clearTimeout(clickTimerRef.current);
      clickTimerRef.current = null;
    }
    openFileTab(entry.path, true);
  };

  async function toggleFolder() {
    const next = !expanded;
    setExpanded(next);
    if (next && children === null) {
      try {
        setChildren(await listDir(entry.path));
      } catch {
        setChildren([]);
      }
    }
  }

  if (!entry.isDir) {
    const iconKind = resolveFileIconKind(entry.name);
    return (
      <div
        className={`file-tree-item file ${activeEditorPath === entry.path ? "selected" : ""} ${isOpen && activeEditorPath !== entry.path ? "open" : ""}`}
        style={{ paddingLeft: depth * 14 + 8 }}
        onClick={handleFileClick}
        onDoubleClick={handleFileDoubleClick}
      >
        <MonotoneFileIcon kind={iconKind} className="file-tree-icon" />
        <span className="file-tree-name">{entry.name}</span>
      </div>
    );
  }

  const iconKind = resolveFileIconKind(entry.name, true, expanded);

  return (
    <div className="file-tree-folder">
      <div
        className="file-tree-item folder"
        style={{ paddingLeft: depth * 14 + 8 }}
        onClick={toggleFolder}
      >
        <span className="file-tree-chevron">{expanded ? "▾" : "▸"}</span>
        <MonotoneFileIcon kind={iconKind} className="file-tree-icon" />
        <span className="file-tree-name">{entry.name}</span>
      </div>
      {expanded &&
        children?.map((child) => (
          <FileTreeNode key={child.path} entry={child} depth={depth + 1} />
        ))}
    </div>
  );
}

export default function FileExplorer() {
  const activeId = useProjectStore((s) => s.activeId);
  // Reload when the isolated worktree path changes (not only the project id).
  const activePath = useProjectStore((s) => s.activePath);
  const [roots, setRoots] = useState<DirEntry[]>([]);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!activeId || !activePath) {
      setRoots([]);
      return;
    }
    let cancelled = false;
    setLoading(true);
    listDir("")
      .then((entries) => {
        if (!cancelled) setRoots(entries);
      })
      .catch(() => {
        if (!cancelled) setRoots([]);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [activeId, activePath]);

  if (!activeId || !activePath) {
    return (
      <div className="file-explorer">
        <div className="file-explorer-empty">
          {!activeId ? "No project open" : "No worktree selected"}
        </div>
      </div>
    );
  }

  return (
    <div className="file-explorer">
      {loading && roots.length === 0 ? (
        <div className="file-explorer-empty">Loading…</div>
      ) : roots.length === 0 ? (
        <div className="file-explorer-empty">Empty worktree</div>
      ) : (
        roots.map((entry) => (
          <FileTreeNode key={entry.path} entry={entry} depth={0} />
        ))
      )}
    </div>
  );
}
