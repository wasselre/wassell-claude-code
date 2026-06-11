import { useEffect, useImperativeHandle, forwardRef, useRef } from 'react';
import { EditorContent, useEditor, type Editor } from '@tiptap/react';
import { Extension } from '@tiptap/core';
import { CrmVariables } from './CrmVariablesExtension';
import { MentionNode, mentionSuggestion, type MentionAttrs } from './MentionExtension';
import StarterKit from '@tiptap/starter-kit';
import Underline from '@tiptap/extension-underline';
import Link from '@tiptap/extension-link';
import Image from '@tiptap/extension-image';
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
}

const DocumentEditor = forwardRef<DocumentEditorHandle, Props>(function DocumentEditor(
  { initialContent, editable, onChange, placeholder, baseDir, onReady, crmVars, onMentionClick },
  ref,
) {
  const onReadyRef = useRef(onReady);
  onReadyRef.current = onReady;
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;
  const onMentionClickRef = useRef(onMentionClick);
  onMentionClickRef.current = onMentionClick;

  const editor = useEditor({
    editable,
    content: initialContent,
    extensions: [
      StarterKit.configure({
        // We want headings, lists, blockquote, code, all from StarterKit.
        // No special config needed for the defaults.
        heading: { levels: [1, 2, 3] },
      }),
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
      Image.configure({
        // We hand-roll the image insert (uploads to wassel-files via the
        // documents page's onInsertImage handler), so the extension just
        // needs to know how to render <img> nodes — no inline-upload UX.
        inline: false,
        allowBase64: false,
      }),
      Placeholder.configure({
        placeholder,
      }),
      TextAlign.configure({
        types: ['heading', 'paragraph'],
      }),
      ListIndentShortcuts,
      CrmVariables,
      MentionNode.configure({ suggestion: mentionSuggestion }),
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
      const el = (e.target as HTMLElement | null)?.closest?.('[data-mention]');
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
