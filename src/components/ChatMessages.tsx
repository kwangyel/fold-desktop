import { useEffect, useRef } from 'react';
import { useChatStore } from '../store/chatStore';
import './ChatMessages.css';

interface ChatMessagesProps {
  tabId: string;
}

export default function ChatMessages({ tabId }: ChatMessagesProps) {
  const tab = useChatStore((state) => state.tabs[tabId]);
  const messagesEndRef = useRef<HTMLDivElement>(null);

  const scrollToBottom = () => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  };

  useEffect(() => {
    scrollToBottom();
  }, [tab?.messages, tab?.loading]);

  if (!tab) {
    return <div className="chat-messages">Loading...</div>;
  }

  return (
    <div className="chat-messages">
      {tab.messages.length === 0 ? (
        <div className="chat-empty">
          <p>Start a conversation</p>
          <p className="text-muted">Type a message below to begin</p>
        </div>
      ) : (
        tab.messages.map((msg) => {
          if (msg.role === 'tool') {
            return (
              <div key={msg.id} className="message tool">
                <div className="message-content tool-activity">
                  <span className="tool-name">{msg.toolName ?? msg.content}</span>
                  <span
                    className={`tool-status ${msg.toolStatus ?? 'running'}`}
                  >
                    {msg.toolStatus === 'done' ? 'done' : 'running…'}
                  </span>
                </div>
              </div>
            );
          }

          return (
            <div key={msg.id} className={`message ${msg.role}`}>
              <div className="message-content">
                {msg.content ? (
                  <p className="message-text">{msg.content}</p>
                ) : msg.role === 'assistant' && tab.loading ? null : (
                  <p className="message-text text-muted">…</p>
                )}
                {msg.attachments && msg.attachments.length > 0 && (
                  <div className="attachments">
                    {msg.attachments.map((att) => (
                      <div key={att.id} className="attachment-item">
                        📎 {att.name}
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </div>
          );
        })
      )}
      {tab.loading && (
        <div className="message assistant">
          <div className="message-content">
            <p className="loading-indicator">
              <span>●</span>
              <span>●</span>
              <span>●</span>
            </p>
          </div>
        </div>
      )}
      <div ref={messagesEndRef} />
    </div>
  );
}
