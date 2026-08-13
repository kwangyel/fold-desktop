import { useEffect, useMemo, useRef, useState } from "react";
import CodeDiffViewer, { DiffLayout } from "./CodeDiffViewer";
import CodeEditor from "./CodeEditor";
import ReviewComposer from "./ReviewComposer";
import { getFileDiff, writeFile } from "../lib/git";
import { markReadAndAdvance } from "../lib/diffActions";
import { useCenterViewStore } from "../store/centerViewStore";
import { useChangesStore } from "../store/changesStore";
import {
  selectCommentsForFile,
  useReviewCommentsStore,
} from "../store/reviewCommentsStore";
import {
  attachCommentToComposer,
  snippetForRange,
} from "../lib/reviewComments";
import "./CodeEditor.css";

interface DiffPaneProps {
  tabId: string;
  filePath: string;
  original: string;
  modified: string;
}

type ViewMode = "diff" | "edit";

export default function DiffPane({ tabId, filePath, original, modified }: DiffPaneProps) {
  const [viewMode, setViewMode] = useState<ViewMode>("diff");
  const [layout, setLayout] = useState<DiffLayout>("unified");
  const [editContent, setEditContent] = useState(modified);
  const [copied, setCopied] = useState(false);
  const [saveState, setSaveState] = useState<"idle" | "saving" | "saved">("idle");

  const updateDiffContent = useCenterViewStore((state) => state.updateDiffContent);
  const isRead = useChangesStore((state) => state.readPaths.has(filePath));

  const comments = useReviewCommentsStore((state) => state.comments);
  const addComment = useReviewCommentsStore((state) => state.add);
  const removeComment = useReviewCommentsStore((state) => state.remove);
  const fileComments = useMemo(
    () => selectCommentsForFile(comments, filePath),
    [comments, filePath],
  );

  // Reset local edit buffer whenever the underlying file/content changes.
  useEffect(() => {
    setEditContent(modified);
    setViewMode("diff");
  }, [filePath, modified]);

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(viewMode === "edit" ? editContent : modified);
      setCopied(true);
      setTimeout(() => setCopied(false), 1200);
    } catch {
      /* clipboard unavailable */
    }
  };

  const handleSave = async () => {
    setSaveState("saving");
    try {
      await writeFile(filePath, editContent);
      const diff = await getFileDiff(filePath);
      updateDiffContent(tabId, diff.original, diff.modified);
      void useChangesStore.getState().refresh();
      setSaveState("saved");
      setTimeout(() => setSaveState("idle"), 1200);
    } catch (err) {
      setSaveState("idle");
      window.alert(`Failed to save: ${err}`);
    }
  };

  // Save on Cmd/Ctrl+S while editing. A ref keeps the handler fresh
  // without re-registering the listener on every keystroke.
  const saveRef = useRef(handleSave);
  saveRef.current = handleSave;
  useEffect(() => {
    if (viewMode !== "edit") return;
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "s") {
        e.preventDefault();
        void saveRef.current();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [viewMode]);

  return (
    <div className="diff-pane">
      <div className="center-editor-header diff-toolbar">
        <span className="file-path" title={filePath}>
          {filePath}
        </span>
        <div className="diff-toolbar-actions">
          <div className="diff-toggle-group">
            <button
              className={viewMode === "diff" ? "active" : ""}
              onClick={() => setViewMode("diff")}
            >
              Diff
            </button>
            <button
              className={viewMode === "edit" ? "active" : ""}
              onClick={() => setViewMode("edit")}
            >
              Edit
            </button>
          </div>

          {viewMode === "diff" && (
            <div className="diff-toggle-group">
              <button
                className={layout === "unified" ? "active" : ""}
                onClick={() => setLayout("unified")}
                title="Unified view"
              >
                Unified
              </button>
              <button
                className={layout === "split" ? "active" : ""}
                onClick={() => setLayout("split")}
                title="Side-by-side view"
              >
                Split
              </button>
            </div>
          )}

          <button className="diff-tool-btn" onClick={() => void handleCopy()}>
            {copied ? "Copied" : "Copy"}
          </button>

          {viewMode === "edit" && saveState !== "idle" && (
            <span className="diff-save-status">
              {saveState === "saving" ? "Saving…" : "Saved ✓"}
            </span>
          )}

          <button
            className="diff-tool-btn"
            onClick={() => void markReadAndAdvance(filePath)}
            title="Mark as read and show next"
          >
            {isRead ? "Read ✓" : "Mark read"}
          </button>
        </div>
      </div>

      {viewMode === "edit" ? (
        <CodeEditor
          key={`${tabId}-edit`}
          filePath={filePath}
          content={editContent}
          onChange={setEditContent}
        />
      ) : (
        <CodeDiffViewer
          key={`${tabId}-${layout}`}
          filePath={filePath}
          original={original}
          modified={modified}
          layout={layout}
          comments={fileComments}
          onDeleteComment={(id) => void removeComment(id)}
          onReattachComment={(id) => {
            const comment = fileComments.find((c) => c.id === id);
            if (!comment) return;
            void attachCommentToComposer(
              comment,
              comment.snippet ??
                snippetForRange(modified, comment.line, comment.endLine),
            );
          }}
          onAddComment={(selection, body) =>
            void (async () => {
              const comment = await addComment({
                file: filePath,
                line: selection.startLine,
                endLine: selection.endLine,
                body,
                snippet: selection.snippet,
              });
              await attachCommentToComposer(comment, selection.snippet);
            })()
          }
        />
      )}
      <ReviewComposer />
    </div>
  );
}
