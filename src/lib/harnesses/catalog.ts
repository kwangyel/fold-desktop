import type { HarnessId, HarnessMeta } from "./types";

/** Catalog of harnesses shown in Connect dialog / model picker icons. */
export const HARNESS_CATALOG: HarnessMeta[] = [
  {
    id: "claudecode",
    name: "Claude Code",
    description: "Connect the Claude Code CLI harness",
    iconClass: "claudecode",
    iconLabel: "CC",
  },
  {
    id: "codex",
    name: "Codex",
    description: "Connect the Codex CLI harness",
    iconClass: "codex",
    iconLabel: "CX",
  },
  {
    id: "cursor",
    name: "Cursor",
    description: "Connect with a Cursor Cloud Agents API key",
    iconClass: "cursor",
    iconLabel: "CR",
  },
  {
    id: "opencode",
    name: "OpenCode",
    description: "Connect the OpenCode CLI harness",
    iconClass: "opencode",
    iconLabel: "OC",
  },
];

export function harnessMeta(id: HarnessId): HarnessMeta {
  const found = HARNESS_CATALOG.find((h) => h.id === id);
  if (!found) {
    throw new Error(`Unknown harness: ${id}`);
  }
  return found;
}
