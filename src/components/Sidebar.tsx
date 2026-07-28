import { useState } from "react";

type Project = {
  id: string;
  name: string;
  branch: string;
  status: "running" | "idle" | "warn";
};

const MOCK_PROJECTS: Project[] = [
  { id: "1", name: "fold-desktop", branch: "edinburgh · 2m ago", status: "running" },
  { id: "2", name: "web-dashboard", branch: "main · 14m ago", status: "idle" },
  { id: "3", name: "api-gateway", branch: "feat/auth · 1h ago", status: "warn" },
  { id: "4", name: "docs-site", branch: "main · yesterday", status: "idle" },
  { id: "5", name: "cli-tools", branch: "refactor · 3d ago", status: "idle" },
];

export default function Sidebar() {
  const [selected, setSelected] = useState("1");

  return (
    <aside className="sidebar">
      <div className="new-project">
        <div className="section-header">
          <span>New Project</span>
        </div>
        <div className="field">
          <label>Repository path</label>
          <input placeholder="/path/to/repo" />
        </div>
        <div className="field">
          <label>Project name</label>
          <input placeholder="my-project" />
        </div>
        <button className="primary-btn">Create Project</button>
      </div>

      <div className="projects">
        <div className="section-header">
          <span>Projects</span>
          <button className="icon-btn" title="Add project">+</button>
        </div>
        {MOCK_PROJECTS.map((p) => (
          <div
            key={p.id}
            className={`project-row ${selected === p.id ? "active" : ""}`}
            onClick={() => setSelected(p.id)}
          >
            <span className={`status-dot ${p.status === "idle" ? "idle" : p.status === "warn" ? "warn" : ""}`} />
            <div className="meta">
              <div className="name">{p.name}</div>
              <div className="sub">{p.branch}</div>
            </div>
          </div>
        ))}
      </div>
    </aside>
  );
}
