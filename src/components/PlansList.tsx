import { useEffect } from "react";
import HarnessIcon from "./icons/HarnessIcon";
import { usePlanStore } from "../store/planStore";
import { useCenterViewStore } from "../store/centerViewStore";
import { useProjectStore } from "../store/projectStore";
import { PLAN_STATUS_LABELS, type PlanRecord } from "../lib/plans";
import "./PlansList.css";

/** Compact relative timestamp, e.g. "3m", "2h", "5d". */
function relativeTime(ms: number): string {
  const seconds = Math.max(1, Math.round((Date.now() - ms) / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h`;
  return `${Math.round(hours / 24)}d`;
}

export default function PlansList() {
  const plans = usePlanStore((s) => s.plans);
  const loading = usePlanStore((s) => s.loading);
  const error = usePlanStore((s) => s.error);
  const refresh = usePlanStore((s) => s.refresh);

  const openPlanTab = useCenterViewStore((s) => s.openPlanTab);
  const activePath = useProjectStore((s) => s.activePath);

  // Plans are stored per worktree, so reload when the worktree changes.
  useEffect(() => {
    void refresh();
  }, [refresh, activePath]);

  if (error) {
    return <div className="plans-empty plans-error">{error}</div>;
  }

  if (plans.length === 0) {
    return (
      <div className="plans-empty">
        {loading
          ? "Loading plans…"
          : "No plans yet. Turn on plan mode in the chat to have an agent research and propose one."}
      </div>
    );
  }

  return (
    <div className="plans-list">
      {plans.map((plan: PlanRecord) => (
        <button
          key={plan.id}
          type="button"
          className="plan-row"
          onClick={() => openPlanTab(plan.id, plan.title)}
          title={plan.path}
        >
          <HarnessIcon harness={plan.createdByHarness} size={18} />
          <span className="plan-row-title">{plan.title}</span>
          <span className={`plan-row-status plan-status-${plan.status}`}>
            {PLAN_STATUS_LABELS[plan.status]}
          </span>
          <span className="plan-row-time">{relativeTime(plan.createdAt)}</span>
        </button>
      ))}
    </div>
  );
}
