import ChatInterface from "./ChatInterface";
import CodeEditor from "./CodeEditor";
import DiffPane from "./DiffPane";
import { useCenterViewStore } from "../store/centerViewStore";
import { useChatStore } from "../store/chatStore";
import "./CodeEditor.css";

export default function CenterPane() {
  const tabs = useCenterViewStore((state) => state.tabs);
  const activeTabId = useCenterViewStore((state) => state.activeTabId);
  const addChatTab = useCenterViewStore((state) => state.addChatTab);
  const closeTab = useCenterViewStore((state) => state.closeTab);
  const setActiveTab = useCenterViewStore((state) => state.setActiveTab);
  const pinTab = useCenterViewStore((state) => state.pinTab);
  const updateTabContent = useCenterViewStore((state) => state.updateTabContent);
  const deleteChatTab = useChatStore((state) => state.deleteTab);

  const activeTab = tabs.find((tab) => tab.id === activeTabId);

  const handleCloseTab = (tabId: string, tabType: string) => {
    if (tabs.length <= 1) return;
    if (tabType === "chat") {
      deleteChatTab(tabId);
    }
    closeTab(tabId);
  };

  const handleTabDoubleClick = (tabId: string, tabType: string, isPreview?: boolean) => {
    if (tabType === "editor" && isPreview) {
      pinTab(tabId);
    }
  };

  const renderTabContent = () => {
    if (!activeTab) return null;

    switch (activeTab.type) {
      case "chat":
        return <ChatInterface tabId={activeTab.id} />;
      case "editor":
        if (!activeTab.filePath || activeTab.fileContent === undefined) return null;
        return (
          <>
            <div className="center-editor-header">
              <span className="file-path">{activeTab.filePath}</span>
              <span className="view-badge">Editor</span>
            </div>
            <CodeEditor
              key={activeTab.id}
              filePath={activeTab.filePath}
              content={activeTab.fileContent}
              onChange={(content) => updateTabContent(activeTab.id, content)}
            />
          </>
        );
      case "diff":
        if (
          !activeTab.filePath ||
          activeTab.diffOriginal === undefined ||
          activeTab.diffModified === undefined
        ) {
          return null;
        }
        return (
          <DiffPane
            key={activeTab.id}
            tabId={activeTab.id}
            filePath={activeTab.filePath}
            original={activeTab.diffOriginal}
            modified={activeTab.diffModified}
          />
        );
      default:
        return null;
    }
  };

  const canCloseTab = (tab: (typeof tabs)[number]) => {
    if (tab.type === "editor" && tab.isPreview) return false;
    return tabs.length > 1;
  };

  return (
    <section className="center">
      <div className="tabbar">
        {tabs.map((tab) => (
          <div
            key={tab.id}
            className={`tab ${tab.id === activeTabId ? "active" : ""} ${tab.isPreview ? "preview" : ""}`}
            onClick={() => setActiveTab(tab.id)}
            onDoubleClick={() => handleTabDoubleClick(tab.id, tab.type, tab.isPreview)}
          >
            <span className="tab-label">{tab.label}</span>
            {canCloseTab(tab) && (
              <span
                className="close"
                onClick={(e) => {
                  e.stopPropagation();
                  handleCloseTab(tab.id, tab.type);
                }}
              >
                ×
              </span>
            )}
          </div>
        ))}
        <div className="tab-add" onClick={addChatTab}>
          +
        </div>
      </div>
      <div className="center-content">{renderTabContent()}</div>
    </section>
  );
}
