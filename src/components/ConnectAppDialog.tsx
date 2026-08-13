import { useEffect, useState } from "react";
import {
  IconBrandGithub,
  IconCheck,
  IconCopy,
  IconLoader2,
} from "@tabler/icons-react";
import { useGithubStore } from "../store/githubStore";
import { useLinearStore } from "../store/linearStore";
import LinearLogo from "./icons/LinearLogo";
import "./ConnectAppDialog.css";

export default function ConnectAppDialog({ onClose }: { onClose: () => void }) {
  const authenticated = useGithubStore((s) => s.authenticated);
  const username = useGithubStore((s) => s.username);
  const checking = useGithubStore((s) => s.checking);
  const connecting = useGithubStore((s) => s.connecting);
  const code = useGithubStore((s) => s.code);
  const disconnecting = useGithubStore((s) => s.disconnecting);
  const error = useGithubStore((s) => s.error);
  const refresh = useGithubStore((s) => s.refresh);
  const startLogin = useGithubStore((s) => s.startLogin);
  const cancelLogin = useGithubStore((s) => s.cancelLogin);
  const logout = useGithubStore((s) => s.logout);

  const linearConnecting = useLinearStore((s) => s.connecting);
  const cancelLinearLogin = useLinearStore((s) => s.cancelLogin);

  const [copied, setCopied] = useState(false);
  const anyConnecting = connecting || linearConnecting;

  useEffect(() => {
    void refresh();
    void useLinearStore.getState().refresh();
  }, [refresh]);

  // Close on Escape (cancels any in-flight login first).
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
    if (linearConnecting) void cancelLinearLogin();
    onClose();
  }

  async function copyCode() {
    if (!code) return;
    try {
      await navigator.clipboard.writeText(code);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // Clipboard may be unavailable; ignore.
    }
  }

  return (
    <div className="dialog-overlay" onMouseDown={handleClose}>
      <div className="dialog dialog-wide" onMouseDown={(e) => e.stopPropagation()}>
        <div className="dialog-header">Connect App</div>

        <div className="dialog-body">
          <div className="app-list">
            {/* GitHub — repos, PRs, and clone. */}
            <div className="app-row">
              <div className="app-icon github">
                <IconBrandGithub size={20} stroke={1.75} />
              </div>
              <div className="app-meta">
                <div className="app-name">GitHub</div>
                <div className="app-sub">
                  {authenticated && username
                    ? `Connected as @${username}`
                    : "Create pull requests, merge, and manage branches"}
                </div>
              </div>
              {authenticated ? (
                <div className="app-connected-actions">
                  <span className="app-connected">
                    <IconCheck size={15} stroke={2.25} />
                    Connected
                  </span>
                  <button
                    className="ghost-btn app-connect-btn"
                    type="button"
                    disabled={disconnecting}
                    onClick={() => void logout()}
                  >
                    {disconnecting ? "Disconnecting…" : "Disconnect"}
                  </button>
                </div>
              ) : (
                <button
                  className="primary-btn app-connect-btn"
                  type="button"
                  disabled={checking || connecting}
                  onClick={() => void startLogin()}
                >
                  {connecting ? "Connecting…" : "Connect"}
                </button>
              )}
            </div>

            {/* Device-code panel shown while the browser flow is running. */}
            {connecting && (
              <div className="device-panel">
                {code ? (
                  <>
                    <div className="device-label">
                      Enter this code at{" "}
                      <code>github.com/login/device</code> in your browser:
                    </div>
                    <button
                      className="device-code"
                      type="button"
                      onClick={copyCode}
                      title="Copy code"
                    >
                      <span>{code}</span>
                      {copied ? (
                        <IconCheck size={16} stroke={2} />
                      ) : (
                        <IconCopy size={16} stroke={1.75} />
                      )}
                    </button>
                    <div className="device-hint">
                      <IconLoader2 size={14} className="spin" />
                      Waiting for authorization…
                    </div>
                  </>
                ) : (
                  <div className="device-hint">
                    <IconLoader2 size={14} className="spin" />
                    Starting GitHub sign-in…
                  </div>
                )}
              </div>
            )}

            {error && <div className="dialog-error">{error}</div>}

            <LinearRow />
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

function LinearRow() {
  const authenticated = useLinearStore((s) => s.authenticated);
  const userName = useLinearStore((s) => s.userName);
  const userEmail = useLinearStore((s) => s.userEmail);
  const organizationName = useLinearStore((s) => s.organizationName);
  const checking = useLinearStore((s) => s.checking);
  const connecting = useLinearStore((s) => s.connecting);
  const disconnecting = useLinearStore((s) => s.disconnecting);
  const error = useLinearStore((s) => s.error);
  const startLogin = useLinearStore((s) => s.startLogin);
  const disconnect = useLinearStore((s) => s.disconnect);

  let subtitle = "Attach issues when creating worktrees and chatting";
  if (authenticated) {
    const parts = [userName || userEmail, organizationName].filter(Boolean);
    subtitle = parts.length > 0 ? `Connected as ${parts.join(" · ")}` : "Connected";
  }

  return (
    <>
      <div className="app-row">
        <div className="app-icon linear">
          <LinearLogo size={18} />
        </div>
        <div className="app-meta">
          <div className="app-name">Linear</div>
          <div className="app-sub">{subtitle}</div>
        </div>
        {authenticated ? (
          <div className="app-connected-actions">
            <span className="app-connected">
              <IconCheck size={15} stroke={2.25} />
              Connected
            </span>
            <button
              className="ghost-btn app-connect-btn"
              type="button"
              disabled={disconnecting}
              onClick={() => void disconnect()}
            >
              {disconnecting ? "Disconnecting…" : "Disconnect"}
            </button>
          </div>
        ) : (
          <button
            className="primary-btn app-connect-btn"
            type="button"
            disabled={checking || connecting}
            onClick={() => void startLogin()}
          >
            {connecting ? "Connecting…" : "Connect"}
          </button>
        )}
      </div>

      {connecting && (
        <div className="device-panel">
          <div className="device-hint">
            <IconLoader2 size={14} className="spin" />
            Waiting for Linear authorization in your browser…
          </div>
        </div>
      )}

      {error && <div className="dialog-error">{error}</div>}
    </>
  );
}
