import { lazy, Suspense, useEffect, useMemo, useState } from "react";
import {
  IconChevronLeft,
  IconChevronRight,
  IconCheck,
} from "@tabler/icons-react";
import { DiffLayout } from "./CodeDiffViewer";
import ReviewComposer from "./ReviewComposer";
import { getFileDiff } from "../lib/git";
import {
  attachCommentToComposer,
  snippetForRange,
} from "../lib/reviewComments";
import { useChangesStore } from "../store/changesStore";
import {
  selectCommentsForFile,
  useReviewCommentsStore,
} from "../store/reviewCommentsStore";
import {
  selectReviewCurrentPath,
  selectReviewedCount,
  useReviewStore,
} from "../store/reviewStore";
import "./ReviewQueue.css";

const CodeDiffViewer = lazy(() => import("./CodeDiffViewer"));

type DiffState = {
  path: string;
  original: string;
  modified: string;
  loading: boolean;
  error: string | null;
};

export default function ReviewQueue() {
  const queue = useReviewStore((s) => s.queue);
  const index = useReviewStore((s) => s.index);
  const next = useReviewStore((s) => s.next);
  const prev = useReviewStore((s) => s.prev);
  const markReviewedAndNext = useReviewStore((s) => s.markReviewedAndNext);

  const readPaths = useChangesStore((s) => s.readPaths);
  const currentPath = useReviewStore(selectReviewCurrentPath);

  const comments = useReviewCommentsStore((s) => s.comments);
  const addComment = useReviewCommentsStore((s) => s.add);
  const removeComment = useReviewCommentsStore((s) => s.remove);
  const refreshComments = useReviewCommentsStore((s) => s.refresh);
  const fileComments = useMemo(
    () => (currentPath ? selectCommentsForFile(comments, currentPath) : []),
    [comments, currentPath],
  );

  const [layout, setLayout] = useState<DiffLayout>("unified");
  const [diff, setDiff] = useState<DiffState | null>(null);

  // Ensure comments are loaded when the review surface opens.
  useEffect(() => {
    void refreshComments();
  }, [refreshComments]);

  const total = queue.length;
  const reviewedCount = selectReviewedCount(queue, readPaths);
  const isReviewed = currentPath ? readPaths.has(currentPath) : false;

  // Load the diff for the file under review whenever it changes.
  useEffect(() => {
    if (!currentPath) {
      setDiff(null);
      return;
    }
    let cancelled = false;
    setDiff({
      path: currentPath,
      original: "",
      modified: "",
      loading: true,
      error: null,
    });
    void getFileDiff(currentPath)
      .then(({ original, modified }) => {
        if (cancelled) return;
        setDiff({ path: currentPath, original, modified, loading: false, error: null });
      })
      .catch((err) => {
        if (cancelled) return;
        setDiff({
          path: currentPath,
          original: "",
          modified: "",
          loading: false,
          error: String(err),
        });
      });
    return () => {
      cancelled = true;
    };
  }, [currentPath]);

  // Keyboard shortcuts: [ / ] to move, r to mark reviewed & advance.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      if (
        target &&
        (target.tagName === "TEXTAREA" ||
          target.tagName === "INPUT" ||
          target.isContentEditable)
      ) {
        return;
      }
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.key === "[") {
        e.preventDefault();
        prev();
      } else if (e.key === "]") {
        e.preventDefault();
        next();
      } else if (e.key.toLowerCase() === "r") {
        e.preventDefault();
        markReviewedAndNext();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [prev, next, markReviewedAndNext]);

  if (total === 0 || !currentPath) {
    return (
      <div className="review-queue">
        <div className="review-empty">
          No pending changes to review. Start a review from the Changes panel.
        </div>
      </div>
    );
  }

  return (
    <div className="review-queue">
      <div className="review-header">
        <div className="review-progress">
          <span className="review-count">
            File {index + 1} of {total}
          </span>
          <span className="review-reviewed">· {reviewedCount} reviewed</span>
        </div>

        <span className="review-file-path" title={currentPath}>
          {isReviewed && <IconCheck size={13} stroke={2.5} className="review-check" />}
          {currentPath}
        </span>

        <div className="review-actions">
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

          <button
            className="review-nav"
            onClick={() => prev()}
            disabled={index === 0}
            title="Previous file ( [ )"
            aria-label="Previous file"
          >
            <IconChevronLeft size={16} stroke={2} />
          </button>
          <button
            className="review-nav"
            onClick={() => next()}
            disabled={index >= total - 1}
            title="Next file ( ] )"
            aria-label="Next file"
          >
            <IconChevronRight size={16} stroke={2} />
          </button>

          <button
            className="review-mark"
            onClick={() => markReviewedAndNext()}
            title="Mark reviewed and go to next unreviewed ( r )"
          >
            {isReviewed ? "Reviewed ✓" : "Mark reviewed & next"}
          </button>
        </div>
      </div>

      {diff?.loading && <div className="review-loading">Loading diff…</div>}
      {diff?.error && <div className="review-error">{diff.error}</div>}
      {diff && !diff.loading && !diff.error && (
        <Suspense fallback={<div className="review-loading">Loading diff…</div>}>
          <CodeDiffViewer
            key={`${currentPath}-${layout}`}
            filePath={currentPath}
            original={diff.original}
            modified={diff.modified}
            layout={layout}
            comments={fileComments}
            onDeleteComment={(id) => void removeComment(id)}
            onReattachComment={(id) => {
              const comment = fileComments.find((c) => c.id === id);
              if (!comment) return;
              void attachCommentToComposer(
                comment,
                comment.snippet ??
                  snippetForRange(diff.modified, comment.line, comment.endLine),
              );
            }}
            onAddComment={(selection, body) =>
              void (async () => {
                const comment = await addComment({
                  file: currentPath,
                  line: selection.startLine,
                  endLine: selection.endLine,
                  body,
                  snippet: selection.snippet,
                });
                await attachCommentToComposer(comment, selection.snippet);
              })()
            }
          />
        </Suspense>
      )}
      <ReviewComposer />
    </div>
  );
}
