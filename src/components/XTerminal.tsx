import { useEffect, useRef } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { Channel, invoke } from "@tauri-apps/api/core";
import "@xterm/xterm/css/xterm.css";
import "./XTerminal.css";

interface XTerminalProps {
  id: string;
  active: boolean;
  /** Working directory; when it changes the PTY is respawned in place. */
  cwd: string | null;
}

function isTauri(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

const RESIZE_DEBOUNCE_MS = 80;

export default function XTerminal({ id, active, cwd }: XTerminalProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const activeRef = useRef(active);
  activeRef.current = active;

  // Create xterm once per tab id. Respawn the PTY when cwd changes.
  useEffect(() => {
    const container = containerRef.current;
    if (!container || !cwd) return;

    let disposed = false;
    let dataSub: { dispose: () => void } | undefined;
    let observer: ResizeObserver | undefined;
    let resizeTimer: ReturnType<typeof setTimeout> | undefined;
    let lastCols = 0;
    let lastRows = 0;

    const term = new Terminal({
      fontFamily: '"SF Mono", Menlo, monospace',
      fontSize: 12,
      lineHeight: 1.2,
      cursorBlink: true,
      scrollback: 5000,
      theme: {
        background: "#101014",
        foreground: "#e6e6e6",
        cursor: "#8ecaff",
        selectionBackground: "rgba(124, 92, 255, 0.3)",
      },
    });

    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(container);

    termRef.current = term;
    fitRef.current = fit;

    const fitAndResize = () => {
      if (disposed || !activeRef.current) return;
      if (container.offsetWidth === 0 || container.offsetHeight === 0) return;
      fit.fit();
      const cols = term.cols;
      const rows = term.rows;
      if (cols === lastCols && rows === lastRows) return;
      lastCols = cols;
      lastRows = rows;
      if (isTauri()) {
        void invoke("pty_resize", { id, cols, rows });
      }
    };

    const scheduleFit = () => {
      if (resizeTimer !== undefined) clearTimeout(resizeTimer);
      resizeTimer = setTimeout(fitAndResize, RESIZE_DEBOUNCE_MS);
    };

    // Wait a frame so the panel has real layout before spawn.
    const raf = requestAnimationFrame(() => {
      if (disposed) return;
      fit.fit();
      lastCols = term.cols;
      lastRows = term.rows;

      if (isTauri()) {
        const output = new Channel<Uint8Array | number[]>();
        output.onmessage = (chunk) => {
          if (disposed) return;
          const bytes =
            chunk instanceof Uint8Array ? chunk : new Uint8Array(chunk);
          term.write(bytes);
        };

        invoke("pty_spawn", {
          id,
          cols: term.cols,
          rows: term.rows,
          onOutput: output,
        }).catch((e) => {
          if (!disposed) {
            term.write(`\r\n\x1b[31mFailed to start shell: ${e}\x1b[0m\r\n`);
          }
        });

        dataSub = term.onData((data) => {
          void invoke("pty_write", { id, data });
        });

        observer = new ResizeObserver(scheduleFit);
        observer.observe(container);
      } else {
        term.write("\r\nTerminal requires the Tauri desktop app.\r\n");
        term.write("Run: npm run tauri dev\r\n");
      }
    });

    return () => {
      disposed = true;
      cancelAnimationFrame(raf);
      if (resizeTimer !== undefined) clearTimeout(resizeTimer);
      observer?.disconnect();
      dataSub?.dispose();
      term.dispose();
      termRef.current = null;
      fitRef.current = null;
      if (isTauri()) {
        void invoke("pty_kill", { id });
      }
    };
  }, [id, cwd]);

  useEffect(() => {
    if (!active) return;
    requestAnimationFrame(() => {
      const container = containerRef.current;
      const fit = fitRef.current;
      const term = termRef.current;
      if (!container || !fit || !term) return;
      if (container.offsetWidth === 0 || container.offsetHeight === 0) return;
      fit.fit();
      if (isTauri()) {
        void invoke("pty_resize", { id, cols: term.cols, rows: term.rows });
      }
    });
  }, [active, id]);

  return (
    <div
      ref={containerRef}
      className={`xterminal-container ${active ? "active" : ""}`}
    />
  );
}
