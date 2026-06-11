import { useCallback, useEffect, useReducer } from 'react';
import { useTranslation } from 'react-i18next';
import type { Editor } from '@tiptap/react';
import {
  Bold,
  Italic,
  Underline as UnderlineIcon,
  Strikethrough,
  Heading1,
  Heading2,
  Heading3,
  List,
  ListOrdered,
  Quote,
  Code,
  Link as LinkIcon,
  Image as ImageIcon,
  AlignLeft,
  AlignCenter,
  AlignRight,
  Undo,
  Redo,
  Minus,
  Table as TableIcon,
  SeparatorHorizontal,
  Rows3,
  Columns3,
  TableRowsSplit,
  TableColumnsSplit,
  TableCellsMerge,
  TableCellsSplit,
  TableProperties,
  Trash2,
} from 'lucide-react';

/**
 * Editor toolbar for Wassel documents.
 *
 * Deliberately omits any font-family control — Wassel docs are Amiri-only
 * by brand policy (enforced in documents.css + the paste sanitizer). The
 * formatting buttons here cover what TipTap StarterKit + our extra
 * extensions support: marks, headings, lists, blockquotes, code, links,
 * images, alignment, undo/redo.
 */
interface Props {
  editor: Editor | null;
  /** Hook for handling image insertion — the parent owns the upload flow
   *  because it has the file id needed to associate the upload with this
   *  document's owning file (so RLS works the same as any other upload). */
  onInsertImage: () => void;
}

export default function DocumentToolbar({ editor, onInsertImage }: Props) {
  const { t } = useTranslation();

  // Re-render on every editor transaction so SELECTION-driven state is live:
  // the contextual table controls must appear the moment the caret enters a
  // table (and bold/align active states must track caret moves, not just doc
  // edits). TipTap v3 doesn't re-render owners on transactions by default.
  const [, forceRender] = useReducer((x: number) => x + 1, 0);
  useEffect(() => {
    if (!editor) return;
    editor.on('transaction', forceRender);
    return () => {
      editor.off('transaction', forceRender);
    };
  }, [editor]);

  const setLink = useCallback(() => {
    if (!editor) return;
    const previous = editor.getAttributes('link').href as string | undefined;
    const url = window.prompt(t('doc.editor.link_prompt'), previous ?? 'https://');
    if (url === null) return; // user cancelled
    if (url === '') {
      editor.chain().focus().extendMarkRange('link').unsetLink().run();
      return;
    }
    editor.chain().focus().extendMarkRange('link').setLink({ href: url }).run();
  }, [editor, t]);

  if (!editor) return null;

  return (
    <div className="border-b border-sand/30 bg-white/80 backdrop-blur-sm sticky top-0 z-10">
      <div className="max-w-4xl mx-auto px-4 py-2 flex flex-wrap items-center gap-1">
        <Group>
          <Btn
            icon={Undo}
            label={t('doc.editor.undo')}
            onClick={() => editor.chain().focus().undo().run()}
            disabled={!editor.can().undo()}
          />
          <Btn
            icon={Redo}
            label={t('doc.editor.redo')}
            onClick={() => editor.chain().focus().redo().run()}
            disabled={!editor.can().redo()}
          />
        </Group>

        <Divider />

        <Group>
          <Btn
            icon={Heading1}
            label={t('doc.editor.h1')}
            active={editor.isActive('heading', { level: 1 })}
            onClick={() => editor.chain().focus().toggleHeading({ level: 1 }).run()}
          />
          <Btn
            icon={Heading2}
            label={t('doc.editor.h2')}
            active={editor.isActive('heading', { level: 2 })}
            onClick={() => editor.chain().focus().toggleHeading({ level: 2 }).run()}
          />
          <Btn
            icon={Heading3}
            label={t('doc.editor.h3')}
            active={editor.isActive('heading', { level: 3 })}
            onClick={() => editor.chain().focus().toggleHeading({ level: 3 }).run()}
          />
        </Group>

        <Divider />

        <Group>
          <Btn
            icon={Bold}
            label={t('doc.editor.bold')}
            active={editor.isActive('bold')}
            onClick={() => editor.chain().focus().toggleBold().run()}
          />
          <Btn
            icon={Italic}
            label={t('doc.editor.italic')}
            active={editor.isActive('italic')}
            onClick={() => editor.chain().focus().toggleItalic().run()}
          />
          <Btn
            icon={UnderlineIcon}
            label={t('doc.editor.underline')}
            active={editor.isActive('underline')}
            onClick={() => editor.chain().focus().toggleUnderline().run()}
          />
          <Btn
            icon={Strikethrough}
            label={t('doc.editor.strike')}
            active={editor.isActive('strike')}
            onClick={() => editor.chain().focus().toggleStrike().run()}
          />
        </Group>

        <Divider />

        <Group>
          <Btn
            icon={List}
            label={t('doc.editor.bulleted_list')}
            active={editor.isActive('bulletList')}
            onClick={() => editor.chain().focus().toggleBulletList().run()}
          />
          <Btn
            icon={ListOrdered}
            label={t('doc.editor.numbered_list')}
            active={editor.isActive('orderedList')}
            onClick={() => editor.chain().focus().toggleOrderedList().run()}
          />
          <Btn
            icon={Quote}
            label={t('doc.editor.quote')}
            active={editor.isActive('blockquote')}
            onClick={() => editor.chain().focus().toggleBlockquote().run()}
          />
          <Btn
            icon={Code}
            label={t('doc.editor.code_block')}
            active={editor.isActive('codeBlock')}
            onClick={() => editor.chain().focus().toggleCodeBlock().run()}
          />
        </Group>

        <Divider />

        <Group>
          <Btn
            icon={AlignLeft}
            label={t('doc.editor.align_left')}
            active={editor.isActive({ textAlign: 'left' })}
            onClick={() => editor.chain().focus().setTextAlign('left').run()}
          />
          <Btn
            icon={AlignCenter}
            label={t('doc.editor.align_center')}
            active={editor.isActive({ textAlign: 'center' })}
            onClick={() => editor.chain().focus().setTextAlign('center').run()}
          />
          <Btn
            icon={AlignRight}
            label={t('doc.editor.align_right')}
            active={editor.isActive({ textAlign: 'right' })}
            onClick={() => editor.chain().focus().setTextAlign('right').run()}
          />
        </Group>

        <Divider />

        <Group>
          <Btn icon={LinkIcon} label={t('doc.editor.link')} active={editor.isActive('link')} onClick={setLink} />
          <Btn icon={ImageIcon} label={t('doc.editor.image')} onClick={onInsertImage} />
          <Btn
            icon={Minus}
            label={t('doc.editor.divider')}
            onClick={() => editor.chain().focus().setHorizontalRule().run()}
          />
          <Btn
            icon={SeparatorHorizontal}
            label={t('doc.editor.page_break')}
            onClick={() => editor.chain().focus().setPageBreak().run()}
          />
        </Group>

        <Divider />

        <Group>
          <Btn
            icon={TableIcon}
            label={t('doc.editor.table.insert')}
            active={editor.isActive('table')}
            onClick={() =>
              editor.chain().focus().insertTable({ rows: 3, cols: 3, withHeaderRow: true }).run()
            }
          />
          {/* The rest of the table operations only make sense INSIDE a table —
              they appear contextually, Google-Docs style. */}
          {editor.isActive('table') && (
            <>
              <Btn
                icon={Rows3}
                label={t('doc.editor.table.add_row')}
                onClick={() => editor.chain().focus().addRowAfter().run()}
              />
              <Btn
                icon={TableRowsSplit}
                label={t('doc.editor.table.delete_row')}
                onClick={() => editor.chain().focus().deleteRow().run()}
              />
              <Btn
                icon={Columns3}
                label={t('doc.editor.table.add_col')}
                onClick={() => editor.chain().focus().addColumnAfter().run()}
              />
              <Btn
                icon={TableColumnsSplit}
                label={t('doc.editor.table.delete_col')}
                onClick={() => editor.chain().focus().deleteColumn().run()}
              />
              <Btn
                icon={TableCellsMerge}
                label={t('doc.editor.table.merge')}
                disabled={!editor.can().mergeCells()}
                onClick={() => editor.chain().focus().mergeCells().run()}
              />
              <Btn
                icon={TableCellsSplit}
                label={t('doc.editor.table.split')}
                disabled={!editor.can().splitCell()}
                onClick={() => editor.chain().focus().splitCell().run()}
              />
              <Btn
                icon={TableProperties}
                label={t('doc.editor.table.header_row')}
                onClick={() => editor.chain().focus().toggleHeaderRow().run()}
              />
              <Btn
                icon={Trash2}
                label={t('doc.editor.table.delete')}
                onClick={() => editor.chain().focus().deleteTable().run()}
              />
            </>
          )}
        </Group>
      </div>
    </div>
  );
}

function Group({ children }: { children: React.ReactNode }) {
  return <div className="flex items-center gap-0.5">{children}</div>;
}

function Divider() {
  return <div className="w-px h-6 bg-sand/40 mx-1" />;
}

interface BtnProps {
  icon: typeof Bold;
  label: string;
  onClick: () => void;
  active?: boolean;
  disabled?: boolean;
}

function Btn({ icon: Icon, label, onClick, active, disabled }: BtnProps) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      title={label}
      aria-label={label}
      aria-pressed={!!active}
      className={`p-2 rounded-lg transition-colors ${
        disabled
          ? 'text-charcoal/20 cursor-not-allowed'
          : active
          ? 'bg-copper text-white'
          : 'text-charcoal/70 hover:bg-cream hover:text-charcoal'
      }`}
    >
      <Icon size={16} />
    </button>
  );
}
