import { useState } from "react";
import FileExplorer from "./FileExplorer";
import ChangesList from "./ChangesList";
import DiffView from "./DiffView";
import TerminalPanel from "./TerminalPanel";
import "./RightPane.css";

type TopTab = "explorer" | "changes" | "diff";

const TOP_TABS: { id: TopTab; label: string }[] = [
  { id: "explorer", label: "Explorer" },
  { id: "changes", label: "Changes" },
  { id: "diff", label: "Diff" },
];

export default function RightPane() {
  const [activeTab, setActiveTab] = useState<TopTab>("explorer");

  return (
    <section className="right">
      <div className="right-pane-top">
        <div className="tabbar">
          {TOP_TABS.map((t) => (
            <div
              key={t.id}
              className={`tab ${t.id === activeTab ? "active" : ""}`}
              onClick={() => setActiveTab(t.id)}
            >
              <span>{t.label}</span>
            </div>
          ))}
        </div>
        <div className="right-pane-top-body">
          {activeTab === "explorer" && <FileExplorer />}
          {activeTab === "changes" && <ChangesList />}
          {activeTab === "diff" && <DiffView />}
        </div>
      </div>

      <div className="right-pane-divider" />

      <div className="right-pane-bottom">
        <TerminalPanel />
      </div>
    </section>
  );
}
