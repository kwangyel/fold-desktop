import { useRef, useState } from "react";
import MonotoneFileIcon from "./fileIcons/MonotoneFileIcon";
import { resolveFileIconKind } from "./fileIcons/fileIconMap";
import { useCenterViewStore } from "../store/centerViewStore";
import "./FileExplorer.css";

interface FileNode {
  name: string;
  type: "file" | "folder";
  children?: FileNode[];
}

const MOCK_TREE: FileNode[] = [
  {
    name: "src",
    type: "folder",
    children: [
      {
        name: "components",
        type: "folder",
        children: [
          { name: "CenterPane.tsx", type: "file" },
          { name: "ChatInput.tsx", type: "file" },
          { name: "RightPane.tsx", type: "file" },
        ],
      },
      { name: "store", type: "folder", children: [{ name: "chatStore.ts", type: "file" }] },
      { name: "App.tsx", type: "file" },
      { name: "main.tsx", type: "file" },
    ],
  },
  {
    name: "src-tauri",
    type: "folder",
    children: [
      {
        name: "src",
        type: "folder",
        children: [
          { name: "lib.rs", type: "file" },
          { name: "pty.rs", type: "file" },
        ],
      },
      { name: "Cargo.toml", type: "file" },
    ],
  },
  { name: "package.json", type: "file" },
  { name: "README.md", type: "file" },
];

interface FileTreeNodeProps {
  node: FileNode;
  depth?: number;
  path: string;
}

function FileTreeNode({ node, depth = 0, path }: FileTreeNodeProps) {
  const [expanded, setExpanded] = useState(depth < 2);
  const clickTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const openFileTab = useCenterViewStore((state) => state.openFileTab);
  const activeTabId = useCenterViewStore((state) => state.activeTabId);
  const tabs = useCenterViewStore((state) => state.tabs);
  const activeEditorPath = tabs.find((tab) => tab.id === activeTabId && tab.type === "editor")?.filePath;
  const isOpen = tabs.some((tab) => tab.type === "editor" && tab.filePath === path);

  const handleFileClick = () => {
    if (clickTimerRef.current) {
      clearTimeout(clickTimerRef.current);
    }
    clickTimerRef.current = setTimeout(() => {
      openFileTab(path, false);
      clickTimerRef.current = null;
    }, 200);
  };

  const handleFileDoubleClick = () => {
    if (clickTimerRef.current) {
      clearTimeout(clickTimerRef.current);
      clickTimerRef.current = null;
    }
    openFileTab(path, true);
  };

  if (node.type === "file") {
    const iconKind = resolveFileIconKind(node.name);
    return (
      <div
        className={`file-tree-item file ${activeEditorPath === path ? "selected" : ""} ${isOpen && activeEditorPath !== path ? "open" : ""}`}
        style={{ paddingLeft: depth * 14 + 8 }}
        onClick={handleFileClick}
        onDoubleClick={handleFileDoubleClick}
      >
        <MonotoneFileIcon kind={iconKind} className="file-tree-icon" />
        <span className="file-tree-name">{node.name}</span>
      </div>
    );
  }

  const iconKind = resolveFileIconKind(node.name, true, expanded);

  return (
    <div className="file-tree-folder">
      <div
        className="file-tree-item folder"
        style={{ paddingLeft: depth * 14 + 8 }}
        onClick={() => setExpanded(!expanded)}
      >
        <span className="file-tree-chevron">{expanded ? "▾" : "▸"}</span>
        <MonotoneFileIcon kind={iconKind} className="file-tree-icon" />
        <span className="file-tree-name">{node.name}</span>
      </div>
      {expanded &&
        node.children?.map((child) => (
          <FileTreeNode
            key={child.name}
            node={child}
            depth={depth + 1}
            path={`${path}/${child.name}`}
          />
        ))}
    </div>
  );
}

export default function FileExplorer() {
  return (
    <div className="file-explorer">
      {MOCK_TREE.map((node) => (
        <FileTreeNode key={node.name} node={node} path={node.name} />
      ))}
    </div>
  );
}
