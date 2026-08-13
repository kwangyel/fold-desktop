import { useEffect, useRef, useState } from 'react';
import { useShallow } from 'zustand/react/shallow';
import {
  IconChecklist,
  IconFile,
  IconFileText,
  IconMessage,
  IconPaperclip,
  IconPhoto,
  IconSparkles,
} from '@tabler/icons-react';
import { useChatStore, type Attachment } from '../store/chatStore';
import { findHarnessModel, useHarnessStore } from '../store/harnessStore';
import { resolveEffortLevels } from '../lib/effort';
import {
  harnessSupportsPlanMode,
  type EffortLevel,
  type HarnessModel,
} from '../lib/harnesses';
import {
  attachmentFromFile,
  makeTextAttachment,
} from '../lib/attachments';
import { startHarnessHandoff } from '../lib/chatTabs';
import EffortDial from './EffortDial';
import ModelPicker from './ModelPicker';
import './ChatInput.css';

interface ChatInputProps {
  tabId: string;
  placeholder?: string;
  /** If set, Send calls this instead of sending on `tabId`. */
  onSend?: (prompt: string) => void | Promise<void>;
}

/** Effort options for a model (API levels merged with harness docs). */
function effortOptionsFor(model: HarnessModel | undefined): EffortLevel[] {
  return resolveEffortLevels(model);
}

function AttachmentIcon({ kind }: { kind: Attachment['kind'] }) {
  const props = { size: 14, stroke: 2 } as const;
  if (kind === 'image') return <IconPhoto {...props} />;
  if (kind === 'prompt') return <IconSparkles {...props} />;
  if (kind === 'transcript') return <IconMessage {...props} />;
  if (kind === 'text') return <IconFileText {...props} />;
  return <IconFile {...props} />;
}

export default function ChatInput({
  tabId,
  placeholder,
  onSend,
}: ChatInputProps) {
  const [message, setMessage] = useState('');
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Everything except `messages` — subscribing to the whole tab would re-render
  // the composer (and the model picker) on every streamed token.
  const tab = useChatStore(
    useShallow((state) => {
      const t = state.tabs[tabId];
      if (!t) return null;
      return {
        selectedModel: t.selectedModel,
        selectedHarness: t.selectedHarness,
        modelEffort: t.modelEffort,
        mode: t.mode,
        planMode: t.planMode,
        attachments: t.attachments,
        loading: t.loading,
      };
    }),
  );
  const addAttachment = useChatStore((state) => state.addAttachment);
  const removeAttachment = useChatStore((state) => state.removeAttachment);
  const setModel = useChatStore((state) => state.setModel);
  const setMode = useChatStore((state) => state.setMode);
  const setPlanMode = useChatStore((state) => state.setPlanMode);
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

    // Switching to a harness without a planning mode (Codex) hides the toggle,
    // so clear the flag rather than leaving it silently set.
    if (!harnessSupportsPlanMode(model.harnessId)) {
      setPlanMode(tabId, false);
    }
  }

  if (!tab) return null;

  const effortOptions = effortOptionsFor(selectedModel);
  const showEffort = effortOptions.length > 0;
  const showFast = Boolean(selectedModel?.supportsFastMode);
  // Hidden for harnesses without a planning mode (Codex).
  const showPlan = Boolean(
    selectedModel && harnessSupportsPlanMode(selectedModel.harnessId),
  );

  const handleSend = () => {
    if (tab.loading) return;
    if (!message.trim() && tab.attachments.length === 0) return;
    const prompt = message.trim();
    setMessage('');
    if (onSend) {
      void onSend(prompt);
      return;
    }
    void sendPrompt(tabId, prompt);
  };

  const handleAttachmentClick = () => {
    fileInputRef.current?.click();
  };

  const handleFileSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files;
    if (!files?.length) return;

    void (async () => {
      for (const file of Array.from(files)) {
        const attachment = await attachmentFromFile(file);
        addAttachment(tabId, attachment);
      }
    })();

    if (fileInputRef.current) {
      fileInputRef.current.value = '';
    }
  };

  const handlePaste = (e: React.ClipboardEvent<HTMLTextAreaElement>) => {
    const items = e.clipboardData?.items;
    if (!items?.length) return;

    const files: File[] = [];
    for (const item of Array.from(items)) {
      if (item.kind === 'file') {
        const file = item.getAsFile();
        if (file) files.push(file);
      }
    }

    if (files.length > 0) {
      e.preventDefault();
      void (async () => {
        for (const file of files) {
          const attachment = await attachmentFromFile(file);
          addAttachment(tabId, attachment);
        }
      })();
      return;
    }

    const text = e.clipboardData.getData('text/plain');
    if (text) {
      e.preventDefault();
      void makeTextAttachment(text).then((attachment) => {
        addAttachment(tabId, attachment);
      });
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  const handleModelChange = (model: HarnessModel) => {
    // Harnesses cannot read each other's sessions. Switching harness in a chat
    // that already has history therefore opens a new chat on the new harness
    // with the transcript attached, rather than silently dropping the context.
    const switchingHarness =
      model.harnessId !== tab.selectedHarness &&
      useChatStore.getState().tabs[tabId]?.messages.length;
    if (switchingHarness) {
      void startHarnessHandoff(tabId, model.harnessId, model.value);
      return;
    }
    setModel(tabId, model.value, model.harnessId);
    applyModelCapabilities(model, tab.modelEffort, tab.mode);
  };

  return (
    <div className="chat-input-container">
      <div className="chat-input-box">
        {tab.attachments.length > 0 && (
          <div className="attachments-preview">
            {tab.attachments.map((att) => (
              <div
                key={att.id}
                className={`attachment-badge kind-${att.kind}`}
                title={att.content ?? att.path ?? att.name}
              >
                {att.kind === 'image' && att.dataUrl ? (
                  <img
                    className="attachment-thumb"
                    src={att.dataUrl}
                    alt=""
                  />
                ) : (
                  <span className="attachment-icon">
                    <AttachmentIcon kind={att.kind} />
                  </span>
                )}
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
          onPaste={handlePaste}
          placeholder={
            placeholder ??
            "Type your message... (paste text or images as attachments)"
          }
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
              <EffortDial
                options={effortOptions}
                value={tab.modelEffort}
                disabled={tab.loading}
                onChange={(effort) => setEffort(tabId, effort)}
              />
            )}

            {showPlan && (
              <button
                type="button"
                className={`plan-mode-btn ${tab.planMode ? 'active' : ''}`}
                onClick={() => setPlanMode(tabId, !tab.planMode)}
                disabled={tab.loading}
                title={
                  tab.planMode
                    ? 'Plan mode on — research and propose, no edits'
                    : 'Plan mode off'
                }
                aria-label={
                  tab.planMode ? 'Disable plan mode' : 'Enable plan mode'
                }
                aria-pressed={tab.planMode}
              >
                <IconChecklist size={16} stroke={2} />
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
              <IconPaperclip size={16} stroke={2} />
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
                disabled={!message.trim() && tab.attachments.length === 0}
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
        multiple
        onChange={handleFileSelect}
        style={{ display: 'none' }}
        aria-label="File input"
      />
    </div>
  );
}
