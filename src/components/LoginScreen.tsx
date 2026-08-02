import { IconBrandGithub, IconLoader2 } from "@tabler/icons-react";
import { useAuthStore } from "../store/authStore";
import "./LoginScreen.css";

export default function LoginScreen() {
  const status = useAuthStore((s) => s.status);
  const error = useAuthStore((s) => s.error);
  const startLogin = useAuthStore((s) => s.startLogin);
  const cancelLogin = useAuthStore((s) => s.cancelLogin);

  const signingIn = status === "signingIn";

  return (
    <div className="login-screen">
      <div className="login-card">
        <div className="login-brand">Fold</div>
        <div className="login-tagline">
          Sign in to sync your projects and manage GitHub from Fold.
        </div>

        {signingIn ? (
          <div className="login-waiting">
            <div className="login-hint">
              <IconLoader2 size={16} className="login-spin" />
              Waiting for authorization in your browser…
            </div>
            <button
              className="ghost-btn"
              type="button"
              onClick={() => cancelLogin()}
            >
              Cancel
            </button>
          </div>
        ) : (
          <button
            className="primary-btn login-github-btn"
            type="button"
            onClick={() => void startLogin()}
          >
            <IconBrandGithub size={18} stroke={1.75} />
            Sign in with GitHub
          </button>
        )}

        {error && <div className="login-error">{error}</div>}
      </div>
    </div>
  );
}
