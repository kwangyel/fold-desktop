import { useAskWatcher } from "../hooks/useAskWatcher";
import { useCenterViewStore } from "../store/centerViewStore";
import { useChatStore } from "../store/chatStore";

/** Keep the MCP ask watcher alive for every in-flight chat, even when that
 *  chat tab is not the active center view (e.g. the Plan tab is open). */
function AskWatcherHost({ tabId }: { tabId: string }) {
  useAskWatcher(tabId);
  return null;
}

export default function BackgroundAskWatchers() {
  // Select primitive/stable values only — returning a fresh array from a
  // Zustand selector every render causes an infinite update loop.
  const tabs = useCenterViewStore((s) => s.tabs);
  const chatTabs = useChatStore((s) => s.tabs);

  const loadingIds: string[] = [];
  for (const tab of tabs) {
    if (tab.type !== "chat") continue;
    const state = chatTabs[tab.id];
    if (state?.loading && state.selectedHarness !== "claudecode") {
      loadingIds.push(tab.id);
    }
  }

  return (
    <>
      {loadingIds.map((id) => (
        <AskWatcherHost key={id} tabId={id} />
      ))}
    </>
  );
}
