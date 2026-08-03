/**
 * Type-only re-exports from `@anthropic-ai/claude-agent-sdk` for Claude Code
 * `stream-json` event shapes. The SDK itself is a Node library and is never
 * executed in the Tauri renderer — Rust drives the `claude` CLI.
 */
export type {
  SDKAssistantMessage,
  SDKMessage,
  SDKResultMessage,
  SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk";
