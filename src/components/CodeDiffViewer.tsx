import { useEffect, useRef, useState } from "react";
import { EditorState, Extension, StateEffect, StateField } from "@codemirror/state";
import {
  Decoration,
  DecorationSet,
  EditorView,
  GutterMarker,
  WidgetType,
  gutter,
} from "@codemirror/view";
import { basicSetup } from "codemirror";
import { unifiedMergeView, MergeView } from "@codemirror/merge";
import { foldEditorTheme, foldSyntaxHighlighting } from "../lib/codemirrorTheme";
import { languageExtensionForPath } from "../lib/languageExtension";
import type { DiffComment } from "../lib/reviewComments";
import { REVIEW_COMPOSER_TAB_ID, commentAttachmentId } from "../lib/reviewComments";
import { useChatStore } from "../store/chatStore";
import InlineCommentComposer from "./InlineCommentComposer";
import "./CodeEditor.css";

export type DiffLayout = "unified" | "split";

/** Payload emitted when a reviewer comments on a line (modified side). */
export interface InlineCommentSelection {
  startLine: number;
  endLine: number;
  /** Text of those lines from the modified document. */
  snippet: string;
}

interface CodeDiffViewerProps {
  filePath: string;
  original: string;
  modified: string;
  layout: DiffLayout;
  /** When provided, a `+` gutter opens the Save/Cancel composer. */
  onAddComment?: (selection: InlineCommentSelection, body: string) => void;
  /** Comments on this file (resolved ones are not painted). */
  comments?: DiffComment[];
  onDeleteComment?: (id: string) => void;
  /** Re-attach a saved comment to the composer under the diff. */
  onReattachComment?: (id: string) => void;
}

type CommentAnchor = {
  top: number;
  left: number;
  startLine: number;
  endLine: number;
};

type ActionRef = { current: ((id: string) => void) | undefined };

type LineComment = Pick<DiffComment, "id" | "line" | "endLine" | "body">;

type CommentsPayload = {
  comments: LineComment[];
  deleteRef: ActionRef;
  reattachRef: ActionRef;
  attachedIds: string[];
};

/** Effect + field that paint a left-marker on lines carrying a comment. */
const setCommentLines = StateEffect.define<number[]>();

const commentLineField = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(deco, tr) {
    deco = deco.map(tr.changes);
    for (const effect of tr.effects) {
      if (effect.is(setCommentLines)) {
        const doc = tr.state.doc;
        const ranges = effect.value
          .filter((ln) => ln >= 1 && ln <= doc.lines)
          .sort((a, b) => a - b)
          .map((ln) =>
            Decoration.line({ class: "cm-comment-line" }).range(doc.line(ln).from),
          );
        deco = Decoration.set(ranges, true);
      }
    }
    return deco;
  },
  provide: (f) => EditorView.decorations.from(f),
});

const setLineComments = StateEffect.define<CommentsPayload>();

class CommentWidget extends WidgetType {
  constructor(
    readonly comments: LineComment[],
    readonly deleteRef: ActionRef,
    readonly reattachRef: ActionRef,
    readonly attachedIds: ReadonlySet<string>,
  ) {
    super();
  }

  eq(other: CommentWidget) {
    if (this.comments.length !== other.comments.length) return false;
    if (this.attachedIds.size !== other.attachedIds.size) return false;
    for (const id of this.attachedIds) {
      if (!other.attachedIds.has(id)) return false;
    }
    return this.comments.every(
      (c, i) => c.id === other.comments[i]?.id && c.body === other.comments[i]?.body,
    );
  }

  toDOM() {
    const wrap = document.createElement("div");
    wrap.className = "cm-review-comment-list";
    wrap.addEventListener("mousedown", (e) => e.stopPropagation());

    for (const comment of this.comments) {
      const item = document.createElement("div");
      item.className = "cm-review-comment";

      const body = document.createElement("div");
      body.className = "cm-review-comment-body";
      body.textContent = comment.body;

      const actions = document.createElement("div");
      actions.className = "cm-review-comment-actions";

      if (!this.attachedIds.has(comment.id)) {
        const add = document.createElement("button");
        add.type = "button";
        add.className = "cm-review-comment-btn";
        add.textContent = "Add to chat";
        add.title = "Add this comment back to the composer";
        add.addEventListener("click", (e) => {
          e.preventDefault();
          e.stopPropagation();
          this.reattachRef.current?.(comment.id);
        });
        actions.append(add);
      }

      const del = document.createElement("button");
      del.type = "button";
      del.className = "cm-review-comment-btn";
      del.textContent = "Delete";
      del.addEventListener("click", (e) => {
        e.preventDefault();
        e.stopPropagation();
        this.deleteRef.current?.(comment.id);
      });
      actions.append(del);

      item.append(body, actions);
      wrap.append(item);
    }
    return wrap;
  }

  ignoreEvent() {
    return true;
  }
}

const commentWidgetField = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(deco, tr) {
    deco = deco.map(tr.changes);
    for (const effect of tr.effects) {
      if (effect.is(setLineComments)) {
        const doc = tr.state.doc;
        const byLine = new Map<number, LineComment[]>();
        for (const c of effect.value.comments) {
          if (c.line < 1 || c.line > doc.lines) continue;
          const list = byLine.get(c.line) ?? [];
          list.push(c);
          byLine.set(c.line, list);
        }
        const ranges = [...byLine.entries()]
          .sort((a, b) => a[0] - b[0])
          .map(([ln, list]) =>
            Decoration.widget({
              widget: new CommentWidget(
                list,
                effect.value.deleteRef,
                effect.value.reattachRef,
                new Set(effect.value.attachedIds),
              ),
              block: true,
              side: 1,
            }).range(doc.line(ln).to),
          );
        deco = Decoration.set(ranges, true);
      }
    }
    return deco;
  },
  provide: (f) => EditorView.decorations.from(f),
});

class PlusMarker extends GutterMarker {
  toDOM() {
    const span = document.createElement("span");
    span.className = "cm-comment-plus";
    span.textContent = "+";
    span.title = "Add a comment";
    return span;
  }
}

const plusMarker = new PlusMarker();

function plusGutter(onClick: (view: EditorView, lineNumber: number) => void): Extension {
  return gutter({
    class: "cm-comment-plus-gutter",
    lineMarker: () => plusMarker,
    domEventHandlers: {
      mousedown(view, line, event) {
        event.preventDefault();
        event.stopPropagation();
        onClick(view, view.state.doc.lineAt(line.from).number);
        return true;
      },
    },
  });
}

function snippetFromDoc(
  doc: { lines: number; line: (n: number) => { text: string } },
  startLine: number,
  endLine: number,
): string {
  const from = Math.max(1, startLine);
  const to = Math.min(doc.lines, Math.max(from, endLine));
  const parts: string[] = [];
  for (let ln = from; ln <= to; ln++) parts.push(doc.line(ln).text);
  return parts.join("\n");
}

function unresolvedForFile(comments: DiffComment[] | undefined): LineComment[] {
  return (comments ?? []).filter((c) => !c.resolved);
}

function commentLineNumbers(comments: LineComment[]): number[] {
  const lines: number[] = [];
  for (const c of comments) {
    for (let ln = c.line; ln <= c.endLine; ln++) lines.push(ln);
  }
  return lines;
}

export default function CodeDiffViewer({
  filePath,
  original,
  modified,
  layout,
  onAddComment,
  comments,
  onDeleteComment,
  onReattachComment,
}: CodeDiffViewerProps) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const modifiedViewRef = useRef<EditorView | null>(null);
  const [anchor, setAnchor] = useState<CommentAnchor | null>(null);

  const onAddRef = useRef(onAddComment);
  onAddRef.current = onAddComment;
  const deleteRefObj = useRef<ActionRef>({ current: onDeleteComment });
  deleteRefObj.current.current = onDeleteComment;
  const reattachRefObj = useRef<ActionRef>({ current: onReattachComment });
  reattachRefObj.current.current = onReattachComment;

  const commentsRef = useRef(comments);
  commentsRef.current = comments;

  const attachedKey = useChatStore((s) =>
    (s.tabs[REVIEW_COMPOSER_TAB_ID]?.attachments ?? [])
      .map((a) => a.id)
      .join(","),
  );

  const composingLineRef = useRef<number | null>(null);

  const attachedCommentIds = (): string[] => {
    const atts =
      useChatStore.getState().tabs[REVIEW_COMPOSER_TAB_ID]?.attachments ?? [];
    return (commentsRef.current ?? [])
      .filter((c) => atts.some((a) => a.id === commentAttachmentId(c.id)))
      .map((c) => c.id);
  };

  const paintComments = (view: EditorView) => {
    const unresolved = unresolvedForFile(commentsRef.current);
    view.dispatch({
      effects: [
        setCommentLines.of(commentLineNumbers(unresolved)),
        setLineComments.of({
          comments: unresolved,
          deleteRef: deleteRefObj.current,
          reattachRef: reattachRefObj.current,
          attachedIds: attachedCommentIds(),
        }),
      ],
    });
  };

  useEffect(() => {
    const parent = containerRef.current;
    const wrap = wrapRef.current;
    if (!parent) return;

    setAnchor(null);
    composingLineRef.current = null;

    const openComposer = (view: EditorView, lineNumber: number) => {
      if (!wrap || !onAddRef.current) return;
      const line = view.state.doc.line(lineNumber);
      const coords = view.coordsAtPos(line.from);
      if (!coords) return;
      const rect = wrap.getBoundingClientRect();
      composingLineRef.current = lineNumber;
      setAnchor({
        top: coords.bottom - rect.top,
        left: Math.max(8, coords.left - rect.left),
        startLine: lineNumber,
        endLine: lineNumber,
      });
    };

    const modifiedExtensions: Extension[] = [
      commentLineField,
      commentWidgetField,
      ...(onAddRef.current ? [plusGutter(openComposer)] : []),
    ];

    const baseExtensions: Extension[] = [
      basicSetup,
      foldEditorTheme,
      foldSyntaxHighlighting,
      languageExtensionForPath(filePath),
      EditorView.lineWrapping,
      EditorState.readOnly.of(true),
      EditorView.editable.of(false),
    ];

    let modifiedView: EditorView;
    let destroy: () => void;

    if (layout === "split") {
      const view = new MergeView({
        parent,
        a: { doc: original, extensions: baseExtensions },
        b: { doc: modified, extensions: [...baseExtensions, ...modifiedExtensions] },
        gutter: true,
      });
      modifiedView = view.b;
      destroy = () => view.destroy();
    } else {
      const view = new EditorView({
        parent,
        state: EditorState.create({
          doc: modified,
          extensions: [
            ...baseExtensions,
            ...modifiedExtensions,
            unifiedMergeView({
              original,
              gutter: true,
              mergeControls: false,
            }),
          ],
        }),
      });
      modifiedView = view;
      destroy = () => view.destroy();
    }

    modifiedViewRef.current = modifiedView;
    paintComments(modifiedView);

    const onScroll = () => {
      const lineNumber = composingLineRef.current;
      if (!lineNumber || !wrap) return;
      const line = modifiedView.state.doc.line(lineNumber);
      const coords = modifiedView.coordsAtPos(line.from);
      if (!coords) return;
      const rect = wrap.getBoundingClientRect();
      setAnchor((current) =>
        current
          ? {
              ...current,
              top: coords.bottom - rect.top,
              left: Math.max(8, coords.left - rect.left),
            }
          : current,
      );
    };
    const scroller = modifiedView.scrollDOM;
    scroller.addEventListener("scroll", onScroll);

    return () => {
      scroller.removeEventListener("scroll", onScroll);
      modifiedViewRef.current = null;
      destroy();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filePath, original, modified, layout]);

  // Repaint markers/widgets when comments or composer chips change.
  const commentKey = (comments ?? [])
    .map((c) => `${c.id}:${c.resolved}:${c.body}`)
    .join(",");
  useEffect(() => {
    const view = modifiedViewRef.current;
    if (view) paintComments(view);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [commentKey, attachedKey]);

  const locationLabel = anchor ? `line ${anchor.startLine}` : "";

  return (
    <div ref={wrapRef} className="code-diff-viewer-wrap">
      <div ref={containerRef} className="code-editor code-diff-viewer" />
      {anchor && onAddComment && (
        <InlineCommentComposer
          top={anchor.top}
          left={anchor.left}
          locationLabel={locationLabel}
          onCancel={() => {
            composingLineRef.current = null;
            setAnchor(null);
          }}
          onSubmit={(body) => {
            const view = modifiedViewRef.current;
            const snippet = view
              ? snippetFromDoc(
                  view.state.doc,
                  anchor.startLine,
                  anchor.endLine,
                )
              : "";
            onAddComment(
              {
                startLine: anchor.startLine,
                endLine: anchor.endLine,
                snippet,
              },
              body,
            );
            composingLineRef.current = null;
            setAnchor(null);
          }}
        />
      )}
    </div>
  );
}
