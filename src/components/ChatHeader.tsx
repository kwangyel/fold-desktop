import { useChatStore } from '../store/chatStore';
import './ChatHeader.css';

interface ChatHeaderProps {
  tabId: string;
}

const MODELS = [
  'claude-3-5-sonnet',
  'claude-opus-4',
  'gpt-4-turbo',
];

export default function ChatHeader({ tabId }: ChatHeaderProps) {
  const tab = useChatStore((state) => state.tabs[tabId]);
  const setModel = useChatStore((state) => state.setModel);
  const setEffort = useChatStore((state) => state.setEffort);
  const setMode = useChatStore((state) => state.setMode);
  const clearChat = useChatStore((state) => state.clearChat);

  if (!tab) return null;

  return (
    <div className="chat-header">
      <div className="header-controls">
        <div className="control-group">
          <label>Model</label>
          <select
            value={tab.selectedModel}
            onChange={(e) => setModel(tabId, e.target.value)}
            className="model-select"
          >
            {MODELS.map((model) => (
              <option key={model} value={model}>
                {model}
              </option>
            ))}
          </select>
        </div>

        <div className="control-group">
          <label>Effort</label>
          <div className="effort-options">
            {(['low', 'medium', 'high'] as const).map((effort) => (
              <label key={effort} className="effort-label">
                <input
                  type="radio"
                  name="effort"
                  value={effort}
                  checked={tab.modelEffort === effort}
                  onChange={() => setEffort(tabId, effort)}
                />
                <span className="effort-text">
                  {effort.charAt(0).toUpperCase() + effort.slice(1)}
                </span>
              </label>
            ))}
          </div>
        </div>

        <div className="control-group">
          <label>Mode</label>
          <div className="mode-toggle">
            {(['normal', 'fast'] as const).map((mode) => (
              <button
                key={mode}
                className={`mode-btn ${tab.mode === mode ? 'active' : ''}`}
                onClick={() => setMode(tabId, mode)}
              >
                {mode.charAt(0).toUpperCase() + mode.slice(1)}
              </button>
            ))}
          </div>
        </div>
      </div>

      <button className="clear-btn" onClick={() => clearChat(tabId)}>
        Clear
      </button>
    </div>
  );
}
