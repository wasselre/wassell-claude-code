import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Loader2, Sparkles, Undo2 } from 'lucide-react';
import { useAppStore } from '@/stores/appStore';
import { getOutcome } from '@/lib/salesProcess';
import { dateTimeShort } from '@/pages/Marketing/lib/format';
import { callJson, HttpError } from '../lib/cardHttp';
import { usePrefFieldFormat } from '../lib/usePrefFieldFormat';

/**
 * What the AI saved onto this client on its own (api/client-ai-changes.ts):
 * preference fields, places, recorded follow-up results — plus what it heard
 * but deliberately did NOT write (a rep's value kept, a doubted place). Each
 * applied preference / place has Undo. Hidden when there is nothing to show.
 */

interface AiChange {
  id: string;
  kind: 'pref' | 'place' | 'outcome';
  field: string | null;
  before_value: unknown;
  after_value: unknown;
  added: unknown;
  applied: boolean;
  note: string | null;
  source: 'chat' | 'call' | 'agent';
  label: string | null;
  created_at: string;
  undone_at: string | null;
}

interface Props {
  clientId: string;
  /** Changes whenever the card re-reads, so the list refreshes after a new reading. */
  refreshKey: string;
  isAr: boolean;
  /** Inside another card: no frame, no title, the whole list. */
  bare?: boolean;
}

const SHOWN = 8;

export default function AiChangesSection({ clientId, refreshKey, isAr, bare = false }: Props) {
  const { t } = useTranslation();
  const addToast = useAppStore((s) => s.addToast);
  const { fieldLabel, formatValue } = usePrefFieldFormat();
  const [changes, setChanges] = useState<AiChange[]>([]);
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const r = await callJson<{ changes: AiChange[] }>(`/api/client-ai-changes?clientId=${encodeURIComponent(clientId)}`, { method: 'GET' });
      setChanges(r.changes);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error('[AiChangesSection] load failed:', err);
      addToast(t('chats.ai_changes.load_failed', { msg }), 'error');
    }
  }, [clientId, addToast, t]);

  useEffect(() => { void load(); }, [load, refreshKey]);

  const undo = async (id: string) => {
    setBusy(id);
    try {
      await callJson<unknown>('/api/client-ai-changes', { method: 'POST', body: JSON.stringify({ changeId: id, action: 'undo' }) });
      addToast(t('chats.ai_changes.undo_done'), 'success');
      await load();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error('[AiChangesSection] undo failed:', err);
      addToast(t('chats.ai_changes.undo_failed', { msg }), 'error');
      if (err instanceof HttpError && err.status === 409) await load();
    } finally {
      setBusy(null);
    }
  };

  if (changes.length === 0) return null;

  const line = (c: AiChange): string => {
    if (c.kind === 'outcome') {
      const o = typeof c.after_value === 'string' ? getOutcome(c.after_value) : undefined;
      const outcome = o ? (isAr ? o.label_ar : o.label_en) : String(c.after_value ?? '');
      const main = c.label ? ` · ${t('chats.ai_changes.main', { label: c.label })}` : '';
      return `${t('chats.ai_changes.outcome', { label: outcome })}${main}`;
    }
    if (c.kind === 'place') {
      const n = Array.isArray(c.added) ? c.added.length : 0;
      const label = `${c.label ?? ''}${n > 1 ? ` (${n})` : ''}`;
      return c.applied ? t('chats.ai_changes.place', { label }) : t('chats.ai_changes.doubted', { label });
    }
    const field = c.field ? fieldLabel(c.field) : '';
    if (!c.applied) {
      return t('chats.ai_changes.kept', {
        field, heard: c.field ? formatValue(c.field, c.after_value) : '', current: c.field ? formatValue(c.field, c.before_value) : '',
      });
    }
    return `${field}: ${c.field ? formatValue(c.field, c.after_value) : ''}`;
  };

  return (
    <div className={bare ? '' : 'mb-2 rounded-lg border border-sand/70 bg-cream/40 px-2.5 py-1.5'} dir={isAr ? 'rtl' : 'ltr'}>
      {!bare && (
        <p className="mb-1 flex items-center gap-1 text-[10.5px] font-semibold text-chocolate">
          <Sparkles size={11} className="text-copper" aria-hidden /> {t('chats.ai_changes.title')}
        </p>
      )}
      <ul className="flex flex-col gap-0.5">
        {(bare ? changes : changes.slice(0, SHOWN)).map((c) => {
          const canUndo = c.applied && !c.undone_at && c.kind !== 'outcome';
          return (
            <li key={c.id} className="flex items-center justify-between gap-2 text-[11px]">
              <span className={`min-w-0 truncate ${c.undone_at ? 'text-charcoal/40 line-through' : c.applied ? 'text-charcoal' : 'text-amber-700'}`} title={line(c)}>
                {line(c)}
                <span className="text-charcoal/40"> · {t(c.source === 'call' ? 'chats.ai_changes.from_call' : 'chats.ai_changes.from_chat')} · {dateTimeShort(c.created_at, isAr)}</span>
              </span>
              {c.undone_at ? (
                <span className="shrink-0 text-[10px] text-charcoal/45">{t('chats.ai_changes.undone')}</span>
              ) : canUndo ? (
                <button
                  type="button"
                  onClick={() => void undo(c.id)}
                  disabled={busy !== null}
                  className="inline-flex shrink-0 items-center gap-0.5 rounded px-1 text-[10.5px] text-copper hover:bg-copper/10 disabled:opacity-50"
                >
                  {busy === c.id ? <Loader2 size={10} className="animate-spin" /> : <Undo2 size={10} aria-hidden />}
                  {t('chats.ai_changes.undo')}
                </button>
              ) : null}
            </li>
          );
        })}
      </ul>
    </div>
  );
}
