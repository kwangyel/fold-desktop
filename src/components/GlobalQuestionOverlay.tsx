import { useMemo } from "react";
import { useQuestionStore } from "../store/questionStore";
import QuestionDialog from "./QuestionDialog";

/**
 * Renders clarifying questions above the center pane, regardless of which
 * tab is active. ChatInterface unmounts when you switch to a Plan/editor tab,
 * which used to hide the dialog and let MCP asks time out unanswered.
 */
export default function GlobalQuestionOverlay() {
  const pending = useQuestionStore((s) => s.pending);
  const tabId = useMemo(() => Object.keys(pending)[0], [pending]);
  if (!tabId) return null;
  return <QuestionDialog tabId={tabId} />;
}
