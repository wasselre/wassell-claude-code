/**
 * Phase 3 · B6 — "Attach existing".
 *
 * Searches the canonical Library and creates a LINK. It never copies bytes and
 * never uploads: the whole point of the many-to-many graph is that the same
 * brochure can sit on a project and three units as one file.
 *
 * It reuses `business_files_search` (B2) rather than a bespoke query, so the
 * picker inherits the Library's Arabic folding, its RLS posture and its facet
 * accuracy for free. The search is debounced for the same reason the Library
 * debounces: the RPC costs 350–1,100 ms on production and a call per keystroke
 * would put eight in flight for one word.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { AlertTriangle, Check, Link2, Loader2, Lock, Search, X } from 'lucide-react';
import Modal from '@/components/ui/Modal';
import Button from '@/components/ui/Button';
import { useAppStore } from '@/stores/appStore';
import { errorText, searchBusinessFiles } from '@/lib/files/library';
import { effectiveFileRoles, roleSatisfies } from '@/lib/files/client';
import { attachFileToRecord } from '@/lib/files/recordFiles';
import { formatBytes, kindAccent, kindIcon } from '@/lib/files/format';
import type { BusinessFileRow, FileDocumentTypeRow, FilePermissionRole } from '@/types';

const DEBOUNCE_MS = 400;
const PAGE_SIZE = 25;

interface Props {
  open: boolean;
  modelId: string;
  recordId: string;
  types: FileDocumentTypeRow[];
  /** Files already linked — shown as already-attached rather than hidden, so a
   *  user searching for one they just linked does not think it vanished. */
  alreadyLinkedFileIds: Set<string>;
  onClose: () => void;
  onAttached: () => void;
}

export default function AttachExistingFileModal({
  open, modelId, recordId, types, alreadyLinkedFileIds, onClose, onAttached,
}: Props) {
  const { t } = useTranslation();
  const isAr = useAppStore((s) => s.language === 'ar');

  const [input, setInput] = useState('');
  const [q, setQ] = useState('');
  const [rows, setRows] = useState<BusinessFileRow[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [role, setRole] = useState<string>('supporting_document');
  /** fileId -> the caller's effective role. null = not resolved yet. */
  const [roles, setRoles] = useState<Record<string, FilePermissionRole> | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  useEffect(() => {
    if (!open) { setInput(''); setQ(''); setRows([]); setError(null); setTotal(0); setRoles(null); }
  }, [open]);

  useEffect(() => {
    if (input === q) return;
    const id = window.setTimeout(() => setQ(input), DEBOUNCE_MS);
    return () => window.clearTimeout(id);
  }, [input, q]);

  const run = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await searchBusinessFiles({ q, sort: 'created_desc', page: 1, pageSize: PAGE_SIZE });
      const found = res.rows ?? [];
      setRows(found);
      setTotal(res.total ?? 0);

      // Linking requires EDIT on the file (the document_links insert policy),
      // but the search returns everything the caller can VIEW — and after B4
      // those two sets differ enormously: three users went from ~1,280 visible
      // files to ~6,100, and almost none of the gain is editable.
      //
      // Without this, most rows offer a Link button that answers 42501. Asking
      // the server for the caller's real role per row turns that into an
      // honest, disabled affordance. Measured live: maryam can view a gallery
      // image she cannot link, and used to only find out by clicking.
      setRoles(null);
      if (found.length > 0) {
        try {
          setRoles(await effectiveFileRoles(found.map((f) => f.id)));
        } catch {
          // effectiveFileRoles toasted. A null map means "unknown", and the
          // list stays clickable rather than locking every row on a lookup
          // failure — the write still fails loudly if it is refused.
          setRoles(null);
        }
      }
    } catch (e) {
      // Never an empty list for a failed search — see the Library's header.
      setError(errorText(e));
    } finally {
      setLoading(false);
    }
  }, [q]);

  useEffect(() => { if (open) void run(); }, [open, run]);

  const attach = useCallback(async (file: BusinessFileRow) => {
    setBusyId(file.id);
    try {
      await attachFileToRecord(file.id, modelId, recordId, role);
      onAttached();
    } catch {
      // attachFileToRecord toasted; the modal stays open so the user can retry
      // or pick a different file rather than losing their search.
    } finally {
      setBusyId(null);
    }
  }, [modelId, recordId, role, onAttached]);

  const roleOptions = useMemo(
    () => types.filter((x) => x.active !== false),
    [types],
  );

  return (
    <Modal open={open} onClose={onClose} maxWidth="max-w-2xl">
      <div className="p-5 space-y-4">
        <div className="flex items-center justify-between gap-3">
          <h2 className="text-base font-bold text-charcoal">{t('files.record.attach_title')}</h2>
          <button
            type="button"
            onClick={onClose}
            aria-label={t('common.close')}
            className="p-1.5 rounded-lg text-charcoal/40 hover:text-charcoal hover:bg-cream"
          >
            <X size={16} aria-hidden />
          </button>
        </div>

        <p className="text-xs text-charcoal/50">{t('files.record.attach_hint')}</p>

        <div className="flex flex-wrap items-center gap-2">
          <div className="relative flex-1 min-w-[14rem]">
            <Search
              size={15}
              className="absolute top-1/2 -translate-y-1/2 start-3 text-charcoal/40 pointer-events-none"
              aria-hidden
            />
            <input
              value={input}
              onChange={(e) => setInput(e.target.value)}
              placeholder={t('files.library.search_placeholder')}
              dir="auto"
              autoFocus
              className="w-full ps-9 pe-3 py-2.5 rounded-xl bg-white border border-sand/40 text-sm text-charcoal placeholder-charcoal/40 focus:outline-none focus:ring-2 focus:ring-copper/30"
            />
          </div>
          <label className="sr-only" htmlFor="attach-role">{t('files.record.link_as')}</label>
          <select
            id="attach-role"
            value={role}
            onChange={(e) => setRole(e.target.value)}
            className="px-3 py-2.5 rounded-xl bg-white border border-sand/40 text-xs font-bold text-charcoal/70 focus:outline-none focus:ring-2 focus:ring-copper/30"
          >
            {roleOptions.map((x) => (
              <option key={x.value} value={x.value}>{isAr ? x.label_ar : x.label_en}</option>
            ))}
          </select>
        </div>

        {error && (
          <div className="p-3 rounded-xl bg-red-500/5 border border-red-500/25" role="alert">
            <p className="flex items-start gap-2 text-xs text-red-700">
              <AlertTriangle size={13} className="mt-0.5 shrink-0" aria-hidden />
              <span>{t('files.library.search_failed')} — {error}</span>
            </p>
            <button
              type="button"
              onClick={() => void run()}
              className="mt-2 px-2.5 py-1 rounded-lg bg-white border border-red-500/25 text-xs font-bold text-red-700 hover:bg-red-500/10"
            >
              {t('files.library.retry')}
            </button>
          </div>
        )}

        <div className="max-h-80 overflow-auto rounded-xl border border-sand/30 divide-y divide-sand/20">
          {loading && rows.length === 0 ? (
            <div className="py-12 flex justify-center">
              <Loader2 size={22} className="animate-spin text-copper" aria-hidden />
            </div>
          ) : !error && rows.length === 0 ? (
            <p className="py-12 text-center text-xs text-charcoal/45">
              {t('files.library.empty_title')}
            </p>
          ) : (
            rows.map((f) => {
              const Icon = kindIcon[f.kind];
              const accent = kindAccent[f.kind];
              const linked = alreadyLinkedFileIds.has(f.id);
              return (
                <div key={f.id} className="flex items-center gap-3 px-3 py-2.5">
                  <span className={`w-8 h-8 rounded-lg flex items-center justify-center shrink-0 ${accent.bg}`}>
                    <Icon size={15} className={accent.fg} aria-hidden />
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block text-sm font-bold text-charcoal truncate" dir="auto" title={f.title}>
                      {f.title}
                    </span>
                    <span className="block text-[11px] text-charcoal/40">
                      {formatBytes(f.size_bytes, isAr)}
                    </span>
                  </span>
                  {linked ? (
                    <span className="inline-flex items-center gap-1 text-[11px] font-bold text-charcoal/45">
                      <Check size={12} aria-hidden />
                      {t('files.record.already_linked')}
                    </span>
                  ) : roles && !roleSatisfies(roles[f.id] ?? null, 'edit') ? (
                    <span
                      className="inline-flex items-center gap-1 text-[11px] font-bold text-charcoal/35"
                      title={t('files.record.no_edit_rights_hint')}
                    >
                      <Lock size={11} aria-hidden />
                      {t('files.record.no_edit_rights')}
                    </span>
                  ) : (
                    <Button
                      variant="secondary"
                      className="!px-3 !py-1.5 text-xs shrink-0"
                      disabled={busyId === f.id}
                      onClick={() => void attach(f)}
                    >
                      {busyId === f.id
                        ? <Loader2 size={12} className="animate-spin" aria-hidden />
                        : <Link2 size={12} aria-hidden />}
                      {t('files.record.link')}
                    </Button>
                  )}
                </div>
              );
            })
          )}
        </div>

        {total > rows.length && (
          <p className="text-[11px] text-charcoal/40">
            {t('files.record.showing_of', { shown: rows.length, total })}
          </p>
        )}
      </div>
    </Modal>
  );
}
