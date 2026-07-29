import { json } from "@codemirror/lang-json";
import { markdown } from "@codemirror/lang-markdown";
import { rust } from "@codemirror/lang-rust";
import { javascript } from "@codemirror/lang-javascript";
import type { Extension } from "@codemirror/state";

export function languageExtensionForPath(path: string): Extension {
  const ext = path.split(".").pop()?.toLowerCase() ?? "";

  switch (ext) {
    case "ts":
    case "tsx":
      return javascript({ typescript: true, jsx: ext === "tsx" });
    case "js":
    case "jsx":
      return javascript({ jsx: ext === "jsx" });
    case "json":
      return json();
    case "md":
      return markdown();
    case "rs":
      return rust();
    default:
      return [];
  }
}
