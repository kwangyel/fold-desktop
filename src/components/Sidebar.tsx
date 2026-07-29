import { useEffect, useState } from "react";
import { IconFolderPlus, IconFolderOpen, IconBrandGithub, IconTrash } from "@tabler/icons-react";
import { useProjectStore } from "../store/projectStore";
import ProjectDialog from "./ProjectDialog";

type DialogMode = "create" | "open" | null;
type ContextMenu = { id: string; name: string; x: number; y: number };

export default function Sidebar() {
  const projects = useProjectStore((s) => s.projects);
  const activeId = useProjectStore((s) => s.activeId);
  const load = useProjectStore((s) => s.load);
  const select = useProjectStore((s) => s.select);
  const remove = useProjectStore((s) => s.remove);

  const [dialog, setDialog] = useState<DialogMode>(null);
  const [menu, setMenu] = useState<ContextMenu | null>(null);

  useEffect(() => {
    load();
  }, [load]);

  // Dismiss the context menu on any outside interaction.
  useEffect(() => {
    if (!menu) return;
    const close = () => setMenu(null);
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setMenu(null);
    };
    window.addEventListener("click", close);
    window.addEventListener("scroll", close, true);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("click", close);
      window.removeEventListener("scroll", close, true);
      window.removeEventListener("keydown", onKey);
    };
  }, [menu]);

  return (
    <aside className="sidebar">
      <div className="new-project">
        <div className="section-header">
          <span>Projects</span>
        </div>
        <div className="project-actions">
          <button className="primary-btn" onClick={() => setDialog("create")}>
            <IconFolderPlus size={15} stroke={2} />
            Create Project
          </button>
          <button className="ghost-btn full" onClick={() => setDialog("open")}>
            <IconFolderOpen size={15} stroke={2} />
            Open Existing
          </button>
        </div>
      </div>

      <div className="projects">
        {projects.length === 0 ? (
          <div className="projects-empty">
            No projects yet. Create or open one to get started.
          </div>
        ) : (
          projects.map((p) => (
            <div
              key={p.id}
              className={`project-row ${activeId === p.id ? "active" : ""}`}
              onClick={() => select(p.id)}
              onContextMenu={(e) => {
                e.preventDefault();
                setMenu({ id: p.id, name: p.name, x: e.clientX, y: e.clientY });
              }}
              title={p.path}
            >
              <span className={`status-dot ${activeId === p.id ? "" : "idle"}`} />
              <div className="meta">
                <div className="name">{p.name}</div>
                <div className="sub">{p.path}</div>
              </div>
              {p.createdOnGithub && (
                <IconBrandGithub
                  size={14}
                  className="gh-badge"
                  title="Marked for GitHub"
                />
              )}
            </div>
          ))
        )}
      </div>

      {menu && (
        <div
          className="context-menu"
          style={{ top: menu.y, left: menu.x }}
          onClick={(e) => e.stopPropagation()}
        >
          <button
            className="context-menu-item danger"
            onClick={() => {
              remove(menu.id);
              setMenu(null);
            }}
          >
            <IconTrash size={14} stroke={1.75} />
            Remove from list
          </button>
        </div>
      )}

      {dialog && (
        <ProjectDialog mode={dialog} onClose={() => setDialog(null)} />
      )}
    </aside>
  );
}
