import { getCurrentWindow } from "@tauri-apps/api/window";
import {
  isPermissionGranted,
  requestPermission,
  sendNotification,
} from "@tauri-apps/plugin-notification";
import {
  attentionCount,
  useAgentStatusStore,
  type AgentState,
  type AgentStatuses,
  type AgentStatusReason,
} from "../store/agentStatusStore";
import { useCenterViewStore } from "../store/centerViewStore";
import { useChatStore } from "../store/chatStore";
import { useQuestionStore } from "../store/questionStore";
import { isTauri } from "./git";
import notificationSoundUrl from "../assets/notification.mp3";

/**
 * Turns agent status transitions into OS-level signals: a macOS notification
 * when a chat starts wanting the user, and a dock badge counting how many do.
 *
 * The status store itself stays side-effect free; everything that touches the
 * window or the notification centre lives here and is installed once.
 */

/** Chat is "being watched" — no need to tell the user what they can already see. */
async function userIsLooking(tabId: string): Promise<boolean> {
  if (useCenterViewStore.getState().activeTabId !== tabId) return false;
  try {
    return await getCurrentWindow().isFocused();
  } catch {
    return false;
  }
}

/** First line of the agent's closing message, as a one-line notification body. */
function lastAssistantLine(tabId: string): string {
  const messages = useChatStore.getState().tabs[tabId]?.messages ?? [];
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const m = messages[i];
    if (m.role !== "assistant") continue;
    const line = (m.content ?? "")
      .replace(/[#*`>_]/g, "")
      .split("\n")
      .map((l) => l.trim())
      .find((l) => l.length > 0);
    if (line) return line.length > 140 ? `${line.slice(0, 139)}…` : line;
  }
  return "";
}

/**
 * macOS puts the app name in the header, so the title is the "which one" —
 * worktree first, since the point is telling parallel runs apart.
 */
function notificationTextFor(
  state: AgentState,
  tabId: string,
  title: string,
  worktreePath: string | null,
  reason: AgentStatusReason | undefined,
): { title: string; body: string } | null {
  const where = worktreePath ? worktreePath.split("/").pop() || "" : "";
  const heading = where ? `${where} · ${title}` : title;
  if (state === "needs-you") {
    return {
      title: heading,
      body:
        reason === "plan"
          ? "Plan ready for your review"
          : "Waiting on your input",
    };
  }
  if (state === "done") {
    return { title: heading, body: lastAssistantLine(tabId) || "Agent run finished" };
  }
  return null;
}

let permissionGranted: boolean | null = null;

/**
 * Our own chime, played in the webview.
 *
 * The plugin's `sound` option maps to macOS's `sound_name`, which only accepts
 * registered system sounds — not an arbitrary file — so the custom sound has to
 * come from here. Decoded once and rewound per play; two runs finishing at the
 * same instant share one chime rather than stacking.
 */
let chime: HTMLAudioElement | null = null;

function playChime() {
  try {
    if (!chime) {
      chime = new Audio(notificationSoundUrl);
      chime.preload = "auto";
    }
    chime.currentTime = 0;
    // Blocked before the user has interacted with the page — nothing to do.
    void chime.play().catch(() => {});
  } catch {
    // A missing audio device must never break the notification itself.
  }
}

async function notify(
  state: AgentState,
  tabId: string,
  entry: {
    title: string;
    worktreePath: string | null;
    reason?: AgentStatusReason;
  },
) {
  const text = notificationTextFor(
    state,
    tabId,
    entry.title,
    entry.worktreePath,
    entry.reason,
  );
  if (!text) return;
  try {
    if (permissionGranted === null) {
      permissionGranted = await isPermissionGranted();
      if (!permissionGranted) {
        permissionGranted = (await requestPermission()) === "granted";
      }
    }
    if (!permissionGranted) return;
    sendNotification(text);
    playChime();
  } catch {
    // Notifications are a nicety — never let one break the run that fired it.
  }
}

async function syncBadge(statuses: AgentStatuses) {
  const count = attentionCount(statuses);
  try {
    await getCurrentWindow().setBadgeCount(count > 0 ? count : undefined);
  } catch {
    // Unsupported platform or missing capability — the sidebar still shows it.
  }
}

/** Drop the "seen me" states for the chat the user is currently looking at. */
function clearIfWatched(tabId: string) {
  if (!tabId) return;
  const entry = useAgentStatusStore.getState().statuses[tabId];
  // `running` clears itself when the run ends; only attention states are "seen".
  if (!entry || entry.state === "running") return;
  // A question still on screen is not answered just by being looked at.
  if (useQuestionStore.getState().pending[tabId]) return;
  useAgentStatusStore.getState().clear(tabId);
}

/**
 * Install every subscription. Returns a disposer so the caller can unmount
 * cleanly (React strict mode mounts effects twice in dev).
 */
export function startAgentNotifications(): () => void {
  if (!isTauri()) return () => {};

  const unsubStatus = useAgentStatusStore.subscribe((store, prev) => {
    for (const [tabId, entry] of Object.entries(store.statuses)) {
      const previous = prev.statuses[tabId];
      const before = previous?.state;
      // Reason is part of the identity: a chat that goes from "answer this" to
      // "review this plan" has something new to say.
      if (before === entry.state && previous?.reason === entry.reason) continue;
      if (entry.state === "needs-you" || (before === "running" && entry.state === "done")) {
        void userIsLooking(tabId).then((looking) => {
          if (!looking) {
            void notify(entry.state, tabId, entry);
          } else if (entry.state === "done") {
            // Finished in plain sight — nothing to catch up on.
            clearIfWatched(tabId);
          }
        });
      }
    }
    if (store.statuses !== prev.statuses) void syncBadge(store.statuses);
  });

  // Bridge pending questions into the status store, once for every harness.
  // Claude's `AskUserQuestion` and the `fold_ask_user` MCP path used by the
  // other harnesses both land in `questionStore`, so subscribing here covers
  // all of them without touching each call site.
  const unsubQuestions = useQuestionStore.subscribe((store, prev) => {
    const status = useAgentStatusStore.getState();
    const chats = useChatStore.getState().tabs;
    for (const tabId of Object.keys(store.pending)) {
      if (prev.pending[tabId]) continue;
      const tab = chats[tabId];
      status.setState(tabId, "needs-you", {
        worktreePath: tab?.worktreePath,
        title: tab?.title,
        reason: "question",
      });
    }
    for (const tabId of Object.keys(prev.pending)) {
      // Answered or cancelled: back to running while the agent keeps going.
      // If it has already stopped, `finish` settled the state itself.
      if (!store.pending[tabId] && chats[tabId]?.loading) {
        status.setState(tabId, "running");
      }
    }
  });

  const unsubActiveTab = useCenterViewStore.subscribe((store, prev) => {
    if (store.activeTabId !== prev.activeTabId) clearIfWatched(store.activeTabId);
  });

  let unlistenFocus: (() => void) | undefined;
  let disposed = false;
  void getCurrentWindow()
    .onFocusChanged(({ payload: focused }) => {
      if (focused) clearIfWatched(useCenterViewStore.getState().activeTabId);
    })
    .then((fn) => {
      // The listener may resolve after unmount (strict mode) — drop it then.
      if (disposed) fn();
      else unlistenFocus = fn;
    })
    .catch(() => {});

  return () => {
    disposed = true;
    unsubStatus();
    unsubQuestions();
    unsubActiveTab();
    unlistenFocus?.();
  };
}
