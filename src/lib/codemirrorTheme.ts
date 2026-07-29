import { HighlightStyle, syntaxHighlighting } from "@codemirror/language";
import { EditorView } from "@codemirror/view";
import { tags as t } from "@lezer/highlight";

export const foldEditorTheme = EditorView.theme(
  {
    "&": {
      color: "var(--text)",
      backgroundColor: "var(--bg)",
      height: "100%",
    },
    ".cm-scroller": {
      overflow: "auto",
      fontFamily: '"SF Mono", Menlo, monospace',
    },
    ".cm-content": {
      caretColor: "var(--accent)",
      padding: "8px 0",
    },
    ".cm-cursor, .cm-dropCursor": {
      borderLeftColor: "var(--accent)",
    },
    ".cm-gutters": {
      backgroundColor: "var(--panel)",
      color: "var(--muted)",
      border: "none",
      paddingRight: "4px",
    },
    ".cm-activeLineGutter": {
      backgroundColor: "var(--panel-2)",
      color: "var(--text)",
    },
    ".cm-activeLine": {
      backgroundColor: "rgba(43, 43, 48, 0.45)",
    },
    "&.cm-focused .cm-selectionBackground, .cm-selectionBackground, &.cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground":
      {
        backgroundColor: "rgba(124, 92, 255, 0.25) !important",
      },
    ".cm-line": {
      padding: "0 12px 0 4px",
    },
    ".cm-changedLine": {
      backgroundColor: "rgba(74, 222, 128, 0.1) !important",
    },
    ".cm-deletedChunk": {
      backgroundColor: "rgba(248, 113, 113, 0.1) !important",
    },
    ".cm-changedText, .cm-deletedText": {
      background: "transparent",
    },
    ".cm-changedLine .cm-changedText": {
      backgroundColor: "rgba(74, 222, 128, 0.18)",
    },
    ".cm-deletedLine .cm-deletedText": {
      backgroundColor: "rgba(248, 113, 113, 0.18)",
    },
    ".cm-mergeSpacer": {
      backgroundColor: "var(--panel)",
    },
  },
  { dark: true },
);

export const foldHighlightStyle = HighlightStyle.define([
  { tag: t.keyword, color: "#c792ea" },
  { tag: [t.name, t.deleted, t.character, t.propertyName, t.macroName], color: "#82aaff" },
  { tag: [t.function(t.variableName), t.labelName], color: "#82aaff" },
  { tag: [t.color, t.constant(t.name), t.standard(t.name)], color: "#f78c6c" },
  { tag: [t.definition(t.name), t.separator], color: "#e6e6e6" },
  { tag: [t.typeName, t.className, t.number, t.changed, t.annotation, t.modifier, t.self, t.namespace], color: "#ffcb6b" },
  { tag: [t.operator, t.operatorKeyword, t.url, t.escape, t.regexp, t.link, t.special(t.string)], color: "#89ddff" },
  { tag: [t.meta, t.comment], color: "#697098", fontStyle: "italic" },
  { tag: t.strong, fontWeight: "bold" },
  { tag: t.emphasis, fontStyle: "italic" },
  { tag: t.strikethrough, textDecoration: "line-through" },
  { tag: t.link, color: "#89ddff", textDecoration: "underline" },
  { tag: t.heading, fontWeight: "bold", color: "#c792ea" },
  { tag: [t.atom, t.bool, t.special(t.variableName)], color: "#f78c6c" },
  { tag: [t.processingInstruction, t.string, t.inserted], color: "#c3e88d" },
  { tag: t.invalid, color: "#ff5370" },
]);

export const foldSyntaxHighlighting = syntaxHighlighting(foldHighlightStyle);
