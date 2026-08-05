import { useCallback, useRef, useState } from "react";
import FileExplorer from "./FileExplorer";
import ChangesList from "./ChangesList";
import PlansList from "./PlansList";
import TerminalPanel from "./TerminalPanel";
import ResizeHandle from "./ResizeHandle";
import "./RightPane.css";

type TopTab = "explorer" | "changes" | "plans";

const TOP_TABS: { id: TopTab; label: string }[] = [
  { id: "explorer", label: "Explorer" },
  { id: "changes", label: "Changes" },
  { id: "plans", label: "Plans" },
];

type Props = {
  width: number;
  topRatio: number;
  onSplitDrag: (dy: number, paneHeight: number) => void;
};

export default function RightPane({ width, topRatio, onSplitDrag }: Props) {
  const [activeTab, setActiveTab] = useState<TopTab>("explorer");
  const paneRef = useRef<HTMLElement>(null);

  const handleSplitDrag = useCallback(
    (dy: number) => {
      const height = paneRef.current?.clientHeight ?? 0;
      if (height <= 0) return;
      onSplitDrag(dy, height);
    },
    [onSplitDrag],
  );

  return (
    <section className="right" ref={paneRef} style={{ width }}>
      <div className="right-pane-top" style={{ flex: `${topRatio} 1 0` }}>
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
          {activeTab === "plans" && <PlansList />}
        </div>
      </div>

      <ResizeHandle orientation="horizontal" onDrag={handleSplitDrag} />

      <div className="right-pane-bottom" style={{ flex: `${1 - topRatio} 1 0` }}>
        <TerminalPanel />
      </div>
    </section>
  );
}
