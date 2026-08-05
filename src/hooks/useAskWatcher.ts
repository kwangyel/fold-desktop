import { useEffect } from "react";
import { listDir, readFile } from "../lib/git";
import { ASKS_DIR, type AskRequestFile } from "../lib/asks";
import { useQuestionStore } from "../store/questionStore";
import { useChatStore } from "../store/chatStore";
import { useProjectStore } from "../store/projectStore";
import { useCenterViewStore } from "../store/centerViewStore";

const POLL_INTERVAL_MS = 500;

/**
 * Surface clarifying questions raised through Fold's `fold_ask_user` MCP tool.
 *
 * Claude Code asks over the Agent SDK's control channel, so it needs none of
 * this. The other harnesses run the MCP server as a separate process, which
 * drops a request file into the Fold asks directory and polls for our answer —
 * so the app has to watch that directory while a run is in flight.
 */
export function useAskWatcher(tabId: string): void {
  const loading = useChatStore((s) => s.tabs[tabId]?.loading ?? false);
  const harness = useChatStore((s) => s.tabs[tabId]?.selectedHarness);
  const activePath = useProjectStore((s) => s.activePath);

  useEffect(() => {
    if (!loading || !activePath || harness === "claudecode") return;

    let cancelled = false;
    const seen = new Set<string>();

    const poll = async () => {
      let entries;
      try {
        entries = await listDir(ASKS_DIR);
      } catch {
        // Directory only exists once a question has been asked.
        return;
      }

      for (const entry of entries) {
        if (
          entry.isDir ||
          !entry.name.endsWith(".json") ||
          entry.name.endsWith(".answer.json") ||
          seen.has(entry.name)
        ) {
          continue;
        }
        seen.add(entry.name);

        try {
          const raw = await readFile(`${ASKS_DIR}/${entry.name}`);
          const request = JSON.parse(raw) as AskRequestFile;
          if (cancelled || !request.questions?.length) {
            // Empty / incomplete payload — try again next tick.
            seen.delete(entry.name);
            continue;
          }
          // Skip asks that already have an answer on disk.
          try {
            await readFile(`${ASKS_DIR}/${request.askId}.answer.json`);
            continue;
          } catch {
            // No answer yet — surface the question.
          }
          useQuestionStore.getState().ask(
            {
              kind: "mcp",
              tabId,
              worktreePath: request.worktreePath,
              askId: request.askId,
            },
            request.questions,
          );
          // Bring the chat forward so the overlay is visible.
          useCenterViewStore.getState().setActiveTab(tabId);
        } catch {
          // Half-written file; it'll be picked up on a later poll.
          seen.delete(entry.name);
        }
      }
    };

    void poll();
    const timer = window.setInterval(() => void poll(), POLL_INTERVAL_MS);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [tabId, loading, harness, activePath]);
}
