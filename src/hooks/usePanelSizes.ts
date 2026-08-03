import { useCallback, useEffect, useState } from "react";

export const MIN_SIDEBAR = 180;
export const MIN_RIGHT = 220;
export const MIN_CENTER = 280;
export const MIN_RIGHT_SECTION = 80;
/** Min height for the create-project actions block (keeps buttons readable). */
export const MIN_SIDEBAR_TOP = 160;
/** Min height for the projects list. */
export const MIN_SIDEBAR_BOTTOM = 100;

const STORAGE_KEY = "fold.panelSizes";

export type PanelSizes = {
  sidebarWidth: number;
  rightWidth: number;
  /** Fraction of right-pane height given to the top section (0–1). */
  rightTopRatio: number;
  /** Fraction of sidebar body height given to create-project actions (0–1). */
  sidebarTopRatio: number;
};

const DEFAULTS: PanelSizes = {
  sidebarWidth: 280,
  rightWidth: 420,
  rightTopRatio: 0.5,
  sidebarTopRatio: 0.38,
};

function clamp(n: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, n));
}

function load(): PanelSizes {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return { ...DEFAULTS };
    const parsed = JSON.parse(raw) as Partial<PanelSizes>;
    return {
      sidebarWidth: clamp(
        Number(parsed.sidebarWidth) || DEFAULTS.sidebarWidth,
        MIN_SIDEBAR,
        800,
      ),
      rightWidth: clamp(
        Number(parsed.rightWidth) || DEFAULTS.rightWidth,
        MIN_RIGHT,
        800,
      ),
      rightTopRatio: clamp(
        Number(parsed.rightTopRatio) || DEFAULTS.rightTopRatio,
        0.1,
        0.9,
      ),
      sidebarTopRatio: clamp(
        Number(parsed.sidebarTopRatio) || DEFAULTS.sidebarTopRatio,
        0.1,
        0.9,
      ),
    };
  } catch {
    return { ...DEFAULTS };
  }
}

export function usePanelSizes() {
  const [sizes, setSizes] = useState<PanelSizes>(load);

  useEffect(() => {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(sizes));
    } catch {
      // Ignore quota / private-mode failures.
    }
  }, [sizes]);

  /** Apply an incremental sidebar width change, clamped against workspace mins. */
  const adjustSidebarWidth = useCallback((dx: number, workspaceWidth: number) => {
    setSizes((prev) => {
      const maxSidebar = Math.max(
        MIN_SIDEBAR,
        workspaceWidth - prev.rightWidth - MIN_CENTER,
      );
      return {
        ...prev,
        sidebarWidth: clamp(prev.sidebarWidth + dx, MIN_SIDEBAR, maxSidebar),
      };
    });
  }, []);

  /** Apply an incremental right-pane width change (positive dx grows the pane). */
  const adjustRightWidth = useCallback((dx: number, workspaceWidth: number) => {
    setSizes((prev) => {
      const maxRight = Math.max(
        MIN_RIGHT,
        workspaceWidth - prev.sidebarWidth - MIN_CENTER,
      );
      return {
        ...prev,
        rightWidth: clamp(prev.rightWidth + dx, MIN_RIGHT, maxRight),
      };
    });
  }, []);

  /** Apply an incremental change to the right-pane top-section height ratio. */
  const adjustRightTopRatio = useCallback((dy: number, paneHeight: number) => {
    setSizes((prev) => {
      if (paneHeight <= 0) return prev;
      const minRatio = MIN_RIGHT_SECTION / paneHeight;
      const maxRatio = 1 - MIN_RIGHT_SECTION / paneHeight;
      if (minRatio >= maxRatio) {
        return { ...prev, rightTopRatio: 0.5 };
      }
      return {
        ...prev,
        rightTopRatio: clamp(prev.rightTopRatio + dy / paneHeight, minRatio, maxRatio),
      };
    });
  }, []);

  /** Apply an incremental change to the sidebar create-project / projects split. */
  const adjustSidebarTopRatio = useCallback((dy: number, bodyHeight: number) => {
    setSizes((prev) => {
      if (bodyHeight <= 0) return prev;
      const minRatio = MIN_SIDEBAR_TOP / bodyHeight;
      const maxRatio = 1 - MIN_SIDEBAR_BOTTOM / bodyHeight;
      if (minRatio >= maxRatio) {
        return { ...prev, sidebarTopRatio: 0.5 };
      }
      return {
        ...prev,
        sidebarTopRatio: clamp(
          prev.sidebarTopRatio + dy / bodyHeight,
          minRatio,
          maxRatio,
        ),
      };
    });
  }, []);

  return {
    sizes,
    adjustSidebarWidth,
    adjustRightWidth,
    adjustRightTopRatio,
    adjustSidebarTopRatio,
  };
}
