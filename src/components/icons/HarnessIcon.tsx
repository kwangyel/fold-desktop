import type { HarnessId, HarnessMeta } from "../../lib/harnesses";
import ClaudeLogo from "./ClaudeLogo";

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

/** Harness badge: Claude spark for Claude Code; letter chips for others. */
export default function HarnessIcon({
  harness,
  size = 34,
  className,
}: HarnessIconProps) {
  const meta = resolveMeta(harness);
  const logoSize = Math.round(size * 0.55);

  return (
    <div
      className={`harness-icon ${meta.iconClass}${className ? ` ${className}` : ""}`}
      style={{ width: size, height: size }}
      aria-hidden
    >
      {meta.id === "claudecode" ? (
        <ClaudeLogo size={logoSize} />
      ) : (
        meta.iconLabel
      )}
    </div>
  );
}
