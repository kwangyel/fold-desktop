import { useEffect, useRef } from "react";
import { EditorState } from "@codemirror/state";
import { EditorView, basicSetup } from "codemirror";
import { foldEditorTheme, foldSyntaxHighlighting } from "../lib/codemirrorTheme";
import { languageExtensionForPath } from "../lib/languageExtension";
import "./CodeEditor.css";

interface CodeEditorProps {
  filePath: string;
  content: string;
  onChange: (content: string) => void;
}

export default function CodeEditor({ filePath, content, onChange }: CodeEditorProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  const onChangeRef = useRef(onChange);

  onChangeRef.current = onChange;

  useEffect(() => {
    const parent = containerRef.current;
    if (!parent) return;

    const view = new EditorView({
      parent,
      state: EditorState.create({
        doc: content,
        extensions: [
          basicSetup,
          foldEditorTheme,
          foldSyntaxHighlighting,
          languageExtensionForPath(filePath),
          EditorView.lineWrapping,
          EditorView.updateListener.of((update) => {
            if (update.docChanged) {
              onChangeRef.current(update.state.doc.toString());
            }
          }),
        ],
      }),
    });

    viewRef.current = view;

    return () => {
      view.destroy();
      viewRef.current = null;
    };
  }, [filePath]);

  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;

    const current = view.state.doc.toString();
    if (content !== current) {
      view.dispatch({
        changes: { from: 0, to: current.length, insert: content },
      });
    }
  }, [content]);

  return <div ref={containerRef} className="code-editor" />;
}
