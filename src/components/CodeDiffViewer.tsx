import { useEffect, useRef } from "react";
import { EditorState } from "@codemirror/state";
import { EditorView, basicSetup } from "codemirror";
import { unifiedMergeView } from "@codemirror/merge";
import { foldEditorTheme, foldSyntaxHighlighting } from "../lib/codemirrorTheme";
import { languageExtensionForPath } from "../lib/languageExtension";
import "./CodeEditor.css";

interface CodeDiffViewerProps {
  filePath: string;
  original: string;
  modified: string;
}

export default function CodeDiffViewer({ filePath, original, modified }: CodeDiffViewerProps) {
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const parent = containerRef.current;
    if (!parent) return;

    const view = new EditorView({
      parent,
      state: EditorState.create({
        doc: modified,
        extensions: [
          basicSetup,
          foldEditorTheme,
          foldSyntaxHighlighting,
          languageExtensionForPath(filePath),
          EditorView.lineWrapping,
          EditorState.readOnly.of(true),
          EditorView.editable.of(false),
          unifiedMergeView({
            original,
            gutter: true,
            mergeControls: false,
          }),
        ],
      }),
    });

    return () => view.destroy();
  }, [filePath, original, modified]);

  return <div ref={containerRef} className="code-editor code-diff-viewer" />;
}
