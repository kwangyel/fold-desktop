import { useState } from "react";
import MonotoneFileIcon from "./fileIcons/MonotoneFileIcon";
import { resolveFileIconKind } from "./fileIcons/fileIconMap";
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
          { name: "App.tsx", type: "file" },
          { name: "ChatInput.tsx", type: "file" },
          { name: "RightPane.tsx", type: "file" },
        ],
      },
      { name: "store", type: "folder", children: [{ name: "chatStore.ts", type: "file" }] },
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

function FileTreeNode({ node, depth = 0 }: { node: FileNode; depth?: number }) {
  const [expanded, setExpanded] = useState(depth < 2);

  if (node.type === "file") {
    const iconKind = resolveFileIconKind(node.name);
    return (
      <div className="file-tree-item file" style={{ paddingLeft: depth * 14 + 8 }}>
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
          <FileTreeNode key={child.name} node={child} depth={depth + 1} />
        ))}
    </div>
  );
}

export default function FileExplorer() {
  return (
    <div className="file-explorer">
      {MOCK_TREE.map((node) => (
        <FileTreeNode key={node.name} node={node} />
      ))}
    </div>
  );
}
