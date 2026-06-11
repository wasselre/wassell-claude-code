import { useEffect, useImperativeHandle, forwardRef, useRef } from 'react';
import { EditorContent, useEditor, type Editor } from '@tiptap/react';
import { Extension, type Extensions } from '@tiptap/core';
import Collaboration from '@tiptap/extension-collaboration';
import { CollaborationCaret } from '@tiptap/extension-collaboration-caret';
import type * as Y from 'yjs';
import { Y_FIELD, type SupabaseCollabProvider } from '@/lib/documents/collab';
import { CrmVariables } from './CrmVariablesExtension';
import { CommentMark } from './CommentMarkExtension';
import { SuggestDelete, SuggestInsert, SuggestionMode, type SuggestionModeStorage } from './SuggestionExtensions';
import { MentionNode, mentionSuggestion, type MentionAttrs } from './MentionExtension';
import { Table, TableRow, TableHeader, TableCell } from '@tiptap/extension-table';
import { PageBreak } from './PageBreakExtension';
import StarterKit from '@tiptap/starter-kit';
import Underline from '@tiptap/extension-underline';
import Link from '@tiptap/extension-link';
import { WasselImage } from './ImageExtension';
import Placeholder from '@tiptap/extension-placeholder';
import TextAlign from '@tiptap/extension-text-align';
import type { JSONContent } from '@tiptap/react';

/**
 * Google-Docs-style list indent / outdent keyboard shortcuts, mapped by
 * VISUAL direction so the bracket keys feel the same as in LTR Google Docs:
 *   Mod-]  → move the item to the RIGHT
 *   Mod-[  → move the item to the LEFT
 *
 * "Right" and "left" translate to sink/lift depending on the document's base
 * direction (read live off the editor DOM so a language toggle is respected):
 *   - RTL doc: indentation grows from the right, so moving RIGHT = lift
 *     (outdent) and moving LEFT = sink (indent deeper).
 *   - LTR doc: the reverse — moving RIGHT = sink, moving LEFT = lift.
 *
 * Tab / Shift-Tab keep their conventional meaning (indent deeper / outdent)
 * via StarterKit's ListItem regardless of direction. Each command returns
 * false outside a list, so the keystroke falls through instead of being eaten.
 */
const ListIndentShortcuts = Extension.create({
  name: 'listIndentShortcuts',
  addKeyboardShortcuts() {
    const isRtl = () => this.editor.view.dom.getAttribute('dir') === 'rtl';
    const moveRight = () =>
      isRtl()
        ? this.editor.commands.liftListItem('listItem')
        : this.editor.commands.sinkListItem('listItem');
    const moveLeft = () =>
      isRtl()
        ? this.editor.commands.sinkListItem('listItem')
        : this.editor.commands.liftListItem('listItem');
    return {
      'Mod-]': moveRight,
      'Mod-[': moveLeft,
    };
  },
});

/**
 * Strip every font-family declaration from incoming HTML so pasted content
 * can never escape the Amiri-only rule.
 *
 * We mutate two places:
 *   1. Inline `style="...; font-family: X;..."` attributes on every node —
 *      regex sub on the style string, then re-set if anything remains.
 *   2. `<style>` blocks inside the pasted fragment — remove font-family
 *      declarations from the CSS text.
 *
 * The same rule applies to `font` shorthand which can carry font-family.
 *
 * CSS in documents.css uses `!important` as a backstop in case anything
 * slips through (e.g. a font-face inside a `<style>` block we missed).
 */
function stripFontFamily(html: string): string {
  if (typeof window === 'undefined') return html;
  const tpl = document.createElement('template');
  tpl.innerHTML = html;

  const STRIP_FONT = (style: string): string =>
    style
      .replace(/font-family\s*:\s*[^;]+;?/gi, '')
      .replace(/\bfont\s*:\s*[^;]+;?/gi, '')
      .trim();

  tpl.content.querySelectorAll<HTMLElement>('[style]').forEach((el) => {
    const cleaned = STRIP_FONT(el.getAttribute('style') ?? '');
    if (cleaned) el.setAttribute('style', cleaned);
    else el.removeAttribute('style');
  });

  tpl.content.querySelectorAll<HTMLStyleElement>('style').forEach((el) => {
    el.textContent = (el.textContent ?? '').replace(/font-family\s*:\s*[^;}]+;?/gi, '');
  });

  // Drop any <font face="..."> wrapper entirely — replace with its children.
  tpl.content.querySelectorAll('font').forEach((el) => {
    const parent = el.parentNode;
    if (!parent) return;
    while (el.firstChild) parent.insertBefore(el.firstChild, el);
    parent.removeChild(el);
  });

  return tpl.innerHTML;
}

export interface DocumentEditorHandle {
  getJSON: () => JSONContent;
  getHTML: () => string;
  insertImage: (src: string, alt?: string) => void;
  focus: () => void;
  editor: Editor | null;
}

interface Props {
  /** Initial document state. Loaded once on mount; subsequent prop changes
   *  are ignored to avoid clobbering in-flight edits. */
  initialContent: JSONContent;
  /** Whether the editor is read-only (no edits). Used for view-only access. */
  editable: boolean;
  /** Called whenever the editor content changes — caller debounces saves. */
  onChange: () => void;
  placeholder: string;
  /** Base writing direction for the document surface (from the app language).
   *  Anchors lists/indentation/markers to one side; individual text blocks
   *  still auto-detect their own direction via CSS `unicode-bidi: plaintext`. */
  baseDir: 'rtl' | 'ltr';
  /** Receives the live Editor instance so the parent toolbar can mount. */
  onReady: (editor: Editor) => void;
  /** Resolved CRM variable values (slug → display value) from the document's
   *  linked records. {{slug}} tokens display these via decorations — the
   *  stored content keeps the raw tokens. */
  crmVars?: Record<string, string>;
  /** Record-mention chip clicked — the page navigates to the record. */
  onMentionClick?: (attrs: MentionAttrs) => void;
  /** Comment anchor clicked — the page activates that thread in the panel. */
  onCommentClick?: (commentId: string) => void;
  /** Suggestions mode: edits become tracked proposals instead of changes. */
  suggesting?: boolean;
  /** App user id stamped onto proposals (suggestions mode). */
  suggestAuthor?: string | null;
  /** Real-time collaboration. When ydoc is provided the SHARED CRDT doc is
   *  the source of truth — `initialContent` is ignored (the page hydrates
   *  the ydoc before mounting this component) and built-in undo/redo is
   *  swapped for the Yjs undo manager. Mount with a stable key per session. */
  ydoc?: Y.Doc | null;
  collabProvider?: SupabaseCollabProvider | null;
  collabUser?: { name: string; color: string } | null;
}

const DocumentEditor = forwardRef<DocumentEditorHandle, Props>(function DocumentEditor(
  {
    initialContent,
    editable,
    onChange,
    placeholder,
    baseDir,
    onReady,
    crmVars,
    onMentionClick,
    onCommentClick,
    suggesting,
    suggestAuthor,
    ydoc,
    collabProvider,
    collabUser,
  },
  ref,
) {
  const onReadyRef = useRef(onReady);
  onReadyRef.current = onReady;
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;
  const onMentionClickRef = useRef(onMentionClick);
  onMentionClickRef.current = onMentionClick;
  const onCommentClickRef = useRef(onCommentClick);
  onCommentClickRef.current = onCommentClick;

  // Collaboration swaps the content source (shared Y.Doc) and the undo stack
  // (Y.UndoManager — undoing your own edits without undoing your peers').
  const collab = !!ydoc;
  const collabExtensions: Extensions = collab
    ? [
        Collaboration.configure({ document: ydoc, field: Y_FIELD }),
        ...(collabProvider && collabUser
          ? [CollaborationCaret.configure({ provider: collabProvider, user: collabUser })]
          : []),
      ]
    : [];

  const editor = useEditor({
    editable,
    // With collab the ydoc IS the content — setting content would re-insert
    // it into the shared doc and duplicate it for every joiner.
    content: collab ? undefined : initialContent,
    extensions: [
      StarterKit.configure({
        // We want headings, lists, blockquote, code, all from StarterKit.
        // No special config needed for the defaults.
        heading: { levels: [1, 2, 3] },
        // Yjs owns history under collab (Collaboration registers undo/redo).
        ...(collab ? { undoRedo: false } : {}),
      }),
      ...collabExtensions,
      Underline,
      Link.configure({
        openOnClick: false,
        autolink: true,
        HTMLAttributes: {
          // No target=_blank on the rendered HTML so internal preview opens
          // in-place; the editor's link command sets the href only.
          rel: 'noopener noreferrer',
        },
      }),
      // Extended Image (width % + align/wrap attrs). The insert flow is
      // still hand-rolled by the page's onInsertImage handler.
      WasselImage,
      Placeholder.configure({
        placeholder,
      }),
      TextAlign.configure({
        types: ['heading', 'paragraph'],
      }),
      ListIndentShortcuts,
      CrmVariables,
      // Comment anchors (highlight decorations driven by the page via
      // refreshCommentHighlights — see CommentMarkExtension).
      CommentMark,
      // Tracked changes: proposal marks + the suggesting-mode interceptor.
      SuggestInsert,
      SuggestDelete,
      SuggestionMode,
      MentionNode.configure({ suggestion: mentionSuggestion }),
      // Google-Docs-style tables: drag column borders to resize; the rest of
      // the operations (rows/cols/merge/split/header) live in the toolbar.
      Table.configure({ resizable: true }),
      TableRow,
      TableHeader,
      TableCell,
      PageBreak,
    ],
    editorProps: {
      attributes: {
        // Base direction from the app language anchors lists/indentation/
        // markers to one side. Per-block direction is still auto-detected in
        // CSS (`unicode-bidi: plaintext`) so mixed Arabic+English paragraphs
        // each render in their native direction.
        dir: baseDir,
        spellcheck: 'true',
      },
      transformPastedHTML: (html) => stripFontFamily(html),
    },
    onUpdate: () => {
      onChangeRef.current();
    },
    onCreate: ({ editor: ed }) => {
      onReadyRef.current(ed);
    },
  });

  // Keep editable in sync if the parent flips it (e.g. permission changes
  // mid-session after a refresh).
  useEffect(() => {
    if (!editor) return;
    editor.setEditable(editable);
  }, [editor, editable]);

  // Keep the base direction in sync if the app language toggles mid-session.
  useEffect(() => {
    if (!editor) return;
    editor.view.dom.setAttribute('dir', baseDir);
  }, [editor, baseDir]);

  // Record-mention chips navigate on click. Delegated MOUSEDOWN listener on
  // the editor surface — neither ProseMirror's handleClickOn nor a DOM
  // 'click' listener works here (verified live 2026-06-11): on mousedown PM
  // sets a NodeSelection and re-renders the chip, so mouseup lands on a NEW
  // element instance and the browser retargets the click to the common
  // ancestor, which no longer matches [data-mention]. At mousedown time the
  // original chip element is still intact.
  useEffect(() => {
    if (!editor) return;
    const dom = editor.view.dom;
    const onMouseDown = (e: MouseEvent) => {
      if (e.button !== 0) return;
      const target = e.target as HTMLElement | null;
      // Comment anchors activate their thread in the panel. No preventDefault —
      // the caret should still land where the user clicked.
      const commentEl = target?.closest?.('[data-comment-id]');
      if (commentEl) {
        const id = commentEl.getAttribute('data-comment-id');
        if (id) onCommentClickRef.current?.(id);
      }
      const el = target?.closest?.('[data-mention]');
      if (!el) return;
      if (el.getAttribute('data-kind') !== 'record') return;
      e.preventDefault();
      const attrs: MentionAttrs = {
        kind: 'record',
        id: el.getAttribute('data-id') ?? '',
        modelId: el.getAttribute('data-model-id'),
        label: el.getAttribute('data-label') ?? '',
      };
      onMentionClickRef.current?.(attrs);
    };
    dom.addEventListener('mousedown', onMouseDown);
    return () => dom.removeEventListener('mousedown', onMouseDown);
  }, [editor]);

  // Suggestions mode flag + author flow into the interceptor's storage —
  // read at event time, so no re-render or dispatch is needed on toggle.
  useEffect(() => {
    if (!editor) return;
    const storage = (editor.storage as unknown as Record<string, SuggestionModeStorage>)['suggestionMode'];
    if (!storage) return;
    storage.enabled = !!suggesting && editable;
    storage.author = suggestAuthor ?? '';
  }, [editor, suggesting, suggestAuthor, editable]);

  // Push fresh CRM variable values into the decoration extension whenever
  // the linked records (or their data) change — the token text in the doc
  // is untouched; only the displayed values update.
  useEffect(() => {
    if (!editor) return;
    // TipTap types editor.storage per-extension via module augmentation we
    // don't declare; the runtime shape is the extension's addStorage() value.
    const storage = (editor.storage as unknown as Record<string, { vars: Record<string, string> }>)['crmVariables'];
    if (!storage) return;
    storage.vars = crmVars ?? {};
    editor.view.dispatch(editor.state.tr.setMeta('crmVarsRefresh', true));
  }, [editor, crmVars]);

  useImperativeHandle(
    ref,
    () => ({
      getJSON: () => editor?.getJSON() ?? { type: 'doc', content: [{ type: 'paragraph' }] },
      getHTML: () => editor?.getHTML() ?? '',
      insertImage: (src: string, alt?: string) => {
        editor?.chain().focus().setImage({ src, alt }).run();
      },
      focus: () => editor?.commands.focus(),
      editor,
    }),
    [editor],
  );

  return (
    <div className="wassel-doc-surface">
      <EditorContent editor={editor} />
    </div>
  );
});

export default DocumentEditor;
