import { useEffect, useState } from 'react';
import { useCenterViewStore } from '../store/centerViewStore';
import { useChatStore } from '../store/chatStore';
import { useProjectStore } from '../store/projectStore';
import { ghPrCreateWeb } from '../lib/github';
import { gitListBranches } from '../lib/git';
import { PR_CREATION_PROMPT, mergeBranchPrompt } from '../lib/prPrompt';
import './CreatePrButton.css';

export default function CreatePrButton() {
  const [open, setOpen] = useState(false);
  const [branches, setBranches] = useState<string[]>([]);
  const [mergeTo, setMergeTo] = useState('main');

  const tabs = useCenterViewStore((s) => s.tabs);
  const activeTabId = useCenterViewStore((s) => s.activeTabId);
  const addChatTab = useCenterViewStore((s) => s.addChatTab);
  const setActiveTab = useCenterViewStore((s) => s.setActiveTab);

  const activePath = useProjectStore((s) => s.activePath);
  const activeProject = useProjectStore((s) => {
    const proj = s.projects.find((p) => p.id === s.activeId);
    return proj ?? null;
  });
  const hasGithubRemote = activeProject?.hasGithubRemote ?? false;

  // Load branches for local-repo mode
  useEffect(() => {
    if (hasGithubRemote || !activePath) return;
    gitListBranches(activePath).then((list) => {
      setBranches(list);
      // Default merge target to 'main', or first other branch if main doesn't exist
      if (list.length > 0 && !list.includes('main')) {
        setMergeTo(list[0]);
      } else {
        setMergeTo('main');
      }
    }).catch(() => setBranches([]));
  }, [hasGithubRemote, activePath]);

  useEffect(() => {
    if (!open) return;
    const close = () => setOpen(false);
    window.addEventListener('click', close);
    return () => window.removeEventListener('click', close);
  }, [open]);

  if (!activePath) return null;

  const getOrCreateChatTabId = (): string | null => {
    const activeTab = tabs.find((t) => t.id === activeTabId);
    if (activeTab?.type === 'chat') return activeTabId;
    const firstChat = tabs.find((t) => t.type === 'chat');
    if (firstChat) {
      setActiveTab(firstChat.id);
      return firstChat.id;
    }
    return null;
  };

  const sendToChat = (prompt: string) => {
    const chatTabId = getOrCreateChatTabId();
    if (chatTabId) {
      void useChatStore.getState().sendPrompt(chatTabId, prompt);
    } else {
      addChatTab();
      setTimeout(() => {
        const newTabId = useCenterViewStore.getState().activeTabId;
        void useChatStore.getState().sendPrompt(newTabId, prompt);
      }, 100);
    }
  };

  // --- GitHub remote: PR flow ---
  if (hasGithubRemote) {
    return (
      <div className="create-pr-wrap">
        <div className="create-pr-split">
          <button className="create-pr-main" onClick={() => sendToChat(PR_CREATION_PROMPT)}>
            Create PR
          </button>
          <button
            className="create-pr-arrow"
            onClick={(e) => { e.stopPropagation(); setOpen((v) => !v); }}
            aria-label="PR options"
          >
            ▾
          </button>
        </div>
        {open && (
          <div className="create-pr-dropdown">
            <button
              className="create-pr-item"
              onClick={(e) => {
                e.stopPropagation();
                setOpen(false);
                void ghPrCreateWeb(activePath);
              }}
            >
              Create PR manually
            </button>
          </div>
        )}
      </div>
    );
  }

  // --- Local repo: Merge flow ---
  return (
    <div className="create-pr-wrap">
      <div className="create-pr-split">
        <button
          className="create-pr-main"
          onClick={() => sendToChat(mergeBranchPrompt(mergeTo))}
        >
          Merge to {mergeTo}
        </button>
        <button
          className="create-pr-arrow"
          onClick={(e) => { e.stopPropagation(); setOpen((v) => !v); }}
          aria-label="Merge options"
        >
          ▾
        </button>
      </div>
      {open && branches.length > 0 && (
        <div className="create-pr-dropdown">
          {branches.map((branch) => (
            <button
              key={branch}
              className={`create-pr-item${branch === mergeTo ? ' create-pr-item-active' : ''}`}
              onClick={(e) => {
                e.stopPropagation();
                setMergeTo(branch);
                setOpen(false);
              }}
            >
              {branch}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
