import { useCallback, useRef } from "react";
import "./ResizeHandle.css";

type Orientation = "vertical" | "horizontal";

type Props = {
  orientation: Orientation;
  onDrag: (delta: number) => void;
  /** Called once when a drag gesture ends. */
  onDragEnd?: () => void;
  className?: string;
};

/**
 * Thin drag handle for resizing adjacent panels.
 * `onDrag` receives the pointer delta since the previous move (dx for vertical, dy for horizontal).
 */
export default function ResizeHandle({
  orientation,
  onDrag,
  onDragEnd,
  className,
}: Props) {
  const lastPos = useRef(0);
  const dragging = useRef(false);

  const onPointerDown = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      if (e.button !== 0) return;
      e.preventDefault();
      dragging.current = true;
      lastPos.current = orientation === "vertical" ? e.clientX : e.clientY;
      e.currentTarget.setPointerCapture(e.pointerId);
      document.body.classList.add(
        orientation === "vertical" ? "resize-col" : "resize-row",
      );
    },
    [orientation],
  );

  const onPointerMove = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      if (!dragging.current) return;
      const pos = orientation === "vertical" ? e.clientX : e.clientY;
      const delta = pos - lastPos.current;
      lastPos.current = pos;
      if (delta !== 0) onDrag(delta);
    },
    [onDrag, orientation],
  );

  const endDrag = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      if (!dragging.current) return;
      dragging.current = false;
      document.body.classList.remove("resize-col", "resize-row");
      try {
        e.currentTarget.releasePointerCapture(e.pointerId);
      } catch {
        // Already released.
      }
      onDragEnd?.();
    },
    [onDragEnd],
  );

  return (
    <div
      className={`resize-handle resize-handle-${orientation}${className ? ` ${className}` : ""}`}
      role="separator"
      aria-orientation={orientation}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={endDrag}
      onPointerCancel={endDrag}
    />
  );
}
