import { useEffect, useRef, useState, type FormEvent } from "react";
import {
  IconCheck,
  IconExternalLink,
  IconLoader2,
  IconRefresh,
} from "@tabler/icons-react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { HARNESS_CATALOG, harnessMeta } from "../lib/harnesses";
import { useClaudeStore } from "../store/claudeStore";
import { useCodexStore } from "../store/codexStore";
import { useCursorStore } from "../store/cursorStore";
import { useHarnessStore } from "../store/harnessStore";
import { useOpenCodeStore } from "../store/opencodeStore";
import HarnessIcon from "./icons/HarnessIcon";
import "@xterm/xterm/css/xterm.css";
import "./ConnectHarnessDialog.css";

function methodLabel(method: string | null): string {
  if (method === "apiKey") return "API key";
  if (method === "subscription") return "subscription";
  return method ?? "connected";
}

type LoginTerminalProps = {
  subscribeLoginOutput: (listener: (data: Uint8Array) => void) => () => void;
  writeLogin: (data: string) => Promise<void>;
  cursorColor?: string;
};

function LoginTerminal({
  subscribeLoginOutput,
  writeLogin,
  cursorColor = "#d97757",
}: LoginTerminalProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<Terminal | null>(null);

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
        cursor: cursorColor,
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
  }, [subscribeLoginOutput, writeLogin, cursorColor]);

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
  const subscribeLoginOutput = useClaudeStore((s) => s.subscribeLoginOutput);
  const writeLogin = useClaudeStore((s) => s.writeLogin);
  const refreshHarnessModels = useHarnessStore((s) => s.refresh);

  useEffect(() => {
    void refresh();
  }, [refresh]);

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
          <LoginTerminal
            subscribeLoginOutput={subscribeLoginOutput}
            writeLogin={writeLogin}
          />
        </div>
      )}

      {error && <div className="dialog-error">{error}</div>}
    </>
  );
}

function CodexRow() {
  const installed = useCodexStore((s) => s.installed);
  const authenticated = useCodexStore((s) => s.authenticated);
  const method = useCodexStore((s) => s.method);
  const checking = useCodexStore((s) => s.checking);
  const connecting = useCodexStore((s) => s.connecting);
  const error = useCodexStore((s) => s.error);
  const refresh = useCodexStore((s) => s.refresh);
  const startLogin = useCodexStore((s) => s.startLogin);
  const openInstallDocs = useCodexStore((s) => s.openInstallDocs);
  const subscribeLoginOutput = useCodexStore((s) => s.subscribeLoginOutput);
  const writeLogin = useCodexStore((s) => s.writeLogin);
  const refreshHarnessModels = useHarnessStore((s) => s.refresh);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => {
    if (authenticated) {
      void refreshHarnessModels();
    }
  }, [authenticated, refreshHarnessModels]);

  const harness = harnessMeta("codex");
  return (
    <>
      <div className="harness-row">
        <HarnessIcon harness={harness} size={34} />
        <div className="harness-meta">
          <div className="harness-name">{harness.name}</div>
          <div className="harness-sub">
            {!installed
              ? "Codex CLI not found"
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
            title="Recheck Codex connection"
            aria-label="Refresh Codex status"
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
            Waiting for authorization… complete ChatGPT / API key login below.
          </div>
          <LoginTerminal
            subscribeLoginOutput={subscribeLoginOutput}
            writeLogin={writeLogin}
            cursorColor="#10a37f"
          />
        </div>
      )}

      {error && <div className="dialog-error">{error}</div>}
    </>
  );
}

function OpenCodeRow() {
  const installed = useOpenCodeStore((s) => s.installed);
  const authenticated = useOpenCodeStore((s) => s.authenticated);
  const method = useOpenCodeStore((s) => s.method);
  const providerCount = useOpenCodeStore((s) => s.providerCount);
  const checking = useOpenCodeStore((s) => s.checking);
  const connecting = useOpenCodeStore((s) => s.connecting);
  const error = useOpenCodeStore((s) => s.error);
  const refresh = useOpenCodeStore((s) => s.refresh);
  const startLogin = useOpenCodeStore((s) => s.startLogin);
  const openInstallDocs = useOpenCodeStore((s) => s.openInstallDocs);
  const subscribeLoginOutput = useOpenCodeStore((s) => s.subscribeLoginOutput);
  const writeLogin = useOpenCodeStore((s) => s.writeLogin);
  const refreshHarnessModels = useHarnessStore((s) => s.refresh);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => {
    if (authenticated) {
      void refreshHarnessModels();
    }
  }, [authenticated, refreshHarnessModels]);

  const harness = harnessMeta("opencode");
  let subtitle = harness.description;
  if (!installed) {
    subtitle = "OpenCode CLI not found";
  } else if (authenticated) {
    subtitle =
      providerCount > 0
        ? `Connected · ${providerCount} provider${providerCount === 1 ? "" : "s"} (${methodLabel(method)})`
        : `Connected (${methodLabel(method)})`;
  }

  return (
    <>
      <div className="harness-row">
        <HarnessIcon harness={harness} size={34} />
        <div className="harness-meta">
          <div className="harness-name">{harness.name}</div>
          <div className="harness-sub">{subtitle}</div>
        </div>

        <div className="harness-actions">
          <button
            className="ghost-btn harness-refresh-btn"
            type="button"
            disabled={checking || connecting}
            onClick={() => void refresh()}
            title="Recheck OpenCode connection"
            aria-label="Refresh OpenCode status"
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
            Select a provider and paste an API key in the terminal below.
          </div>
          <LoginTerminal
            subscribeLoginOutput={subscribeLoginOutput}
            writeLogin={writeLogin}
            cursorColor="#2563eb"
          />
        </div>
      )}

      {error && <div className="dialog-error">{error}</div>}
    </>
  );
}

function CursorRow() {
  const authenticated = useCursorStore((s) => s.authenticated);
  const method = useCursorStore((s) => s.method);
  const apiKeyName = useCursorStore((s) => s.apiKeyName);
  const userEmail = useCursorStore((s) => s.userEmail);
  const cliInstalled = useCursorStore((s) => s.cliInstalled);
  const checking = useCursorStore((s) => s.checking);
  const connecting = useCursorStore((s) => s.connecting);
  const disconnecting = useCursorStore((s) => s.disconnecting);
  const error = useCursorStore((s) => s.error);
  const refresh = useCursorStore((s) => s.refresh);
  const connect = useCursorStore((s) => s.connect);
  const disconnect = useCursorStore((s) => s.disconnect);
  const openApiKeyDocs = useCursorStore((s) => s.openApiKeyDocs);
  const openCliDocs = useCursorStore((s) => s.openCliDocs);
  const refreshHarnessModels = useHarnessStore((s) => s.refresh);

  const [apiKey, setApiKey] = useState("");

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => {
    void refreshHarnessModels();
  }, [authenticated, refreshHarnessModels]);

  const harness = harnessMeta("cursor");

  let subtitle = harness.description;
  if (authenticated) {
    const who = apiKeyName || userEmail;
    subtitle = who
      ? `Connected · ${who} (${methodLabel(method)})`
      : `Connected (${methodLabel(method)})`;
    if (!cliInstalled) {
      subtitle += " · Agent CLI missing";
    }
  }

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    await connect(apiKey);
    if (useCursorStore.getState().authenticated) {
      setApiKey("");
      void refreshHarnessModels();
    }
  }

  async function onDisconnect() {
    await disconnect();
    setApiKey("");
    void refreshHarnessModels();
  }

  return (
    <>
      <div className="harness-row">
        <HarnessIcon harness={harness} size={34} />
        <div className="harness-meta">
          <div className="harness-name">{harness.name}</div>
          <div className="harness-sub">{subtitle}</div>
        </div>

        <div className="harness-actions">
          <button
            className="ghost-btn harness-refresh-btn"
            type="button"
            disabled={checking || connecting || disconnecting}
            onClick={() => void refresh()}
            title="Recheck Cursor connection"
            aria-label="Refresh Cursor status"
          >
            <IconRefresh
              size={14}
              stroke={1.75}
              className={checking ? "spin" : undefined}
            />
          </button>

          {authenticated ? (
            <div className="harness-connected-actions">
              <span className="harness-connected">
                <IconCheck size={15} stroke={2.25} />
                Connected
              </span>
              <button
                className="ghost-btn harness-connect-btn"
                type="button"
                disabled={disconnecting}
                onClick={() => void onDisconnect()}
              >
                {disconnecting ? "Disconnecting…" : "Disconnect"}
              </button>
            </div>
          ) : null}
        </div>
      </div>

      {/* API key field is always visible so connect/update is obvious. */}
      <form className="harness-login-panel" onSubmit={(e) => void onSubmit(e)}>
        <div className="harness-login-hint">
          {authenticated
            ? "Paste a new key to replace the saved one, or disconnect above."
            : "Paste your Cursor API key. Fold validates it with the Cloud Agents API, then runs chat via the Agent CLI."}
        </div>
        <div className="field">
          <label htmlFor="cursor-api-key">Cursor API key</label>
          <input
            id="cursor-api-key"
            type="password"
            autoComplete="off"
            spellCheck={false}
            placeholder="crsr_… or key from cursor.com/dashboard/api"
            value={apiKey}
            disabled={connecting || disconnecting}
            onChange={(e) => setApiKey(e.target.value)}
          />
        </div>
        {!cliInstalled && (
          <div className="harness-login-hint harness-warn-hint">
            Cursor Agent CLI not found — install it to run chat in worktrees.
            <button
              className="ghost-btn harness-connect-btn"
              type="button"
              onClick={() => void openCliDocs()}
            >
              Install CLI
              <IconExternalLink size={13} stroke={1.75} />
            </button>
          </div>
        )}
        <div className="harness-key-form-actions">
          <button
            className="ghost-btn harness-connect-btn"
            type="button"
            onClick={() => void openApiKeyDocs()}
          >
            Get API key
            <IconExternalLink size={13} stroke={1.75} />
          </button>
          <button
            className="primary-btn harness-connect-btn"
            type="submit"
            disabled={connecting || !apiKey.trim()}
          >
            {connecting ? (
              <>
                <IconLoader2 size={13} className="spin" />
                Validating…
              </>
            ) : authenticated ? (
              "Update key"
            ) : (
              "Save & connect"
            )}
          </button>
        </div>
      </form>

      {error && <div className="dialog-error">{error}</div>}
    </>
  );
}

export default function ConnectHarnessDialog({
  onClose,
}: {
  onClose: () => void;
}) {
  const claudeConnecting = useClaudeStore((s) => s.connecting);
  const cancelClaudeLogin = useClaudeStore((s) => s.cancelLogin);
  const codexConnecting = useCodexStore((s) => s.connecting);
  const cancelCodexLogin = useCodexStore((s) => s.cancelLogin);
  const opencodeConnecting = useOpenCodeStore((s) => s.connecting);
  const cancelOpenCodeLogin = useOpenCodeStore((s) => s.cancelLogin);

  const anyConnecting =
    claudeConnecting || codexConnecting || opencodeConnecting;

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") handleClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function handleClose() {
    if (claudeConnecting) void cancelClaudeLogin();
    if (codexConnecting) void cancelCodexLogin();
    if (opencodeConnecting) void cancelOpenCodeLogin();
    onClose();
  }

  return (
    <div className="dialog-overlay" onMouseDown={handleClose}>
      <div
        className={`dialog dialog-wide`}
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
            <CodexRow />
            <CursorRow />
            <OpenCodeRow />
          </div>
        </div>

        <div className="dialog-footer">
          <button className="ghost-btn" type="button" onClick={handleClose}>
            {anyConnecting ? "Cancel" : "Close"}
          </button>
        </div>
      </div>
    </div>
  );
}
