/**
 * Mentions for Wassel Documents — type `@` to mention a USER (@ريان) or a
 * CRM RECORD (@مينا 52, @client…). Mentions are atomic inline chips; record
 * mentions navigate to the record on click (wired via DocumentEditor's
 * handleClickOn → page-level navigate).
 *
 * Search is instant and fully in-memory: active users + every record of the
 * linkable models (same `linkableModels` / `recordTitle` machinery as the
 * Linked-records picker), so the dropdown costs zero network.
 *
 * The dropdown is a hand-rolled vanilla-DOM list (no tippy dependency) driven
 * by @tiptap/suggestion's imperative lifecycle. Styles in documents.css
 * (`.doc-mention`, `.doc-mention-menu`).
 *
 * Serialization: <span data-mention data-kind data-id data-model-id>@label</span>
 * — survives content_html so export/share surfaces can hydrate later.
 */

import Mention from '@tiptap/extension-mention';
import type { SuggestionOptions, SuggestionProps, SuggestionKeyDownProps } from '@tiptap/suggestion';
import { useAppStore } from '@/stores/appStore';
import { linkableModels, recordTitle } from '@/lib/documents/links';

export interface MentionAttrs {
  kind: 'user' | 'record';
  id: string;
  modelId: string | null;
  label: string;
}

interface MentionItem extends MentionAttrs {
  /** Secondary line in the dropdown (email / model label). Not stored. */
  sublabel: string;
}

/** Node schema shared by the live editor AND renderDocumentHtml. */
export const MentionNode = Mention.extend({
  addAttributes() {
    return {
      kind: {
        default: 'record',
        parseHTML: (el: HTMLElement) => el.getAttribute('data-kind') ?? 'record',
        renderHTML: (attrs: Record<string, unknown>) => ({ 'data-kind': String(attrs.kind ?? 'record') }),
      },
      id: {
        default: '',
        parseHTML: (el: HTMLElement) => el.getAttribute('data-id') ?? '',
        renderHTML: (attrs: Record<string, unknown>) => ({ 'data-id': String(attrs.id ?? '') }),
      },
      modelId: {
        default: null,
        parseHTML: (el: HTMLElement) => el.getAttribute('data-model-id'),
        renderHTML: (attrs: Record<string, unknown>) =>
          attrs.modelId ? { 'data-model-id': String(attrs.modelId) } : {},
      },
      label: {
        default: '',
        parseHTML: (el: HTMLElement) => el.getAttribute('data-label') ?? el.textContent?.replace(/^@/, '') ?? '',
        renderHTML: (attrs: Record<string, unknown>) => ({ 'data-label': String(attrs.label ?? '') }),
      },
    };
  },
}).configure({
  HTMLAttributes: { class: 'doc-mention', 'data-mention': '' },
  renderText({ node }) {
    return `@${String(node.attrs.label ?? '')}`;
  },
  renderHTML({ options, node }) {
    return ['span', { ...options.HTMLAttributes }, `@${String(node.attrs.label ?? '')}`];
  },
  // Suggestion is attached separately in buildMentionExtension so the bare
  // node stays usable by renderDocumentHtml (no editor, no suggestion).
});

// ─── In-memory search ─────────────────────────────────────────────────────

const MAX_USERS = 4;
const MAX_RECORDS = 8;

function mentionItems(query: string): MentionItem[] {
  const s = useAppStore.getState();
  const isAr = s.language === 'ar';
  const q = query.trim().toLowerCase();
  const items: MentionItem[] = [];

  // Users first — the canonical @mention target.
  const users = s.users
    .filter((u) => u.is_active)
    .filter((u) => {
      if (!q) return true;
      return (
        u.name_ar.toLowerCase().includes(q) ||
        u.name_en.toLowerCase().includes(q) ||
        u.email.toLowerCase().includes(q)
      );
    })
    .slice(0, MAX_USERS);
  for (const u of users) {
    items.push({
      kind: 'user',
      id: u.id,
      modelId: null,
      label: isAr ? u.name_ar : u.name_en,
      sublabel: u.email,
    });
  }

  // Records — only once the user starts typing (the full corpus is too broad
  // for an empty query).
  if (q) {
    const models = linkableModels(s.models);
    let added = 0;
    for (const model of models) {
      if (added >= MAX_RECORDS) break;
      const records = s.records[model.id] ?? [];
      for (const r of records) {
        if (added >= MAX_RECORDS) break;
        const title = recordTitle(model, r, isAr);
        if (title.toLowerCase().includes(q)) {
          items.push({
            kind: 'record',
            id: r.id,
            modelId: model.id,
            label: title,
            sublabel: isAr ? model.label_ar : model.label_en,
          });
          added += 1;
        }
      }
    }
  }

  return items;
}

// ─── Vanilla-DOM dropdown (suggestion renderer) ───────────────────────────

class MentionMenu {
  private el: HTMLDivElement;
  private items: MentionItem[] = [];
  private selected = 0;
  private command: (attrs: MentionAttrs) => void = () => {};

  constructor() {
    this.el = document.createElement('div');
    this.el.className = 'doc-mention-menu';
    document.body.appendChild(this.el);
  }

  update(props: SuggestionProps<MentionItem>) {
    this.items = props.items;
    this.command = (attrs) => props.command(attrs as MentionItem);
    if (this.selected >= this.items.length) this.selected = 0;
    this.position(props.clientRect?.() ?? null);
    this.render();
  }

  private position(rect: DOMRect | null) {
    if (!rect) return;
    const menuWidth = 280;
    const left = Math.min(Math.max(8, rect.left), window.innerWidth - menuWidth - 8);
    this.el.style.left = `${left}px`;
    this.el.style.top = `${rect.bottom + 6}px`;
  }

  private render() {
    this.el.innerHTML = '';
    if (this.items.length === 0) {
      this.el.classList.add('is-empty');
      return;
    }
    this.el.classList.remove('is-empty');
    this.items.forEach((item, i) => {
      const row = document.createElement('button');
      row.type = 'button';
      row.className = `doc-mention-item${i === this.selected ? ' is-selected' : ''}`;
      const label = document.createElement('span');
      label.className = 'doc-mention-item-label';
      label.textContent = item.label;
      const sub = document.createElement('span');
      sub.className = 'doc-mention-item-sub';
      sub.textContent = item.sublabel;
      row.append(label, sub);
      // mousedown (not click) so the editor never loses focus mid-selection.
      row.addEventListener('mousedown', (e) => {
        e.preventDefault();
        this.select(i);
      });
      this.el.appendChild(row);
    });
  }

  private select(i: number) {
    const item = this.items[i];
    if (!item) return;
    const { kind, id, modelId, label } = item;
    this.command({ kind, id, modelId, label });
  }

  onKeyDown(props: SuggestionKeyDownProps): boolean {
    if (this.items.length === 0) return false;
    if (props.event.key === 'ArrowDown') {
      this.selected = (this.selected + 1) % this.items.length;
      this.render();
      return true;
    }
    if (props.event.key === 'ArrowUp') {
      this.selected = (this.selected - 1 + this.items.length) % this.items.length;
      this.render();
      return true;
    }
    if (props.event.key === 'Enter' || props.event.key === 'Tab') {
      this.select(this.selected);
      return true;
    }
    return false;
  }

  destroy() {
    this.el.remove();
  }
}

/** Suggestion config for the live editor. */
export const mentionSuggestion: Omit<SuggestionOptions<MentionItem>, 'editor'> = {
  char: '@',
  allowSpaces: true,
  items: ({ query }) => mentionItems(query),
  render: () => {
    let menu: MentionMenu | null = null;
    return {
      onStart: (props) => {
        menu = new MentionMenu();
        menu.update(props);
      },
      onUpdate: (props) => {
        menu?.update(props);
      },
      onKeyDown: (props) => {
        if (props.event.key === 'Escape') {
          menu?.destroy();
          menu = null;
          return true;
        }
        return menu?.onKeyDown(props) ?? false;
      },
      onExit: () => {
        menu?.destroy();
        menu = null;
      },
    };
  },
};
