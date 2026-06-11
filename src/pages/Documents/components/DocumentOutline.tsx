import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ListTree } from 'lucide-react';
import type { Editor } from '@tiptap/react';

interface OutlineItem {
  level: 1 | 2 | 3;
  text: string;
  pos: number;
}

interface Props {
  editor: Editor | null;
}

/**
 * Auto-generated document outline (Google-Docs style) — every H1/H2/H3 in
 * the document, indentation by level, click → smooth-scroll to the heading.
 * Rebuilds on every doc change (heading walks are cheap — documents are
 * pages, not books).
 */
export default function DocumentOutline({ editor }: Props) {
  const { t } = useTranslation();
  const [items, setItems] = useState<OutlineItem[]>([]);

  useEffect(() => {
    if (!editor) return;
    const rebuild = () => {
      const next: OutlineItem[] = [];
      editor.state.doc.descendants((node, pos) => {
        if (node.type.name === 'heading') {
          const level = Number(node.attrs.level);
          if (level >= 1 && level <= 3) {
            next.push({ level: level as 1 | 2 | 3, text: node.textContent.trim(), pos });
          }
          return false; // headings have no nested headings
        }
        return true;
      });
      setItems(next);
    };
    rebuild();
    editor.on('update', rebuild);
    return () => {
      editor.off('update', rebuild);
    };
  }, [editor]);

  const jump = (item: OutlineItem) => {
    if (!editor) return;
    const dom = editor.view.nodeDOM(item.pos);
    if (dom instanceof HTMLElement) {
      dom.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
    // Park the caret at the heading so keyboard flow continues from there.
    editor.chain().setTextSelection(item.pos + 1).run();
  };

  return (
    <nav className="doc-outline" aria-label={t('doc.outline.title')}>
      <div className="flex items-center gap-1.5 mb-2 text-charcoal/40">
        <ListTree size={13} />
        <span className="text-[0.6875rem] font-bold uppercase tracking-widest">{t('doc.outline.title')}</span>
      </div>
      {items.length === 0 ? (
        <p className="text-xs text-charcoal/35 leading-relaxed">{t('doc.outline.empty')}</p>
      ) : (
        <ul className="space-y-0.5">
          {items.map((item, i) => (
            <li key={`${item.pos}-${i}`}>
              <button
                onClick={() => jump(item)}
                dir="auto"
                title={item.text}
                className={`w-full text-start truncate rounded-md px-2 py-1 text-xs transition-colors hover:bg-cream hover:text-charcoal ${
                  item.level === 1
                    ? 'font-bold text-charcoal'
                    : item.level === 2
                    ? 'text-charcoal/70 ms-2'
                    : 'text-charcoal/50 ms-4'
                }`}
              >
                {item.text || '…'}
              </button>
            </li>
          ))}
        </ul>
      )}
    </nav>
  );
}
