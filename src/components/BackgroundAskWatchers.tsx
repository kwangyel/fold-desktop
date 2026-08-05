import { useAskWatcher } from "../hooks/useAskWatcher";
import { useCenterViewStore } from "../store/centerViewStore";

/** Keep the MCP ask watcher alive for every chat tab. Each host no-ops unless
 *  that tab is actively loading a non-Claude harness — so we intentionally do
 *  NOT subscribe to chatStore here (streaming would re-render this every chunk). */
function AskWatcherHost({ tabId }: { tabId: string }) {
  useAskWatcher(tabId);
  return null;
}

export default function BackgroundAskWatchers() {
  // Primitive string — only changes when chat tabs are added/removed, not when
  // editor content or other tab metadata updates.
  const chatTabIdsKey = useCenterViewStore((s) =>
    s.tabs
      .filter((t) => t.type === "chat")
      .map((t) => t.id)
      .join("\0"),
  );
  const chatTabIds = chatTabIdsKey ? chatTabIdsKey.split("\0") : [];

  return (
    <>
      {chatTabIds.map((id) => (
        <AskWatcherHost key={id} tabId={id} />
      ))}
    </>
  );
}
