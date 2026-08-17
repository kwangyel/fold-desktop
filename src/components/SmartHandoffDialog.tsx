import { useEffect } from "react";
import { IconBrain } from "@tabler/icons-react";
import { formatResetsIn } from "../lib/contextUsage";
import { startSmartHandoff } from "../lib/chatTabs";
import {
  HANDOFF_USAGE_THRESHOLD,
  usageLimitReason,
  type HandoffPromptOffer,
} from "../lib/handoffPrompt";
import { useCenterViewStore } from "../store/centerViewStore";
import "./ProjectDialog.css";
import "./SmartHandoffDialog.css";

type Props = {
  offer: HandoffPromptOffer;
  onClose: () => void;
};

function UsageChip({
  label,
  percent,
}: {
  label: string;
  percent: number | null;
}) {
  if (percent == null) return null;
  const hot = percent >= HANDOFF_USAGE_THRESHOLD;
  return (
    <span className={hot ? "hot" : undefined}>
      {label} {percent}%
    </span>
  );
}

export default function SmartHandoffDialog({ offer, onClose }: Props) {
  const reason = usageLimitReason(offer.usage);
  const chatTitle = offer.title.trim();
  const resetAt =
    reason?.label === "5-hour session"
      ? offer.usage.sessionResetsAt
      : reason?.label === "weekly usage"
        ? offer.usage.weekResetsAt
        : null;
  const resetsIn = formatResetsIn(resetAt);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const handleHandoff = () => {
    useCenterViewStore.getState().setActiveTab(offer.tabId);
    onClose();
    void startSmartHandoff(offer.tabId);
  };

  return (
    <div className="dialog-overlay" onMouseDown={onClose}>
      <div
        className="dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="smart-handoff-title"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="dialog-header" id="smart-handoff-title">
          Create a Smart Handoff?
        </div>
        <div className="dialog-body">
          <p className="dialog-hint">
            Claude Code{reason ? `'s ${reason.label}` : " usage"} is at{" "}
            <strong>{reason?.percent ?? 0}%</strong>
            {resetsIn ? ` (resets in ${resetsIn})` : ""}
            {chatTitle ? (
              <>
                {" "}
                after finishing <strong>{chatTitle}</strong>
              </>
            ) : null}
            . No Claude agent is running, so this is a good moment to summarize
            and continue in a fresh chat.
          </p>
          <p className="dialog-hint">
            Smart Handoff writes a compact summary and attaches it to a new
            chat. You can cancel and keep using this conversation.
          </p>
          <div className="smart-handoff-usage">
            <UsageChip label="Context" percent={offer.usage.contextPercent} />
            <UsageChip label="Session" percent={offer.usage.sessionPercent} />
            <UsageChip label="Week" percent={offer.usage.weekPercent} />
          </div>
        </div>
        <div className="dialog-footer">
          <button type="button" className="ghost-btn" onClick={onClose}>
            Not now
          </button>
          <button
            type="button"
            className="primary-btn smart-handoff-dialog-confirm"
            onClick={handleHandoff}
          >
            <IconBrain size={14} stroke={2} />
            Smart Handoff
          </button>
        </div>
      </div>
    </div>
  );
}
