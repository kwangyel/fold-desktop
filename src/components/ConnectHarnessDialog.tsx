import { useEffect, useRef } from "react";
import {
  IconCheck,
  IconExternalLink,
  IconLoader2,
  IconRefresh,
} from "@tabler/icons-react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { HARNESS_CATALOG } from "../lib/harnesses";
import { useClaudeStore } from "../store/claudeStore";
import { useHarnessStore } from "../store/harnessStore";
import HarnessIcon from "./icons/HarnessIcon";
import "@xterm/xterm/css/xterm.css";
import "./ConnectHarnessDialog.css";

function methodLabel(method: string | null): string {
  if (method === "apiKey") return "API key";
  if (method === "subscription") return "subscription";
  return method ?? "connected";
}

function ClaudeLoginTerminal() {
  const containerRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<Terminal | null>(null);
  const subscribeLoginOutput = useClaudeStore((s) => s.subscribeLoginOutput);
  const writeLogin = useClaudeStore((s) => s.writeLogin);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const term = new Terminal({
      fontFamily: '"SF Mono", Menlo, monospace',
      fontSize: 11,
      lineHeight: 1.2,
      cursorBlink: true,
      convertEol: true,
      theme: {
        background: "#101014",
        foreground: "#e6e6e6",
        cursor: "#d97757",
        selectionBackground: "rgba(217, 119, 87, 0.3)",
      },
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(container);
    fit.fit();
    termRef.current = term;

    const unsub = subscribeLoginOutput((bytes) => {
      term.write(bytes);
    });

    const dataSub = term.onData((data) => {
      void writeLogin(data);
    });

    const observer = new ResizeObserver(() => fit.fit());
    observer.observe(container);

    return () => {
      observer.disconnect();
      dataSub.dispose();
      unsub();
      term.dispose();
      termRef.current = null;
    };
  }, [subscribeLoginOutput, writeLogin]);

  return <div ref={containerRef} className="harness-login-terminal" />;
}

function ClaudeCodeRow() {
  const installed = useClaudeStore((s) => s.installed);
  const authenticated = useClaudeStore((s) => s.authenticated);
  const method = useClaudeStore((s) => s.method);
  const checking = useClaudeStore((s) => s.checking);
  const connecting = useClaudeStore((s) => s.connecting);
  const error = useClaudeStore((s) => s.error);
  const refresh = useClaudeStore((s) => s.refresh);
  const startLogin = useClaudeStore((s) => s.startLogin);
  const openInstallDocs = useClaudeStore((s) => s.openInstallDocs);
  const refreshHarnessModels = useHarnessStore((s) => s.refresh);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // After connect status changes to authenticated, refresh model catalog.
  useEffect(() => {
    if (authenticated) {
      void refreshHarnessModels();
    }
  }, [authenticated, refreshHarnessModels]);

  const harness = HARNESS_CATALOG[0];
  return (
    <>
      <div className="harness-row">
        <HarnessIcon harness={harness} size={34} />
        <div className="harness-meta">
          <div className="harness-name">{harness.name}</div>
          <div className="harness-sub">
            {!installed
              ? "Claude Code CLI not found"
              : authenticated
                ? `Connected (${methodLabel(method)})`
                : harness.description}
          </div>
        </div>

        <div className="harness-actions">
          <button
            className="ghost-btn harness-refresh-btn"
            type="button"
            disabled={checking || connecting}
            onClick={() => void refresh()}
            title="Recheck Claude Code connection"
            aria-label="Refresh Claude Code status"
          >
            <IconRefresh
              size={14}
              stroke={1.75}
              className={checking ? "spin" : undefined}
            />
          </button>

          {!installed ? (
            <button
              className="ghost-btn harness-connect-btn"
              type="button"
              onClick={() => void openInstallDocs()}
            >
              Install
              <IconExternalLink size={13} stroke={1.75} />
            </button>
          ) : authenticated ? (
            <span className="harness-connected">
              <IconCheck size={15} stroke={2.25} />
              Connected
            </span>
          ) : (
            <button
              className="primary-btn harness-connect-btn"
              type="button"
              disabled={checking || connecting}
              onClick={() => void startLogin()}
            >
              {connecting ? "Logging in…" : "Log in"}
            </button>
          )}
        </div>
      </div>

      {connecting && (
        <div className="harness-login-panel">
          <div className="harness-login-hint">
            <IconLoader2 size={14} className="spin" />
            Waiting for authorization… complete login in the terminal below.
          </div>
          <ClaudeLoginTerminal />
        </div>
      )}

      {error && <div className="dialog-error">{error}</div>}
    </>
  );
}

export default function ConnectHarnessDialog({
  onClose,
}: {
  onClose: () => void;
}) {
  const connecting = useClaudeStore((s) => s.connecting);
  const cancelLogin = useClaudeStore((s) => s.cancelLogin);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") handleClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function handleClose() {
    if (connecting) void cancelLogin();
    onClose();
  }

  return (
    <div className="dialog-overlay" onMouseDown={handleClose}>
      <div
        className={`dialog ${connecting ? "dialog-wide" : ""}`}
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="dialog-header">Connect Harness</div>

        <div className="dialog-body">
          <p className="harness-intro">
            Link an agent harness so Fold can run coding agents in your
            worktrees.
          </p>

          <div className="harness-list">
            <ClaudeCodeRow />

            {HARNESS_CATALOG.slice(1).map((harness) => (
              <div key={harness.id} className="harness-row">
                <HarnessIcon harness={harness} size={34} />
                <div className="harness-meta">
                  <div className="harness-name">{harness.name}</div>
                  <div className="harness-sub">{harness.description}</div>
                </div>
                <button
                  className="ghost-btn harness-connect-btn"
                  type="button"
                  disabled
                  title="Coming soon"
                >
                  Connect
                </button>
              </div>
            ))}
          </div>
        </div>

        <div className="dialog-footer">
          <button className="ghost-btn" type="button" onClick={handleClose}>
            {connecting ? "Cancel" : "Close"}
          </button>
        </div>
      </div>
    </div>
  );
}
