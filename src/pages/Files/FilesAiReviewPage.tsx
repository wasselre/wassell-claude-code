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
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  AlertTriangle, Check, ExternalLink, FileText, Film, Image as ImageIcon, Link2, Loader2, Music, Sparkles, Unlink, X,
} from 'lucide-react';
import { useAppStore } from '@/stores/appStore';
import Button from '@/components/ui/Button';
import type {
  AiReviewRow, AppRecord, FileDocumentTypeRow, FileVocabRow, FileRow, FileLinkedRecord,
} from '@/types';
import {
  approveAiSuggestions, dismissAiSuggestions, errorText, fetchAiReviewCount,
  fetchAiReviewQueue, fetchFileLinkedRecords, listDocumentTypes, listFileVocabularies,
} from '@/lib/files/library';
import { getFile, signViewUrls } from '@/lib/files/client';
import { attachFileToRecord } from '@/lib/files/recordFiles';
import { resolveLocalizedName } from '@/lib/geo/localizedName';
import FilesTabs from './components/FilesTabs';
import FilePreviewModal from './components/FilePreviewModal';
import BulkLinkModal from './library/BulkLinkModal';

const PAGE_LIMIT = 200;

/** One AI link suggestion staged in files.ai_suggestions.links (unlinked files
 *  only). The record was matched deterministically from a name the AI read. */
interface LinkSuggestion {
  model_id: string;
  model_name: string;
  record_id: string;
  label: string;
  matched_name: string;
  /** 0..1 — how sure the deterministic matcher is (1 = exact name). */
  confidence?: number;
}

const kindIcon: Record<string, typeof FileText> = {
  image: ImageIcon, video: Film, audio: Music, pdf: FileText, document: FileText,
};

export default function FilesAiReviewPage() {
  const { t } = useTranslation();
  const isAr = useAppStore((s) => s.language === 'ar');
  const addToast = useAppStore((s) => s.addToast);
  const models = useAppStore((s) => s.models);
  const records = useAppStore((s) => s.records);

  // Resolve a linked UNIT to its parent project so the reviewer sees "which unit
  // in what project", not just "2 units". A unit references its project via
  // data.project_id → an all_projects record. Built once from the warm store.
  const projectNameById = useMemo(() => {
    const map = new Map<string, string>();
    const apModel = models.find((m) => m.name === 'all_projects');
    if (apModel) {
      for (const r of records[apModel.id] ?? []) {
        const pn = (r.data as Record<string, unknown>)?.project_name;
        if (typeof pn === 'string' && pn) map.set(r.id, pn);
      }
    }
    return map;
  }, [models, records]);
  const unitById = useMemo(() => {
    const map = new Map<string, AppRecord>();
    const um = models.find((m) => m.name === 'units');
    if (um) for (const r of records[um.id] ?? []) map.set(r.id, r);
    return map;
  }, [models, records]);
  /** The best display label for a linked record — a unit's own code, else the
   *  resolved title. */
  const linkLabel = useCallback((l: FileLinkedRecord): string => {
    if (l.model_name === 'units') {
      const u = unitById.get(l.record_id);
      const code = (u?.data as Record<string, unknown>)?.unit_code
        ?? (u?.data as Record<string, unknown>)?.unit_number;
      if (typeof code === 'string' && code) return code;
    }
    return l.label;
  }, [unitById]);
  /** The parent project's name for a unit (null for a project link — it IS the project). */
  const linkProject = useCallback((l: FileLinkedRecord): string | null => {
    if (l.model_name !== 'units') return null;
    const u = unitById.get(l.record_id);
    const pid = (u?.data as Record<string, unknown>)?.project_id;
    return typeof pid === 'string' ? (projectNameById.get(pid) ?? null) : null;
  }, [unitById, projectNameById]);

  const [rows, setRows] = useState<AiReviewRow[]>([]);
  const [total, setTotal] = useState(0);
  const [loadingMore, setLoadingMore] = useState(false);
  /** Focus mode: full-screen, one decision at a time. The card is always rows[0]
   *  — deciding REMOVES it, so the next row slides into view automatically. */
  const [focus, setFocus] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);
  const [busyIds, setBusyIds] = useState<Set<string>>(() => new Set());
  const [bulkBusy, setBulkBusy] = useState(false);
  /** file_id:record_id currently being attached. */
  const [attaching, setAttaching] = useState<Set<string>>(() => new Set());
  /** File whose manual "link to a record" dialog is open. */
  const [linkFileId, setLinkFileId] = useState<string | null>(null);

  const refreshRowLinks = useCallback(async (fileId: string) => {
    try {
      const map = await fetchFileLinkedRecords([fileId], isAr);
      const list = map.get(fileId) ?? [];
      setLinks((prev) => { const next = new Map(prev); next.set(fileId, list); return next; });
      // Now that it's linked, drop the AI link suggestions from the card.
      if (list.length > 0) setRows((prev) => prev.map((r) => (r.id === fileId ? { ...r, ai_suggestions: null } : r)));
    } catch { /* fetchFileLinkedRecords toasted */ }
  }, [isAr]);

  const [types, setTypes] = useState<FileDocumentTypeRow[]>([]);
  const [vocab, setVocab] = useState<FileVocabRow[]>([]);
  const [thumbs, setThumbs] = useState<Record<string, string>>({});
  const [links, setLinks] = useState<Map<string, FileLinkedRecord[]>>(new Map());
  const [linksLoading, setLinksLoading] = useState(false);
  const [previewRow, setPreviewRow] = useState<FileRow | null>(null);

  // ── Load the queue ────────────────────────────────────────────────────────
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    void (async () => {
      try {
        // The QUEUE is the page — its failure is the only fatal one. The count is
        // a best-effort header number: fetched separately so a slow/failed count
        // (it once timed out under a 7k-file backlog) can never blank the queue.
        const queue = await fetchAiReviewQueue(PAGE_LIMIT);
        if (cancelled) return;
        setRows(queue);
        setTotal(queue.length);
        fetchAiReviewCount()
          .then((c) => { if (!cancelled) setTotal(c); })
          .catch(() => { /* keep the queue-length fallback; count is non-fatal */ });
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
        const map = await fetchFileLinkedRecords(rows.map((r) => r.id), isAr);
        if (!cancelled) setLinks(map);
      } catch {
        if (!cancelled) setLinks(new Map()); // fetchFileLinkedRecords toasted
      } finally {
        if (!cancelled) setLinksLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [rows, isAr]);

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
          file_id: row.id, model_id: s.model_id, model_name: s.model_name,
          model_label_ar: m?.label_ar ?? null, model_label_en: m?.label_en ?? null,
          record_id: s.record_id, label: s.label,
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

  // Page through the rest of the queue (it can be thousands). Offset by the
  // number already loaded; dedup on append so a shift from concurrent approvals
  // can't double-show a row.
  const loadMore = useCallback(async () => {
    setLoadingMore(true);
    try {
      const next = await fetchAiReviewQueue(PAGE_LIMIT, rows.length);
      setRows((prev) => {
        const seen = new Set(prev.map((r) => r.id));
        return [...prev, ...next.filter((r) => !seen.has(r.id))];
      });
    } catch { /* fetchAiReviewQueue toasted */ } finally { setLoadingMore(false); }
  }, [rows.length]);

  const hasMore = total > rows.length;

  // ── Focus mode helpers ─────────────────────────────────────────────────────
  /** The top link suggestion for a row — the project match if any, else the first. */
  const topSuggestion = useCallback((row: AiReviewRow): LinkSuggestion | null => {
    const links = (row.ai_suggestions && typeof row.ai_suggestions === 'object'
      ? (row.ai_suggestions as { links?: LinkSuggestion[] }).links : null) ?? [];
    if (links.length === 0) return null;
    return links.find((l) => l.model_name === 'all_projects') ?? links[0]!;
  }, []);
  /** developer id → name, so a project's developer shows as a name not a uuid. */
  const developerName = useCallback((id: string): string | null => {
    const dm = models.find((mm) => mm.name === 'developers');
    if (!dm) return null;
    const dev = (records[dm.id] ?? []).find((r) => r.id === id);
    const nm = (dev?.data as Record<string, unknown>)?.name;
    return typeof nm === 'string' ? nm : null;
  }, [models, records]);
  /** Enough about the record we'd link to for the reviewer to judge the match —
   *  modeled on the competitor-watch Confirm-links card (developer/city/price/units). */
  const recordFacts = useCallback((modelName: string, recordId: string): Array<{ k: string; v: string }> => {
    const m = models.find((mm) => mm.name === modelName);
    if (!m) return [];
    const rec = (records[m.id] ?? []).find((r) => r.id === recordId);
    const d = (rec?.data ?? {}) as Record<string, unknown>;
    const loc = (d.location ?? {}) as Record<string, unknown>;
    const out: Array<{ k: string; v: string }> = [];
    const add = (k: string, v: unknown) => { if (typeof v === 'string' && v.trim()) out.push({ k, v }); };
    const compact = (n: number) => (n >= 1_000_000 ? `${(n / 1_000_000).toFixed(n >= 10_000_000 ? 0 : 1)}M` : n >= 1000 ? `${Math.round(n / 1000)}K` : String(Math.round(n)));
    const fmtRange = (r: unknown): string | null => {
      const o = r as { min?: number; max?: number } | null;
      if (!o || (o.min == null && o.max == null)) return null;
      const unit = isAr ? 'ر.س' : 'SAR';
      if (o.min != null && o.max != null && o.max !== o.min) return `${compact(o.min)}–${compact(o.max)} ${unit}`;
      const one = o.min ?? o.max;
      return one != null ? `${compact(one)} ${unit}` : null;
    };
    const UNIT_AR: Record<string, string> = { floor: 'دور', villa: 'فيلا', townhouse: 'تاون هاوس', penthouse: 'بنتهاوس', apartment: 'شقة', duplex: 'دوبلكس' };
    // city/district are geo REFERENCE ids (cities/districts records), never names.
    const oneId = (v: unknown): string | null =>
      Array.isArray(v) ? (typeof v[0] === 'string' ? v[0] : null) : (typeof v === 'string' && v ? v : null);
    const geoName = (mn: 'cities' | 'districts', id: string | null): string | null => {
      if (!id) return null;
      const gm = models.find((mm) => mm.name === mn);
      const grec = gm ? (records[gm.id] ?? []).find((r) => r.id === id) : undefined;
      const lz = resolveLocalizedName(id, grec?.data as Record<string, unknown> | undefined);
      return lz ? (isAr ? lz.ar : lz.enDisplay) : null;
    };
    if (modelName === 'all_projects') {
      const dev = typeof d.developer === 'string' ? developerName(d.developer) : null;
      add(t('files.ai_review.fact_developer'), dev);
      add(t('files.ai_review.fact_city'), geoName('cities', oneId(loc.city ?? d.city)));
      add(t('files.ai_review.fact_district'), geoName('districts', oneId(loc.district ?? d.district)));
      const price = fmtRange(d.available_price_range ?? d.price_range);
      if (price) out.push({ k: t('files.ai_review.fact_price'), v: price });
      if (Array.isArray(d.unit_types) && d.unit_types.length) {
        const ut = (d.unit_types as string[]).map((u) => (isAr ? (UNIT_AR[u] ?? u) : u)).join(isAr ? '، ' : ', ');
        out.push({ k: t('files.ai_review.fact_units'), v: ut });
      }
    } else if (modelName === 'units') {
      const proj = typeof d.project_id === 'string' ? projectNameById.get(d.project_id) : null;
      if (proj) out.push({ k: t('files.ai_review.fact_project'), v: proj });
      add(t('files.ai_review.fact_unit_type'), d.unit_type);
      if (d.unit_area != null && d.unit_area !== '') out.push({ k: t('files.ai_review.fact_area'), v: `${Number(d.unit_area)} ${isAr ? 'م²' : 'm²'}` });
      if (d.bedrooms != null && d.bedrooms !== '') out.push({ k: t('files.ai_review.fact_bedrooms'), v: String(d.bedrooms) });
      if (d.bathrooms != null && d.bathrooms !== '') out.push({ k: t('files.ai_review.fact_bathrooms'), v: String(d.bathrooms) });
      add(t('files.ai_review.fact_floor'), d.floor);
      const uprice = typeof d.total_price === 'number' && d.total_price > 0
        ? `${compact(d.total_price)} ${isAr ? 'ر.س' : 'SAR'}` : fmtRange(d.price_range);
      if (uprice) out.push({ k: t('files.ai_review.fact_price'), v: uprice });
    }
    return out;
  }, [models, records, t, isAr, developerName, projectNameById]);
  /** Accept = approve the AI read + attach the suggested project; Reject = dismiss.
   *  Both remove the row via decide(), so rows[0] advances to the next card. */
  const focusAct = useCallback(async (row: AiReviewRow, accept: boolean) => {
    if (accept) {
      const sugg = topSuggestion(row);
      const alreadyLinked = (links.get(row.id)?.length ?? 0) > 0;
      if (sugg && !alreadyLinked) {
        try { await attachFileToRecord(row.id, sugg.model_id, sugg.record_id, null); }
        catch { /* attach toasted; still approve the metadata below */ }
      }
    }
    await decide(row, accept);
    // Keep the queue flowing near the end.
    if (rows.length <= 3 && hasMore && !loadingMore) void loadMore();
  }, [topSuggestion, links, decide, rows.length, hasMore, loadingMore, loadMore]);

  // Keyboard: Y / → / Enter = accept, N / ← / Backspace = reject, Esc = exit.
  useEffect(() => {
    if (!focus) return;
    const onKey = (e: KeyboardEvent) => {
      const cur = rows[0];
      if (e.key === 'Escape') { setFocus(false); return; }
      if (!cur || busyIds.has(cur.id)) return;
      if (e.key === 'y' || e.key === 'Y' || e.key === 'ArrowRight' || e.key === 'Enter') { e.preventDefault(); void focusAct(cur, true); }
      else if (e.key === 'n' || e.key === 'N' || e.key === 'ArrowLeft' || e.key === 'Backspace') { e.preventDefault(); void focusAct(cur, false); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [focus, rows, busyIds, focusAct]);

  return (
    <div className="p-6 max-w-screen-2xl mx-auto">
      {/* ── FOCUS MODE — full-screen, one decision at a time ──────────────── */}
      {focus && (
        <div className="fixed inset-0 z-50 bg-cream flex flex-col" role="dialog" aria-modal="true">
          <div className="flex items-center justify-between px-6 py-3 border-b border-sand/30 shrink-0">
            <div className="flex items-center gap-2 text-sm font-bold text-charcoal">
              <Sparkles size={16} className="text-copper" aria-hidden />
              {t('files.ai_review.focus_mode')}
              <span className="text-charcoal/40 font-normal">· {t('files.ai_review.remaining', { count: total })}</span>
            </div>
            <button type="button" onClick={() => setFocus(false)}
                    className="inline-flex items-center gap-1.5 text-sm text-charcoal/60 hover:text-charcoal">
              <X size={16} aria-hidden /> {t('files.ai_review.exit_focus')}
            </button>
          </div>

          <div className="flex-1 overflow-auto flex items-center justify-center p-6">
            {(() => {
              const cur = rows[0];
              if (!cur) {
                return hasMore ? (
                  <div className="text-center space-y-3 text-charcoal/60">
                    <Loader2 size={28} className="animate-spin mx-auto text-copper" aria-hidden />
                    <p className="text-sm">{t('files.ai_review.loading_more_focus')}</p>
                  </div>
                ) : (
                  <div className="text-center space-y-3">
                    <Check size={44} className="mx-auto text-emerald-500" aria-hidden />
                    <p className="text-lg font-bold text-charcoal">{t('files.ai_review.focus_done')}</p>
                    <Button variant="secondary" onClick={() => setFocus(false)}>{t('files.ai_review.exit_focus')}</Button>
                  </div>
                );
              }
              const curThumb = thumbs[cur.id];
              const CurIcon = kindIcon[cur.kind] ?? FileText;
              const curSubjects = cur.ai_subjects ?? [];
              const curTags = cur.tags ?? [];
              const curLinks = links.get(cur.id) ?? [];
              const sugg = topSuggestion(cur);
              const facts = sugg ? recordFacts(sugg.model_name, sugg.record_id) : [];
              const suggModel = sugg ? models.find((m) => m.id === sugg.model_id) : undefined;
              return (
                <div className="w-full max-w-4xl grid md:grid-cols-2 gap-6 items-start">
                  {/* the file + the AI read */}
                  <div className="space-y-3">
                    <button type="button" onClick={() => void openPreview(cur.id)}
                            className="w-full aspect-[4/3] rounded-2xl overflow-hidden bg-white border border-sand/40 flex items-center justify-center hover:ring-2 hover:ring-copper/40">
                      {curThumb ? <img src={curThumb} alt="" className="w-full h-full object-contain" />
                                : <CurIcon size={48} className="text-copper/40" aria-hidden />}
                    </button>
                    <div className="text-base font-bold text-charcoal break-all" dir="auto">{cur.original_name}</div>
                    {cur.ai_description && <p className="text-sm text-charcoal/70 leading-relaxed" dir="auto">{cur.ai_description}</p>}
                    <div className="flex flex-wrap gap-1.5">
                      {curSubjects.map((s) => <span key={s} className="px-2 py-0.5 rounded-md bg-copper/10 text-copper text-[11px] font-bold" dir="auto">{typeLabel(s)}</span>)}
                      {cur.asset_nature && <span className="px-2 py-0.5 rounded-md bg-gold/15 text-charcoal/70 text-[11px] font-bold" dir="auto">{natureLabel(cur.asset_nature)}</span>}
                      {curTags.slice(0, 8).map((tg) => <span key={tg} className="px-2 py-0.5 rounded-md bg-cream text-charcoal/55 text-[11px]" dir="auto">#{tg}</span>)}
                    </div>
                  </div>

                  {/* where it links + the target's info */}
                  <div className="space-y-3">
                    <h3 className="text-xs font-bold uppercase tracking-wide text-charcoal/45">{t('files.ai_review.link_target')}</h3>
                    {curLinks.length > 0 ? (
                      <div className="rounded-2xl border border-emerald-500/30 bg-emerald-500/5 p-4 space-y-2">
                        <div className="text-[11px] font-bold text-emerald-700">{t('files.ai_review.linked')}</div>
                        {curLinks.map((l) => (
                          <a key={l.record_id} href={`/model/${l.model_name}/${l.record_id}`} target="_blank" rel="noopener noreferrer"
                             className="flex items-center gap-1.5 text-sm text-emerald-800 hover:underline" dir="auto">
                            <span className="font-bold">{linkLabel(l)}</span>
                            {linkProject(l) && <span className="text-emerald-700/70">— {linkProject(l)}</span>}
                            <ExternalLink size={12} aria-hidden />
                          </a>
                        ))}
                        {(() => {
                          const lf = curLinks[0] ? recordFacts(curLinks[0].model_name, curLinks[0].record_id) : [];
                          return lf.length > 0 ? (
                            <dl className="grid grid-cols-2 gap-2 pt-2 border-t border-emerald-500/15">
                              {lf.map((f) => (
                                <div key={f.k}><dt className="text-[10px] text-emerald-700/50">{f.k}</dt>
                                  <dd className="text-xs font-bold text-emerald-900/80" dir="auto">{f.v}</dd></div>
                              ))}
                            </dl>
                          ) : null;
                        })()}
                      </div>
                    ) : sugg ? (
                      <div className="space-y-2">
                        <p className="text-sm font-bold text-charcoal">{t('files.ai_review.link_question')}</p>
                        <a href={`/model/${sugg.model_name}/${sugg.record_id}`} target="_blank" rel="noopener noreferrer"
                           className="block rounded-2xl border-2 border-copper/40 bg-copper/5 p-4 space-y-2 hover:bg-copper/10 transition-colors">
                          <div className="flex items-center gap-1.5 text-[11px] font-bold text-copper">
                            <Sparkles size={11} aria-hidden /> {t('files.ai_review.suggested_link')}
                          </div>
                          <div className="text-lg font-bold text-charcoal" dir="auto">{sugg.label}</div>
                          <div className="flex items-center gap-2 text-[11px] text-charcoal/45">
                            <span>{(isAr ? suggModel?.label_ar : suggModel?.label_en) || sugg.model_name}</span>
                            {typeof sugg.confidence === 'number' && (
                              <span className={`px-1.5 py-0.5 rounded font-bold ${
                                sugg.confidence >= 0.85 ? 'bg-emerald-500/15 text-emerald-700'
                                : sugg.confidence >= 0.6 ? 'bg-amber-500/15 text-amber-700'
                                : 'bg-red-500/10 text-red-600'}`}>
                                {t('files.ai_review.confidence')} {Math.round(sugg.confidence * 100)}%
                              </span>
                            )}
                          </div>
                          {facts.length > 0 && (
                            <dl className="grid grid-cols-2 gap-2 pt-1">
                              {facts.map((f) => (
                                <div key={f.k}><dt className="text-[10px] text-charcoal/40">{f.k}</dt>
                                  <dd className="text-xs font-bold text-charcoal/80" dir="auto">{f.v}</dd></div>
                              ))}
                            </dl>
                          )}
                          <div className="inline-flex items-center gap-1 text-[11px] text-copper pt-1"><ExternalLink size={11} aria-hidden /> {t('files.ai_review.open_record_new_tab')}</div>
                        </a>
                        {sugg.matched_name && (
                          <p className="text-[11px] text-charcoal/55" dir="auto">
                            {t('files.ai_review.ai_read_name')} <b className="text-charcoal/80">{sugg.matched_name}</b>
                          </p>
                        )}
                      </div>
                    ) : (
                      <div className="rounded-2xl border border-sand/40 bg-white p-4 text-sm text-charcoal/45">
                        {t('files.ai_review.no_suggested_link')}
                      </div>
                    )}
                  </div>
                </div>
              );
            })()}
          </div>

          {rows[0] && (
            <div className="flex items-center justify-center gap-4 px-6 py-4 border-t border-sand/30 shrink-0">
              <button type="button" disabled={busyIds.has(rows[0].id)} onClick={() => void focusAct(rows[0]!, false)}
                      className="inline-flex items-center gap-2 px-8 py-3 rounded-2xl bg-white border-2 border-red-300 text-red-600 font-bold hover:bg-red-50 disabled:opacity-50">
                <X size={20} aria-hidden /> {t('files.ai_review.no')}
              </button>
              <button type="button" disabled={busyIds.has(rows[0].id)} onClick={() => void focusAct(rows[0]!, true)}
                      className="inline-flex items-center gap-2 px-8 py-3 rounded-2xl bg-emerald-600 text-white font-bold hover:bg-emerald-700 disabled:opacity-50">
                {busyIds.has(rows[0].id) ? <Loader2 size={20} className="animate-spin" aria-hidden /> : <Check size={20} aria-hidden />} {t('files.ai_review.yes')}
              </button>
            </div>
          )}
          <p className="text-center text-[11px] text-charcoal/35 pb-2">{t('files.ai_review.focus_hint')}</p>
        </div>
      )}

      <div className="flex items-start justify-between flex-wrap gap-4 mb-5">
        <div>
          <h1 className="text-2xl font-bold text-charcoal mb-3">{t('files.title')}</h1>
          <FilesTabs />
        </div>
        {rows.length > 0 && (
          <div className="flex items-center gap-2">
            <Button variant="secondary" className="!px-4 !py-2.5" onClick={() => setFocus(true)}>
              <Sparkles size={16} aria-hidden />
              {t('files.ai_review.focus_mode')}
            </Button>
            <Button className="!px-4 !py-2.5" disabled={bulkBusy} onClick={() => void approveAll()}>
              {bulkBusy ? <Loader2 size={16} className="animate-spin" aria-hidden /> : <Check size={16} aria-hidden />}
              {t('files.ai_review.approve_all', { count: rows.length })}
            </Button>
          </div>
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
            const linkTotal = rowLinks.length;
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
                        {rowLinks.map((l) => {
                          const project = linkProject(l);
                          return (
                            // Clickable → opens the record's page in a NEW TAB, so
                            // the reviewer keeps the queue open. Shows the unit's
                            // own code and the project it belongs to.
                            <a key={l.record_id}
                               href={`/model/${l.model_name}/${l.record_id}`}
                               target="_blank" rel="noopener noreferrer"
                               title={t('files.ai_review.open_record_new_tab')}
                               className="inline-flex items-baseline gap-1 px-2 py-0.5 rounded-md bg-emerald-500/10 text-emerald-700 text-[11px] hover:bg-emerald-500/20 hover:underline transition-colors" dir="auto">
                              <span className="font-bold">{linkLabel(l)}</span>
                              {project && <span className="text-emerald-700/80">— {project}</span>}
                              <span className="text-emerald-700/45">
                                · {(isAr ? l.model_label_ar : l.model_label_en) || l.model_name}
                              </span>
                              <ExternalLink size={9} className="self-center opacity-60" aria-hidden />
                            </a>
                          );
                        })}
                      </>
                    ) : linksLoading ? (
                      <span className="text-[11px] text-charcoal/35">{t('files.ai_review.checking_links')}</span>
                    ) : (
                      <>
                        {suggestions.length > 0 ? (
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
                        {/* Manual link — always available for an unlinked file, whether
                            or not the AI proposed a record. */}
                        <button type="button" onClick={() => setLinkFileId(row.id)}
                                className="inline-flex items-center gap-1 px-2 py-0.5 rounded-md border border-copper/40 text-copper text-[11px] font-bold hover:bg-copper/10">
                          <Link2 size={10} aria-hidden />{t('files.ai_review.link_manual')}
                        </button>
                      </>
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
            <div className="flex flex-col items-center gap-2 pt-3">
              <p className="text-center text-xs text-charcoal/45">
                {t('files.ai_review.showing_first', { shown: rows.length, total })}
              </p>
              <Button variant="secondary" className="!px-4 !py-2 text-xs"
                      disabled={loadingMore} onClick={() => void loadMore()}>
                {loadingMore ? <Loader2 size={13} className="animate-spin" aria-hidden /> : null}
                {t('files.ai_review.load_more')}
              </Button>
            </div>
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

      {/* Manual "link to a record" — reuses the library's file→record picker for
          the single file, then refreshes just that card's link status. */}
      <BulkLinkModal
        open={Boolean(linkFileId)}
        fileIds={linkFileId ? [linkFileId] : []}
        types={types}
        onClose={() => setLinkFileId(null)}
        onApplied={() => { if (linkFileId) void refreshRowLinks(linkFileId); }}
      />
    </div>
  );
}
