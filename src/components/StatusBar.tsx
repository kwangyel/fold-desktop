import { memo, useEffect, useRef, useState } from "react";
import { IconChevronUp, IconGitBranch } from "@tabler/icons-react";
import {
  formatResetsIn,
  formatTokenCount,
  harnessSupportsContextStatus,
} from "../lib/contextUsage";
import { gitListBranches } from "../lib/git";
import { HARNESS_CATALOG, type HarnessId } from "../lib/harnesses";
import { useCenterViewStore } from "../store/centerViewStore";
import { useChatStore } from "../store/chatStore";
import {
  resolveViewingSession,
  resolveViewingUsage,
  useContextUsageStore,
} from "../store/contextUsageStore";
import { useHarnessStore } from "../store/harnessStore";
import { useProjectStore } from "../store/projectStore";
import {
  DEFAULT_TARGET_BRANCH,
  selectTargetBranch,
  useTargetBranchStore,
} from "../store/targetBranchStore";
import HarnessIcon from "./icons/HarnessIcon";
import "./StatusBar.css";

function UsageMeter({
  label,
  percent,
  detail,
  title,
}: {
  label: string;
  percent: number | null;
  detail?: string | null;
  title: string;
}) {
  const pct = percent ?? 0;
  return (
    <div className="status-bar-meter" title={title}>
      <span className="status-bar-meter-kind">{label}</span>
      <span className="status-bar-context-label">
        {percent != null ? `${pct}%` : "—"}
      </span>
      <div
        className="status-bar-progress"
        role="progressbar"
        aria-valuenow={pct}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-label={label}
      >
        <div
          className="status-bar-progress-fill"
          style={{ width: `${pct}%` }}
        />
      </div>
      {detail ? (
        <span className="status-bar-context-tokens">{detail}</span>
      ) : null}
    </div>
  );
}

function StatusBar() {
  const [pickerOpen, setPickerOpen] = useState(false);
  const [targetOpen, setTargetOpen] = useState(false);
  const [branches, setBranches] = useState<string[]>([]);
  const pickerRef = useRef<HTMLDivElement>(null);
  const targetRef = useRef<HTMLDivElement>(null);

  const activeId = useProjectStore((s) => s.activeId);
  const branch = useProjectStore((s) => {
    const project = s.projects.find((p) => p.id === s.activeId);
    if (!project?.activeWorktreeId) return null;
    const wt = project.worktrees.find((w) => w.id === project.activeWorktreeId);
    return wt?.branch ?? null;
  });

  const byProjectId = useTargetBranchStore((s) => s.byProjectId);
  const setTargetBranch = useTargetBranchStore((s) => s.setTargetBranch);
  const targetBranch = selectTargetBranch(byProjectId, activeId);

  const activeTabId = useCenterViewStore((s) => s.activeTabId);
  const preferredHarnessId = useChatStore((s) => {
    const tab = s.tabs[activeTabId];
    return (tab?.selectedHarness as HarnessId | undefined) ?? null;
  });

  const byHarness = useContextUsageStore((s) => s.byHarness);
  const sessionByHarness = useContextUsageStore((s) => s.sessionByHarness);
  const viewingHarnessId = useContextUsageStore((s) => s.viewingHarnessId);
  const setViewingHarness = useContextUsageStore((s) => s.setViewingHarness);

  const connectedHarnesses = useHarnessStore((s) => s.connectedHarnesses);
  const refreshHarnesses = useHarnessStore((s) => s.refresh);
  const refreshUsage = useContextUsageStore((s) => s.refresh);

  const activePath = useProjectStore((s) => s.activePath);

  const usage = resolveViewingUsage(
    byHarness,
    viewingHarnessId,
    preferredHarnessId,
  );
  const session = resolveViewingSession(
    sessionByHarness,
    viewingHarnessId,
    preferredHarnessId,
    usage?.harnessId ?? null,
  );

  const statusHarnesses = connectedHarnesses.filter((h) =>
    harnessSupportsContextStatus(h.id),
  );

  const pickerEntries = HARNESS_CATALOG.filter(
    (h) =>
      harnessSupportsContextStatus(h.id) &&
      (statusHarnesses.some((c) => c.id === h.id) ||
        byHarness[h.id] != null ||
        sessionByHarness[h.id] != null),
  );

  useEffect(() => {
    if (!pickerOpen) return;
    void refreshHarnesses({ silent: true });
    const onPointer = (e: MouseEvent) => {
      if (!pickerRef.current?.contains(e.target as Node)) {
        setPickerOpen(false);
      }
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setPickerOpen(false);
    };
    window.addEventListener("mousedown", onPointer);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("mousedown", onPointer);
      window.removeEventListener("keydown", onKey);
    };
  }, [pickerOpen, refreshHarnesses]);

  // Load local branches for the target-branch drop-up.
  useEffect(() => {
    if (!activePath) {
      setBranches([]);
      return;
    }
    const path = activePath;
    let cancelled = false;
    void gitListBranches(path)
      .then((list) => {
        if (cancelled || path !== activePath) return;
        // Always offer `main` even if it isn't checked out locally yet.
        const next =
          list.includes(DEFAULT_TARGET_BRANCH) || list.length === 0
            ? list
            : [DEFAULT_TARGET_BRANCH, ...list];
        setBranches(next);
        // If the saved target vanished, fall back to main (or first branch).
        if (activeId && next.length > 0 && !next.includes(targetBranch)) {
          const fallback = next.includes(DEFAULT_TARGET_BRANCH)
            ? DEFAULT_TARGET_BRANCH
            : next[0];
          setTargetBranch(activeId, fallback);
        }
      })
      .catch(() => {
        if (!cancelled) setBranches([DEFAULT_TARGET_BRANCH]);
      });
    return () => {
      cancelled = true;
    };
    // Intentionally omit targetBranch — we only re-validate when path changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activePath, activeId, setTargetBranch]);

  useEffect(() => {
    if (!targetOpen) return;
    const onPointer = (e: MouseEvent) => {
      if (!targetRef.current?.contains(e.target as Node)) {
        setTargetOpen(false);
      }
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setTargetOpen(false);
    };
    window.addEventListener("mousedown", onPointer);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("mousedown", onPointer);
      window.removeEventListener("keydown", onKey);
    };
  }, [targetOpen]);

  useEffect(() => {
    if (!connectedHarnesses.some((h) => h.id === "claudecode")) return;
    void refreshUsage();
  }, [connectedHarnesses, activeTabId, activePath, refreshUsage]);

  const showUsage =
    usage != null || session != null || pickerEntries.length > 0;
  const percent = usage?.percent ?? 0;
  const usedLabel = usage
    ? `${formatTokenCount(usage.usedTokens)} / ${formatTokenCount(usage.contextWindow)}`
    : null;
  const sessionWindow = session?.fiveHour ?? null;
  const sessionReset = formatResetsIn(sessionWindow?.resetsAt ?? null);
  const weekWindow = session?.sevenDay ?? null;
  const weekReset = formatResetsIn(weekWindow?.resetsAt ?? null);
  const activeMeta =
    HARNESS_CATALOG.find(
      (h) =>
        h.id ===
        (usage?.harnessId ??
          session?.harnessId ??
          viewingHarnessId ??
          pickerEntries[0]?.id),
    ) ?? null;

  const sessionTitle = sessionWindow
    ? [
        `Session ${sessionWindow.percent}% (5-hour)`,
        sessionReset ? `resets in ${sessionReset}` : null,
        weekWindow
          ? `Week ${weekWindow.percent}%${weekReset ? ` · resets in ${weekReset}` : ""}`
          : null,
        session?.subscriptionType
          ? `Plan: ${session.subscriptionType}`
          : null,
      ]
        .filter(Boolean)
        .join(" · ")
    : "Session usage updates after the next agent turn (Pro/Max)";

  const menuBranches =
    branches.length > 0
      ? branches
      : [DEFAULT_TARGET_BRANCH];

  return (
    <footer className="status-bar">
      <div className="status-bar-left">
        {branch ? (
          <span className="status-bar-branch" title={branch}>
            <IconGitBranch size={14} stroke={1.75} aria-hidden />
            <span className="status-bar-branch-name">{branch}</span>
          </span>
        ) : (
          <span className="status-bar-branch muted">No branch</span>
        )}

        {activePath ? (
          <div className="status-bar-target" ref={targetRef}>
            <span className="status-bar-target-label" title="PR / merge target">
              Target Branch
            </span>
            <button
              type="button"
              className="status-bar-target-btn"
              aria-haspopup="menu"
              aria-expanded={targetOpen}
              aria-label={`Target branch ${targetBranch}`}
              title="Target branch for Create PR / Merge"
              onClick={(e) => {
                e.stopPropagation();
                setTargetOpen((o) => !o);
              }}
            >
              <span className="status-bar-target-name">{targetBranch}</span>
              <IconChevronUp size={12} stroke={2} aria-hidden />
            </button>
            {targetOpen ? (
              <div className="status-bar-target-menu" role="menu">
                {menuBranches.map((b) => (
                  <button
                    key={b}
                    type="button"
                    role="menuitem"
                    className={`status-bar-target-item${b === targetBranch ? " active" : ""}`}
                    onClick={() => {
                      if (activeId) setTargetBranch(activeId, b);
                      setTargetOpen(false);
                    }}
                  >
                    {b}
                  </button>
                ))}
              </div>
            ) : null}
          </div>
        ) : null}
      </div>

      {showUsage ? (
        <div className="status-bar-right" ref={pickerRef}>
          {activeMeta ? <HarnessIcon harness={activeMeta} size={16} /> : null}

          <UsageMeter
            label="Ctx"
            percent={usage ? percent : null}
            detail={usedLabel}
            title={
              usedLabel
                ? `Context ${percent}% · ${usedLabel}`
                : "Context usage updates after the next agent turn"
            }
          />

          <UsageMeter
            label="Session"
            percent={sessionWindow ? sessionWindow.percent : null}
            detail={sessionReset ? `↻ ${sessionReset}` : null}
            title={sessionTitle}
          />

          {pickerEntries.length > 0 ? (
            <div className="status-bar-harness-picker">
              <button
                type="button"
                className="status-bar-up-btn"
                aria-haspopup="menu"
                aria-expanded={pickerOpen}
                aria-label="Harness usage status"
                title="Harness usage status"
                onClick={(e) => {
                  e.stopPropagation();
                  setPickerOpen((o) => !o);
                }}
              >
                <IconChevronUp size={14} stroke={2} />
              </button>
              {pickerOpen ? (
                <div className="status-bar-picker-menu" role="menu">
                  {pickerEntries.map((h) => {
                    const entry = byHarness[h.id];
                    const sess = sessionByHarness[h.id];
                    const selected =
                      (usage?.harnessId ??
                        session?.harnessId ??
                        viewingHarnessId) === h.id;
                    const sessionPct = sess?.fiveHour?.percent;
                    return (
                      <button
                        key={h.id}
                        type="button"
                        role="menuitem"
                        className={`status-bar-picker-item${selected ? " active" : ""}`}
                        onClick={() => {
                          setViewingHarness(h.id);
                          setPickerOpen(false);
                        }}
                      >
                        <HarnessIcon harness={h} size={18} />
                        <span className="status-bar-picker-name">{h.name}</span>
                        <span className="status-bar-picker-stats">
                          <span
                            className={`status-bar-picker-pct${entry ? "" : " muted"}`}
                          >
                            Ctx {entry ? `${entry.percent}%` : "—"}
                          </span>
                          <span
                            className={`status-bar-picker-pct${sessionPct != null ? "" : " muted"}`}
                          >
                            Sess {sessionPct != null ? `${sessionPct}%` : "—"}
                          </span>
                        </span>
                      </button>
                    );
                  })}
                </div>
              ) : null}
            </div>
          ) : null}
        </div>
      ) : null}
    </footer>
  );
}

/** Panel resizes re-render the parent every frame; this subtree doesn't need to. */
export default memo(StatusBar);
