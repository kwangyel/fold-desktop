import type { ModelInfo } from "@anthropic-ai/claude-agent-sdk";
import { cursorListModels } from "../cursor";
import { useCursorStore } from "../../store/cursorStore";
import { harnessMeta } from "./catalog";
import type { HarnessAdapter } from "./types";

/**
 * No static Cursor catalog. Live `GET /v1/models` returns the real list
 * (30+ models). A hardcoded 3-item stub was previously masking API failures
 * and getting TTL-cached in the picker.
 *
 * @see https://cursor.com/docs/cloud-agent/api/endpoints#list-models
 */
export const CURSOR_MODELS_FALLBACK: ModelInfo[] = [];

export const cursorAdapter: HarnessAdapter = {
  id: "cursor",
  meta: harnessMeta("cursor"),
  isConnected: () => useCursorStore.getState().authenticated,
  // `cursor-agent --mode plan` (read-only: analyze, propose, no edits).
  supportsPlanMode: true,
  listModels: async () => cursorListModels(),
  fallbackModels: () => CURSOR_MODELS_FALLBACK,
};
