import { useEffect, useRef, useState } from "react";
import "./InlineCommentComposer.css";

interface InlineCommentComposerProps {
  /** Container-relative vertical offset of the target line. */
  top: number;
  /** Container-relative left offset so the box lines up with the code. */
  left: number;
  /** e.g. "line 12". */
  locationLabel: string;
  onSubmit: (body: string) => void;
  onCancel: () => void;
}

/**
 * Compact Save/Cancel form anchored to a diff line. Does not send to chat —
 * the parent persists the comment and attaches it to a new chat tab.
 */
export default function InlineCommentComposer({
  top,
  left,
  locationLabel,
  onSubmit,
  onCancel,
}: InlineCommentComposerProps) {
  const [value, setValue] = useState("");
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    textareaRef.current?.focus();
  }, []);

  const submit = () => {
    const body = value.trim();
    if (!body) return;
    onSubmit(body);
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Escape") {
      e.preventDefault();
      onCancel();
      return;
    }
    if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
      e.preventDefault();
      submit();
    }
  };

  return (
    <div
      className="inline-comment-anchor"
      style={{ top, left }}
      onMouseDown={(e) => e.stopPropagation()}
    >
      <div className="inline-comment-box">
        <div className="inline-comment-header">
          <span className="inline-comment-location">{locationLabel}</span>
        </div>
        <textarea
          ref={textareaRef}
          className="inline-comment-input"
          placeholder="Leave a comment on this line…"
          value={value}
          rows={3}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={handleKeyDown}
        />
        <div className="inline-comment-actions">
          <button
            type="button"
            className="inline-comment-cancel"
            onClick={onCancel}
          >
            Cancel
          </button>
          <button
            type="button"
            className="inline-comment-save"
            onClick={submit}
            disabled={!value.trim()}
            title="Save comment (⌘⏎)"
          >
            Save
          </button>
        </div>
      </div>
    </div>
  );
}
