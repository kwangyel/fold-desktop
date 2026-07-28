import { useChatStore } from '../store/chatStore';
import './ChatHeader.css';

interface ChatHeaderProps {
  tabId: string;
}

export default function ChatHeader({ tabId }: ChatHeaderProps) {
  const tab = useChatStore((state) => state.tabs[tabId]);
  const clearChat = useChatStore((state) => state.clearChat);

  if (!tab) return null;

  return (
    <div className="chat-header">
      <button className="clear-btn" onClick={() => clearChat(tabId)}>
        Clear
      </button>
    </div>
  );
}
