import { useEffect, useRef, useState } from "react";
import { IconChevronDown, IconLoader2 } from "@tabler/icons-react";
import { HARNESS_CATALOG, type HarnessModel } from "../lib/harnesses";
import { useClaudeStore } from "../store/claudeStore";
import { useCodexStore } from "../store/codexStore";
import { useCursorStore } from "../store/cursorStore";
import { useHarnessStore } from "../store/harnessStore";
import { useOpenCodeStore } from "../store/opencodeStore";
import HarnessIcon from "./icons/HarnessIcon";
import "./ModelPicker.css";

type ModelPickerProps = {
  value: string;
  harnessId: string;
  disabled?: boolean;
  onChange: (model: HarnessModel) => void;
};

export default function ModelPicker({
  value,
  harnessId,
  disabled,
  onChange,
}: ModelPickerProps) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  const models = useHarnessStore((s) => s.models);
  const connectedHarnesses = useHarnessStore((s) => s.connectedHarnesses);
  const harnessErrors = useHarnessStore((s) => s.harnessErrors);
  const loading = useHarnessStore((s) => s.loading);
  const refresh = useHarnessStore((s) => s.refresh);

  // Live auth flags — harnessStore can lag behind after login / a failed catalog
  // fetch, and the empty state must not say "Connect a harness" when one is up.
  const claudeConnected = useClaudeStore(
    (s) => s.installed && s.authenticated,
  );
  const codexConnected = useCodexStore(
    (s) => s.installed && s.authenticated,
  );
  const cursorConnected = useCursorStore((s) => s.authenticated);
  const opencodeConnected = useOpenCodeStore(
    (s) => s.installed && s.authenticated,
  );
  const liveConnected =
    claudeConnected ||
    codexConnected ||
    cursorConnected ||
    opencodeConnected;

  // Soft-refresh when opened: reuse the cached catalog immediately; only block
  // the UI when we have nothing to show. A previously failed fetch left
  // `fetchedAt` null in the store, so this retries it rather than serving a
  // catalog that's missing a connected harness.
  useEffect(() => {
    if (!open) return;
    void refresh({ silent: models.length > 0 });
    // eslint-disable-next-line react-hooks/exhaustive-deps -- only re-run on open
  }, [open, refresh]);

  useEffect(() => {
    if (!open) return;
    const onPointer = (e: MouseEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    window.addEventListener("mousedown", onPointer);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("mousedown", onPointer);
      window.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const selected =
    models.find((m) => m.value === value && m.harnessId === harnessId) ??
    models.find((m) => m.value === value);

  const label =
    selected?.displayName ??
    (!liveConnected && connectedHarnesses.length === 0 && models.length === 0
      ? "No harness"
      : value);

  // Prefer harnessStore's connected list; if it's stale-empty but models exist,
  // derive sections from the catalog so the picker still renders.
  const groupHarnesses =
    connectedHarnesses.length > 0
      ? connectedHarnesses
      : HARNESS_CATALOG.filter((h) => models.some((m) => m.harnessId === h.id));

  const groups = groupHarnesses
    .map((h) => ({
      harness: h,
      models: models.filter((m) => m.harnessId === h.id),
    }))
    .filter((g) => g.models.length > 0);

  // Connected harnesses that produced no models — listed with their reason so
  // a failing harness explains itself instead of vanishing from the menu.
  const failedHarnesses = groupHarnesses
    .filter((h) => !groups.some((g) => g.harness.id === h.id))
    .map((h) => ({ harness: h, reason: harnessErrors[h.id] }))
    .filter((f) => f.reason != null);

  const showLoading = loading || (liveConnected && models.length === 0);
  const emptyMessage = showLoading
    ? "Loading models…"
    : liveConnected
      ? "Couldn't load models. Close and reopen to retry."
      : "Connect a harness to choose a model.";

  return (
    <div className="model-picker" ref={rootRef}>
      <button
        type="button"
        className="model-picker-trigger"
        disabled={disabled}
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        title={selected?.description ?? "Select model"}
      >
        {selected ? <HarnessIcon harness={selected.harnessId} size={16} /> : null}
        <span className="model-picker-label">{label}</span>
        {loading && models.length === 0 ? (
          <IconLoader2 size={12} className="spin" />
        ) : (
          <IconChevronDown size={12} stroke={2} />
        )}
      </button>

      {open && (
        <div className="model-picker-menu" role="listbox">
          {groups.length === 0 ? (
            <div className="model-picker-empty">
              {showLoading ? (
                <>
                  <IconLoader2 size={14} className="spin" />
                  {emptyMessage}
                </>
              ) : (
                emptyMessage
              )}
            </div>
          ) : (
            groups.map((group, index) => (
              <div key={group.harness.id} className="model-picker-group">
                {index > 0 && (
                  <div className="model-picker-divider" role="separator" />
                )}
                <div className="model-picker-group-header">
                  <HarnessIcon harness={group.harness} size={20} />
                  <span>{group.harness.name}</span>
                </div>
                <div className="model-picker-divider" role="separator" />
                {group.models.map((model) => {
                  const active =
                    model.value === value && model.harnessId === harnessId;
                  return (
                    <button
                      key={`${model.harnessId}:${model.value}`}
                      type="button"
                      role="option"
                      aria-selected={active}
                      className={`model-picker-option${active ? " active" : ""}`}
                      onClick={() => {
                        onChange(model);
                        setOpen(false);
                      }}
                    >
                      <span className="model-picker-option-name">
                        {model.displayName}
                      </span>
                      {model.description ? (
                        <span className="model-picker-option-desc">
                          {model.description}
                        </span>
                      ) : null}
                    </button>
                  );
                })}
              </div>
            ))
          )}

          {failedHarnesses.map(({ harness, reason }) => (
            <div key={`failed-${harness.id}`} className="model-picker-group">
              <div className="model-picker-divider" role="separator" />
              <div className="model-picker-group-header">
                <HarnessIcon harness={harness} size={20} />
                <span>{harness.name}</span>
              </div>
              <div className="model-picker-failed">{reason}</div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
