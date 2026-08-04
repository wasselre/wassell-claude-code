import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Building2, Database, Loader2, Plus, X } from 'lucide-react';
import { useAppStore } from '@/stores/appStore';
import {
  addDocumentLink,
  listLinksForFile,
  recordTitle,
  removeDocumentLink,
  type DocumentLink,
} from '@/lib/documents/links';

interface Props {
  fileId: string;
  /** When false the panel is read-only — the project picker and remove
   *  buttons are hidden, matching the file's edit permission. */
  canEdit: boolean;
}

/**
 * Links rail for a file/media, shown inside FilePreviewModal. Two fields:
 *   1. "Link a project" — a searchable dropdown over our_projects records that
 *      adds a document_links row (many-to-many).
 *   2. "Linked records" — every record currently linked to this file (any
 *      model), each removable.
 *
 * Uses the existing document_links surface (addDocumentLink / removeDocumentLink
 * / listLinksForFile). RLS gates by FILE access, so a viewer only ever sees
 * links they could open.
 */
export default function FileLinksPanel({ fileId, canEdit }: Props) {
  const { t } = useTranslation();
  const isAr = useAppStore((s) => s.language === 'ar');
  const models = useAppStore((s) => s.models);
  /** Store shape: Record<modelId, AppRecord[]> — per-model arrays. */
  const recordsMap = useAppStore((s) => s.records);

  const [links, setLinks] = useState<DocumentLink[]>([]);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [query, setQuery] = useState('');

  const projectModel = useMemo(() => models.find((m) => m.name === 'our_projects'), [models]);

  useEffect(() => {
    setQuery('');
    let cancelled = false;
    setLoading(true);
    listLinksForFile(fileId)
      .then((rows) => {
        if (!cancelled) setLinks(rows);
      })
      .catch(() => {
        /* surfaced by links.ts */
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [fileId]);

  /** Instant in-memory search over our_projects records, excluding ones already
   *  linked to this file. */
  const projectResults = useMemo(() => {
    if (!projectModel) return [];
    const q = query.trim().toLowerCase();
    const linkedIds = new Set(links.filter((l) => l.model_id === projectModel.id).map((l) => l.record_id));
    const pool = (recordsMap[projectModel.id] ?? []).filter((r) => !linkedIds.has(r.id));
    const scored = q
      ? pool.filter((r) => recordTitle(projectModel, r, isAr).toLowerCase().includes(q))
      : pool;
    return scored.slice(0, 8);
  }, [projectModel, recordsMap, query, links, isAr]);

  const addProject = async (recordId: string) => {
    if (!projectModel || busy) return;
    setBusy(true);
    try {
      const row = await addDocumentLink(fileId, projectModel.id, recordId);
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

  return (
    <div
      className="w-80 max-w-[85vw] shrink-0 bg-white border-s border-sand/30 flex flex-col overflow-y-auto"
      onClick={(e) => e.stopPropagation()}
    >
      <div className="p-5 space-y-6">
        {/* Field 1 — link a project */}
        {canEdit && (
          <div>
            <div className="text-xs font-bold text-charcoal/40 uppercase tracking-widest mb-2">
              {t('files.links.link_project')}
            </div>
            {projectModel ? (
              <>
                <div className="relative mb-2">
                  <Building2
                    size={15}
                    className="absolute top-1/2 -translate-y-1/2 start-3 text-charcoal/40 pointer-events-none"
                  />
                  <input
                    value={query}
                    onChange={(e) => setQuery(e.target.value)}
                    placeholder={t('files.links.project_search_placeholder')}
                    dir="auto"
                    className="w-full ps-9 pe-3 py-2 rounded-lg border border-sand/40 text-sm focus:outline-none focus:ring-2 focus:ring-copper/30"
                  />
                </div>
                <div className="space-y-1">
                  {projectResults.map((r) => (
                    <button
                      key={r.id}
                      onClick={() => void addProject(r.id)}
                      disabled={busy}
                      className="w-full flex items-center gap-2 px-3 py-2 rounded-xl border border-sand/30 hover:bg-cream hover:border-copper/30 text-start disabled:opacity-50"
                    >
                      <Plus size={14} className="text-copper shrink-0" />
                      <span className="text-sm text-charcoal truncate">
                        {recordTitle(projectModel, r, isAr)}
                      </span>
                    </button>
                  ))}
                  {projectResults.length === 0 && query.trim() && (
                    <p className="text-sm text-charcoal/40 px-1 py-2">{t('doc.links.no_results')}</p>
                  )}
                </div>
              </>
            ) : (
              <p className="text-sm text-charcoal/40">{t('files.links.no_project_model')}</p>
            )}
          </div>
        )}

        {/* Field 2 — linked records to this media */}
        <div>
          <div className="text-xs font-bold text-charcoal/40 uppercase tracking-widest mb-2">
            {t('files.links.linked_records')}
          </div>
          {loading ? (
            <div className="py-4 flex justify-center">
              <Loader2 size={18} className="animate-spin text-copper" />
            </div>
          ) : links.length === 0 ? (
            <p className="text-sm text-charcoal/50">{t('files.links.empty')}</p>
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
                    {canEdit && (
                      <button
                        onClick={() => void remove(link)}
                        disabled={busy}
                        className="p-1.5 rounded-lg text-charcoal/40 hover:text-red-600 hover:bg-red-50 disabled:opacity-40"
                        aria-label={t('doc.links.remove')}
                      >
                        <X size={14} />
                      </button>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
