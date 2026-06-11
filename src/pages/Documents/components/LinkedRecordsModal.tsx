import { useEffect, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import { Database, Link2, Loader2, Plus, X } from 'lucide-react';
import { useAppStore } from '@/stores/appStore';
import {
  addDocumentLink,
  linkableModels,
  listLinksForFile,
  recordTitle,
  removeDocumentLink,
  type DocumentLink,
} from '@/lib/documents/links';

interface Props {
  fileId: string;
  open: boolean;
  onClose: () => void;
}

/**
 * "Linked records" manager for a document — opened from the doc header.
 * Lists the document's record relationships and lets the user add/remove
 * them via a model picker + in-memory record search (the SPA store already
 * holds all records, so the search is instant with no network).
 */
export default function LinkedRecordsModal({ fileId, open, onClose }: Props) {
  const { t } = useTranslation();
  const isAr = useAppStore((s) => s.language === 'ar');
  const models = useAppStore((s) => s.models);
  /** Store shape: Record<modelId, AppRecord[]> — per-model arrays. */
  const recordsMap = useAppStore((s) => s.records);

  const [links, setLinks] = useState<DocumentLink[]>([]);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const pickable = useMemo(() => linkableModels(models), [models]);
  const [modelId, setModelId] = useState<string>('');
  const [query, setQuery] = useState('');

  useEffect(() => {
    if (!open) return;
    setQuery('');
    const first = pickable[0];
    if (!modelId && first) setModelId(first.id);
    let cancelled = false;
    setLoading(true);
    listLinksForFile(fileId)
      .then((rows) => {
        if (!cancelled) setLinks(rows);
      })
      .catch(() => {
        /* surfaced */
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, fileId]);

  const selectedModel = useMemo(() => models.find((m) => m.id === modelId), [models, modelId]);

  /** Instant in-memory search over the selected model's records by title. */
  const results = useMemo(() => {
    if (!selectedModel) return [];
    const q = query.trim().toLowerCase();
    const linkedIds = new Set(links.filter((l) => l.model_id === selectedModel.id).map((l) => l.record_id));
    const pool = (recordsMap[selectedModel.id] ?? []).filter((r) => !linkedIds.has(r.id));
    const scored = q
      ? pool.filter((r) => recordTitle(selectedModel, r, isAr).toLowerCase().includes(q))
      : pool;
    return scored.slice(0, 8);
  }, [selectedModel, recordsMap, query, links, isAr]);

  if (!open) return null;

  const add = async (recordId: string) => {
    if (!selectedModel || busy) return;
    setBusy(true);
    try {
      const row = await addDocumentLink(fileId, selectedModel.id, recordId);
      setLinks((prev) => [row, ...prev.filter((l) => l.id !== row.id)]);
      setQuery('');
    } catch {
      /* surfaced */
    } finally {
      setBusy(false);
    }
  };

  const remove = async (link: DocumentLink) => {
    if (busy) return;
    setBusy(true);
    try {
      await removeDocumentLink(link.id);
      setLinks((prev) => prev.filter((l) => l.id !== link.id));
    } catch {
      /* surfaced */
    } finally {
      setBusy(false);
    }
  };

  const titleFor = (link: DocumentLink): { record: string; model: string } => {
    const m = models.find((x) => x.id === link.model_id);
    const r = (recordsMap[link.model_id] ?? []).find((x) => x.id === link.record_id);
    return {
      record: r ? recordTitle(m, r, isAr) : t('doc.links.record_missing'),
      model: m ? (isAr ? m.label_ar : m.label_en) : '—',
    };
  };

  return createPortal(
    <div
      className="fixed inset-0 z-50 bg-charcoal/40 backdrop-blur-sm flex items-center justify-center p-4 modal-overlay"
      onClick={onClose}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="bg-white rounded-2xl shadow-2xl w-full max-w-lg max-h-[85vh] overflow-y-auto"
      >
        {/* Header */}
        <div className="flex items-center justify-between px-5 pt-4 pb-3 border-b border-sand/30">
          <div className="flex items-center gap-2">
            <Link2 size={18} className="text-copper" />
            <h3 className="font-bold text-charcoal">{t('doc.links.title')}</h3>
          </div>
          <button
            onClick={onClose}
            className="p-2 rounded-lg text-charcoal/50 hover:text-charcoal hover:bg-cream"
            aria-label={t('common.close')}
          >
            <X size={16} />
          </button>
        </div>

        <div className="p-5 space-y-5">
          {/* Existing links */}
          <div>
            <div className="text-xs font-bold text-charcoal/40 uppercase tracking-widest mb-2">
              {t('doc.links.current')}
            </div>
            {loading ? (
              <div className="py-4 flex justify-center">
                <Loader2 size={18} className="animate-spin text-copper" />
              </div>
            ) : links.length === 0 ? (
              <p className="text-sm text-charcoal/50">{t('doc.links.empty')}</p>
            ) : (
              <div className="space-y-1.5">
                {links.map((link) => {
                  const tt = titleFor(link);
                  return (
                    <div
                      key={link.id}
                      className="flex items-center gap-2 px-3 py-2 rounded-xl bg-cream/60 border border-sand/30"
                    >
                      <Database size={14} className="text-copper shrink-0" />
                      <div className="flex-1 min-w-0">
                        <div className="text-sm font-bold text-charcoal truncate">{tt.record}</div>
                        <div className="text-[0.6875rem] text-charcoal/50">{tt.model}</div>
                      </div>
                      <button
                        onClick={() => void remove(link)}
                        disabled={busy}
                        className="p-1.5 rounded-lg text-charcoal/40 hover:text-red-600 hover:bg-red-50 disabled:opacity-40"
                        aria-label={t('doc.links.remove')}
                      >
                        <X size={14} />
                      </button>
                    </div>
                  );
                })}
              </div>
            )}
          </div>

          {/* Add a link */}
          <div>
            <div className="text-xs font-bold text-charcoal/40 uppercase tracking-widest mb-2">
              {t('doc.links.add')}
            </div>
            <div className="flex gap-2 mb-2">
              <select
                value={modelId}
                onChange={(e) => {
                  setModelId(e.target.value);
                  setQuery('');
                }}
                className="px-3 py-2 rounded-lg border border-sand/40 bg-white text-sm focus:outline-none focus:ring-2 focus:ring-copper/30 max-w-[45%]"
              >
                {pickable.map((m) => (
                  <option key={m.id} value={m.id}>
                    {isAr ? m.label_ar : m.label_en}
                  </option>
                ))}
              </select>
              <input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder={t('doc.links.search_placeholder')}
                dir="auto"
                className="flex-1 px-3 py-2 rounded-lg border border-sand/40 text-sm focus:outline-none focus:ring-2 focus:ring-copper/30"
              />
            </div>
            <div className="space-y-1">
              {results.map((r) => (
                <button
                  key={r.id}
                  onClick={() => void add(r.id)}
                  disabled={busy}
                  className="w-full flex items-center gap-2 px-3 py-2 rounded-xl border border-sand/30 hover:bg-cream hover:border-copper/30 text-start disabled:opacity-50"
                >
                  <Plus size={14} className="text-copper shrink-0" />
                  <span className="text-sm text-charcoal truncate">
                    {recordTitle(selectedModel, r, isAr)}
                  </span>
                </button>
              ))}
              {results.length === 0 && query.trim() && (
                <p className="text-sm text-charcoal/40 px-1 py-2">{t('doc.links.no_results')}</p>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>,
    document.body,
  );
}
