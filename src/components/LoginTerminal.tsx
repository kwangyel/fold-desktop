import { useEffect, useRef } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";

type LoginTerminalProps = {
  subscribeLoginOutput: (listener: (data: Uint8Array) => void) => () => void;
  writeLogin: (data: string) => Promise<void>;
  cursorColor?: string;
};

/** xterm host for harness login PTYs — loaded only while a login is in progress. */
export default function LoginTerminal({
  subscribeLoginOutput,
  writeLogin,
  cursorColor = "#d97757",
}: LoginTerminalProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<Terminal | null>(null);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const term = new Terminal({
      fontFamily: '"SF Mono", Menlo, monospace',
      fontSize: 12,
      lineHeight: 1.25,
      cursorBlink: true,
      convertEol: true,
      theme: {
        background: "#101014",
        foreground: "#e6e6e6",
        cursor: cursorColor,
        selectionBackground: "rgba(217, 119, 87, 0.3)",
      },
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(container);
    fit.fit();
    termRef.current = term;

    const unsub = subscribeLoginOutput((bytes) => {
      term.write(bytes);
    });

    const dataSub = term.onData((data) => {
      void writeLogin(data);
    });

    const observer = new ResizeObserver(() => fit.fit());
    observer.observe(container);

    return () => {
      observer.disconnect();
      dataSub.dispose();
      unsub();
      term.dispose();
      termRef.current = null;
    };
  }, [subscribeLoginOutput, writeLogin, cursorColor]);

  return <div ref={containerRef} className="harness-login-terminal" />;
}
