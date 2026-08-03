import { useEffect, useRef, useState } from 'react';
import { useChatStore } from '../store/chatStore';
import { findHarnessModel, useHarnessStore } from '../store/harnessStore';
import type { EffortLevel, HarnessModel } from '../lib/harnesses';
import ModelPicker from './ModelPicker';
import './ChatInput.css';

interface ChatInputProps {
  tabId: string;
}

const EFFORT_LABELS: Record<EffortLevel, string> = {
  low: 'Low',
  medium: 'Med',
  high: 'High',
  xhigh: 'XHigh',
  max: 'Max',
  ultracode: 'Ultra',
};

/** Effort options for a model: SDK levels + ultracode when effort is supported. */
function effortOptionsFor(model: HarnessModel | undefined): EffortLevel[] {
  if (!model?.supportsEffort) return [];
  const levels = (model.supportedEffortLevels ?? [
    'low',
    'medium',
    'high',
  ]) as EffortLevel[];
  // Claude Code exposes ultracode in the effort menu for effort-capable models.
  if (!levels.includes('ultracode')) {
    return [...levels, 'ultracode'];
  }
  return levels;
}

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

  const models = useHarnessStore((state) => state.models);
  const harnessLoading = useHarnessStore((state) => state.loading);

  const selectedModel = findHarnessModel(
    models,
    tab?.selectedModel ?? '',
    tab?.selectedHarness as HarnessModel['harnessId'] | undefined,
  );

  // Keep selection valid when the connected catalog changes.
  useEffect(() => {
    if (!tab || harnessLoading || models.length === 0) return;

    const stillValid = models.some(
      (m) =>
        m.value === tab.selectedModel && m.harnessId === tab.selectedHarness,
    );
    if (!stillValid) {
      const next = models[0];
      setModel(tabId, next.value, next.harnessId);
      applyModelCapabilities(next, tab.modelEffort, tab.mode);
      return;
    }

    const current = findHarnessModel(
      models,
      tab.selectedModel,
      tab.selectedHarness as HarnessModel['harnessId'],
    );
    if (current) {
      applyModelCapabilities(current, tab.modelEffort, tab.mode);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [models, harnessLoading, tabId]);

  function applyModelCapabilities(
    model: HarnessModel,
    effort: EffortLevel,
    mode: 'normal' | 'fast',
  ) {
    const options = effortOptionsFor(model);
    if (options.length === 0) {
      // Model has no effort — leave stored value; control is hidden.
    } else if (!options.includes(effort)) {
      const preferred =
        options.find((e) => e === 'medium') ??
        options.find((e) => e === 'high') ??
        options[0];
      setEffort(tabId, preferred);
    }

    if (mode === 'fast' && !model.supportsFastMode) {
      setMode(tabId, 'normal');
    }
  }

  if (!tab) return null;

  const effortOptions = effortOptionsFor(selectedModel);
  const showEffort = effortOptions.length > 0;
  const showFast = Boolean(selectedModel?.supportsFastMode);

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

  const handleModelChange = (model: HarnessModel) => {
    setModel(tabId, model.value, model.harnessId);
    applyModelCapabilities(model, tab.modelEffort, tab.mode);
  };

  const handleEffortCycle = () => {
    if (effortOptions.length === 0) return;
    const currentIndex = effortOptions.indexOf(tab.modelEffort);
    const nextIndex =
      currentIndex === -1 ? 0 : (currentIndex + 1) % effortOptions.length;
    setEffort(tabId, effortOptions[nextIndex]);
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
              <ModelPicker
                value={tab.selectedModel}
                harnessId={tab.selectedHarness}
                disabled={tab.loading}
                onChange={handleModelChange}
              />
            </div>

            {showEffort && (
              <button
                className="effort-btn"
                onClick={handleEffortCycle}
                disabled={tab.loading}
                title={`Effort: ${effortOptions.map((e) => EFFORT_LABELS[e]).join(' → ')}`}
              >
                {EFFORT_LABELS[tab.modelEffort] ?? tab.modelEffort}
              </button>
            )}

            {showFast && (
              <button
                type="button"
                className={`fast-mode-btn ${tab.mode === 'fast' ? 'active' : ''}`}
                onClick={() =>
                  setMode(tabId, tab.mode === 'fast' ? 'normal' : 'fast')
                }
                disabled={tab.loading}
                title={tab.mode === 'fast' ? 'Fast mode on' : 'Fast mode off'}
                aria-label={
                  tab.mode === 'fast' ? 'Disable fast mode' : 'Enable fast mode'
                }
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
            )}
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
