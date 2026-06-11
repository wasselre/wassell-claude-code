/**
 * TipTap extension that DISPLAYS resolved CRM variable values in place of
 * `{{slug}}` tokens — without ever touching the stored document.
 *
 * The token stays as plain text in the TipTap JSON; a ProseMirror inline
 * decoration swaps its visual for the resolved value (CSS hides the token
 * glyphs and renders `data-resolved` via ::after — see documents.css
 * `.crm-var--resolved`). Unresolved tokens keep their raw text with a
 * dashed amber underline so the author can see what's missing.
 *
 * The live values are pushed in from outside (DocumentEditor effect) via
 * `editor.storage.crmVariables.vars` + a `crmVarsRefresh` transaction meta
 * that forces the decoration set to rebuild.
 */

import { Extension } from '@tiptap/core';
import { Plugin, PluginKey } from '@tiptap/pm/state';
import { Decoration, DecorationSet } from '@tiptap/pm/view';
import type { Node as PMNode } from '@tiptap/pm/model';

export interface CrmVariablesStorage {
  vars: Record<string, string>;
}

const pluginKey = new PluginKey<DecorationSet>('crmVariables');

const TOKEN_RE = /\{\{(\w+)\}\}/g;

export const CrmVariables = Extension.create<Record<string, never>, CrmVariablesStorage>({
  name: 'crmVariables',

  addStorage() {
    return { vars: {} };
  },

  addProseMirrorPlugins() {
    const getVars = (): Record<string, string> => this.storage.vars;

    const buildDecorations = (doc: PMNode): DecorationSet => {
      const decos: Decoration[] = [];
      const vars = getVars();
      doc.descendants((node, pos) => {
        if (!node.isText || !node.text) return;
        TOKEN_RE.lastIndex = 0;
        let m: RegExpExecArray | null;
        while ((m = TOKEN_RE.exec(node.text)) !== null) {
          const slug = m[1] ?? '';
          const from = pos + m.index;
          const to = from + m[0].length;
          const resolved = vars[slug];
          if (resolved !== undefined && resolved !== '') {
            decos.push(
              Decoration.inline(from, to, {
                class: 'crm-var crm-var--resolved',
                'data-resolved': resolved,
                // Hover reveals the underlying token so authors know the source.
                title: m[0],
              }),
            );
          } else {
            decos.push(
              Decoration.inline(from, to, {
                class: 'crm-var crm-var--missing',
                title: m[0],
              }),
            );
          }
        }
      });
      return DecorationSet.create(doc, decos);
    };

    return [
      new Plugin<DecorationSet>({
        key: pluginKey,
        state: {
          init: (_config, { doc }) => buildDecorations(doc),
          apply: (tr, old) =>
            tr.docChanged || tr.getMeta('crmVarsRefresh')
              ? buildDecorations(tr.doc)
              : old.map(tr.mapping, tr.doc),
        },
        props: {
          decorations(state) {
            return pluginKey.getState(state);
          },
        },
      }),
    ];
  },
});
