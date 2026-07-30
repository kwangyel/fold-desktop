import { useEffect, useState } from "react";
import {
  IconBrandGithub,
  IconBrandGitlab,
  IconCheck,
  IconCopy,
  IconLoader2,
} from "@tabler/icons-react";
import { useGithubStore } from "../store/githubStore";
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

  const [copied, setCopied] = useState(false);

  useEffect(() => {
    void refresh();
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
      <div className="dialog" onMouseDown={(e) => e.stopPropagation()}>
        <div className="dialog-header">Connect App</div>

        <div className="dialog-body">
          <div className="app-list">
            {/* GitHub — the one actionable integration for now. */}
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

            {/* Coming-soon integrations. */}
            <div className="app-row disabled">
              <div className="app-icon gitlab">
                <IconBrandGitlab size={20} stroke={1.75} />
              </div>
              <div className="app-meta">
                <div className="app-name">GitLab</div>
                <div className="app-sub">Coming soon</div>
              </div>
            </div>
            <div className="app-row disabled">
              <div className="app-icon linear">L</div>
              <div className="app-meta">
                <div className="app-name">Linear</div>
                <div className="app-sub">Coming soon</div>
              </div>
            </div>
          </div>

          {error && <div className="dialog-error">{error}</div>}
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
