/**
 * Comment anchors for Wassel documents.
 *
 * A comment thread's ANCHOR is a `comment` mark on the commented text —
 * `<span data-comment-id="...">` in the serialized HTML. Because it's a mark
 * in the content, it moves with edits, splits across formatting, and
 * disappears naturally when the text is deleted (the thread then shows as
 * "orphaned" in the panel via its anchor_text snapshot). The conversation
 * itself lives in `public.document_comments` (see lib/documents/comments.ts).
 *
 * Highlighting is NOT done by styling the span directly — resolved threads
 * keep their mark (so Reopen restores the anchor) but must not show. Instead
 * a decoration plugin paints only ids present in `storage.openIds`, with a
 * stronger class for `storage.activeId`. The page pushes fresh sets in and
 * dispatches a `commentsRefresh` meta to rebuild (same pattern as
 * CrmVariablesExtension).
 *
 * Registered in DocumentEditor AND render.ts — one schema, no drift.
 */

import { Mark, mergeAttributes } from '@tiptap/core';
import { Plugin, PluginKey } from '@tiptap/pm/state';
import { Decoration, DecorationSet } from '@tiptap/pm/view';
import type { Node as PMNode } from '@tiptap/pm/model';
import type { Editor } from '@tiptap/react';

export interface CommentMarkStorage {
  /** Ids of UNRESOLVED threads — only these get the highlight decoration. */
  openIds: Set<string>;
  /** Thread focused in the panel — gets the stronger highlight. */
  activeId: string | null;
}

declare module '@tiptap/core' {
  interface Commands<ReturnType> {
    comment: {
      /** Mark the current selection as the anchor of comment `commentId`. */
      setComment: (commentId: string) => ReturnType;
      /** Remove every mark instance of one comment (thread delete). */
      unsetCommentById: (commentId: string) => ReturnType;
    };
  }
}

const highlightKey = new PluginKey<DecorationSet>('commentHighlight');

export const CommentMark = Mark.create<Record<string, never>, CommentMarkStorage>({
  name: 'comment',

  // Typing at the edge of a commented span must not grow the comment.
  inclusive: false,
  // A mark type excludes itself by default; clearing that lets two different
  // comments overlap on the same text (each keeps its own mark instance).
  excludes: '',

  addStorage() {
    return { openIds: new Set<string>(), activeId: null };
  },

  addAttributes() {
    return {
      commentId: {
        default: null,
        parseHTML: (el: HTMLElement) => el.getAttribute('data-comment-id'),
        renderHTML: (attrs: Record<string, unknown>) =>
          attrs.commentId ? { 'data-comment-id': String(attrs.commentId) } : {},
      },
    };
  },

  parseHTML() {
    return [{ tag: 'span[data-comment-id]' }];
  },

  renderHTML({ HTMLAttributes }) {
    return ['span', mergeAttributes(HTMLAttributes), 0];
  },

  addCommands() {
    return {
      setComment:
        (commentId: string) =>
        ({ commands }) =>
          commands.setMark(this.name, { commentId }),
      unsetCommentById:
        (commentId: string) =>
        ({ tr, state, dispatch }) => {
          let changed = false;
          state.doc.descendants((node, pos) => {
            if (!node.isText) return;
            for (const m of node.marks) {
              if (m.type.name === this.name && m.attrs.commentId === commentId) {
                tr.removeMark(pos, pos + node.nodeSize, m);
                changed = true;
              }
            }
          });
          if (changed && dispatch) dispatch(tr);
          return changed;
        },
    };
  },

  addProseMirrorPlugins() {
    const getStorage = () => this.storage;
    const markName = this.name;

    const build = (doc: PMNode): DecorationSet => {
      const { openIds, activeId } = getStorage();
      if (openIds.size === 0) return DecorationSet.empty;
      const decos: Decoration[] = [];
      doc.descendants((node, pos) => {
        if (!node.isText) return;
        for (const m of node.marks) {
          if (m.type.name !== markName) continue;
          const id = m.attrs.commentId as string | null;
          if (!id || !openIds.has(id)) continue;
          decos.push(
            Decoration.inline(pos, pos + node.nodeSize, {
              class: id === activeId ? 'doc-comment-hl doc-comment-hl--active' : 'doc-comment-hl',
            }),
          );
        }
      });
      return DecorationSet.create(doc, decos);
    };

    return [
      new Plugin<DecorationSet>({
        key: highlightKey,
        state: {
          init: (_config, { doc }) => build(doc),
          apply: (tr, old) =>
            tr.docChanged || tr.getMeta('commentsRefresh') ? build(tr.doc) : old.map(tr.mapping, tr.doc),
        },
        props: {
          decorations(state) {
            return highlightKey.getState(state);
          },
        },
      }),
    ];
  },
});

/** Comment ids present in the document right now, with the first anchor
 *  position of each (for sorting the panel in reading order). Threads whose
 *  id is absent are "orphaned" — their text was deleted. */
export function collectCommentAnchors(editor: Editor): Map<string, number> {
  const found = new Map<string, number>();
  editor.state.doc.descendants((node, pos) => {
    if (!node.isText) return;
    for (const m of node.marks) {
      if (m.type.name !== 'comment') continue;
      const id = m.attrs.commentId as string | null;
      if (id && !found.has(id)) found.set(id, pos);
    }
  });
  return found;
}

/** Push fresh open/active ids into the highlight plugin and repaint. */
export function refreshCommentHighlights(editor: Editor, openIds: Set<string>, activeId: string | null): void {
  const storage = (editor.storage as unknown as Record<string, CommentMarkStorage>)['comment'];
  if (!storage) return;
  storage.openIds = openIds;
  storage.activeId = activeId;
  editor.view.dispatch(editor.state.tr.setMeta('commentsRefresh', true));
}
