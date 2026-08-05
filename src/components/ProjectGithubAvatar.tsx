import { useEffect, useState } from "react";
import { IconBrandGithub } from "@tabler/icons-react";
import { fetch } from "@tauri-apps/plugin-http";
import { gitGithubRepoOwner, isTauri } from "../lib/git";

type Props = {
  path: string;
  active?: boolean;
};

export default function ProjectGithubAvatar({ path, active = false }: Props) {
  const [owner, setOwner] = useState<{ login: string; avatarUrl: string } | null>(
    null,
  );
  const [avatarSrc, setAvatarSrc] = useState<string | null>(null);
  const [imgError, setImgError] = useState(false);

  useEffect(() => {
    setImgError(false);
    let cancelled = false;
    void gitGithubRepoOwner(path)
      .then((info) => {
        if (!cancelled) setOwner(info);
      })
      .catch(() => {
        if (!cancelled) setOwner(null);
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
    let objectUrl: string | null = null;
    void (async () => {
      try {
        const res = await fetch(url, { method: "GET" });
        if (!res.ok) throw new Error(String(res.status));
        const blob = await res.blob();
        objectUrl = URL.createObjectURL(blob);
        if (!cancelled) setAvatarSrc(objectUrl);
      } catch {
        if (!cancelled) setAvatarSrc(url);
      }
    })();

    return () => {
      cancelled = true;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
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
