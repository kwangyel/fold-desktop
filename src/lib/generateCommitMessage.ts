import {
  ClaudeOutput,
  claudeAgentRun,
  claudeReleaseChannel,
} from "./claude";
import {
  CodexOutput,
  codexAgentRun,
  codexReleaseChannel,
} from "./codex";
import {
  CursorOutput,
  cursorAgentRun,
  cursorReleaseChannel,
} from "./cursor";
import {
  OpenCodeOutput,
  opencodeAgentRun,
  opencodeReleaseChannel,
} from "./opencode";
import { effortForAgentWire } from "./effort";
import type { EffortLevel, HarnessId } from "./harnesses";
import { getStagedDiff, isTauri } from "./git";
import { useCenterViewStore } from "../store/centerViewStore";
import { useChatStore } from "../store/chatStore";
import { useChangesStore } from "../store/changesStore";
import { useProjectStore } from "../store/projectStore";
import { useCursorStore } from "../store/cursorStore";
import { useCodexStore } from "../store/codexStore";
import { useOpenCodeStore } from "../store/opencodeStore";

type AgentChunk = ClaudeOutput | CursorOutput | CodexOutput | OpenCodeOutput;

const CLAUDE_EXIT_RE = /__CLAUDE_EXIT__:(-?\d+)/;
const CURSOR_EXIT_RE = /__CURSOR_EXIT__:(-?\d+)/;
const CODEX_EXIT_RE = /__CODEX_EXIT__:(-?\d+)/;
const OPENCODE_EXIT_RE = /__OPENCODE_EXIT__:(-?\d+)/;

const EXIT_PREFIXES = [
  "__CLAUDE_EXIT__",
  "__CURSOR_EXIT__",
  "__CODEX_EXIT__",
  "__OPENCODE_EXIT__",
] as const;

function decode(chunk: AgentChunk): string {
  const bytes = chunk instanceof Uint8Array ? chunk : new Uint8Array(chunk);
  return new TextDecoder().decode(bytes);
}

function exitRegexFor(harnessId: HarnessId): RegExp {
  switch (harnessId) {
    case "cursor":
      return CURSOR_EXIT_RE;
    case "codex":
      return CODEX_EXIT_RE;
    case "opencode":
      return OPENCODE_EXIT_RE;
    default:
      return CLAUDE_EXIT_RE;
  }
}

function releaseChannel(harnessId: HarnessId, sessionId: string): void {
  switch (harnessId) {
    case "cursor":
      cursorReleaseChannel(sessionId);
      break;
    case "codex":
      codexReleaseChannel(sessionId);
      break;
    case "opencode":
      opencodeReleaseChannel(sessionId);
      break;
    default:
      claudeReleaseChannel(sessionId);
      break;
  }
}

function isConnected(harnessId: HarnessId): boolean {
  switch (harnessId) {
    case "cursor":
      return useCursorStore.getState().authenticated;
    case "codex": {
      const s = useCodexStore.getState();
      return s.installed && s.authenticated;
    }
    case "opencode": {
      const s = useOpenCodeStore.getState();
      return s.installed && s.authenticated;
    }
    default:
      return true;
  }
}

type ContentBlock = { type: string; text?: string };

function textFromEvent(event: Record<string, unknown>, harnessId: HarnessId): string {
  if (harnessId === "opencode") {
    const part = event.part as { text?: string } | undefined;
    if (event.type === "text" && part?.text) return part.text;
    return "";
  }
  if (harnessId === "codex") {
    const item = event.item as { type?: string; text?: string } | undefined;
    if (
      event.type === "item.completed" &&
      item?.type === "agent_message" &&
      item.text
    ) {
      return item.text;
    }
    return "";
  }
  if (event.type === "assistant") {
    // Cursor streaming segments use model_call_id; skip those duplicates when possible.
    if (harnessId === "cursor" && event.model_call_id) return "";
    const message = event.message as { content?: unknown } | undefined;
    const content = message?.content;
    if (typeof content === "string") return content;
    if (Array.isArray(content)) {
      return (content as ContentBlock[])
        .filter((b) => b.type === "text")
        .map((b) => b.text ?? "")
        .join("");
    }
  }
  if (event.type === "result" && typeof event.result === "string" && !event.is_error) {
    return event.result;
  }
  return "";
}

function cleanCommitMessage(raw: string): string {
  let text = raw.trim();
  // Strip common markdown fences / quotes the model may wrap with.
  if (text.startsWith("```")) {
    text = text.replace(/^```[a-z]*\n?/i, "").replace(/\n?```$/, "").trim();
  }
  if (
    (text.startsWith('"') && text.endsWith('"')) ||
    (text.startsWith("'") && text.endsWith("'"))
  ) {
    text = text.slice(1, -1).trim();
  }
  // Prefer first paragraph if the model added explanation afterward.
  const paragraphs = text.split(/\n\s*\n/);
  if (paragraphs.length > 1 && paragraphs[0].length > 10) {
    text = paragraphs[0].trim();
  }
  return text;
}

function resolveActiveHarness(): {
  harnessId: HarnessId;
  model: string;
  effort: string | null;
  fastMode: boolean;
} {
  const { tabs, activeTabId } = useCenterViewStore.getState();
  const chatTabs = useChatStore.getState().tabs;
  const active = tabs.find((t) => t.id === activeTabId && t.type === "chat");
  const firstChat = tabs.find((t) => t.type === "chat");
  const tabId = active?.id ?? firstChat?.id;
  const tab = tabId ? chatTabs[tabId] : undefined;
  return {
    harnessId: (tab?.selectedHarness || "claudecode") as HarnessId,
    model: tab?.selectedModel || "sonnet",
    effort: tab?.modelEffort ?? null,
    fastMode: tab?.mode === "fast",
  };
}

async function collectAssistantText(
  harnessId: HarnessId,
  sessionId: string,
  run: (onEvent: (chunk: AgentChunk) => void) => Promise<void>,
): Promise<string> {
  let lineBuffer = "";
  let assistant = "";
  let lastSegment = "";
  let finished = false;
  let exitError: string | null = null;

  const append = (text: string) => {
    if (!text) return;
    if (harnessId === "cursor") {
      if (text === lastSegment) return;
      if (lastSegment && text.startsWith(lastSegment)) {
        assistant += text.slice(lastSegment.length);
      } else {
        assistant += text;
      }
      lastSegment = text;
      return;
    }
    assistant += text;
  };

  const onEvent = (chunk: AgentChunk) => {
    if (finished) return;
    lineBuffer += decode(chunk);
    const exitRe = exitRegexFor(harnessId);
    const exitMatch = lineBuffer.match(exitRe);
    if (exitMatch) {
      const code = Number(exitMatch[1]);
      const before = lineBuffer.slice(0, exitMatch.index);
      for (const line of before.split("\n")) {
        const trimmed = line.trim();
        if (!trimmed || EXIT_PREFIXES.some((p) => trimmed.startsWith(p))) continue;
        try {
          const event = JSON.parse(trimmed) as Record<string, unknown>;
          append(textFromEvent(event, harnessId));
        } catch {
          // ignore non-JSON
        }
      }
      finished = true;
      if (code === -1) exitError = "Generation cancelled.";
      else if (code !== 0) exitError = `Agent exited with code ${code}.`;
      return;
    }

    const lines = lineBuffer.split("\n");
    lineBuffer = lines.pop() ?? "";
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const event = JSON.parse(trimmed) as Record<string, unknown>;
        append(textFromEvent(event, harnessId));
      } catch {
        // ignore
      }
    }
  };

  try {
    await run(onEvent);

    // Agent spawn is non-blocking; wait for the exit sentinel on the channel.
    const deadline = Date.now() + 120_000;
    while (!finished && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 50));
    }
    if (!finished) {
      throw new Error("Timed out waiting for commit message generation.");
    }
    if (exitError) throw new Error(exitError);
    const cleaned = cleanCommitMessage(assistant);
    if (!cleaned) throw new Error("Model returned an empty commit message.");
    return cleaned;
  } finally {
    releaseChannel(harnessId, sessionId);
  }
}

/**
 * Generate a commit message via a one-shot harness run (no chat UI).
 * Uses the active chat tab's model/harness, falling back to Claude/sonnet.
 */
export async function generateCommitMessage(): Promise<string> {
  if (!isTauri()) {
    return "Update Changes panel with staging and commit UI.";
  }

  const worktree = useProjectStore.getState().activePath;
  if (!worktree) {
    throw new Error("Select a workspace before generating a commit message.");
  }

  const staged = useChangesStore.getState().changes.filter((c) => c.staged);
  if (staged.length === 0) {
    throw new Error("Stage changes before generating a commit message.");
  }

  const { harnessId, model, effort: rawEffort, fastMode } = resolveActiveHarness();
  const effort = rawEffort
    ? effortForAgentWire(harnessId, rawEffort as EffortLevel)
    : null;
  if (!isConnected(harnessId)) {
    throw new Error(
      `${harnessId} is not connected. Open Connect Harness to connect.`,
    );
  }

  const fileList = staged
    .map((f) => `- ${f.status}: ${f.path} (+${f.additions}/-${f.deletions})`)
    .join("\n");
  let diff = "";
  try {
    diff = await getStagedDiff();
  } catch {
    diff = "";
  }

  const prompt = [
    "Write a concise git commit message for the staged changes below.",
    "Reply with ONLY the commit message text — no quotes, no markdown fences, no explanation.",
    "Prefer a short subject line (imperative mood); add a brief body only if needed.",
    "",
    "Staged files:",
    fileList,
    "",
    diff ? `Staged diff:\n${diff}` : "",
  ]
    .filter(Boolean)
    .join("\n");

  const sessionId = `commit-msg-${Date.now()}`;

  // One-shot run with no history to carry: never resume a harness session.
  return collectAssistantText(harnessId, sessionId, async (onEvent) => {
    switch (harnessId) {
      case "cursor":
        await cursorAgentRun(
          sessionId,
          prompt,
          worktree,
          model,
          effort,
          false,
          null,
          onEvent,
        );
        break;
      case "codex":
        await codexAgentRun(
          sessionId,
          prompt,
          worktree,
          model,
          effort,
          null,
          onEvent,
        );
        break;
      case "opencode":
        await opencodeAgentRun(
          sessionId,
          prompt,
          worktree,
          model,
          effort,
          false,
          null,
          onEvent,
        );
        break;
      default:
        await claudeAgentRun(
          sessionId,
          prompt,
          worktree,
          model,
          effort,
          fastMode,
          null,
          null,
          onEvent,
        );
        break;
    }
  });
}
