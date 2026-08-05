import { lazy, Suspense, useEffect, useRef } from "react";
import ChatInterface from "./ChatInterface";
import CreatePrButton from "./CreatePrButton";
import GlobalQuestionOverlay from "./GlobalQuestionOverlay";
import BackgroundAskWatchers from "./BackgroundAskWatchers";
import { closeActiveTab } from "../lib/closeActiveTab";
import { useCenterViewStore, getLiveEditorContent, setLiveEditorContent } from "../store/centerViewStore";
import { useChatStore } from "../store/chatStore";
import { useProjectStore } from "../store/projectStore";
import { ghPrView } from "../lib/github";
import { gitGithubRemote } from "../lib/git";
import "./CodeEditor.css";

const CodeEditor = lazy(() => import("./CodeEditor"));
const DiffPane = lazy(() => import("./DiffPane"));
const PrView = lazy(() => import("./PrView"));
const PlanView = lazy(() => import("./PlanView"));

export default function CenterPane() {
  const tabs = useCenterViewStore((state) => state.tabs);
  const activeTabId = useCenterViewStore((state) => state.activeTabId);
  const addChatTab = useCenterViewStore((state) => state.addChatTab);
  const closeTab = useCenterViewStore((state) => state.closeTab);
  const setActiveTab = useCenterViewStore((state) => state.setActiveTab);
  const pinTab = useCenterViewStore((state) => state.pinTab);
  const updateTabContent = useCenterViewStore((state) => state.updateTabContent);
  const openPrTab = useCenterViewStore((state) => state.openPrTab);
  const deleteChatTab = useChatStore((state) => state.deleteTab);

  const activePath = useProjectStore((state) => state.activePath);
  // Worktree paths whose PR tab has already been auto-opened, so closing the
  // tab doesn't cause it to pop back up.
  const autoOpened = useRef<Set<string>>(new Set());
  const contentDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const activeTab = tabs.find((tab) => tab.id === activeTabId);

  const handleCloseTab = (tabId: string, tabType: string) => {
    if (tabs.length <= 1) return;
    if (contentDebounceRef.current) {
      clearTimeout(contentDebounceRef.current);
      contentDebounceRef.current = null;
    }
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

  const handleEditorChange = (tabId: string, content: string) => {
    // Keep keystrokes in the live buffer immediately; debounce the Zustand write
    // so CenterPane / explorers aren't re-rendered on every character.
    setLiveEditorContent(tabId, content);
    if (contentDebounceRef.current) clearTimeout(contentDebounceRef.current);
    contentDebounceRef.current = setTimeout(() => {
      contentDebounceRef.current = null;
      updateTabContent(tabId, content);
    }, 200);
  };

  // Flush pending editor writes when leaving an editor tab.
  useEffect(() => {
    return () => {
      if (contentDebounceRef.current) {
        clearTimeout(contentDebounceRef.current);
        contentDebounceRef.current = null;
      }
      if (activeTab?.type === "editor") {
        const live = getLiveEditorContent(activeTab.id);
        if (live !== undefined) {
          updateTabContent(activeTab.id, live);
        }
      }
    };
    // Only flush when the active tab identity changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeTabId]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey) || e.key.toLowerCase() !== "w" || e.shiftKey) return;
      if (closeActiveTab()) {
        e.preventDefault();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // Detect a PR on the active worktree's branch and auto-open the PR tab the
  // first time one is found for this worktree. This covers PRs that already
  // exist on GitHub when the worktree is opened, not just ones created in-app.
  // The remote is detected on the worktree path directly (rather than the
  // persisted project flag) so it stays accurate after a remote is added.
  useEffect(() => {
    if (!activePath) return;
    const path = activePath;
    if (autoOpened.current.has(path)) return;

    let cancelled = false;
    let timer: number | undefined;

    const check = async () => {
      try {
        const info = await ghPrView(path);
        if (cancelled || !info) return;
        if (!autoOpened.current.has(path)) {
          autoOpened.current.add(path);
          openPrTab(path);
        }
        if (timer !== undefined) window.clearInterval(timer);
      } catch {
        // Ignore transient errors; keep polling.
      }
    };

    void gitGithubRemote(path).then((hasRemote) => {
      if (cancelled || !hasRemote) return;
      // Slow poll — CreatePrButton also checks; avoid competing every 5s.
      timer = window.setInterval(check, 30000);
      void check();
    });

    return () => {
      cancelled = true;
      if (timer !== undefined) window.clearInterval(timer);
    };
  }, [activePath, openPrTab]);

  const renderTabContent = () => {
    if (!activeTab) return null;

    switch (activeTab.type) {
      case "chat":
        return <ChatInterface tabId={activeTab.id} />;
      case "editor":
        if (!activeTab.filePath) return null;
        if (activeTab.fileLoading) {
          return (
            <>
              <div className="center-editor-header">
                <span className="file-path">{activeTab.filePath}</span>
                <span className="view-badge">Editor</span>
              </div>
              <div className="center-editor-loading">Loading…</div>
            </>
          );
        }
        if (activeTab.fileContent === undefined) return null;
        const editorContent =
          getLiveEditorContent(activeTab.id) ?? activeTab.fileContent;
        return (
          <>
            <div className="center-editor-header">
              <span className="file-path">{activeTab.filePath}</span>
              <span className="view-badge">Editor</span>
            </div>
            <Suspense fallback={<div className="center-editor-loading">Loading editor…</div>}>
              <CodeEditor
                key={activeTab.id}
                filePath={activeTab.filePath}
                content={editorContent}
                onChange={(content) => handleEditorChange(activeTab.id, content)}
              />
            </Suspense>
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
          <Suspense fallback={<div className="center-editor-loading">Loading diff…</div>}>
            <DiffPane
              key={activeTab.id}
              tabId={activeTab.id}
              filePath={activeTab.filePath}
              original={activeTab.diffOriginal}
              modified={activeTab.diffModified}
            />
          </Suspense>
        );
      case "pr":
        return (
          <Suspense fallback={<div className="center-editor-loading">Loading…</div>}>
            <PrView key={activeTab.id} tabId={activeTab.id} />
          </Suspense>
        );
      case "plan":
        return (
          <Suspense fallback={<div className="center-editor-loading">Loading…</div>}>
            <PlanView key={activeTab.id} tabId={activeTab.id} />
          </Suspense>
        );
      default:
        return null;
    }
  };

  const canCloseTab = () => tabs.length > 1;

  if (!activePath) {
    return <section className="center" />;
  }

  return (
    <section className="center">
      <div className="tabbar">
        <div className="tabbar-tabs">
          {tabs.map((tab) => (
            <div
              key={tab.id}
              className={`tab ${tab.id === activeTabId ? "active" : ""} ${tab.isPreview ? "preview" : ""}`}
              onClick={() => setActiveTab(tab.id)}
              onDoubleClick={() => handleTabDoubleClick(tab.id, tab.type, tab.isPreview)}
            >
              <span className="tab-label">{tab.label}</span>
              {canCloseTab() && (
                <button
                  type="button"
                  className="close"
                  aria-label={`Close ${tab.label}`}
                  onClick={(e) => {
                    e.stopPropagation();
                    handleCloseTab(tab.id, tab.type);
                  }}
                >
                  ×
                </button>
              )}
            </div>
          ))}
          <div className="tab-add" onClick={addChatTab}>
            +
          </div>
        </div>
        <CreatePrButton />
      </div>
      <div className="center-content">
        {renderTabContent()}
        <GlobalQuestionOverlay />
        <BackgroundAskWatchers />
      </div>
    </section>
  );
}
