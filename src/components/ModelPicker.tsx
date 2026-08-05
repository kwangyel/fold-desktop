import { useEffect, useRef, useState } from "react";
import { IconChevronDown, IconLoader2 } from "@tabler/icons-react";
import { type HarnessModel } from "../lib/harnesses";
import { useHarnessStore } from "../store/harnessStore";
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
  const loading = useHarnessStore((s) => s.loading);
  const refresh = useHarnessStore((s) => s.refresh);

  // Only probe harness CLIs / list models when the user opens the picker —
  // not on every chat mount (which previously stalled app startup).
  useEffect(() => {
    if (!open) return;
    void refresh();
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
    (connectedHarnesses.length === 0 ? "No harness" : value);

  // Group models by harness, preserving catalog order among connected ones.
  const groups = connectedHarnesses
    .map((h) => ({
      harness: h,
      models: models.filter((m) => m.harnessId === h.id),
    }))
    .filter((g) => g.models.length > 0);

  return (
    <div className="model-picker" ref={rootRef}>
      <button
        type="button"
        className="model-picker-trigger"
        disabled={disabled || loading}
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        title={selected?.description ?? "Select model"}
      >
        {selected ? <HarnessIcon harness={selected.harnessId} size={16} /> : null}
        <span className="model-picker-label">{label}</span>
        {loading ? (
          <IconLoader2 size={12} className="spin" />
        ) : (
          <IconChevronDown size={12} stroke={2} />
        )}
      </button>

      {open && (
        <div className="model-picker-menu" role="listbox">
          {groups.length === 0 ? (
            <div className="model-picker-empty">
              {loading
                ? "Loading models…"
                : "Connect a harness to choose a model."}
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
        </div>
      )}
    </div>
  );
}
