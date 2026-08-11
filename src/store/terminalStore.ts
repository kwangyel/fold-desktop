import { create } from "zustand";

export type TerminalTabRequest = {
  id: string;
  label: string;
  cwd: string;
  /** Shell command to run once the PTY is ready (no trailing newline needed). */
  command?: string;
};

type TerminalStore = {
  /** Tabs requested from outside TerminalPanel (e.g. setup script). */
  requests: TerminalTabRequest[];
  open: (opts: {
    label: string;
    cwd: string;
    command?: string;
  }) => string;
  /** TerminalPanel calls this after it has absorbed a request into local state. */
  acknowledge: (id: string) => void;
};

let nextRequestId = 1;

export const useTerminalStore = create<TerminalStore>((set) => ({
  requests: [],

  open: ({ label, cwd, command }) => {
    const id = `term-req-${nextRequestId++}`;
    set((s) => ({
      requests: [...s.requests, { id, label, cwd, command }],
    }));
    return id;
  },

  acknowledge: (id) => {
    set((s) => ({
      requests: s.requests.filter((r) => r.id !== id),
    }));
  },
}));
