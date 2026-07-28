import { useEffect } from 'react';
import { useChatStore } from '../store/chatStore';
import ChatHeader from './ChatHeader';
import ChatMessages from './ChatMessages';
import ChatInput from './ChatInput';
import './ChatInterface.css';

interface ChatInterfaceProps {
  tabId: string;
}

export default function ChatInterface({ tabId }: ChatInterfaceProps) {
  const initializeTab = useChatStore((state) => state.initializeTab);

  // Initialize this tab's state when component mounts
  useEffect(() => {
    initializeTab(tabId);
  }, [tabId, initializeTab]);

  return (
    <div className="chat-interface">
      <ChatHeader tabId={tabId} />
      <ChatMessages tabId={tabId} />
      <ChatInput tabId={tabId} />
    </div>
  );
}
