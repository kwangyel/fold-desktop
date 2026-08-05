/**
 * Shape of a clarifying-question request. This mirrors the Claude Agent SDK's
 * `AskUserQuestion` tool input exactly, so the same UI can serve both Claude
 * Code (native tool) and the other harnesses (via Fold's `fold_ask_user` MCP
 * tool, which reuses this schema).
 */
export type QuestionOption = {
  label: string;
  description?: string;
};

export type Question = {
  question: string;
  /** Short label for the step, max ~12 characters. */
  header?: string;
  options: QuestionOption[];
  multiSelect?: boolean;
};

export type QuestionSet = {
  questions: Question[];
};

/** Answers keyed by the question text, as the tool expects them back. */
export type QuestionAnswers = Record<string, string>;

/** Where a pending question came from, so the answer is routed back correctly. */
export type QuestionSource =
  | { kind: "claude"; tabId: string; requestId: string }
  | { kind: "mcp"; tabId: string; worktreePath: string; askId: string };

export type PendingQuestions = {
  source: QuestionSource;
  questions: Question[];
};

/**
 * Build the `updatedInput` payload the AskUserQuestion tool expects: the
 * original questions plus an answers map keyed by question text. Multi-select
 * answers are joined with ", " per the SDK docs.
 */
export function buildAnswerPayload(
  questions: Question[],
  answers: QuestionAnswers,
): { questions: Question[]; answers: QuestionAnswers } {
  return { questions, answers };
}

/** Normalise a selection into the single string value the tool expects. */
export function formatAnswer(
  selected: string[],
  customText: string,
): string {
  const custom = customText.trim();
  if (custom) return custom;
  return selected.join(", ");
}
