/**
 * Phase 3 · B7 — link (or unlink) a whole selection to one record.
 *
 * The counterpart to B6's per-record "Attach existing": that one starts from a
 * record and finds files, this one starts from files and finds a record. Both
 * write `document_links`, so both converge into `file_links` at COMMIT with no
 * bytes copied — one file, N records.
 *
 * ── UNLINK IS DELIBERATELY IN THE SAME DIALOG ─────────────────────────────
 * Not a separate bulk-bar button. Unlinking needs exactly the same input as
 * linking — WHICH record — and a bar button that opens a record picker to
 * remove something is the same dialog with a different verb. Keeping them
 * together also makes the asymmetry visible: unlink only removes MANUAL links,
 * because a field-derived edge's truth lives in the record.
 */
import { useCallback, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { AlertTriangle, Link2, Loader2, Search, Unlink, X } from 'lucide-react';
import Modal from '@/components/ui/Modal';
import Button from '@/components/ui/Button';
import { useAppStore } from '@/stores/appStore';
import { linkableModels, recordTitle } from '@/lib/documents/links';
import { bulkLinkToRecord, bulkUnlinkFromRecord, type BulkResult } from '@/lib/files/bulkEdit';
import { errorText } from '@/lib/files/library';
import type { FileDocumentTypeRow } from '@/types';

interface Props {
  open: boolean;
  fileIds: string[];
  types: FileDocumentTypeRow[];
  onClose: () => void;
  onApplied: () => void;
}

/** Enough to choose from without rendering thousands of rows into the DOM. */
const MAX_RESULTS = 40;

export default function BulkLinkModal({ open, fileIds, types, onClose, onApplied }: Props) {
  const { t } = useTranslation();
  const isAr = useAppStore((s) => s.language === 'ar');
  const models = useAppStore((s) => s.models);
  const records = useAppStore((s) => s.records);

  const linkable = useMemo(() => linkableModels(models), [models]);
  const [modelId, setModelId] = useState<string>('');
  const [query, setQuery] = useState('');
  const [recordId, setRecordId] = useState<string | null>(null);
  const [role, setRole] = useState('supporting_document');
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<(BulkResult & { verb: 'link' | 'unlink' }) | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Default to the model with the MOST loaded records.
  //
  // `linkable` is in the app's own model order, and its first entry is Website
  // Settings — a one-row config model, never the answer to "link these files to
  // something". "First model that has any records" does not fix that, because
  // one row IS some rows (measured: it still opened on Website Settings).
  // Sorting by count lands on a real business model — units, projects, clients
  // — which is what a file is nearly always linked to.
  const defaultModelId = useMemo(() => {
    let best = linkable[0]?.id ?? '';
    let bestN = -1;
    for (const m of linkable) {
      const n = records[m.id]?.length ?? 0;
      if (n > bestN) { bestN = n; best = m.id; }
    }
    return best;
  }, [linkable, records]);
  const effectiveModelId = modelId || defaultModelId;
  const model = models.find((m) => m.id === effectiveModelId);

  // Searched from the STORE, not the server: these records are already loaded,
  // and a per-keystroke query for something the client already holds would be
  // a round trip to answer a question it can answer itself.
  const matches = useMemo(() => {
    const bucket = records[effectiveModelId] ?? [];
    const q = query.trim().toLowerCase();
    const scored = bucket.filter((r) => {
      if (!q) return true;
      return recordTitle(model, r, isAr).toLowerCase().includes(q);
    });
    return scored.slice(0, MAX_RESULTS);
  }, [records, effectiveModelId, query, model, isAr]);

  const run = useCallback(async (verb: 'link' | 'unlink') => {
    if (!recordId || !effectiveModelId) return;
    setBusy(true);
    setError(null);
    setResult(null);
    try {
      const res = verb === 'link'
        ? await bulkLinkToRecord(fileIds, effectiveModelId, recordId, role)
        : await bulkUnlinkFromRecord(fileIds, effectiveModelId, recordId);
      setResult({ ...res, verb });
      if (res.updated > 0) onApplied();
      // Stay open on a partial result — that is the number worth reading.
      if (res.skipped === 0 && verb === 'link') onClose();
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  }, [recordId, effectiveModelId, fileIds, role, onApplied, onClose]);

  if (!open) return null;
  const field = 'w-full px-3 py-2 rounded-lg bg-white border border-sand/40 text-sm text-charcoal focus:outline-none focus:ring-2 focus:ring-copper/30';

  return (
    <Modal open={open} onClose={busy ? () => {} : onClose} maxWidth="max-w-lg">
      <div className="p-5 space-y-4" data-no-marquee>
        <div className="flex items-center justify-between gap-3">
          <h2 className="text-base font-bold text-charcoal">
            {t('files.bulk.link_title', { count: fileIds.length })}
          </h2>
          <button type="button" onClick={onClose} disabled={busy} aria-label={t('common.close')}
                  className="p-1.5 rounded-lg text-charcoal/40 hover:text-charcoal hover:bg-cream disabled:opacity-40">
            <X size={16} aria-hidden />
          </button>
        </div>

        <p className="text-xs text-charcoal/50">{t('files.bulk.link_hint')}</p>

        <div className="flex gap-2">
          <select
            className={field}
            value={effectiveModelId}
            onChange={(e) => { setModelId(e.target.value); setRecordId(null); }}
          >
            {linkable.map((m) => (
              <option key={m.id} value={m.id}>{(isAr ? m.label_ar : m.label_en) || m.name}</option>
            ))}
          </select>
          <select className={field} value={role} onChange={(e) => setRole(e.target.value)}>
            {types.map((x) => (
              <option key={x.value} value={x.value}>{isAr ? x.label_ar : x.label_en}</option>
            ))}
          </select>
        </div>

        <div className="relative">
          <Search size={15} className="absolute top-1/2 -translate-y-1/2 start-3 text-charcoal/40 pointer-events-none" aria-hidden />
          <input
            className={`${field} ps-9`} dir="auto" autoFocus value={query}
            placeholder={t('files.bulk.link_search')}
            onChange={(e) => setQuery(e.target.value)}
          />
        </div>

        <div className="max-h-56 overflow-auto rounded-xl border border-sand/30 divide-y divide-sand/20">
          {matches.length === 0 ? (
            <p className="py-8 text-center text-xs text-charcoal/45">{t('files.bulk.link_no_records')}</p>
          ) : (
            matches.map((r) => (
              <button
                key={r.id}
                type="button"
                onClick={() => setRecordId(r.id)}
                className={`w-full text-start px-3 py-2 text-sm transition-colors ${
                  recordId === r.id ? 'bg-copper/10 text-copper font-bold' : 'text-charcoal hover:bg-cream'
                }`}
                dir="auto"
              >
                {recordTitle(model, r, isAr)}
              </button>
            ))
          )}
        </div>

        {error && (
          <p className="flex items-start gap-2 text-xs text-red-700" role="alert">
            <AlertTriangle size={13} className="mt-0.5 shrink-0" aria-hidden />
            <span>{error}</span>
          </p>
        )}

        {result && (
          <div className={`p-3 rounded-xl border ${result.skipped > 0 ? 'bg-amber-500/10 border-amber-500/30' : 'bg-emerald-500/10 border-emerald-500/30'}`} role="status">
            <p className={`text-xs font-bold ${result.skipped > 0 ? 'text-amber-800' : 'text-emerald-800'}`}>
              {result.verb === 'link'
                ? t('files.bulk.link_result', { updated: result.updated, requested: result.requested })
                : t('files.bulk.unlink_result', { updated: result.updated, requested: result.requested })}
            </p>
            {result.skipped > 0 && (
              <p className="mt-1 text-[11px] text-amber-800/80">
                {result.verb === 'link' ? t('files.bulk.partial_hint') : t('files.bulk.unlink_partial_hint')}
              </p>
            )}
          </div>
        )}

        <div className="flex justify-end gap-2 pt-1">
          <Button variant="secondary" className="!px-3 !py-2 text-xs" disabled={!recordId || busy}
                  onClick={() => void run('unlink')}>
            <Unlink size={13} aria-hidden />
            {t('files.bulk.unlink')}
          </Button>
          <Button className="!px-3 !py-2 text-xs" disabled={!recordId || busy} onClick={() => void run('link')}>
            {busy ? <Loader2 size={13} className="animate-spin" aria-hidden /> : <Link2 size={13} aria-hidden />}
            {t('files.bulk.link_action', { count: fileIds.length })}
          </Button>
        </div>
      </div>
    </Modal>
  );
}
