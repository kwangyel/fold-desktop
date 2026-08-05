import { create } from "zustand";
import type {
  PendingQuestions,
  Question,
  QuestionAnswers,
  QuestionSource,
} from "../lib/questions";

type QuestionStore = {
  /** At most one outstanding question set per chat tab. */
  pending: Record<string, PendingQuestions>;

  /** Queue a question set for a tab, replacing any earlier one. */
  ask: (source: QuestionSource, questions: Question[]) => void;
  /** Drop the pending set for a tab (after answering, or on cancel). */
  clear: (tabId: string) => void;
  get: (tabId: string) => PendingQuestions | undefined;
};

export const useQuestionStore = create<QuestionStore>((set, get) => ({
  pending: {},

  ask: (source, questions) =>
    set((state) => ({
      pending: { ...state.pending, [source.tabId]: { source, questions } },
    })),

  clear: (tabId) =>
    set((state) => {
      const { [tabId]: _dropped, ...rest } = state.pending;
      return { pending: rest };
    }),

  get: (tabId) => get().pending[tabId],
}));

/** True when every question has a non-empty answer. */
export function allAnswered(
  questions: Question[],
  answers: QuestionAnswers,
): boolean {
  return questions.every((q) => (answers[q.question] ?? "").trim().length > 0);
}
