import { useEffect } from "react";
import {
  IconCheck,
  IconTrash,
  IconArrowBackUp,
  IconSend,
  IconPaperclip,
} from "@tabler/icons-react";
import { openDiffForPath } from "../lib/diffActions";
import {
  REVIEW_COMPOSER_TAB_ID,
  attachCommentToComposer,
  attachCommentsToComposer,
  commentAttachmentId,
  commentLocation,
  type DiffComment,
} from "../lib/reviewComments";
import {
  selectUnresolvedCount,
  useReviewCommentsStore,
} from "../store/reviewCommentsStore";
import { useChatStore } from "../store/chatStore";
import "./ReviewCommentsPanel.css";

/** Comments grouped by file, preserving first-seen file order. */
function groupByFile(comments: DiffComment[]): [string, DiffComment[]][] {
  const groups = new Map<string, DiffComment[]>();
  for (const c of comments) {
    const list = groups.get(c.file) ?? [];
    list.push(c);
    groups.set(c.file, list);
  }
  for (const list of groups.values()) list.sort((a, b) => a.line - b.line);
  return [...groups.entries()];
}

export default function ReviewCommentsPanel() {
  const comments = useReviewCommentsStore((s) => s.comments);
  const refresh = useReviewCommentsStore((s) => s.refresh);
  const remove = useReviewCommentsStore((s) => s.remove);
  const setResolved = useReviewCommentsStore((s) => s.setResolved);
  const composerAttachmentKey = useChatStore(
    (s) =>
      (s.tabs[REVIEW_COMPOSER_TAB_ID]?.attachments ?? [])
        .map((a) => a.id)
        .join(","),
  );

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const unresolved = comments.filter((c) => !c.resolved);
  const unresolvedCount = selectUnresolvedCount(comments);
  const groups = groupByFile(comments);

  const handleSend = () => {
    void attachCommentsToComposer(unresolved);
  };

  return (
    <div className="review-comments-panel">
      <div className="rc-header">
        <span className="rc-count">
          {comments.length === 0
            ? "No review comments"
            : `${unresolvedCount} unresolved · ${comments.length} total`}
        </span>
        <button
          className="rc-send"
          onClick={handleSend}
          disabled={unresolved.length === 0}
          title="Attach unresolved comments to the composer under the diff"
        >
          <IconSend size={13} stroke={2} />
          Attach to chat
        </button>
      </div>

      {comments.length === 0 ? (
        <div className="rc-empty">
          Click + on a diff line to add a comment. Comments stay on the line
          and appear as removable attachments in the composer under the diff.
        </div>
      ) : (
        <div className="rc-list">
          {groups.map(([file, list]) => (
            <div key={file} className="rc-group">
              <button
                className="rc-file"
                title={file}
                onClick={() => void openDiffForPath(file)}
              >
                {file}
              </button>
              {list.map((c) => (
                <div
                  key={c.id}
                  className={`rc-item ${c.resolved ? "resolved" : ""}`}
                >
                  <div className="rc-item-head">
                    <button
                      className="rc-loc"
                      onClick={() => void openDiffForPath(c.file)}
                      title="Open the diff"
                    >
                      {commentLocation(c)}
                    </button>
                    {c.author === "agent" && (
                      <span className="rc-author">agent</span>
                    )}
                    <div className="rc-item-actions">
                      {!c.resolved &&
                        !composerAttachmentKey
                          .split(",")
                          .includes(commentAttachmentId(c.id)) && (
                          <button
                            className="rc-action"
                            title="Add this comment back to the composer"
                            onClick={() => void attachCommentToComposer(c, "")}
                          >
                            <IconPaperclip size={13} stroke={2} />
                          </button>
                        )}
                      <button
                        className="rc-action"
                        title={c.resolved ? "Mark unresolved" : "Mark resolved"}
                        onClick={() => void setResolved(c.id, !c.resolved)}
                      >
                        {c.resolved ? (
                          <IconArrowBackUp size={13} stroke={2} />
                        ) : (
                          <IconCheck size={13} stroke={2} />
                        )}
                      </button>
                      <button
                        className="rc-action danger"
                        title="Delete comment"
                        onClick={() => void remove(c.id)}
                      >
                        <IconTrash size={13} stroke={2} />
                      </button>
                    </div>
                  </div>
                  <div className="rc-body">{c.body}</div>
                </div>
              ))}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
