import { claudeAgentRespond } from "./claude";
import { writeFile } from "./git";
import {
  buildAnswerPayload,
  type PendingQuestions,
  type QuestionAnswers,
} from "./questions";
import { ASKS_DIR } from "./asks";

/**
 * Send the user's answers back to whichever agent asked.
 *
 * Claude Code asks through the Agent SDK's native `AskUserQuestion` tool, which
 * is paused on our `canUseTool` callback. The other harnesses have no such tool
 * in headless mode, so they ask through Fold's `fold_ask_user` MCP server,
 * which is polling for an answer file.
 */
export async function answerQuestions(
  pending: PendingQuestions,
  answers: QuestionAnswers,
): Promise<void> {
  const payload = buildAnswerPayload(pending.questions, answers);

  if (pending.source.kind === "claude") {
    await claudeAgentRespond(pending.source.tabId, {
      type: "fold_permission_response",
      requestId: pending.source.requestId,
      behavior: "allow",
      updatedInput: payload as unknown as Record<string, unknown>,
    });
    return;
  }

  await writeFile(
    `${ASKS_DIR}/${pending.source.askId}.answer.json`,
    `${JSON.stringify({ answers }, null, 2)}\n`,
  );
}

/**
 * Retire a question whose run has ended before the user answered it.
 *
 * Nothing deletes the MCP request file, and the watcher treats any request
 * without an answer beside it as live — so an abandoned ask would otherwise be
 * picked up again by the *next* run in this worktree and shown as if the new
 * agent had asked it. Writing the answer file settles it for good, and releases
 * the MCP server immediately instead of leaving it to poll out its timeout.
 */
export async function abandonQuestions(pending: PendingQuestions): Promise<void> {
  if (pending.source.kind !== "mcp") return;
  try {
    await writeFile(
      `${ASKS_DIR}/${pending.source.askId}.answer.json`,
      `${JSON.stringify({ answers: {}, cancelled: true }, null, 2)}\n`,
    );
  } catch {
    // Best-effort cleanup; the watcher's own staleness check still covers us.
  }
}
