import { useCenterViewStore } from "../store/centerViewStore";
import { useChatStore } from "../store/chatStore";

export function closeActiveTab(): boolean {
  const { tabs, activeTabId, closeTab } = useCenterViewStore.getState();
  if (tabs.length <= 1) return false;

  const activeTab = tabs.find((tab) => tab.id === activeTabId);
  if (!activeTab) return false;

  if (activeTab.type === "chat") {
    useChatStore.getState().deleteTab(activeTabId);
  }
  closeTab(activeTabId);
  return true;
}
