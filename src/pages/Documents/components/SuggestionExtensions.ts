/**
 * Suggestions mode (tracked changes) for Wassel documents.
 *
 * Two marks carry the proposals INSIDE the content (so they serialize,
 * survive reloads, and will sync in collab):
 *   suggestInsert — text proposed to be added   (copper underline)
 *   suggestDelete — text proposed to be removed (red strikethrough)
 * Both render as `<span data-suggest="insert|delete" data-author data-ts>`.
 *
 * The SuggestionMode extension intercepts editing while `storage.enabled`:
 *   - insertions: an appendTransaction adds suggestInsert over every range
 *     inserted by a user transaction (typing, paste-at-caret, input rules).
 *   - Backspace/Delete: instead of deleting, the target range is marked
 *     suggestDelete. Parts that are themselves suggestInsert text are REALLY
 *     deleted (removing a pending proposal is not a new proposal). A caret
 *     bumping against already-struck text hops over it.
 *   - type-over / paste-over a selection: the selection is first marked as
 *     suggested-deleted and the caret collapsed AFTER it; we then return
 *     false so ProseMirror's default insert continues at the collapsed
 *     caret — and the appendTransaction marks what it inserted.
 *   - cut: copies plain text to the clipboard, then marks the selection
 *     deleted (a real cut would silently bypass tracking).
 *
 * KNOWN v1 LIMITS (documented in the PRD): structural changes (Enter splits,
 * block joins at block boundaries, list/table ops, formatting) apply
 * immediately rather than as suggestions; internal drag-drop is untracked.
 *
 * Accept/Reject operate on RUNS — maximal adjacent spans of the same
 * type+author — via commands; the toolbar shows contextual controls when
 * the caret is inside a run.
 */

import { Extension, Mark, mergeAttributes } from '@tiptap/core';
import { Plugin, PluginKey, TextSelection } from '@tiptap/pm/state';
import type { EditorState } from '@tiptap/pm/state';
import type { EditorView } from '@tiptap/pm/view';
import type { Node as PMNode } from '@tiptap/pm/model';
import { isChangeOrigin } from '@tiptap/extension-collaboration';

// ─── Marks ────────────────────────────────────────────────────────────────────

interface SuggestAttrs {
  author: string | null;
  ts: number | null;
}

function suggestMark(name: string, kind: 'insert' | 'delete', inclusive: boolean) {
  return Mark.create({
    name,
    inclusive,
    addAttributes() {
      return {
        author: {
          default: null,
          parseHTML: (el: HTMLElement) => el.getAttribute('data-author'),
          renderHTML: (attrs: Record<string, unknown>) =>
            attrs.author ? { 'data-author': String(attrs.author) } : {},
        },
        ts: {
          default: null,
          parseHTML: (el: HTMLElement) => {
            const v = el.getAttribute('data-ts');
            return v ? Number(v) : null;
          },
          renderHTML: (attrs: Record<string, unknown>) =>
            attrs.ts ? { 'data-ts': String(attrs.ts) } : {},
        },
      };
    },
    parseHTML() {
      return [{ tag: `span[data-suggest="${kind}"]` }];
    },
    renderHTML({ HTMLAttributes }) {
      return ['span', mergeAttributes(HTMLAttributes, { 'data-suggest': kind }), 0];
    },
  });
}

/** Proposed addition. Inclusive so continued typing extends the proposal. */
export const SuggestInsert = suggestMark('suggestInsert', 'insert', true);
/** Proposed removal. Not inclusive — typing at its edge is NEW text. */
export const SuggestDelete = suggestMark('suggestDelete', 'delete', false);

// ─── Runs (units of review) ───────────────────────────────────────────────────

export interface SuggestionRun {
  from: number;
  to: number;
  kind: 'insert' | 'delete';
  author: string | null;
  ts: number | null;
}

/** All suggestion runs in the doc, in document order. Adjacent same-kind,
 *  same-author spans merge into one reviewable run. */
export function findSuggestionRuns(doc: PMNode): SuggestionRun[] {
  const runs: SuggestionRun[] = [];
  doc.descendants((node, pos) => {
    if (!node.isText) return;
    for (const m of node.marks) {
      const kind = m.type.name === 'suggestInsert' ? 'insert' : m.type.name === 'suggestDelete' ? 'delete' : null;
      if (!kind) continue;
      const attrs = m.attrs as unknown as SuggestAttrs;
      const last = runs[runs.length - 1];
      if (last && last.kind === kind && last.author === attrs.author && last.to === pos) {
        last.to = pos + node.nodeSize;
      } else {
        runs.push({ from: pos, to: pos + node.nodeSize, kind, author: attrs.author, ts: attrs.ts });
      }
    }
  });
  return runs;
}

/** The run the selection currently touches (for the contextual toolbar). */
export function findRunAtSelection(state: EditorState): SuggestionRun | null {
  const { from, to } = state.selection;
  for (const run of findSuggestionRuns(state.doc)) {
    if (run.from <= to && run.to >= from) return run;
  }
  return null;
}

// ─── Mode extension ───────────────────────────────────────────────────────────

export interface SuggestionModeStorage {
  enabled: boolean;
  /** App user id stamped on proposals. */
  author: string;
}

declare module '@tiptap/core' {
  interface Commands<ReturnType> {
    suggestionMode: {
      acceptSuggestionRun: (run: SuggestionRun) => ReturnType;
      rejectSuggestionRun: (run: SuggestionRun) => ReturnType;
      acceptAllSuggestions: () => ReturnType;
      rejectAllSuggestions: () => ReturnType;
    };
  }
}

interface Range {
  from: number;
  to: number;
}

export const SuggestionMode = Extension.create<Record<string, never>, SuggestionModeStorage>({
  name: 'suggestionMode',

  addStorage() {
    return { enabled: false, author: '' };
  },

  addCommands() {
    const apply = (run: SuggestionRun, action: 'accept' | 'reject') =>
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ({ state, tr, dispatch }: any) => {
        const insType = state.schema.marks.suggestInsert;
        const delType = state.schema.marks.suggestDelete;
        tr.setMeta('suggestionSkip', true);
        if (run.kind === 'insert') {
          if (action === 'accept') tr.removeMark(run.from, run.to, insType);
          else tr.delete(run.from, run.to);
        } else {
          if (action === 'accept') tr.delete(run.from, run.to);
          else tr.removeMark(run.from, run.to, delType);
        }
        if (dispatch) dispatch(tr);
        return true;
      };
    const applyAll = (action: 'accept' | 'reject') =>
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ({ state, tr, dispatch }: any) => {
        const insType = state.schema.marks.suggestInsert;
        const delType = state.schema.marks.suggestDelete;
        const runs = findSuggestionRuns(state.doc).sort((a, b) => b.from - a.from);
        if (runs.length === 0) return false;
        tr.setMeta('suggestionSkip', true);
        for (const run of runs) {
          const removeText = run.kind === 'insert' ? action === 'reject' : action === 'accept';
          if (removeText) tr.delete(run.from, run.to);
          else tr.removeMark(run.from, run.to, run.kind === 'insert' ? insType : delType);
        }
        if (dispatch) dispatch(tr);
        return true;
      };
    return {
      acceptSuggestionRun: (run: SuggestionRun) => apply(run, 'accept'),
      rejectSuggestionRun: (run: SuggestionRun) => apply(run, 'reject'),
      acceptAllSuggestions: () => applyAll('accept'),
      rejectAllSuggestions: () => applyAll('reject'),
    };
  },

  addProseMirrorPlugins() {
    const getStorage = (): SuggestionModeStorage => this.storage;

    /** Classify [from,to] into proposed-insert parts (really deletable) and
     *  plain parts (to strike); returns false if there's nothing actionable
     *  (i.e. the whole range is already struck). Mutates tr. */
    const strikeRange = (
      state: EditorState,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      tr: any,
      from: number,
      to: number,
      author: string,
    ): boolean => {
      const insertParts: Range[] = [];
      const plainParts: Range[] = [];
      state.doc.nodesBetween(from, to, (node, pos) => {
        if (!node.isText) return;
        const f = Math.max(from, pos);
        const t = Math.min(to, pos + node.nodeSize);
        if (t <= f) return;
        const hasIns = node.marks.some((m) => m.type.name === 'suggestInsert');
        const hasDel = node.marks.some((m) => m.type.name === 'suggestDelete');
        if (hasIns) insertParts.push({ from: f, to: t });
        else if (!hasDel) plainParts.push({ from: f, to: t });
      });
      if (insertParts.length === 0 && plainParts.length === 0) return false;
      const delType = state.schema.marks.suggestDelete;
      if (!delType) return false;
      tr.setMeta('suggestionSkip', true);
      // Remove pending-insert text for real, end-first so positions hold.
      [...insertParts]
        .sort((a, b) => b.from - a.from)
        .forEach((r) => tr.delete(r.from, r.to));
      // Strike the rest (map through the deletes above).
      plainParts.forEach((r) => {
        const f = tr.mapping.map(r.from, 1);
        const t = tr.mapping.map(r.to, -1);
        if (t > f) tr.addMark(f, t, delType.create({ author, ts: Date.now() }));
      });
      return true;
    };

    const handleDeleteKey = (view: EditorView, dir: -1 | 1): boolean => {
      const st = getStorage();
      if (!st.enabled) return false;
      const { state } = view;
      const sel = state.selection;
      let from = sel.from;
      let to = sel.to;
      if (sel.empty) {
        const $f = sel.$from;
        if (dir === -1) {
          // Block start — let the default block-join run (untracked, v1).
          if ($f.parentOffset === 0) return false;
          from = sel.from - 1;
          to = sel.from;
        } else {
          if ($f.parentOffset >= $f.parent.content.size) return false;
          from = sel.from;
          to = sel.from + 1;
        }
      }
      const tr = state.tr;
      const acted = strikeRange(state, tr, from, to, st.author);
      if (!acted) {
        // Entire target already struck — hop the caret over it instead of
        // letting the default delete eat proposed-deleted text.
        if (sel.empty) {
          const target = dir === -1 ? from : to;
          view.dispatch(state.tr.setSelection(TextSelection.create(state.doc, target)));
          return true;
        }
        return true; // selection fully struck — nothing more to propose
      }
      const caret = dir === -1 ? tr.mapping.map(from, -1) : tr.mapping.map(to, 1);
      tr.setSelection(TextSelection.create(tr.doc, Math.min(caret, tr.doc.content.size)));
      view.dispatch(tr);
      return true;
    };

    /** Non-empty selection about to be replaced (typing/paste): strike it,
     *  collapse the caret after it, and let the DEFAULT insert continue —
     *  the appendTransaction below marks whatever lands. */
    const preStrikeSelection = (view: EditorView): void => {
      const st = getStorage();
      const { state } = view;
      const sel = state.selection;
      if (sel.empty) return;
      const tr = state.tr;
      strikeRange(state, tr, sel.from, sel.to, st.author);
      const caret = tr.mapping.map(sel.to, 1);
      tr.setSelection(TextSelection.create(tr.doc, Math.min(caret, tr.doc.content.size)));
      view.dispatch(tr);
    };

    return [
      new Plugin({
        key: new PluginKey('suggestionMode'),

        // Mark everything user transactions INSERT while suggesting.
        appendTransaction: (transactions, _oldState, newState) => {
          const st = getStorage();
          if (!st.enabled) return null;
          const insType = newState.schema.marks.suggestInsert;
          if (!insType) return null;
          const tr = newState.tr;
          let marked = false;
          for (const transaction of transactions) {
            if (!transaction.docChanged) continue;
            if (transaction.getMeta('suggestionSkip')) continue;
            if (transaction.getMeta('history$')) continue; // undo/redo restores state, not new proposals
            if (isChangeOrigin(transaction)) continue; // remote collab edits are NOT our proposals
            const ranges: Range[] = [];
            for (const step of transaction.steps) {
              const map = step.getMap();
              // Slide already-collected ranges through this step.
              for (const r of ranges) {
                r.from = map.map(r.from, 1);
                r.to = map.map(r.to, -1);
              }
              map.forEach((_fromA, _toA, fromB, toB) => {
                if (toB > fromB) ranges.push({ from: fromB, to: toB });
              });
            }
            for (const r of ranges) {
              if (r.to <= r.from) continue;
              tr.addMark(r.from, r.to, insType.create({ author: st.author, ts: Date.now() }));
              marked = true;
            }
          }
          if (!marked) return null;
          tr.setMeta('suggestionSkip', true);
          return tr;
        },

        props: {
          handleKeyDown: (view, event) => {
            if (event.key === 'Backspace') return handleDeleteKey(view, -1);
            if (event.key === 'Delete') return handleDeleteKey(view, 1);
            return false;
          },
          handleTextInput: (view) => {
            const st = getStorage();
            if (!st.enabled || view.state.selection.empty) return false;
            preStrikeSelection(view);
            return false; // default insert continues at the collapsed caret
          },
          handlePaste: (view) => {
            const st = getStorage();
            if (!st.enabled || view.state.selection.empty) return false;
            preStrikeSelection(view);
            return false;
          },
          handleDOMEvents: {
            cut: (view, event) => {
              const st = getStorage();
              if (!st.enabled || view.state.selection.empty) return false;
              // Preserve the copy half of cut (plain text is enough here),
              // then strike instead of removing.
              const { from, to } = view.state.selection;
              const text = view.state.doc.textBetween(from, to, '\n');
              event.preventDefault();
              event.clipboardData?.setData('text/plain', text);
              const tr = view.state.tr;
              strikeRange(view.state, tr, from, to, st.author);
              tr.setSelection(TextSelection.create(tr.doc, Math.min(tr.mapping.map(to, 1), tr.doc.content.size)));
              view.dispatch(tr);
              return true;
            },
          },
        },
      }),
    ];
  },
});
