import ChatInput from "./ChatInput";
import {
  REVIEW_COMPOSER_TAB_ID,
  ensureReviewComposer,
  sendReviewComposer,
} from "../lib/reviewComments";

/**
 * Chat composer pinned under a diff. Comments land here as removable chips;
 * Send opens a new chat with the prompt and attachments (Conductor-style).
 */
export default function ReviewComposer() {
  ensureReviewComposer();
  return (
    <ChatInput
      tabId={REVIEW_COMPOSER_TAB_ID}
      placeholder="Ask about this diff…"
      onSend={(prompt) => void sendReviewComposer(prompt)}
    />
  );
}
