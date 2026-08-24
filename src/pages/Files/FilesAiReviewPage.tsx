/**
 * Library · "AI review" tab.
 *
 * One screen to judge enrichment quality: every file the caller can EDIT that
 * still carries unreviewed AI suggestions, each shown next to EXACTLY what the
 * AI proposed (description, classifications, nature, tags), with Approve / Dismiss
 * per file and an Approve-all. Approve marks the suggestions human_approved
 * (values stay); Dismiss undoes the AI-applied description/nature/subjects and
 * clears the provenance. Both are edit-gated server-side by the same RPCs the
 * detail panel uses.
 *
 * Same three-terminal-state discipline as the Library (loading / error / empty
 * are distinct screens) — a failed load must never read as "nothing to review".
 */
import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  AlertTriangle, Check, FileText, Film, Image as ImageIcon, Link2, Loader2, Music, Sparkles, Unlink, X,
} from 'lucide-react';
import { useAppStore } from '@/stores/appStore';
import Button from '@/components/ui/Button';
import type {
  AiReviewRow, FileDocumentTypeRow, FileVocabRow, FileRow, PageLinkSummary,
} from '@/types';
import {
  approveAiSuggestions, dismissAiSuggestions, errorText, fetchAiReviewCount,
  fetchAiReviewQueue, fetchPageLinks, listDocumentTypes, listFileVocabularies,
} from '@/lib/files/library';
import { getFile, signViewUrls } from '@/lib/files/client';
import { attachFileToRecord } from '@/lib/files/recordFiles';
import FilesTabs from './components/FilesTabs';
import FilePreviewModal from './components/FilePreviewModal';

const PAGE_LIMIT = 200;

/** One AI link suggestion staged in files.ai_suggestions.links (unlinked files
 *  only). The record was matched deterministically from a name the AI read. */
interface LinkSuggestion {
  model_id: string;
  model_name: string;
  record_id: string;
  label: string;
  matched_name: string;
}

const kindIcon: Record<string, typeof FileText> = {
  image: ImageIcon, video: Film, audio: Music, pdf: FileText, document: FileText,
};

export default function FilesAiReviewPage() {
  const { t } = useTranslation();
  const isAr = useAppStore((s) => s.language === 'ar');
  const addToast = useAppStore((s) => s.addToast);

  const [rows, setRows] = useState<AiReviewRow[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);
  const [busyIds, setBusyIds] = useState<Set<string>>(() => new Set());
  const [bulkBusy, setBulkBusy] = useState(false);
  /** file_id:record_id currently being attached. */
  const [attaching, setAttaching] = useState<Set<string>>(() => new Set());
  const models = useAppStore((s) => s.models);

  const [types, setTypes] = useState<FileDocumentTypeRow[]>([]);
  const [vocab, setVocab] = useState<FileVocabRow[]>([]);
  const [thumbs, setThumbs] = useState<Record<string, string>>({});
  const [links, setLinks] = useState<Map<string, PageLinkSummary[]>>(new Map());
  const [linksLoading, setLinksLoading] = useState(false);
  const [previewRow, setPreviewRow] = useState<FileRow | null>(null);

  // ── Load the queue ────────────────────────────────────────────────────────
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    void (async () => {
      try {
        const [queue, count] = await Promise.all([fetchAiReviewQueue(PAGE_LIMIT), fetchAiReviewCount()]);
        if (cancelled) return;
        setRows(queue);
        setTotal(count);
      } catch (e) {
        if (!cancelled) setError(errorText(e));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [reloadKey]);

  // Vocabularies for readable labels (subjects + asset_nature).
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const [ts, vs] = await Promise.all([listDocumentTypes(), listFileVocabularies()]);
        if (cancelled) return;
        setTypes(ts);
        setVocab(vs);
      } catch { /* both toast; labels fall back to the raw slug */ }
    })();
    return () => { cancelled = true; };
  }, []);

  // Thumbnails for image rows — one batch sign.
  useEffect(() => {
    const imageIds = rows.filter((r) => r.kind === 'image').map((r) => r.id);
    if (imageIds.length === 0) { setThumbs({}); return; }
    let cancelled = false;
    void (async () => {
      try {
        const map = await signViewUrls(imageIds);
        if (!cancelled) setThumbs(map);
      } catch { if (!cancelled) setThumbs({}); }
    })();
    return () => { cancelled = true; };
  }, [rows]);

  // Link status for each row — the reviewer needs to see whether a file is
  // already attached to a record before judging it (and AI link suggestions,
  // when they exist, only make sense for an UNLINKED file).
  useEffect(() => {
    if (rows.length === 0) { setLinks(new Map()); return; }
    let cancelled = false;
    setLinksLoading(true);
    void (async () => {
      try {
        const map = await fetchPageLinks(rows.map((r) => r.id));
        if (!cancelled) setLinks(map);
      } catch {
        if (!cancelled) setLinks(new Map()); // fetchPageLinks toasted
      } finally {
        if (!cancelled) setLinksLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [rows]);

  const typeLabel = useCallback((slug: string) => {
    const row = types.find((x) => x.value === slug);
    return row ? (isAr ? row.label_ar : row.label_en) : slug;
  }, [types, isAr]);
  const natureLabel = useCallback((slug: string) => {
    const row = vocab.find((x) => x.dimension === 'asset_nature' && x.value === slug);
    return row ? (isAr ? row.label_ar : row.label_en) : slug;
  }, [vocab, isAr]);

  const removeRow = useCallback((id: string) => {
    setRows((prev) => prev.filter((r) => r.id !== id));
    setTotal((n) => Math.max(0, n - 1));
  }, []);

  const decide = useCallback(async (row: AiReviewRow, accept: boolean) => {
    setBusyIds((cur) => new Set(cur).add(row.id));
    try {
      if (accept) await approveAiSuggestions(row.id);
      else await dismissAiSuggestions(row.id);
      removeRow(row.id);
    } catch {
      // approve/dismiss already toasted the failure; keep the row so it can retry.
    } finally {
      setBusyIds((cur) => { const n = new Set(cur); n.delete(row.id); return n; });
    }
  }, [removeRow]);

  const attachLink = useCallback(async (row: AiReviewRow, s: LinkSuggestion) => {
    const key = `${row.id}:${s.record_id}`;
    setAttaching((cur) => new Set(cur).add(key));
    try {
      await attachFileToRecord(row.id, s.model_id, s.record_id, null);
      // Reflect it immediately: the file now counts as linked (so the suggestion
      // block hides and the green "linked" chip shows), and we drop the staged
      // suggestions so a second click can't double-attach.
      const m = models.find((mm) => mm.id === s.model_id);
      setLinks((prev) => {
        const next = new Map(prev);
        const existing = next.get(row.id) ?? [];
        next.set(row.id, [...existing, {
          file_id: row.id, model_name: s.model_name,
          model_label_ar: m?.label_ar ?? null, model_label_en: m?.label_en ?? null, count: 1,
        }]);
        return next;
      });
      setRows((prev) => prev.map((r) => (r.id === row.id ? { ...r, ai_suggestions: null } : r)));
      addToast(t('files.ai_review.linked_toast', { label: s.label }), 'success');
    } catch {
      // attachFileToRecord toasted; leave the suggestion so it can be retried.
    } finally {
      setAttaching((cur) => { const n = new Set(cur); n.delete(key); return n; });
    }
  }, [models, addToast, t]);

  const approveAll = useCallback(async () => {
    setBulkBusy(true);
    try {
      // Sequential: the RPC is one row-locked UPDATE; a burst would just contend.
      for (const row of [...rows]) {
        try { await approveAiSuggestions(row.id); removeRow(row.id); }
        catch { /* toasted; leave it for individual retry */ }
      }
      addToast(t('files.ai_review.approved_all'), 'success');
    } finally { setBulkBusy(false); }
  }, [rows, removeRow, addToast, t]);

  const openPreview = useCallback(async (fileId: string) => {
    try {
      const row = await getFile(fileId);
      if (row) setPreviewRow(row);
    } catch { /* getFile toasted */ }
  }, []);

  const hasMore = total > rows.length;

  return (
    <div className="p-6 max-w-screen-2xl mx-auto">
      <div className="flex items-start justify-between flex-wrap gap-4 mb-5">
        <div>
          <h1 className="text-2xl font-bold text-charcoal mb-3">{t('files.title')}</h1>
          <FilesTabs />
        </div>
        {rows.length > 0 && (
          <Button className="!px-4 !py-2.5" disabled={bulkBusy} onClick={() => void approveAll()}>
            {bulkBusy ? <Loader2 size={16} className="animate-spin" aria-hidden /> : <Check size={16} aria-hidden />}
            {t('files.ai_review.approve_all', { count: rows.length })}
          </Button>
        )}
      </div>

      {/* Intro band */}
      <div className="mb-4 flex items-center gap-2 text-sm text-charcoal/60">
        <Sparkles size={15} className="text-copper" aria-hidden />
        <span>{t('files.ai_review.intro')}</span>
        {!loading && !error && (
          <span className="text-charcoal/35">· {t('files.ai_review.pending', { count: total })}</span>
        )}
      </div>

      {error && (
        <div className="p-4 rounded-xl bg-red-500/5 border border-red-500/25 mb-4" role="alert">
          <div className="flex items-start gap-2.5">
            <AlertTriangle size={16} className="mt-0.5 shrink-0 text-red-600" aria-hidden />
            <div className="min-w-0 flex-1">
              <p className="text-sm font-bold text-red-700">{t('files.ai_review.load_failed')}</p>
              <p className="mt-0.5 text-xs text-red-700/80 break-words">{error}</p>
            </div>
            <Button variant="secondary" className="!px-3 !py-1.5 text-xs shrink-0"
                    onClick={() => setReloadKey((k) => k + 1)}>
              {t('files.library.retry')}
            </Button>
          </div>
        </div>
      )}

      {loading ? (
        <div className="py-24 flex justify-center">
          <Loader2 size={28} className="animate-spin text-copper" aria-hidden />
        </div>
      ) : !error && rows.length === 0 ? (
        <div className="py-20 flex flex-col items-center justify-center text-center">
          <div className="w-20 h-20 rounded-3xl bg-cream flex items-center justify-center mb-4">
            <Check size={30} className="text-copper/60" aria-hidden />
          </div>
          <p className="text-sm font-bold text-charcoal/70">{t('files.ai_review.empty_title')}</p>
          <p className="mt-1 text-xs text-charcoal/45 max-w-sm">{t('files.ai_review.empty_hint')}</p>
        </div>
      ) : (
        <div className="space-y-3">
          {rows.map((row) => {
            const Icon = kindIcon[row.kind] ?? FileText;
            const thumb = thumbs[row.id];
            const busy = busyIds.has(row.id);
            const subjects = row.ai_subjects ?? [];
            const tags = row.tags ?? [];
            const rowLinks = links.get(row.id) ?? [];
            const linkTotal = rowLinks.reduce((n, l) => n + l.count, 0);
            const suggestions: LinkSuggestion[] = linkTotal === 0 && row.ai_suggestions && typeof row.ai_suggestions === 'object'
              ? ((row.ai_suggestions as { links?: LinkSuggestion[] }).links ?? [])
              : [];
            return (
              <div key={row.id}
                   className="flex gap-4 p-3 rounded-2xl bg-white border border-sand/30 shadow-sm">
                {/* Thumbnail / preview trigger */}
                <button type="button" onClick={() => void openPreview(row.id)}
                        className="w-24 h-24 shrink-0 rounded-xl overflow-hidden bg-cream flex items-center justify-center hover:ring-2 hover:ring-copper/40 transition"
                        aria-label={t('files.ai_review.open_file')}>
                  {thumb
                    ? <img src={thumb} alt="" className="w-full h-full object-cover" />
                    : <Icon size={28} className="text-copper/50" aria-hidden />}
                </button>

                {/* AI proposal */}
                <div className="flex-1 min-w-0 space-y-2">
                  <div className="flex items-center gap-2 min-w-0">
                    <span className="text-sm font-bold text-charcoal truncate" dir="auto">
                      {row.original_name}
                    </span>
                  </div>

                  {row.ai_description && (
                    <p className="text-xs text-charcoal/70 leading-relaxed" dir="auto">
                      {row.ai_description}
                    </p>
                  )}

                  <div className="flex flex-wrap items-center gap-1.5">
                    {subjects.map((s) => (
                      <span key={`s-${s}`}
                            className="inline-flex items-center gap-1 px-2 py-0.5 rounded-md bg-copper/10 text-copper text-[11px] font-bold" dir="auto">
                        <Sparkles size={9} aria-hidden />{typeLabel(s)}
                      </span>
                    ))}
                    {row.asset_nature && (
                      <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-md bg-gold/15 text-charcoal/70 text-[11px] font-bold" dir="auto">
                        <Sparkles size={9} aria-hidden />{natureLabel(row.asset_nature)}
                      </span>
                    )}
                    {tags.map((tag) => (
                      <span key={`t-${tag}`}
                            className="px-2 py-0.5 rounded-md bg-cream text-charcoal/55 text-[11px]" dir="auto">
                        #{tag}
                      </span>
                    ))}
                    {subjects.length === 0 && !row.asset_nature && tags.length === 0 && !row.ai_description && (
                      <span className="text-[11px] text-charcoal/40">{t('files.ai_review.nothing_proposed')}</span>
                    )}
                  </div>

                  {/* Link status — always shown, independent of what the AI
                      proposed. Linked → the record model(s) it's attached to;
                      unlinked → said plainly (that's where an AI link suggestion
                      would belong, once the enrichment stages them). */}
                  <div className="flex flex-wrap items-center gap-1.5 pt-1 border-t border-sand/20">
                    {linkTotal > 0 ? (
                      <>
                        <Link2 size={12} className="text-emerald-600" aria-hidden />
                        <span className="text-[11px] font-bold text-emerald-700">{t('files.ai_review.linked')}</span>
                        {rowLinks.map((l) => (
                          <span key={l.model_name}
                                className="px-2 py-0.5 rounded-md bg-emerald-500/10 text-emerald-700 text-[11px]" dir="auto">
                            {(isAr ? l.model_label_ar : l.model_label_en) || l.model_name}
                            {l.count > 1 ? ` (${l.count})` : ''}
                          </span>
                        ))}
                      </>
                    ) : linksLoading ? (
                      <span className="text-[11px] text-charcoal/35">{t('files.ai_review.checking_links')}</span>
                    ) : suggestions.length > 0 ? (
                      <>
                        <Sparkles size={12} className="text-copper" aria-hidden />
                        <span className="text-[11px] font-bold text-copper">{t('files.ai_review.suggest_link')}</span>
                        {suggestions.map((s) => {
                          const key = `${row.id}:${s.record_id}`;
                          const on = attaching.has(key);
                          const modelLbl = (() => {
                            const m = models.find((mm) => mm.id === s.model_id);
                            return m ? (isAr ? m.label_ar : m.label_en) : s.model_name;
                          })();
                          return (
                            <button key={key} type="button" disabled={on}
                                    onClick={() => void attachLink(row, s)}
                                    className="inline-flex items-center gap-1 px-2 py-0.5 rounded-md bg-copper/10 text-copper text-[11px] font-bold hover:bg-copper/20 disabled:opacity-50"
                                    dir="auto">
                              {on ? <Loader2 size={10} className="animate-spin" aria-hidden /> : <Link2 size={10} aria-hidden />}
                              {s.label}
                              <span className="font-normal text-copper/60">· {modelLbl}</span>
                            </button>
                          );
                        })}
                      </>
                    ) : (
                      <span className="inline-flex items-center gap-1 text-[11px] font-bold text-charcoal/45">
                        <Unlink size={12} aria-hidden />{t('files.ai_review.not_linked')}
                      </span>
                    )}
                  </div>
                </div>

                {/* Verdict */}
                <div className="flex flex-col gap-2 shrink-0 self-center">
                  <button type="button" disabled={busy} onClick={() => void decide(row, true)}
                          className="inline-flex items-center justify-center gap-1 px-3 py-2 rounded-lg bg-copper text-white text-xs font-bold hover:bg-terracotta disabled:opacity-50 min-w-[104px]">
                    {busy ? <Loader2 size={13} className="animate-spin" aria-hidden /> : <Check size={13} aria-hidden />}
                    {t('files.ai_review.approve')}
                  </button>
                  <button type="button" disabled={busy} onClick={() => void decide(row, false)}
                          className="inline-flex items-center justify-center gap-1 px-3 py-2 rounded-lg bg-white border border-sand/40 text-charcoal/70 text-xs font-bold hover:bg-cream disabled:opacity-50 min-w-[104px]">
                    <X size={13} aria-hidden />
                    {t('files.ai_review.dismiss')}
                  </button>
                </div>
              </div>
            );
          })}

          {hasMore && (
            <p className="text-center text-xs text-charcoal/45 pt-2">
              {t('files.ai_review.showing_first', { shown: rows.length, total })}
            </p>
          )}
        </div>
      )}

      <FilePreviewModal
        file={previewRow}
        open={Boolean(previewRow)}
        canEdit={false}
        canDelete={false}
        onClose={() => setPreviewRow(null)}
        onShare={() => {}}
        onPermissions={() => {}}
        onDelete={() => {}}
      />
    </div>
  );
}
