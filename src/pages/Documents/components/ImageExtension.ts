/**
 * Wassel document image — the stock TipTap Image extended with layout attrs:
 *
 *   width: 25 | 50 | 75 | 100 (percent of the page column; null = natural)
 *   align: 'start' | 'center' | 'end' | 'wrap-start' | 'wrap-end'
 *          (wrap-* float the image so text flows around it)
 *
 * Both render as style/data-attrs on the <img>, so the same markup works in
 * the editor, content_html, and the export shells (CSS in documents.css and
 * buildHtmlShell). Controls live in the toolbar's contextual image group.
 *
 * Shared by DocumentEditor AND renderDocumentHtml — one schema, no drift.
 */

import Image from '@tiptap/extension-image';

export type ImageAlign = 'start' | 'center' | 'end' | 'wrap-start' | 'wrap-end';

export const WasselImage = Image.extend({
  addAttributes() {
    return {
      ...this.parent?.(),
      width: {
        default: null,
        parseHTML: (el: HTMLElement) => {
          const w = el.style.width || el.getAttribute('width') || '';
          const m = /^(\d{1,3})%$/.exec(w);
          return m ? Number(m[1]) : null;
        },
        renderHTML: (attrs: Record<string, unknown>) =>
          typeof attrs.width === 'number' ? { style: `width: ${attrs.width}%` } : {},
      },
      align: {
        default: 'center',
        parseHTML: (el: HTMLElement) => el.getAttribute('data-align') ?? 'center',
        renderHTML: (attrs: Record<string, unknown>) => ({
          'data-align': String(attrs.align ?? 'center'),
        }),
      },
    };
  },
}).configure({
  inline: false,
  allowBase64: false,
});
