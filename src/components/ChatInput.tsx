import { useRef, useState } from 'react';
import { useChatStore } from '../store/chatStore';
import './ChatInput.css';

interface ChatInputProps {
  tabId: string;
}

/** Claude Code model aliases / ids passed as `--model`. */
const MODELS = ['sonnet', 'opus', 'haiku'];

export default function ChatInput({ tabId }: ChatInputProps) {
  const [message, setMessage] = useState('');
  const fileInputRef = useRef<HTMLInputElement>(null);

  const tab = useChatStore((state) => state.tabs[tabId]);
  const addAttachment = useChatStore((state) => state.addAttachment);
  const removeAttachment = useChatStore((state) => state.removeAttachment);
  const setModel = useChatStore((state) => state.setModel);
  const setMode = useChatStore((state) => state.setMode);
  const setEffort = useChatStore((state) => state.setEffort);
  const sendPrompt = useChatStore((state) => state.sendPrompt);
  const cancelAgent = useChatStore((state) => state.cancelAgent);

  if (!tab) return null;

  const handleSend = () => {
    if (!message.trim() || tab.loading) return;
    const prompt = message.trim();
    setMessage('');
    void sendPrompt(tabId, prompt);
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

  const handleEffortCycle = () => {
    const efforts: Array<'low' | 'medium' | 'high' | 'ultracode'> = [
      'low',
      'medium',
      'high',
      'ultracode',
    ];
    const currentIndex = efforts.indexOf(tab.modelEffort);
    const nextIndex = (currentIndex + 1) % efforts.length;
    setEffort(tabId, efforts[nextIndex]);
  };

  const getEffortLabel = (effort: string): string => {
    const labels: Record<string, string> = {
      low: 'Low',
      medium: 'Med',
      high: 'High',
      ultracode: 'Ultra',
    };
    return labels[effort] || effort;
  };

  return (
    <div className="chat-input-container">
      <div className="chat-input-box">
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

        <textarea
          value={message}
          onChange={(e) => setMessage(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder="Type your message... (Shift+Enter for new line)"
          className="message-input"
          disabled={tab.loading}
          rows={3}
        />

        <div className="chat-input-footer">
          <div className="input-toolbar">
            <div className="control-group">
              <label>Model</label>
              <select
                value={tab.selectedModel}
                onChange={(e) => setModel(tabId, e.target.value)}
                className="model-select"
                disabled={tab.loading}
              >
                {MODELS.map((model) => (
                  <option key={model} value={model}>
                    {model}
                  </option>
                ))}
              </select>
            </div>

            <button
              className="effort-btn"
              onClick={handleEffortCycle}
              disabled={tab.loading}
              title="Cycle effort level: Low → Med → High → Ultra"
            >
              {getEffortLabel(tab.modelEffort)}
            </button>

            <button
              type="button"
              className={`fast-mode-btn ${tab.mode === 'fast' ? 'active' : ''}`}
              onClick={() => setMode(tabId, tab.mode === 'fast' ? 'normal' : 'fast')}
              disabled={tab.loading}
              title={tab.mode === 'fast' ? 'Fast mode on' : 'Fast mode off'}
              aria-label={tab.mode === 'fast' ? 'Disable fast mode' : 'Enable fast mode'}
              aria-pressed={tab.mode === 'fast'}
            >
              <svg
                className="fast-mode-icon"
                viewBox="0 0 24 24"
                fill="currentColor"
                aria-hidden="true"
              >
                <path d="M13 2L3 14h8l-1 8 10-12h-8l1-8z" />
              </svg>
            </button>
          </div>

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

            {tab.loading ? (
              <button
                className="send-btn cancel"
                onClick={() => void cancelAgent(tabId)}
                title="Cancel agent"
                aria-label="Cancel agent"
              >
                ■
              </button>
            ) : (
              <button
                className="send-btn"
                onClick={handleSend}
                disabled={!message.trim()}
                title="Send message"
                aria-label="Send message"
              >
                ▶
              </button>
            )}
          </div>
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
