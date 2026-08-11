import { memo, lazy, Suspense, useEffect, useState } from "react";
import { useProjectStore } from "../store/projectStore";
import { useTerminalStore } from "../store/terminalStore";
import "./TerminalPanel.css";

const XTerminal = lazy(() => import("./XTerminal"));

interface TerminalTab {
  id: string;
  label: string;
  /** When set, this tab stays in that directory instead of following activePath. */
  pinnedCwd?: string;
  /** Command to inject once after the PTY starts. */
  initialCommand?: string;
}

let nextTerminalId = 1;

function createTerminalTab(opts?: {
  label?: string;
  pinnedCwd?: string;
  initialCommand?: string;
  id?: string;
}): TerminalTab {
  const n = nextTerminalId;
  nextTerminalId += 1;
  return {
    id: opts?.id ?? `term-${n}`,
    label: opts?.label ?? `Terminal ${n}`,
    pinnedCwd: opts?.pinnedCwd,
    initialCommand: opts?.initialCommand,
  };
}

const INITIAL_TERMINAL = createTerminalTab();

function TerminalPanel() {
  const activePath = useProjectStore((s) => s.activePath);
  const [terminals, setTerminals] = useState<TerminalTab[]>([INITIAL_TERMINAL]);
  const [activeId, setActiveId] = useState(INITIAL_TERMINAL.id);
  // Defer PTY spawn so it doesn't compete with auth/projects/harness startup.
  const [spawnReady, setSpawnReady] = useState(false);
  const requests = useTerminalStore((s) => s.requests);
  const acknowledge = useTerminalStore((s) => s.acknowledge);

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

  // Absorb external open requests (setup script, etc.) into local tabs.
  useEffect(() => {
    if (requests.length === 0) return;
    const batch = [...requests];
    for (const req of batch) acknowledge(req.id);
    const tabs = batch.map((req) =>
      createTerminalTab({
        id: req.id,
        label: req.label,
        pinnedCwd: req.cwd,
        initialCommand: req.command,
      }),
    );
    setTerminals((prev) => [...prev, ...tabs]);
    setActiveId(tabs[tabs.length - 1].id);
  }, [requests, acknowledge]);

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
            {terminals.map((t) => {
              const cwd = t.pinnedCwd ?? activePath;
              return (
                <XTerminal
                  key={t.id}
                  id={t.id}
                  cwd={cwd}
                  active={t.id === activeId}
                  initialCommand={t.initialCommand}
                />
              );
            })}
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
