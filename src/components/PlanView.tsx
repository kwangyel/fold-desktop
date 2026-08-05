import { useEffect, useState } from "react";
import AssistantMarkdown from "./AssistantMarkdown";
import HarnessIcon from "./icons/HarnessIcon";
import ModelPicker from "./ModelPicker";
import { useCenterViewStore } from "../store/centerViewStore";
import { usePlanStore } from "../store/planStore";
import {
  hasPendingPlanApproval,
  resolvePlanApproval,
  useChatStore,
} from "../store/chatStore";
import {
  buildImplementPrompt,
  readPlanMarkdown,
  PLAN_STATUS_LABELS,
  type PlanRecord,
} from "../lib/plans";
import { gitHeadCommit } from "../lib/git";
import type { HarnessId, HarnessModel } from "../lib/harnesses";
import "./PlanView.css";

/** Which harness/model should carry the plan out. Defaults to the author. */
type Implementer = { harnessId: HarnessId; model: string };

/** Re-read interval while a plan is still being written / awaiting review. */
const DRAFT_REFRESH_MS = 1500;

export default function PlanView({ tabId }: { tabId: string }) {
  const tab = useCenterViewStore((s) => s.tabs.find((t) => t.id === tabId));
  const addChatTab = useCenterViewStore((s) => s.addChatTab);

  const plans = usePlanStore((s) => s.plans);
  const refreshPlans = usePlanStore((s) => s.refresh);
  const updatePlan = usePlanStore((s) => s.update);

  const initializeTab = useChatStore((s) => s.initializeTab);
  const setModel = useChatStore((s) => s.setModel);
  const sendPrompt = useChatStore((s) => s.sendPrompt);

  const [markdown, setMarkdown] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [implementer, setImplementer] = useState<Implementer | null>(null);
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  const planId = tab?.planId;
  const plan: PlanRecord | undefined = plans.find((p) => p.id === planId);

  // The index may not be loaded yet when a plan tab is restored.
  useEffect(() => {
    if (planId && !plan) void refreshPlans();
  }, [planId, plan, refreshPlans]);

  // Load (and, while draft, keep refreshing) the plan body from disk. Claude
  // often keeps editing the plan file after we first open the tab.
  useEffect(() => {
    if (!plan) return;
    let cancelled = false;

    const load = () => {
      readPlanMarkdown(plan)
        .then((body) => {
          if (cancelled) return;
          setMarkdown((prev) => (prev === body ? prev : body));
          setLoadError(null);
        })
        .catch((e) => {
          if (!cancelled) setLoadError(String(e));
        });
    };

    load();

    const shouldPoll =
      plan.status === "draft" || plan.status === "approved";
    const timer = shouldPoll
      ? window.setInterval(load, DRAFT_REFRESH_MS)
      : undefined;

    return () => {
      cancelled = true;
      if (timer !== undefined) window.clearInterval(timer);
    };
  }, [plan?.id, plan?.path, plan?.status]);

  if (!tab) return null;
  if (!plan) {
    return <div className="plan-view-status">Loading plan…</div>;
  }

  const chosen: Implementer = implementer ?? {
    harnessId: plan.createdByHarness,
    model: plan.createdByModel,
  };
  // Approving in the same session only works while that agent is still paused
  // on its ExitPlanMode request and the user hasn't switched harness/model.
  const sameSession =
    hasPendingPlanApproval(plan.id) &&
    chosen.harnessId === plan.createdByHarness &&
    chosen.model === plan.createdByModel;

  const settled = plan.status === "implemented" || plan.status === "failed";

  const handleApprove = async () => {
    setBusy(true);
    setActionError(null);
    try {
      const baseCommit = await gitHeadCommit(plan.worktreePath).catch(() => "");
      await updatePlan(plan.id, {
        status: "implementing",
        baseCommit,
        implementedByHarness: chosen.harnessId,
        implementedByModel: chosen.model,
      });

      if (sameSession) {
        await resolvePlanApproval(plan.id, true);
        await updatePlan(plan.id, { implementChatTabId: plan.sourceChatTabId });
        return;
      }

      // Hand the plan to a different harness/model: it reads the plan file, so
      // nothing depends on who wrote it.
      await resolvePlanApproval(plan.id, false, "Implementing in a new session.");
      addChatTab();
      const chatTabId = useCenterViewStore.getState().activeTabId;
      initializeTab(chatTabId);
      setModel(chatTabId, chosen.model, chosen.harnessId);
      await updatePlan(plan.id, { implementChatTabId: chatTabId });
      void sendPrompt(chatTabId, buildImplementPrompt(plan), {
        planId: plan.id,
      });
    } catch (e) {
      setActionError(String(e));
      await updatePlan(plan.id, { status: "draft" });
    } finally {
      setBusy(false);
    }
  };

  const handleReject = async () => {
    setBusy(true);
    setActionError(null);
    try {
      await resolvePlanApproval(plan.id, false, "User rejected the plan.");
      await updatePlan(plan.id, { status: "rejected" });
    } catch (e) {
      setActionError(String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="plan-view">
      <div className="plan-view-header">
        <div className="plan-view-heading">
          <h2 className="plan-view-title">{plan.title}</h2>
          <span className={`plan-status plan-status-${plan.status}`}>
            {PLAN_STATUS_LABELS[plan.status]}
          </span>
        </div>
        <div className="plan-view-meta">
          <HarnessIcon harness={plan.createdByHarness} size={14} />
          <span>{plan.createdByModel}</span>
          <span className="plan-view-sep">·</span>
          <code className="plan-view-path">{plan.path}</code>
          {plan.changedFiles !== undefined && (
            <>
              <span className="plan-view-sep">·</span>
              <span>
                {plan.changedFiles} file{plan.changedFiles === 1 ? "" : "s"}{" "}
                changed
              </span>
            </>
          )}
        </div>
      </div>

      <div className="plan-view-body">
        {loadError ? (
          <div className="plan-view-status plan-view-error">{loadError}</div>
        ) : markdown === null ? (
          <div className="plan-view-status">Loading plan…</div>
        ) : markdown.trim() ? (
          <AssistantMarkdown content={markdown} />
        ) : (
          <div className="plan-view-status">
            Plan file is empty so far — waiting for the agent to finish writing
            it…
          </div>
        )}
      </div>

      {!settled && (
        <div className="plan-view-footer">
          <div className="plan-view-implementer">
            <label>Implement with</label>
            <ModelPicker
              value={chosen.model}
              harnessId={chosen.harnessId}
              disabled={busy}
              onChange={(model: HarnessModel) =>
                setImplementer({
                  harnessId: model.harnessId,
                  model: model.value,
                })
              }
            />
          </div>

          <div className="plan-view-actions">
            {actionError && (
              <span className="plan-view-error">{actionError}</span>
            )}
            <button
              type="button"
              className="plan-btn"
              onClick={() => void handleReject()}
              disabled={busy || plan.status === "implementing"}
            >
              Reject
            </button>
            <button
              type="button"
              className="plan-btn primary"
              onClick={() => void handleApprove()}
              disabled={
                busy ||
                plan.status === "implementing" ||
                !markdown?.trim()
              }
            >
              {plan.status === "implementing"
                ? "Implementing…"
                : "Approve & implement"}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
