import { memo, lazy, Suspense, useEffect, useState } from "react";
import { useProjectStore } from "../store/projectStore";
import "./TerminalPanel.css";

const XTerminal = lazy(() => import("./XTerminal"));

interface TerminalTab {
  id: string;
  label: string;
}

let nextTerminalId = 1;

function createTerminalTab(): TerminalTab {
  const id = `term-${nextTerminalId}`;
  const label = `Terminal ${nextTerminalId}`;
  nextTerminalId += 1;
  return { id, label };
}

const INITIAL_TERMINAL = createTerminalTab();

function TerminalPanel() {
  const [terminals, setTerminals] = useState<TerminalTab[]>([INITIAL_TERMINAL]);
  const [activeId, setActiveId] = useState(INITIAL_TERMINAL.id);
  // Defer PTY spawn so it doesn't compete with auth/projects/harness startup.
  const [spawnReady, setSpawnReady] = useState(false);
  const activePath = useProjectStore((s) => s.activePath);

  useEffect(() => {
    let cancelled = false;
    const win = window as Window & {
      requestIdleCallback?: (cb: () => void, opts?: { timeout: number }) => number;
      cancelIdleCallback?: (id: number) => void;
    };
    let idleId: number;
    if (typeof win.requestIdleCallback === "function") {
      idleId = win.requestIdleCallback(
        () => {
          if (!cancelled) setSpawnReady(true);
        },
        { timeout: 1500 },
      );
    } else {
      idleId = window.setTimeout(() => {
        if (!cancelled) setSpawnReady(true);
      }, 400);
    }
    return () => {
      cancelled = true;
      if (typeof win.cancelIdleCallback === "function") {
        win.cancelIdleCallback(idleId);
      } else {
        window.clearTimeout(idleId);
      }
    };
  }, []);

  const addTerminal = () => {
    const tab = createTerminalTab();
    setTerminals((prev) => [...prev, tab]);
    setActiveId(tab.id);
  };

  const closeTerminal = (id: string) => {
    setTerminals((prev) => {
      if (prev.length <= 1) return prev;
      const next = prev.filter((t) => t.id !== id);
      if (activeId === id) {
        setActiveId(next[0]?.id ?? "");
      }
      return next;
    });
  };

  return (
    <div className="terminal-panel">
      <div className="tabbar terminal-tabbar">
        {terminals.map((t) => (
          <div
            key={t.id}
            className={`tab ${t.id === activeId ? "active" : ""}`}
            onClick={() => setActiveId(t.id)}
          >
            <span>{t.label}</span>
            {terminals.length > 1 && (
              <span
                className="close"
                onClick={(e) => {
                  e.stopPropagation();
                  closeTerminal(t.id);
                }}
              >
                ×
              </span>
            )}
          </div>
        ))}
        <div className="tab-add" onClick={addTerminal} title="New terminal">
          +
        </div>
      </div>
      <div className="terminal-panel-body">
        {activePath && spawnReady ? (
          <Suspense fallback={<div className="terminal-empty">Starting terminal…</div>}>
            {terminals.map((t) => (
              <XTerminal
                key={t.id}
                id={t.id}
                cwd={activePath}
                active={t.id === activeId}
              />
            ))}
          </Suspense>
        ) : activePath ? (
          <div className="terminal-empty">Starting terminal…</div>
        ) : (
          <div className="terminal-empty">No worktree selected</div>
        )}
      </div>
    </div>
  );
}

/** Panel resizes re-render the parent every frame; this subtree doesn't need to. */
export default memo(TerminalPanel);
