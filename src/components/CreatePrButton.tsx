import { useEffect, useRef, useState } from 'react';
import { useCenterViewStore } from '../store/centerViewStore';
import { useChangesStore } from '../store/changesStore';
import { useChatStore } from '../store/chatStore';
import { useProjectStore } from '../store/projectStore';
import {
  selectTargetBranch,
  useTargetBranchStore,
} from '../store/targetBranchStore';
import { ghPrCreateWeb, ghPrViewCached, invalidatePrCache, type PrInfo } from '../lib/github';
import {
  gitGithubRemote,
  gitMergeReadiness,
  gitMergeToTarget,
  gitRebaseOntoTarget,
  type MergeReadiness,
} from '../lib/git';
import { commitChangesPrompt, prCreationPrompt } from '../lib/prPrompt';
import { makePromptAttachment } from '../lib/attachments';
import {
  closeLinkedIssuesIfPrOpen,
  listLinkedIssues,
} from '../lib/linkedIssues';
import './CreatePrButton.css';

export default function CreatePrButton() {
  const [open, setOpen] = useState(false);
  const [existingPr, setExistingPr] = useState<PrInfo | null>(null);
  // Detected live from the worktree (not the persisted project flag), so a
  // remote added after project creation still shows the PR button.
  const [hasGithubRemote, setHasGithubRemote] = useState(false);
  const [readiness, setReadiness] = useState<MergeReadiness | null>(null);
  const [actionBusy, setActionBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const prevChatLoading = useRef(false);

  const addChatTab = useCenterViewStore((s) => s.addChatTab);
  const setActiveTab = useCenterViewStore((s) => s.setActiveTab);
  const openPrTab = useCenterViewStore((s) => s.openPrTab);

  const activePath = useProjectStore((s) => s.activePath);
  const activeId = useProjectStore((s) => s.activeId);
  const projectPath = useProjectStore((s) => {
    const proj = s.projects.find((p) => p.id === s.activeId);
    return proj?.path ?? null;
  });
  const projectHasGithubRemote = useProjectStore((s) => {
    const proj = s.projects.find((p) => p.id === s.activeId);
    return proj?.hasGithubRemote ?? false;
  });

  const byProjectId = useTargetBranchStore((s) => s.byProjectId);
  const targetBranch = selectTargetBranch(byProjectId, activeId);
  const changeCount = useChangesStore((s) => s.changes.length);
  const refreshChanges = useChangesStore((s) => s.refresh);

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
          if (!cancelled && path === activePath) {
            setExistingPr(info);
            if (info) void closeLinkedIssuesIfPrOpen(info, path);
          }
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

  // Local repos: poll merge readiness so the Merge button appears after the
  // agent commits (working tree clean + commits ahead of target).
  useEffect(() => {
    if (hasGithubRemote || !activePath) {
      setReadiness(null);
      return;
    }
    const path = activePath;
    let cancelled = false;

    const check = () => {
      void gitMergeReadiness(path, targetBranch)
        .then((info) => {
          if (cancelled || path !== activePath) return;
          setReadiness(info);
          // Clear a stale Changes list after the agent commits (ignore Fold's
          // own `.cursor/` files when deciding dirtiness).
          if (!info.dirty && changeCount > 0) void refreshChanges();
        })
        .catch((e) => {
          if (!cancelled) {
            setReadiness(null);
            setActionError(String(e));
          }
        });
    };

    check();
    const timer = window.setInterval(check, 2000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [hasGithubRemote, activePath, targetBranch, changeCount, refreshChanges]);

  // Re-check as soon as the active chat agent finishes (Commit changes flow).
  const activeChatTabId = useCenterViewStore((s) => {
    const active = s.tabs.find((t) => t.id === s.activeTabId);
    return active?.type === 'chat' ? active.id : null;
  });
  const chatLoading = useChatStore((s) =>
    activeChatTabId ? (s.tabs[activeChatTabId]?.loading ?? false) : false,
  );
  useEffect(() => {
    const wasLoading = prevChatLoading.current;
    prevChatLoading.current = chatLoading;
    if (!activePath) return;
    if (!(wasLoading && !chatLoading)) return;

    if (hasGithubRemote) {
      invalidatePrCache(activePath);
      void ghPrViewCached(activePath, { force: true })
        .then((info) => {
          setExistingPr(info);
          if (info) void closeLinkedIssuesIfPrOpen(info, activePath);
        })
        .catch(() => {});
      return;
    }

    void refreshChanges();
    void gitMergeReadiness(activePath, targetBranch)
      .then(setReadiness)
      .catch(() => {});
  }, [chatLoading, hasGithubRemote, activePath, targetBranch, refreshChanges]);

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

  /** Attach a prompt chip and immediately send — used for Create PR / Commit only. */
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

  const attachAndSendPrPrompt = () => {
    void (async () => {
      const linked = (await listLinkedIssues(activePath)).filter((issue) => !issue.closed);
      attachAndSendPrompt('Create PR', prCreationPrompt(targetBranch, linked));
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
              onClick={() => void attachAndSendPrPrompt()}
              title={`Create PR into ${targetBranch}`}
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
                  attachAndSendPrPrompt();
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

  // --- Local repo: commit with agent, then merge/rebase via git ---
  // Prefer live readiness; only fall back to the Changes list before the first
  // readiness result arrives.
  const dirty = readiness ? readiness.dirty : changeCount > 0;
  const aheadCount = readiness?.aheadCount ?? 0;
  const hasConflicts = readiness?.hasConflicts ?? false;
  const canShowMerge = aheadCount > 0;
  const canMerge = canShowMerge && !hasConflicts && (readiness?.safeToMerge ?? false);
  const sourceBranch = readiness?.currentBranch ?? '';
  const cannotMergeReason =
    readiness?.reason
    || (hasConflicts ? `Cannot merge — conflicts with ${targetBranch}` : null);

  const runMerge = async () => {
    if (!projectPath || !sourceBranch) {
      setActionError('Cannot merge — missing project path or branch.');
      return;
    }
    if (!canMerge) {
      setActionError(cannotMergeReason || `Cannot merge into ${targetBranch}`);
      return;
    }
    setActionBusy(true);
    setActionError(null);
    setOpen(false);
    try {
      await gitMergeToTarget(projectPath, sourceBranch, targetBranch);
      await refreshChanges();
      const next = await gitMergeReadiness(activePath, targetBranch);
      setReadiness(next);
    } catch (e) {
      setActionError(String(e));
      // Refresh readiness so the button reflects conflict / blocked state.
      void gitMergeReadiness(activePath, targetBranch).then(setReadiness).catch(() => {});
    } finally {
      setActionBusy(false);
    }
  };

  const runRebase = async () => {
    setActionBusy(true);
    setActionError(null);
    setOpen(false);
    try {
      await gitRebaseOntoTarget(activePath, targetBranch);
      await refreshChanges();
      const next = await gitMergeReadiness(activePath, targetBranch);
      setReadiness(next);
    } catch (e) {
      setActionError(String(e));
    } finally {
      setActionBusy(false);
    }
  };

  // Commits ahead of target → show Merge (even with uncommitted files).
  if (canShowMerge) {
    return (
      <div className="create-pr-wrap">
        <div className="create-pr-split">
          <button
            className={`create-pr-main${canMerge ? '' : ' create-pr-disabled'}`}
            onClick={() => void runMerge()}
            disabled={actionBusy || !canMerge}
            title={
              canMerge
                ? `Merge ${sourceBranch} into ${targetBranch}`
                : (cannotMergeReason || `Cannot merge into ${targetBranch}`)
            }
          >
            {actionBusy ? 'Working…' : 'Merge'}
          </button>
          <button
            className="create-pr-arrow"
            onClick={(e) => { e.stopPropagation(); setOpen((v) => !v); }}
            disabled={actionBusy}
            aria-label="Merge options"
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
                void runRebase();
              }}
            >
              Rebase onto {targetBranch}
            </button>
            {dirty && (
              <button
                className="create-pr-item"
                onClick={(e) => {
                  e.stopPropagation();
                  setOpen(false);
                  attachAndSendPrompt('Commit changes', commitChangesPrompt(targetBranch));
                }}
              >
                Commit changes
              </button>
            )}
          </div>
        )}
        {(actionError || (!canMerge && cannotMergeReason)) && (
          <div
            className="create-pr-action-error"
            title={actionError || cannotMergeReason || undefined}
          >
            {actionError || cannotMergeReason}
          </div>
        )}
      </div>
    );
  }

  // Nothing ahead — offer Commit when the worktree is dirty.
  if (dirty) {
    return (
      <div className="create-pr-wrap">
        <button
          className="create-pr-main create-pr-merge-solo"
          onClick={() =>
            attachAndSendPrompt('Commit changes', commitChangesPrompt(targetBranch))
          }
          title="Review the diff, write a commit message, and commit"
        >
          Commit changes
        </button>
        {actionError && (
          <div className="create-pr-action-error" title={actionError}>
            {actionError}
          </div>
        )}
      </div>
    );
  }

  if (actionError) {
    return (
      <div className="create-pr-wrap">
        <div className="create-pr-action-error" title={actionError}>
          {actionError}
        </div>
      </div>
    );
  }

  return null;
}
