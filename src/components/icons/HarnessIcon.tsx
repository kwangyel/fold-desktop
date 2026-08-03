import type { ReactNode } from "react";
import type { HarnessId, HarnessMeta } from "../../lib/harnesses";
import ClaudeLogo from "./ClaudeLogo";
import CodexLogo from "./CodexLogo";
import CursorLogo from "./CursorLogo";

type HarnessIconProps = {
  harness: Pick<HarnessMeta, "id" | "iconClass" | "iconLabel"> | HarnessId;
  /** Outer badge size in px (default 34 for dialogs, 20 for picker). */
  size?: number;
  className?: string;
};

function resolveMeta(
  harness: HarnessIconProps["harness"],
): { id: HarnessId; iconClass: string; iconLabel: string } {
  if (typeof harness === "string") {
    return { id: harness, iconClass: harness, iconLabel: "" };
  }
  return harness;
}

/** Harness badge: product marks for Claude / Cursor / Codex; letter chips otherwise. */
export default function HarnessIcon({
  harness,
  size = 34,
  className,
}: HarnessIconProps) {
  const meta = resolveMeta(harness);
  const logoSize = Math.round(size * 0.55);

  let mark: ReactNode = meta.iconLabel;
  if (meta.id === "claudecode") {
    mark = <ClaudeLogo size={logoSize} />;
  } else if (meta.id === "cursor") {
    mark = <CursorLogo size={logoSize} />;
  } else if (meta.id === "codex") {
    mark = <CodexLogo size={logoSize} />;
  }

  return (
    <div
      className={`harness-icon ${meta.iconClass}${className ? ` ${className}` : ""}`}
      style={{ width: size, height: size }}
      aria-hidden
    >
      {mark}
    </div>
  );
}
