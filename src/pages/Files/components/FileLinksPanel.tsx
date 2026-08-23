import { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Building2, Plus } from 'lucide-react';
import { useAppStore } from '@/stores/appStore';
import type { AppRecord } from '@/types';
import {
  addDocumentLink,
  listLinksForFile,
  recordTitle,
  type DocumentLink,
} from '@/lib/documents/links';
import UsedInPanel from './UsedInPanel';

interface Props {
  fileId: string;
  /** When false the panel is read-only — the project picker is hidden, matching
   *  the file's edit permission. The linked-records list shows either way. */
  canEdit: boolean;
}

/**
 * Links rail for a file/media, shown inside FilePreviewModal.
 *
 *   1. "Link a project" — a searchable dropdown over our_projects records that
 *      adds a `document_links` row (a MANUAL link).
 *   2. "Linked records" — rendered by UsedInPanel from the UNIFIED `file_links`
 *      graph, so it shows EVERY record the file is linked to, however the link
 *      arose (a record field, a marketing asset, a manual document_links row —
 *      all of which converge into file_links).
 *
 * ── WHY THE LIST IS UsedInPanel, NOT document_links ───────────────────────
 * This panel used to list `document_links` only. A file linked to a project via
 * a FIELD or a MARKETING asset (the common case) has no document_links row, so
 * the panel read "no linked records" while the record's own files panel showed
 * the file — a direct contradiction (operator report, 2026-08-23). file_links
 * is the one converged truth; document_links is only the manual-link write path,
 * still used by the "Link a project" adder above and to exclude already-linked
 * projects from its results.
 */
export default function FileLinksPanel({ fileId, canEdit }: Props) {
  const { t } = useTranslation();
  const isAr = useAppStore((s) => s.language === 'ar');
  const models = useAppStore((s) => s.models);
  /** Store shape: Record<modelId, AppRecord[]> — per-model arrays. */
  const recordsMap = useAppStore((s) => s.records);

  /** Manual links, loaded only to exclude already-linked projects from the
   *  adder. The DISPLAYED list is UsedInPanel (the file_links truth). */
  const [links, setLinks] = useState<DocumentLink[]>([]);
  const [busy, setBusy] = useState(false);
  const [query, setQuery] = useState('');

  const projectModel = useMemo(() => models.find((m) => m.name === 'our_projects'), [models]);
  const masterModel = useMemo(() => models.find((m) => m.name === 'all_projects'), [models]);

  /** our_projects records carry no project_name of their own — the human name
   *  lives on the linked master all_projects record (the 1:1 `project` lookup). */
  const projectDisplayTitle = useCallback(
    (record: AppRecord): string => {
      const raw = record.data?.project;
      const masterId = Array.isArray(raw)
        ? (raw[0] as string | undefined)
        : typeof raw === 'string'
        ? raw
        : undefined;
      if (masterId && masterModel) {
        const master = (recordsMap[masterModel.id] ?? []).find((x) => x.id === masterId);
        if (master) return recordTitle(masterModel, master, isAr);
      }
      return recordTitle(projectModel, record, isAr);
    },
    [masterModel, recordsMap, isAr, projectModel],
  );

  useEffect(() => {
    setQuery('');
    if (!canEdit) return;
    let cancelled = false;
    listLinksForFile(fileId)
      .then((rows) => { if (!cancelled) setLinks(rows); })
      .catch(() => { /* surfaced by links.ts */ });
    return () => { cancelled = true; };
  }, [fileId, canEdit]);

  /** Instant in-memory search over our_projects records, excluding ones already
   *  manually linked to this file. */
  const projectResults = useMemo(() => {
    if (!projectModel) return [];
    const q = query.trim().toLowerCase();
    const linkedIds = new Set(links.filter((l) => l.model_id === projectModel.id).map((l) => l.record_id));
    const pool = (recordsMap[projectModel.id] ?? []).filter((r) => !linkedIds.has(r.id));
    const scored = q
      ? pool.filter((r) => projectDisplayTitle(r).toLowerCase().includes(q))
      : pool;
    return scored.slice(0, 8);
  }, [projectModel, recordsMap, query, links, projectDisplayTitle]);

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

  return (
    <div
      className="w-80 max-w-[85vw] shrink-0 bg-white border-s border-sand/30 flex flex-col overflow-y-auto"
      onClick={(e) => e.stopPropagation()}
    >
      <div className="p-5 space-y-6">
        {/* Field 1 — link a project (writes a manual document_links row). */}
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
                        {projectDisplayTitle(r)}
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

        {/* Field 2 — the linked records, from the UNIFIED file_links graph. */}
        <UsedInPanel fileId={fileId} isAr={isAr} />
      </div>
    </div>
  );
}
