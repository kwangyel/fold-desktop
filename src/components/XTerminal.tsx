import { useEffect, useRef } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { Channel, invoke } from "@tauri-apps/api/core";
import "@xterm/xterm/css/xterm.css";
import "./XTerminal.css";

interface XTerminalProps {
  id: string;
  active: boolean;
}

function isTauri(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

export default function XTerminal({ id, active }: XTerminalProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const term = new Terminal({
      fontFamily: '"SF Mono", Menlo, monospace',
      fontSize: 12,
      lineHeight: 1.2,
      cursorBlink: true,
      theme: {
        background: "#101014",
        foreground: "#e6e6e6",
        cursor: "#7c5cff",
        selectionBackground: "rgba(124, 92, 255, 0.3)",
      },
    });

    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(container);
    fit.fit();

    termRef.current = term;
    fitRef.current = fit;

    let dataSub: { dispose: () => void } | undefined;
    let observer: ResizeObserver | undefined;

    if (isTauri()) {
      const output = new Channel<Uint8Array | number[]>();
      output.onmessage = (chunk) => {
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
        term.write(`\r\n\x1b[31mFailed to start shell: ${e}\x1b[0m\r\n`);
      });

      dataSub = term.onData((data) => {
        void invoke("pty_write", { id, data });
      });

      observer = new ResizeObserver(() => {
        fit.fit();
        void invoke("pty_resize", { id, cols: term.cols, rows: term.rows });
      });
      observer.observe(container);
    } else {
      term.write("\r\nTerminal requires the Tauri desktop app.\r\n");
      term.write("Run: npm run tauri dev\r\n");
    }

    return () => {
      observer?.disconnect();
      dataSub?.dispose();
      term.dispose();
      termRef.current = null;
      fitRef.current = null;
      if (isTauri()) {
        void invoke("pty_kill", { id });
      }
    };
  }, [id]);

  useEffect(() => {
    if (!active) return;
    requestAnimationFrame(() => {
      fitRef.current?.fit();
      const term = termRef.current;
      if (term && isTauri()) {
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
