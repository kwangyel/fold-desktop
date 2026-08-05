import { useEffect, useMemo, useState } from "react";
import { allAnswered, useQuestionStore } from "../store/questionStore";
import { formatAnswer, type QuestionAnswers } from "../lib/questions";
import { answerQuestions } from "../lib/answerQuestions";
import "./QuestionDialog.css";

/** Per-question working state: chosen labels plus any free-text override. */
type Draft = { selected: string[]; custom: string };

export default function QuestionDialog({ tabId }: { tabId: string }) {
  const pending = useQuestionStore((s) => s.pending[tabId]);
  const clear = useQuestionStore((s) => s.clear);

  const [step, setStep] = useState(0);
  const [drafts, setDrafts] = useState<Record<number, Draft>>({});
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Reset wizard state whenever a new question set arrives for this tab.
  const questionKey = pending?.questions.map((q) => q.question).join("\0") ?? "";
  useEffect(() => {
    setStep(0);
    setDrafts({});
    setSubmitting(false);
    setError(null);
  }, [tabId, questionKey]);

  const questions = pending?.questions ?? [];
  const question = questions[step];

  const answers: QuestionAnswers = useMemo(() => {
    const result: QuestionAnswers = {};
    questions.forEach((q, i) => {
      const draft = drafts[i];
      if (!draft) return;
      const value = formatAnswer(draft.selected, draft.custom);
      if (value) result[q.question] = value;
    });
    return result;
  }, [questions, drafts]);

  if (!pending || !question) return null;

  const draft = drafts[step] ?? { selected: [], custom: "" };
  const isLast = step === questions.length - 1;
  const answeredHere = formatAnswer(draft.selected, draft.custom).length > 0;

  const setDraft = (patch: Partial<Draft>) =>
    setDrafts((prev) => ({ ...prev, [step]: { ...draft, ...patch } }));

  const toggleOption = (label: string) => {
    if (question.multiSelect) {
      const selected = draft.selected.includes(label)
        ? draft.selected.filter((l) => l !== label)
        : [...draft.selected, label];
      // Picking a listed option supersedes any free text.
      setDraft({ selected, custom: "" });
    } else {
      setDraft({ selected: [label], custom: "" });
    }
  };

  const handleSubmit = async () => {
    setSubmitting(true);
    setError(null);
    try {
      await answerQuestions(pending, answers);
      clear(tabId);
    } catch (e) {
      setError(String(e));
      setSubmitting(false);
    }
  };

  return (
    <div className="question-overlay">
      <div className="question-card" role="dialog" aria-modal="true">
        <div className="question-progress">
          {questions.map((q, i) => (
            <span
              key={q.question}
              className={`question-dot ${i === step ? "active" : ""} ${
                answers[q.question] ? "done" : ""
              }`}
            />
          ))}
          <span className="question-step-count">
            {step + 1} of {questions.length}
          </span>
        </div>

        {question.header && (
          <div className="question-header">{question.header}</div>
        )}
        <p className="question-text">{question.question}</p>

        <div className="question-options">
          {question.options.map((option) => {
            const checked = draft.selected.includes(option.label);
            return (
              <label
                key={option.label}
                className={`question-option ${checked ? "checked" : ""}`}
              >
                <input
                  type={question.multiSelect ? "checkbox" : "radio"}
                  name={`q-${step}`}
                  checked={checked}
                  onChange={() => toggleOption(option.label)}
                />
                <span className="question-option-body">
                  <span className="question-option-label">{option.label}</span>
                  {option.description && (
                    <span className="question-option-desc">
                      {option.description}
                    </span>
                  )}
                </span>
              </label>
            );
          })}

          <label
            className={`question-option question-other ${
              draft.custom ? "checked" : ""
            }`}
          >
            <span className="question-option-body">
              <span className="question-option-label">Other</span>
              <input
                type="text"
                className="question-custom-input"
                placeholder="Type your own answer…"
                value={draft.custom}
                onChange={(e) =>
                  // Free text replaces any option selection.
                  setDraft({ custom: e.target.value, selected: [] })
                }
              />
            </span>
          </label>
        </div>

        {error && <div className="question-error">{error}</div>}

        <div className="question-actions">
          <button
            type="button"
            className="question-btn"
            onClick={() => setStep((s) => s - 1)}
            disabled={step === 0 || submitting}
          >
            Back
          </button>
          {isLast ? (
            <button
              type="button"
              className="question-btn primary"
              onClick={() => void handleSubmit()}
              disabled={submitting || !allAnswered(questions, answers)}
            >
              {submitting ? "Sending…" : "Submit"}
            </button>
          ) : (
            <button
              type="button"
              className="question-btn primary"
              onClick={() => setStep((s) => s + 1)}
              disabled={!answeredHere || submitting}
            >
              Next
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
