import type { ModelInfo } from "@anthropic-ai/claude-agent-sdk";
import { cursorListModels } from "../cursor";
import { useCursorStore } from "../../store/cursorStore";
import { harnessMeta } from "./catalog";
import type { HarnessAdapter } from "./types";

/**
 * Docs / API-shaped fallback when live `GET /v1/models` is unavailable.
 * IDs match Cursor Cloud Agents API examples.
 *
 * @see https://cursor.com/docs/cloud-agent/api/endpoints#list-models
 */
export const CURSOR_MODELS_FALLBACK: ModelInfo[] = [
  {
    value: "composer-2",
    resolvedModel: "composer-2",
    displayName: "Composer 2",
    description: "Cursor Composer 2 · Default coding agent model",
    supportsFastMode: true,
  },
  {
    value: "composer-2.5",
    resolvedModel: "composer-2.5",
    displayName: "Composer 2.5",
    description: "Cursor Composer 2.5 · Latest Composer agent model",
    supportsFastMode: true,
  },
  {
    value: "auto-smart",
    resolvedModel: "auto-smart",
    displayName: "Auto (Router)",
    description: "Cursor Router picks a model per request",
    supportsAutoMode: true,
  },
];

export const cursorAdapter: HarnessAdapter = {
  id: "cursor",
  meta: harnessMeta("cursor"),
  isConnected: () => useCursorStore.getState().authenticated,
  listModels: async () => {
    try {
      return await cursorListModels();
    } catch {
      return CURSOR_MODELS_FALLBACK;
    }
  },
};
