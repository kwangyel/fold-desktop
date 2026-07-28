import { useState } from "react";
import ChatInterface from "./ChatInterface";

type TabType = "chat" | "editor" | "project";

type Tab = {
  id: string;
  label: string;
  type: TabType;
};

const INITIAL_TABS: Tab[] = [
  {
    id: "chat-1",
    label: "Chat",
    type: "chat",
  },
];

export default function CenterPane() {
  const [tabs, setTabs] = useState<Tab[]>(INITIAL_TABS);
  const [active, setActive] = useState(0);

  const handleAddTab = () => {
    const newId = `chat-${Date.now()}`;
    const newTab: Tab = {
      id: newId,
      label: "Chat",
      type: "chat",
    };
    setTabs([...tabs, newTab]);
    setActive(tabs.length);
  };

  const handleCloseTab = (index: number) => {
    const newTabs = tabs.filter((_, i) => i !== index);
    if (newTabs.length === 0) return;

    setTabs(newTabs);
    if (active >= newTabs.length) {
      setActive(newTabs.length - 1);
    }
  };

  const activeTab = tabs[active];

  const getTabLabel = (tab: Tab): string => {
    switch (tab.type) {
      case "chat":
        return "Chat";
      case "editor":
        return tab.label;
      case "project":
        return tab.label;
      default:
        return tab.label;
    }
  };

  const renderTabContent = () => {
    if (!activeTab) return null;

    switch (activeTab.type) {
      case "chat":
        return <ChatInterface tabId={activeTab.id} />;
      case "editor":
        return (
          <div className="pane-body">
            CodeMirror 6 editor will mount here ({activeTab.label})
          </div>
        );
      case "project":
        return (
          <div className="pane-body">
            Project view will mount here ({activeTab.label})
          </div>
        );
      default:
        return <div className="pane-body">Unknown tab type</div>;
    }
  };

  return (
    <section className="center">
      <div className="tabbar">
        {tabs.map((tab, i) => (
          <div
            key={tab.id}
            className={`tab ${i === active ? "active" : ""}`}
            onClick={() => setActive(i)}
          >
            <span>{getTabLabel(tab)}</span>
            <span className="close" onClick={(e) => {
              e.stopPropagation();
              handleCloseTab(i);
            }}>×</span>
          </div>
        ))}
        <div className="tab-add" onClick={handleAddTab}>
          +
        </div>
      </div>
      {renderTabContent()}
    </section>
  );
}
