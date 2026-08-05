/**
 * File-based bridge between Fold and the `fold_ask_user` MCP server.
 *
 * Cursor, Codex, and OpenCode expose no ask-the-user tool in headless mode, but
 * all three support MCP. The MCP server runs as a separate process, so it needs
 * a way to reach the app: it writes `<askId>.json` here and polls for
 * `<askId>.answer.json`. Files keep this dependency-free — the alternative is a
 * loopback HTTP server in the Tauri backend.
 *
 * Logical path `.fold/asks`; on disk this is
 * `{workspaces}/.fold/<worktree>/asks/` (beside the git worktree).
 */
export const ASKS_DIR = ".fold/asks";

/** A question request written by the MCP server, awaiting an answer. */
export type AskRequestFile = {
  askId: string;
  worktreePath: string;
  createdAt: number;
  questions: {
    question: string;
    header?: string;
    options: { label: string; description?: string }[];
    multiSelect?: boolean;
  }[];
};
