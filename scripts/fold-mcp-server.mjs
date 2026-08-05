#!/usr/bin/env node
/**
 * Fold's stdio MCP server, exposing a single `fold_ask_user` tool.
 *
 * Claude Code can ask clarifying questions natively (the Agent SDK's
 * `AskUserQuestion` tool, routed through `canUseTool` — see
 * scripts/claude-agent.mjs). Cursor, Codex, and OpenCode expose no equivalent
 * in headless mode, but all three support MCP, so this server gives them the
 * same capability and the same Fold UI.
 *
 * The server runs as its own process, so it reaches the app through files: the
 * request is written to `<worktree>/.fold/asks/<askId>.json` and the answer is
 * awaited at `<askId>.answer.json`. Fold watches that directory.
 *
 * Usage: fold-mcp-server.mjs <worktree-path>
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

const worktree = process.argv[2] || process.cwd();
const asksDir = join(worktree, ".fold", "asks");

/** How often to check for the answer file, and how long to wait overall. */
const POLL_INTERVAL_MS = 300;
const TIMEOUT_MS = 30 * 60 * 1000;

const questionSchema = z.object({
  question: z.string().describe("The full question text to show the user."),
  header: z
    .string()
    .max(12)
    .optional()
    .describe("Short label for the question (max 12 characters)."),
  options: z
    .array(
      z.object({
        label: z.string().describe("Short answer label."),
        description: z
          .string()
          .optional()
          .describe("One line explaining what this option means."),
      }),
    )
    .min(2)
    .max(4)
    .describe("Between 2 and 4 choices."),
  multiSelect: z
    .boolean()
    .optional()
    .describe("Set when the user may pick more than one option."),
});

const server = new McpServer({ name: "fold", version: "1.0.0" });

server.registerTool(
  "fold_ask_user",
  {
    title: "Ask the user a question",
    description:
      "Ask the user one or more multiple-choice clarifying questions and wait " +
      "for their answers. Use this when the task has several valid approaches " +
      "and picking the wrong one would waste work — for example an ambiguous " +
      "requirement, or a choice between libraries. The user can also type a " +
      "free-form answer. Blocks until the user responds.",
    inputSchema: {
      questions: z.array(questionSchema).min(1).max(4),
    },
  },
  async ({ questions }) => {
    const askId = `ask-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    await mkdir(asksDir, { recursive: true });
    await writeFile(
      join(asksDir, `${askId}.json`),
      JSON.stringify(
        { askId, worktreePath: worktree, createdAt: Date.now(), questions },
        null,
        2,
      ),
    );

    const answerPath = join(asksDir, `${askId}.answer.json`);
    const deadline = Date.now() + TIMEOUT_MS;
    while (Date.now() < deadline) {
      try {
        const raw = await readFile(answerPath, "utf8");
        const { answers } = JSON.parse(raw);
        return {
          content: [
            {
              type: "text",
              text: Object.entries(answers ?? {})
                .map(([question, answer]) => `${question}\n→ ${answer}`)
                .join("\n\n"),
            },
          ],
        };
      } catch {
        // Not answered yet.
      }
      await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
    }

    return {
      content: [
        {
          type: "text",
          text: "The user did not answer in time. Proceed using your best judgement and state the assumption you made.",
        },
      ],
      isError: true,
    };
  },
);

await server.connect(new StdioServerTransport());
