import { useEffect, useState } from "react";
import { IconChevronDown, IconLogout } from "@tabler/icons-react";
import { fetch } from "@tauri-apps/plugin-http";
import { resolveUserAvatarUrl } from "../lib/auth";
import { isTauri } from "../lib/git";
import { useAuthStore } from "../store/authStore";
import "./UserMenu.css";

export default function UserMenu() {
  const user = useAuthStore((s) => s.user);
  const logout = useAuthStore((s) => s.logout);
  const [open, setOpen] = useState(false);
  const [imgError, setImgError] = useState(false);
  const [avatarSrc, setAvatarSrc] = useState<string | null>(null);

  const remoteAvatar = user ? resolveUserAvatarUrl(user) : null;

  // Load the saved avatar via Tauri's HTTP client (img tags can fail on external URLs).
  useEffect(() => {
    setImgError(false);
    if (!remoteAvatar) {
      setAvatarSrc(null);
      return;
    }
    if (!isTauri()) {
      setAvatarSrc(remoteAvatar);
      return;
    }

    let cancelled = false;
    let objectUrl: string | null = null;
    void (async () => {
      try {
        const res = await fetch(remoteAvatar, { method: "GET" });
        if (!res.ok) throw new Error(String(res.status));
        const blob = await res.blob();
        objectUrl = URL.createObjectURL(blob);
        if (!cancelled) setAvatarSrc(objectUrl);
      } catch {
        if (!cancelled) setAvatarSrc(remoteAvatar);
      }
    })();

    return () => {
      cancelled = true;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [remoteAvatar]);

  // Close the dropdown on any outside interaction / Escape.
  useEffect(() => {
    if (!open) return;
    const close = () => setOpen(false);
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    window.addEventListener("click", close);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("click", close);
      window.removeEventListener("keydown", onKey);
    };
  }, [open]);

  if (!user) return null;

  const name = user.githubUsername || user.email || "Account";
  const initial = name.charAt(0).toUpperCase();

  return (
    <div className="user-menu">
      <button
        className={`user-trigger ${open ? "open" : ""}`}
        type="button"
        onClick={(e) => {
          e.stopPropagation();
          setOpen((o) => !o);
        }}
        title={user.email ?? name}
      >
        <span className="user-avatar">
          {avatarSrc && !imgError ? (
            <img src={avatarSrc} alt="" onError={() => setImgError(true)} />
          ) : (
            initial
          )}
        </span>
        <span className="user-name">{name}</span>
        <IconChevronDown size={14} className="user-caret" stroke={2} />
      </button>

      {open && (
        <div className="user-dropdown" onClick={(e) => e.stopPropagation()}>
          <button
            className="user-dropdown-item danger"
            type="button"
            onClick={() => {
              setOpen(false);
              void logout();
            }}
          >
            <IconLogout size={14} stroke={1.75} />
            Sign out
          </button>
        </div>
      )}
    </div>
  );
}
