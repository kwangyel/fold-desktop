import { useRef, useState } from 'react';
import { useChatStore, Message } from '../store/chatStore';
import './ChatInput.css';

interface ChatInputProps {
  tabId: string;
}

export default function ChatInput({ tabId }: ChatInputProps) {
  const [message, setMessage] = useState('');
  const fileInputRef = useRef<HTMLInputElement>(null);

  const tab = useChatStore((state) => state.tabs[tabId]);
  const addMessage = useChatStore((state) => state.addMessage);
  const addAttachment = useChatStore((state) => state.addAttachment);
  const removeAttachment = useChatStore((state) => state.removeAttachment);
  const setLoading = useChatStore((state) => state.setLoading);

  if (!tab) return null;

  const handleSend = () => {
    if (!message.trim()) return;

    const userMessage: Message = {
      id: Date.now().toString(),
      role: 'user',
      content: message.trim(),
      attachments: tab.attachments.length > 0 ? [...tab.attachments] : undefined,
      timestamp: Date.now(),
    };

    addMessage(tabId, userMessage);
    setMessage('');

    // Simulate assistant response with timeout
    setLoading(tabId, true);

    setTimeout(() => {
      const mockResponses = [
        "That's an interesting question! Here's what I think about that...",
        'I appreciate your input. Let me provide some insights on this topic.',
        'Good point! Here are a few things to consider...',
        "I understand. Based on what you've shared, here's my perspective...",
      ];

      const assistantMessage: Message = {
        id: Date.now().toString(),
        role: 'assistant',
        content: mockResponses[Math.floor(Math.random() * mockResponses.length)],
        timestamp: Date.now(),
      };

      addMessage(tabId, assistantMessage);
      setLoading(tabId, false);
    }, 1000);
  };

  const handleAttachmentClick = () => {
    fileInputRef.current?.click();
  };

  const handleFileSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    const attachment = {
      id: Date.now().toString(),
      name: file.name,
      size: file.size,
      type: file.type,
    };

    addAttachment(tabId, attachment);

    // Reset input
    if (fileInputRef.current) {
      fileInputRef.current.value = '';
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  return (
    <div className="chat-input-container">
      {tab.attachments.length > 0 && (
        <div className="attachments-preview">
          {tab.attachments.map((att) => (
            <div key={att.id} className="attachment-badge">
              <span className="attachment-icon">📎</span>
              <span className="attachment-name">{att.name}</span>
              <button
                className="attachment-remove"
                onClick={() => removeAttachment(tabId, att.id)}
                aria-label="Remove attachment"
              >
                ×
              </button>
            </div>
          ))}
        </div>
      )}

      <div className="chat-input-wrapper">
        <textarea
          value={message}
          onChange={(e) => setMessage(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder="Type your message... (Shift+Enter for new line)"
          className="message-input"
          disabled={tab.loading}
          rows={3}
        />

        <div className="input-actions">
          <button
            className="attach-btn"
            onClick={handleAttachmentClick}
            disabled={tab.loading}
            title="Attach file"
            aria-label="Attach file"
          >
            📎
          </button>

          <button
            className="send-btn"
            onClick={handleSend}
            disabled={!message.trim() || tab.loading}
            title="Send message"
            aria-label="Send message"
          >
            {tab.loading ? '⏳' : '▶'}
          </button>
        </div>
      </div>

      <input
        ref={fileInputRef}
        type="file"
        onChange={handleFileSelect}
        style={{ display: 'none' }}
        aria-label="File input"
      />
    </div>
  );
}
