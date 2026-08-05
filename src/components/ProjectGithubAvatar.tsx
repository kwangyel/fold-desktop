import { memo, useEffect, useState } from "react";
import { IconBrandGithub } from "@tabler/icons-react";
import { fetch } from "@tauri-apps/plugin-http";
import { gitGithubRepoOwnerCached, isTauri } from "../lib/git";

type Props = {
  path: string;
  active?: boolean;
};

/**
 * Avatar bitmaps keyed by URL. Owners repeat across projects and rows remount
 * whenever the sidebar list changes, so without this every remount re-downloads
 * the same image (and leaks a fresh object URL).
 */
const avatarCache = new Map<string, string>();
const avatarInflight = new Map<string, Promise<string>>();

async function loadAvatar(url: string): Promise<string> {
  const cached = avatarCache.get(url);
  if (cached) return cached;
  const pending = avatarInflight.get(url);
  if (pending) return pending;

  const request = (async () => {
    try {
      const res = await fetch(url, { method: "GET" });
      if (!res.ok) throw new Error(String(res.status));
      const blob = await res.blob();
      const objectUrl = URL.createObjectURL(blob);
      avatarCache.set(url, objectUrl);
      return objectUrl;
    } catch {
      // Fall back to the plain URL; the <img> may still be able to load it.
      return url;
    } finally {
      avatarInflight.delete(url);
    }
  })();

  avatarInflight.set(url, request);
  return request;
}

function ProjectGithubAvatar({ path, active = false }: Props) {
  const [owner, setOwner] = useState<{ login: string; avatarUrl: string } | null>(
    null,
  );
  const [avatarSrc, setAvatarSrc] = useState<string | null>(null);
  const [imgError, setImgError] = useState(false);

  useEffect(() => {
    setImgError(false);
    let cancelled = false;
    void gitGithubRepoOwnerCached(path).then((info) => {
      if (!cancelled) setOwner(info);
    });
    return () => {
      cancelled = true;
    };
  }, [path]);

  // Load avatar via Tauri's HTTP client (img tags can fail on external URLs).
  useEffect(() => {
    setImgError(false);
    const url = owner?.avatarUrl;
    if (!url) {
      setAvatarSrc(null);
      return;
    }
    if (!isTauri()) {
      setAvatarSrc(url);
      return;
    }

    let cancelled = false;
    void loadAvatar(url).then((src) => {
      if (!cancelled) setAvatarSrc(src);
    });

    return () => {
      cancelled = true;
    };
  }, [owner?.avatarUrl]);

  const title = owner?.login ?? "No GitHub remote";

  if (owner && avatarSrc && !imgError) {
    return (
      <img
        className={`project-gh-avatar ${active ? "" : "idle"}`}
        src={avatarSrc}
        alt=""
        title={title}
        onError={() => setImgError(true)}
      />
    );
  }

  return (
    <span
      className={`project-gh-avatar logo ${active ? "" : "idle"}`}
      title={title}
    >
      <IconBrandGithub size={14} stroke={1.75} />
    </span>
  );
}

export default memo(ProjectGithubAvatar);
