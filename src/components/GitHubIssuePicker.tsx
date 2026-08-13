import { useEffect, useRef, useState } from "react";
import {
  IconBrandGithub,
  IconLoader2,
  IconSearch,
  IconX,
} from "@tabler/icons-react";
import { ghListIssues, type GhIssue } from "../lib/github";
import { useGithubStore } from "../store/githubStore";
import "./GitHubIssuePicker.css";

type Props = {
  /** Repo directory (main worktree path) that `gh issue list` runs in. */
  repoPath: string;
  selected: GhIssue | null;
  onSelect: (issue: GhIssue | null) => void;
  /** Compact popover for the chat composer. */
  variant?: "field" | "popover";
  onClose?: () => void;
};

export default function GitHubIssuePicker({
  repoPath,
  selected,
  onSelect,
  variant = "field",
  onClose,
}: Props) {
  const authenticated = useGithubStore((s) => s.authenticated);
  const refresh = useGithubStore((s) => s.refresh);

  const [query, setQuery] = useState("");
  const [issues, setIssues] = useState<GhIssue[]>([]);
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
    if (!authenticated || !repoPath) {
      setIssues([]);
      return;
    }

    const id = ++requestId.current;
    const handle = window.setTimeout(() => {
      setLoading(true);
      setError(null);
      void ghListIssues(repoPath, query)
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
  }, [authenticated, repoPath, query]);

  if (!authenticated) {
    return (
      <div className={`github-picker github-picker-${variant}`}>
        <div className="github-picker-empty">
          Connect GitHub in Apps to attach issues.
        </div>
      </div>
    );
  }

  if (selected && variant === "field") {
    return (
      <div className="github-picker github-picker-field">
        <button
          type="button"
          className="github-issue-chip"
          onClick={() => onSelect(null)}
          title="Remove GitHub issue"
        >
          <span className="github-issue-chip-icon">
            <IconBrandGithub size={12} stroke={2} />
          </span>
          <span className="github-issue-id">#{selected.number}</span>
          <span className="github-issue-title">{selected.title}</span>
          <IconX size={14} stroke={2} />
        </button>
      </div>
    );
  }

  return (
    <div className={`github-picker github-picker-${variant}`}>
      <div className="github-picker-search">
        <IconSearch size={14} stroke={2} />
        <input
          ref={inputRef}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search GitHub issues…"
          aria-label="Search GitHub issues"
        />
        {loading && <IconLoader2 size={14} className="spin" />}
        {variant === "popover" && onClose && (
          <button
            type="button"
            className="icon-btn"
            onClick={onClose}
            title="Close"
            aria-label="Close GitHub issue picker"
          >
            <IconX size={14} stroke={2} />
          </button>
        )}
      </div>

      {error && <div className="github-picker-error">{error}</div>}

      <div className="github-issue-list" role="listbox">
        {issues.length === 0 && !loading && !error ? (
          <div className="github-picker-empty">
            {query.trim() ? "No matching issues" : "No open issues"}
          </div>
        ) : (
          issues.map((issue) => (
            <button
              key={issue.number}
              type="button"
              className="github-issue-row"
              role="option"
              onClick={() => onSelect(issue)}
            >
              <span className="github-issue-id">#{issue.number}</span>
              <span className="github-issue-title">{issue.title}</span>
              {issue.state && (
                <span className="github-issue-state">{issue.state}</span>
              )}
            </button>
          ))
        )}
      </div>
    </div>
  );
}
