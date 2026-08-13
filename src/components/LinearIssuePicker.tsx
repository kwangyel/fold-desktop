import { useEffect, useRef, useState } from "react";
import { IconLoader2, IconSearch, IconX } from "@tabler/icons-react";
import type { LinearIssue } from "../lib/linear";
import { useLinearStore } from "../store/linearStore";
import LinearLogo from "./icons/LinearLogo";
import "./LinearIssuePicker.css";

type Props = {
  selected: LinearIssue | null;
  onSelect: (issue: LinearIssue | null) => void;
  /** Compact popover for the chat composer. */
  variant?: "field" | "popover";
  onClose?: () => void;
};

export default function LinearIssuePicker({
  selected,
  onSelect,
  variant = "field",
  onClose,
}: Props) {
  const authenticated = useLinearStore((s) => s.authenticated);
  const searchIssues = useLinearStore((s) => s.searchIssues);
  const refresh = useLinearStore((s) => s.refresh);

  const [query, setQuery] = useState("");
  const [issues, setIssues] = useState<LinearIssue[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const requestId = useRef(0);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => {
    if (variant === "popover") inputRef.current?.focus();
  }, [variant]);

  useEffect(() => {
    if (!authenticated) {
      setIssues([]);
      return;
    }

    const id = ++requestId.current;
    const handle = window.setTimeout(() => {
      setLoading(true);
      setError(null);
      void searchIssues(query)
        .then((results) => {
          if (requestId.current !== id) return;
          setIssues(results);
          setLoading(false);
        })
        .catch((e) => {
          if (requestId.current !== id) return;
          setError(String(e));
          setIssues([]);
          setLoading(false);
        });
    }, query.trim() ? 250 : 0);

    return () => window.clearTimeout(handle);
  }, [authenticated, query, searchIssues]);

  if (!authenticated) {
    return (
      <div className={`linear-picker linear-picker-${variant}`}>
        <div className="linear-picker-empty">
          Connect Linear in Apps to attach issues.
        </div>
      </div>
    );
  }

  if (selected && variant === "field") {
    return (
      <div className="linear-picker linear-picker-field">
        <button
          type="button"
          className="linear-issue-chip"
          onClick={() => onSelect(null)}
          title="Remove Linear issue"
        >
          <span className="linear-issue-chip-icon">
            <LinearLogo size={12} />
          </span>
          <span className="linear-issue-id">{selected.identifier}</span>
          <span className="linear-issue-title">{selected.title}</span>
          <IconX size={14} stroke={2} />
        </button>
      </div>
    );
  }

  return (
    <div className={`linear-picker linear-picker-${variant}`}>
      <div className="linear-picker-search">
        <IconSearch size={14} stroke={2} />
        <input
          ref={inputRef}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search Linear issues…"
          aria-label="Search Linear issues"
        />
        {loading && <IconLoader2 size={14} className="spin" />}
        {variant === "popover" && onClose && (
          <button
            type="button"
            className="icon-btn"
            onClick={onClose}
            title="Close"
            aria-label="Close Linear issue picker"
          >
            <IconX size={14} stroke={2} />
          </button>
        )}
      </div>

      {error && <div className="linear-picker-error">{error}</div>}

      <div className="linear-issue-list" role="listbox">
        {issues.length === 0 && !loading && !error ? (
          <div className="linear-picker-empty">
            {query.trim()
              ? "No matching issues"
              : "No assigned open issues"}
          </div>
        ) : (
          issues.map((issue) => (
            <button
              key={issue.id}
              type="button"
              className="linear-issue-row"
              role="option"
              onClick={() => onSelect(issue)}
            >
              <span className="linear-issue-id">{issue.identifier}</span>
              <span className="linear-issue-title">{issue.title}</span>
              {issue.stateName && (
                <span
                  className="linear-issue-state"
                  style={
                    issue.stateColor
                      ? { color: issue.stateColor }
                      : undefined
                  }
                >
                  {issue.stateName}
                </span>
              )}
            </button>
          ))
        )}
      </div>
    </div>
  );
}
