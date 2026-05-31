import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { v4 as uuid } from 'uuid';
import { User as UserIcon, Clock, Send } from 'lucide-react';
import { useAppStore } from '@/stores/appStore';
import AutoGrowTextarea from './AutoGrowTextarea';
import type { NoteEntry } from '@/types';

interface NotesFieldProps {
  value: unknown;
  onChange: (entries: NoteEntry[]) => void;
}

function toEntries(value: unknown): NoteEntry[] {
  if (!Array.isArray(value)) return [];
  return (value as unknown[])
    .filter((e): e is NoteEntry =>
      !!e && typeof e === 'object' &&
      typeof (e as NoteEntry).text === 'string' &&
      typeof (e as NoteEntry).created_at === 'string',
    )
    .slice();
}

export default function NotesField({ value, onChange }: NotesFieldProps) {
  const { t } = useTranslation();
  const { users, currentUserId, language } = useAppStore();
  const isAr = language === 'ar';
  const [draft, setDraft] = useState('');

  const entries = toEntries(value);
  const sorted = [...entries].sort((a, b) => b.created_at.localeCompare(a.created_at));

  const submit = () => {
    const text = draft.trim();
    if (!text) return;
    const entry: NoteEntry = {
      id: uuid(),
      text,
      author_id: currentUserId,
      created_at: new Date().toISOString(),
    };
    onChange([...entries, entry]);
    setDraft('');
  };

  const authorName = (authorId: string | null): string => {
    if (!authorId) return t('fields.notes_unknown_user');
    const u = users.find((x) => x.id === authorId);
    if (!u) return t('fields.notes_unknown_user');
    return isAr ? u.name_ar : u.name_en;
  };

  const formatTs = (iso: string): string => {
    try {
      const d = new Date(iso);
      const date = d.toLocaleDateString(isAr ? 'ar-SA' : 'en-GB');
      const time = d.toLocaleTimeString(isAr ? 'ar-SA' : 'en-GB', {
        hour: '2-digit',
        minute: '2-digit',
      });
      return `${date} · ${time}`;
    } catch {
      return iso;
    }
  };

  return (
    <div className="space-y-3">
      {/* Composer */}
      <div className="flex flex-col gap-2 p-3 rounded-xl bg-sand/10 border border-sand/20">
        <AutoGrowTextarea
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
              e.preventDefault();
              submit();
            }
          }}
          rows={2}
          placeholder={t('fields.notes_add_placeholder')}
          className="form-input"
        />
        <div className="flex justify-end">
          <button
            type="button"
            onClick={submit}
            disabled={!draft.trim()}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-bold rounded-lg bg-copper text-white hover:bg-terracotta disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
          >
            <Send size={12} />
            {t('fields.notes_save')}
          </button>
        </div>
      </div>

      {/* Entries list */}
      {sorted.length === 0 ? (
        <p className="text-xs text-charcoal/30 italic px-1">{t('fields.notes_empty')}</p>
      ) : (
        <ul className="space-y-2">
          {sorted.map((entry) => (
            <li
              key={entry.id}
              className="p-3 rounded-xl bg-white border border-sand/20 shadow-sm"
            >
              <div className="flex items-center gap-3 text-[11px] text-charcoal/50 mb-1.5">
                <span className="inline-flex items-center gap-1 font-semibold">
                  <UserIcon size={11} />
                  {authorName(entry.author_id)}
                </span>
                <span className="inline-flex items-center gap-1" dir="ltr">
                  <Clock size={11} />
                  {formatTs(entry.created_at)}
                </span>
              </div>
              <p className="text-sm text-charcoal whitespace-pre-wrap break-words">
                {entry.text}
              </p>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
