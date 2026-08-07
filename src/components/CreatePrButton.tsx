import { useEffect, useState } from 'react';
import { useCenterViewStore } from '../store/centerViewStore';
import { useChatStore } from '../store/chatStore';
import { useProjectStore } from '../store/projectStore';
import { ghPrCreateWeb, ghPrViewCached, type PrInfo } from '../lib/github';
import { gitGithubRemote, gitListBranches } from '../lib/git';
import { PR_CREATION_PROMPT, mergeBranchPrompt } from '../lib/prPrompt';
import { makePromptAttachment } from '../lib/attachments';
import './CreatePrButton.css';

export default function CreatePrButton() {
  const [open, setOpen] = useState(false);
  const [branches, setBranches] = useState<string[]>([]);
  const [mergeTo, setMergeTo] = useState('main');
  const [existingPr, setExistingPr] = useState<PrInfo | null>(null);
  // Detected live from the worktree (not the persisted project flag), so a
  // remote added after project creation still shows the PR button.
  const [hasGithubRemote, setHasGithubRemote] = useState(false);

  const addChatTab = useCenterViewStore((s) => s.addChatTab);
  const setActiveTab = useCenterViewStore((s) => s.setActiveTab);
  const openPrTab = useCenterViewStore((s) => s.openPrTab);

  const activePath = useProjectStore((s) => s.activePath);
  const projectHasGithubRemote = useProjectStore((s) => {
    const proj = s.projects.find((p) => p.id === s.activeId);
    return proj?.hasGithubRemote ?? false;
  });

  // Prefer live detection; fall back to the persisted flag while checking.
  useEffect(() => {
    setHasGithubRemote(projectHasGithubRemote);
    if (!activePath) {
      setHasGithubRemote(false);
      return;
    }
    const path = activePath;
    let cancelled = false;
    void gitGithubRemote(path).then((hasRemote) => {
      if (!cancelled && path === activePath) setHasGithubRemote(hasRemote);
    }).catch(() => {
      if (!cancelled) setHasGithubRemote(projectHasGithubRemote);
    });
    return () => {
      cancelled = true;
    };
  }, [activePath, projectHasGithubRemote]);

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

  // Detect an existing PR for the current branch so we can surface a "View PR"
  // affordance. Re-checks periodically to catch PRs created out of band.
  useEffect(() => {
    setExistingPr(null);
    if (!hasGithubRemote || !activePath) return;
    const path = activePath;
    let cancelled = false;

    const check = () => {
      ghPrViewCached(path)
        .then((info) => {
          if (!cancelled && path === activePath) setExistingPr(info);
        })
        .catch(() => {});
    };

    check();
    const timer = window.setInterval(check, 30000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [hasGithubRemote, activePath]);

  useEffect(() => {
    if (!open) return;
    const close = () => setOpen(false);
    window.addEventListener('click', close);
    return () => window.removeEventListener('click', close);
  }, [open]);

  if (!activePath) return null;

  const getOrCreateChatTabId = (): string | null => {
    const { tabs, activeTabId: currentId } = useCenterViewStore.getState();
    const activeTab = tabs.find((t) => t.id === currentId);
    if (activeTab?.type === 'chat') return currentId;
    const firstChat = tabs.find((t) => t.type === 'chat');
    if (firstChat) {
      setActiveTab(firstChat.id);
      return firstChat.id;
    }
    addChatTab();
    return null; // caller will pick up the new tab after a tick
  };

  /** Attach a prompt chip and immediately send — used for Create PR / Merge only. */
  const attachAndSendPrompt = (name: string, prompt: string) => {
    void (async () => {
      const attachment = await makePromptAttachment(name, prompt);
      const attachAndSend = (tabId: string) => {
        const store = useChatStore.getState();
        store.initializeTab(tabId);
        store.addAttachment(tabId, attachment);
        void store.sendPrompt(tabId, '');
      };
      const chatTabId = getOrCreateChatTabId();
      if (chatTabId) {
        attachAndSend(chatTabId);
        return;
      }
      addChatTab();
      setTimeout(() => {
        const newTabId = useCenterViewStore.getState().activeTabId;
        attachAndSend(newTabId);
      }, 100);
    })();
  };

  // --- GitHub remote: PR flow ---
  if (hasGithubRemote) {
    const hasPr = existingPr !== null;
    return (
      <div className="create-pr-wrap">
        <div className="create-pr-split">
          {hasPr ? (
            <button
              className="create-pr-main create-pr-view"
              onClick={() => openPrTab(activePath)}
              title={existingPr?.title}
            >
              View PR #{existingPr?.number}
            </button>
          ) : (
            <button
              className="create-pr-main"
              onClick={() => attachAndSendPrompt('Create PR', PR_CREATION_PROMPT)}
            >
              Create PR
            </button>
          )}
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
            {hasPr ? (
              <button
                className="create-pr-item"
                onClick={(e) => {
                  e.stopPropagation();
                  setOpen(false);
                  attachAndSendPrompt('Create PR', PR_CREATION_PROMPT);
                }}
              >
                Create new PR
              </button>
            ) : (
              <button
                className="create-pr-item"
                onClick={(e) => {
                  e.stopPropagation();
                  setOpen(false);
                  openPrTab(activePath);
                }}
              >
                View PR
              </button>
            )}
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
          onClick={() =>
            attachAndSendPrompt(`Merge to ${mergeTo}`, mergeBranchPrompt(mergeTo))
          }
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
