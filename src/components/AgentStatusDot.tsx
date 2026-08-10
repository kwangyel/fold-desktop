import {
  useAgentStatusStore,
  worktreeState,
  type AgentState,
} from "../store/agentStatusStore";

const LABELS: Record<AgentState, string> = {
  running: "Agent running",
  "needs-you": "Waiting on you",
  done: "Finished",
};

/** Small state dot for sidebar rows. Renders nothing when there is no state. */
export default function AgentStatusDot({ state }: { state: AgentState | null }) {
  if (!state) return null;
  return (
    <span
      className={`agent-dot ${state}`}
      title={LABELS[state]}
      aria-label={LABELS[state]}
      role="img"
    />
  );
}

/** Status of one chat. Subscribes narrowly so streaming doesn't re-render rows. */
export function ChatStatusDot({ chatId }: { chatId: string }) {
  const state = useAgentStatusStore((s) => s.statuses[chatId]?.state ?? null);
  return <AgentStatusDot state={state} />;
}

/** Status of a worktree, rolled up from every chat under it. */
export function WorktreeStatusDot({ worktreePath }: { worktreePath: string }) {
  const state = useAgentStatusStore((s) => worktreeState(s.statuses, worktreePath));
  return <AgentStatusDot state={state} />;
}
