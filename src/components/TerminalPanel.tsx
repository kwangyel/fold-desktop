import { useState } from "react";
import XTerminal from "./XTerminal";
import "./TerminalPanel.css";

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

export default function TerminalPanel() {
  const [terminals, setTerminals] = useState<TerminalTab[]>([INITIAL_TERMINAL]);
  const [activeId, setActiveId] = useState(INITIAL_TERMINAL.id);

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
        {terminals.map((t) => (
          <XTerminal key={t.id} id={t.id} active={t.id === activeId} />
        ))}
      </div>
    </div>
  );
}
