#!/usr/bin/env node
/**
 * Fetch Claude Code model catalog via the Agent SDK (`supportedModels()`).
 * Prints JSON to stdout. Used by the Tauri `claude_list_models` command.
 */
import { query } from "@anthropic-ai/claude-agent-sdk";

const q = query({
  prompt: "x",
  options: {
    maxTurns: 1,
    permissionMode: "bypassPermissions",
  },
});

try {
  const models = await q.supportedModels();
  process.stdout.write(JSON.stringify(models));
} finally {
  q.close();
}
