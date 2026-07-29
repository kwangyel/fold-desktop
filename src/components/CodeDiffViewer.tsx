import { useEffect, useRef } from "react";
import { EditorState, Extension } from "@codemirror/state";
import { EditorView, basicSetup } from "codemirror";
import { unifiedMergeView, MergeView } from "@codemirror/merge";
import { foldEditorTheme, foldSyntaxHighlighting } from "../lib/codemirrorTheme";
import { languageExtensionForPath } from "../lib/languageExtension";
import "./CodeEditor.css";

export type DiffLayout = "unified" | "split";

interface CodeDiffViewerProps {
  filePath: string;
  original: string;
  modified: string;
  layout: DiffLayout;
}

export default function CodeDiffViewer({
  filePath,
  original,
  modified,
  layout,
}: CodeDiffViewerProps) {
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const parent = containerRef.current;
    if (!parent) return;

    const baseExtensions: Extension[] = [
      basicSetup,
      foldEditorTheme,
      foldSyntaxHighlighting,
      languageExtensionForPath(filePath),
      EditorView.lineWrapping,
      EditorState.readOnly.of(true),
      EditorView.editable.of(false),
    ];

    if (layout === "split") {
      const view = new MergeView({
        parent,
        a: { doc: original, extensions: baseExtensions },
        b: { doc: modified, extensions: baseExtensions },
        gutter: true,
      });
      return () => view.destroy();
    }

    const view = new EditorView({
      parent,
      state: EditorState.create({
        doc: modified,
        extensions: [
          ...baseExtensions,
          unifiedMergeView({
            original,
            gutter: true,
            mergeControls: false,
          }),
        ],
      }),
    });

    return () => view.destroy();
  }, [filePath, original, modified, layout]);

  return <div ref={containerRef} className="code-editor code-diff-viewer" />;
}
