/** Activity kinds shown in chat bubbles / summary accordion. */
export type ActivityKind =
  | "thinking"
  | "search"
  | "read"
  | "write"
  | "shell"
  | "tool";

const SEARCH_NAMES = /^(grep|glob|search|semanticsearch|websearch|rg)$/i;
const READ_NAMES = /^(read|readfile|read_file|cat|view)$/i;
const WRITE_NAMES =
  /^(write|edit|create|apply|strreplace|str_replace|multiedit|delete|writefile|editfile)$/i;
const SHELL_NAMES = /^(bash|shell|terminal|run|exec|command)$/i;

export function activityKindFromToolName(name: string | undefined): ActivityKind {
  if (!name) return "tool";
  const n = name.replace(/\s+/g, "");
  if (SEARCH_NAMES.test(n) || /search|grep|glob/i.test(name)) return "search";
  if (READ_NAMES.test(n) || /^read\b/i.test(name)) return "read";
  if (WRITE_NAMES.test(n) || /write|edit|create|replace|delete/i.test(name))
    return "write";
  if (SHELL_NAMES.test(n) || /bash|shell|terminal|command/i.test(name))
    return "shell";
  return "tool";
}

export function activityLabel(kind: ActivityKind, count: number): string {
  const plural = count === 1 ? "" : "s";
  switch (kind) {
    case "thinking":
      return `${count} thinking`;
    case "search":
      return `${count} search${plural}`;
    case "read":
      return `${count} read${plural}`;
    case "write":
      return `${count} edit${plural}`;
    case "shell":
      return `${count} command${plural}`;
    default:
      return `${count} tool${plural}`;
  }
}

/** Pull a short one-line excerpt from tool input for the accordion header. */
export function toolExcerpt(
  toolName: string | undefined,
  input: unknown,
): string {
  if (input == null) return toolName ?? "tool";
  if (typeof input === "string") {
    const trimmed = input.trim().replace(/\s+/g, " ");
    return trimmed.length > 80 ? `${trimmed.slice(0, 77)}…` : trimmed || (toolName ?? "tool");
  }
  if (typeof input !== "object") return String(input);

  const obj = input as Record<string, unknown>;
  const candidates = [
    "command",
    "cmd",
    "query",
    "pattern",
    "path",
    "file_path",
    "filePath",
    "file",
    "target_file",
    "glob",
    "glob_pattern",
    "url",
    "prompt",
    "description",
  ];
  for (const key of candidates) {
    const v = obj[key];
    if (typeof v === "string" && v.trim()) {
      const trimmed = v.trim().replace(/\s+/g, " ");
      const prefix = toolName ? `${toolName} ` : "";
      const body = trimmed.length > 72 ? `${trimmed.slice(0, 69)}…` : trimmed;
      return `${prefix}${body}`.trim();
    }
  }

  try {
    const raw = JSON.stringify(obj);
    if (raw.length <= 80) return raw;
    return `${raw.slice(0, 77)}…`;
  } catch {
    return toolName ?? "tool";
  }
}

/** Extract file paths from a tool input payload. */
export function filePathsFromInput(input: unknown): string[] {
  if (input == null) return [];
  if (typeof input === "string") return [];
  if (typeof input !== "object") return [];

  const obj = input as Record<string, unknown>;
  const keys = [
    "path",
    "file_path",
    "filePath",
    "file",
    "target_file",
    "targetFile",
    "filename",
  ];
  const paths: string[] = [];
  for (const key of keys) {
    const v = obj[key];
    if (typeof v === "string" && v.trim() && !v.includes("\n")) {
      paths.push(v.trim());
    }
  }
  if (Array.isArray(obj.paths)) {
    for (const p of obj.paths) {
      if (typeof p === "string" && p.trim()) paths.push(p.trim());
    }
  }
  return [...new Set(paths)];
}

export function stringifyPayload(value: unknown): string {
  if (value == null) return "";
  if (typeof value === "string") return value;
  if (Array.isArray(value)) {
    return value
      .map((item) => {
        if (typeof item === "string") return item;
        if (item && typeof item === "object" && "text" in item) {
          return String((item as { text?: unknown }).text ?? "");
        }
        try {
          return JSON.stringify(item, null, 2);
        } catch {
          return String(item);
        }
      })
      .filter(Boolean)
      .join("\n");
  }
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

/** Dig args/result out of a Cursor `tool_call` object. */
export function cursorToolPayload(
  toolCall: Record<string, unknown> | undefined,
): { args?: unknown; result?: unknown } {
  if (!toolCall) return {};
  const key = Object.keys(toolCall)[0];
  if (!key) return {};
  const body = toolCall[key];
  if (!body || typeof body !== "object") return {};
  const rec = body as Record<string, unknown>;
  return {
    args: rec.args ?? rec.arguments ?? rec.input,
    result: rec.result ?? rec.output ?? rec.content,
  };
}
