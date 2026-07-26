// Marketing Content Intelligence — admin workspace over the content-understanding
// pipeline. Per collected item: media preview, transcript (+ timestamps), visual
// text/OCR, extracted prices/offers/locations, project attribution + evidence,
// processing status, and costs. Filters + overview metrics. All data comes from
// live production via /api/marketing content_* actions (admin-gated).
import { useCallback, useEffect, useState } from 'react';
import { RefreshCw, Play, Film, ImageIcon, Layers, FileText, MapPin, Tag, X, AlertTriangle } from 'lucide-react';
import { useAppStore } from '@/stores/appStore';
import BackToSettings from './components/BackToSettings';
import CampaignsPanel from './components/CampaignsPanel';
import {
  fetchOpsOrgHealth, fetchContentMetrics, fetchContentItems, runContentProcessing,
  type OpsOrgHealth, type ContentMetrics, type ContentItem,
} from '@/lib/marketing/client';

const STATUS_CLS: Record<string, string> = {
  processed: 'bg-green-100 text-green-800', partial: 'bg-amber-100 text-amber-800',
  failed: 'bg-red-100 text-red-800', processing: 'bg-blue-100 text-blue-800', collected: 'bg-charcoal/10 text-charcoal/60',
};
function TypeIcon({ t }: { t: string | null }) {
  if (['video', 'reel', 'short'].includes(t ?? '')) return <Film size={13} />;
  if (['carousel', 'sidecar', 'album'].includes(t ?? '')) return <Layers size={13} />;
  return <ImageIcon size={13} />;
}
function Metric({ label, value, tone }: { label: string; value: string | number; tone?: string }) {
  return <div className="card p-3"><div className="text-[11px] text-charcoal/50 mb-0.5">{label}</div><div className={`text-xl font-bold ${tone ?? 'text-copper'}`}>{value}</div></div>;
}

export default function ContentIntelligencePage() {
  const isAr = useAppStore((s) => s.language === 'ar');
  const addToast = useAppStore((s) => s.addToast);
  const L = (ar: string, en: string) => (isAr ? ar : en);

  const [orgs, setOrgs] = useState<OpsOrgHealth[]>([]);
  const [orgId, setOrgId] = useState('');
  const [metrics, setMetrics] = useState<ContentMetrics | null>(null);
  const [items, setItems] = useState<ContentItem[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [filters, setFilters] = useState<{ platform?: string; post_type?: string; processing_status?: string }>({});
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [detail, setDetail] = useState<ContentItem | null>(null);
  const [view, setView] = useState<'content' | 'campaigns'>('content');

  useEffect(() => { void fetchOpsOrgHealth().then((r) => { setOrgs(r.organizations); if (!orgId && r.organizations[0]) setOrgId(r.organizations[0].organization_id); }).catch(() => {}); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, []);

  const load = useCallback(async () => {
    if (!orgId) return;
    setLoading(true);
    try {
      const [m, it] = await Promise.all([fetchContentMetrics(orgId), fetchContentItems(orgId, { page, ...filters })]);
      setMetrics(m); setItems(it.items); setTotal(it.total);
    } catch (e) { addToast(e instanceof Error ? e.message : L('فشل التحميل', 'Load failed'), 'error'); }
    finally { setLoading(false); }
  }, [orgId, page, filters, addToast, isAr]);
  useEffect(() => { void load(); }, [load]);

  const onRun = async () => {
    if (!orgId) return; setBusy(true);
    try { const { enqueued } = await runContentProcessing(orgId, 50); addToast(L(`تمت جدولة معالجة ${enqueued} عنصرًا`, `Queued processing for ${enqueued} items`), 'success'); }
    catch (e) { addToast(e instanceof Error ? e.message : 'error', 'error'); }
    finally { setBusy(false); }
  };

  const orgName = (o: OpsOrgHealth) => (isAr ? (o.name_ar ?? o.name_en) : (o.name_en ?? o.name_ar)) ?? o.organization_id.slice(0, 8);
  const pages = Math.ceil(total / 24) || 1;

  return (
    <div className="max-w-6xl pb-16">
      <BackToSettings />
      <div className="flex items-center justify-between mb-5 flex-wrap gap-3">
        <div className="flex items-center gap-3">
          <div className="w-11 h-11 rounded-2xl bg-copper/10 flex items-center justify-center"><Film size={22} className="text-copper" /></div>
          <div>
            <h1 className="text-xl font-bold text-charcoal">{L('ذكاء المحتوى', 'Content Intelligence')}</h1>
            <div className="text-xs text-charcoal/40">{L('الوسائط، النصوص المنطوقة، النص المرئي، والإسناد لكل منشور', 'Media, transcripts, visual text, and attribution per post')}</div>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <select value={orgId} onChange={(e) => { setOrgId(e.target.value); setPage(1); }} className="text-xs border border-sand rounded-lg px-2 py-1.5 bg-white max-w-[200px]">
            {orgs.map((o) => <option key={o.organization_id} value={o.organization_id}>{orgName(o)}</option>)}
          </select>
          <button type="button" onClick={() => load()} className="inline-flex items-center gap-1.5 text-xs px-3 py-1.5 rounded-lg bg-copper/10 text-copper hover:bg-copper/20"><RefreshCw size={14} /> {L('تحديث', 'Refresh')}</button>
          <button type="button" onClick={onRun} disabled={busy || !orgId} className="inline-flex items-center gap-1.5 text-xs px-3 py-1.5 rounded-lg bg-chocolate text-white hover:bg-chocolate/90 disabled:opacity-50"><Play size={14} /> {L('معالجة المحتوى', 'Process content')}</button>
        </div>
      </div>

      <div className="flex gap-1 mb-4 border-b border-sand/50">
        {(['content', 'campaigns'] as const).map((v) => (
          <button key={v} type="button" onClick={() => setView(v)} className={`px-4 py-2 text-sm font-medium -mb-px border-b-2 ${view === v ? 'border-copper text-copper' : 'border-transparent text-charcoal/50 hover:text-charcoal'}`}>
            {v === 'content' ? L('المحتوى', 'Content') : L('الحملات', 'Campaigns')}
          </button>
        ))}
      </div>

      {view === 'campaigns' ? (orgId ? <CampaignsPanel orgId={orgId} /> : null) : (
      <>
      {metrics && (
        <div className="grid grid-cols-3 md:grid-cols-6 gap-2 mb-4">
          <Metric label={L('إجمالي', 'Total')} value={metrics.total} />
          <Metric label={L('فيديو', 'Videos')} value={metrics.videos} />
          <Metric label={L('صور', 'Images')} value={metrics.images} />
          <Metric label={L('ألبومات', 'Carousels')} value={metrics.carousels} />
          <Metric label={L('مُعالَج', 'Processed')} value={metrics.processed} tone={metrics.processed ? 'text-green-600' : 'text-charcoal/40'} />
          <Metric label={L('منقوص/فشل', 'Partial/Failed')} value={`${metrics.partial}/${metrics.failed}`} tone={metrics.failed ? 'text-red-600' : 'text-amber-600'} />
          <Metric label={L('وسائط مخزّنة', 'Media stored')} value={metrics.media_stored} />
          <Metric label={L('نجاح التخزين', 'Store rate')} value={metrics.media_success_rate != null ? `${Math.round(metrics.media_success_rate * 100)}%` : '—'} />
          <Metric label={L('مُفرّغ صوتيًا', 'Transcribed')} value={metrics.transcribed} />
          <Metric label={L('مُسنَد', 'Attributed')} value={metrics.attributed} tone="text-copper" />
          <Metric label={L('غير مُسنَد', 'Unattributed')} value={metrics.unattributed} />
          <Metric label={L('التكلفة', 'Cost')} value={`$${metrics.cost_usd.toFixed(3)}`} />
        </div>
      )}

      <div className="flex gap-2 mb-3 flex-wrap">
        {([['platform', ['instagram', 'tiktok', 'youtube']], ['post_type', ['reel', 'video', 'image', 'carousel']], ['processing_status', ['processed', 'partial', 'failed', 'collected']]] as const).map(([key, opts]) => (
          <select key={key} value={(filters as Record<string, string>)[key] ?? ''} onChange={(e) => { setFilters((f) => ({ ...f, [key]: e.target.value || undefined })); setPage(1); }} className="text-xs border border-sand rounded-lg px-2 py-1 bg-white">
            <option value="">{L('كل', 'All')} {key.replace('_', ' ')}</option>
            {opts.map((o) => <option key={o} value={o}>{o}</option>)}
          </select>
        ))}
      </div>

      {loading ? <div className="text-sm text-charcoal/40">{L('جارٍ التحميل…', 'Loading…')}</div> : items.length === 0 ? (
        <div className="text-sm text-charcoal/40">{L('لا محتوى — شغّل المعالجة.', 'No content — run processing.')}</div>
      ) : (
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
          {items.map((it) => {
            const enr = it.mkt_content_enrichment?.[0];
            const tx = it.mkt_transcripts?.find((t) => t.status === 'done');
            const thumb = it.mkt_content_media?.find((m) => m.media_kind === 'thumbnail' && m.stored_url)?.stored_url
              ?? it.mkt_content_media?.find((m) => m.media_kind === 'image' && m.stored_url)?.stored_url ?? it.thumbnail_ref;
            return (
              <button key={it.id} type="button" onClick={() => setDetail(it)} className="card p-0 overflow-hidden text-start hover:ring-2 hover:ring-copper/30 transition">
                <div className="aspect-square bg-charcoal/5 relative">
                  {thumb ? <img src={thumb} alt="" loading="lazy" className="w-full h-full object-cover" /> : <div className="w-full h-full flex items-center justify-center text-charcoal/20"><TypeIcon t={it.post_type} /></div>}
                  <span className={`absolute top-1.5 start-1.5 px-1.5 py-0.5 rounded-full text-[10px] ${STATUS_CLS[it.processing_status] ?? ''}`}>{it.processing_status}</span>
                  <span className="absolute top-1.5 end-1.5 bg-black/50 text-white rounded-full p-1"><TypeIcon t={it.post_type} /></span>
                </div>
                <div className="p-2">
                  <div className="text-[11px] text-charcoal/60 line-clamp-2 min-h-[28px]">{it.caption?.slice(0, 90) || '—'}</div>
                  <div className="flex flex-wrap gap-1 mt-1">
                    {tx && <span className="text-[9px] px-1 py-0.5 rounded bg-blue-50 text-blue-700 flex items-center gap-0.5"><FileText size={9} /> {tx.language ?? 'ar'}</span>}
                    {enr?.primary_project_id && <span className="text-[9px] px-1 py-0.5 rounded bg-copper/10 text-copper flex items-center gap-0.5"><Tag size={9} /> {L('مشروع', 'project')}</span>}
                    {typeof (enr?.result as Record<string, unknown>)?.offer === 'string' && <span className="text-[9px] px-1 py-0.5 rounded bg-amber-50 text-amber-700">{L('عرض', 'offer')}</span>}
                  </div>
                </div>
              </button>
            );
          })}
        </div>
      )}

      {pages > 1 && (
        <div className="flex items-center justify-center gap-2 mt-4 text-sm">
          <button type="button" disabled={page <= 1} onClick={() => setPage((p) => p - 1)} className="px-3 py-1 rounded bg-sand/30 disabled:opacity-40">{L('السابق', 'Prev')}</button>
          <span className="text-charcoal/50">{page} / {pages}</span>
          <button type="button" disabled={page >= pages} onClick={() => setPage((p) => p + 1)} className="px-3 py-1 rounded bg-sand/30 disabled:opacity-40">{L('التالي', 'Next')}</button>
        </div>
      )}

      {detail && <DetailModal item={detail} onClose={() => setDetail(null)} L={L} />}
      </>
      )}
    </div>
  );
}

function DetailModal({ item, onClose, L }: { item: ContentItem; onClose: () => void; L: (ar: string, en: string) => string }) {
  const enr = item.mkt_content_enrichment?.[0];
  const result = (enr?.result ?? {}) as Record<string, unknown>;
  const media = (item.mkt_content_media ?? []).filter((m) => m.stored_url).sort((a, b) => a.carousel_index - b.carousel_index);
  const struct = (item.mkt_visual_text ?? []).map((v) => v.structured as Record<string, unknown>);
  const collect = (k: string) => [...new Set(struct.flatMap((s) => (Array.isArray(s[k]) ? (s[k] as string[]) : [])))].filter(Boolean);
  // Attribution used to render as a bare UUID prefix, which made it impossible
  // to tell WHICH project a post had been attributed to — the one thing a
  // reviewer is here to check. The narrowing step already stored each
  // candidate's names on the enrichment row, and the primary is always chosen
  // from that list, so the name resolves locally. A manual re-assignment to a
  // project outside the candidate set still falls back to the id.
  const projectName = (id: string): string => {
    const c = (enr?.candidate_projects ?? []).find((x) => x.projectId === id);
    return (L(c?.nameAr ?? '', c?.nameEn ?? '') || c?.nameEn || c?.nameAr) ?? `${id.slice(0, 8)}…`;
  };
  return (
    <div className="fixed inset-0 bg-black/50 z-50 flex items-center justify-center p-4" onClick={onClose}>
      <div className="bg-cream rounded-2xl max-w-3xl w-full max-h-[88vh] overflow-y-auto" onClick={(e) => e.stopPropagation()}>
        <div className="sticky top-0 bg-cream border-b border-sand/50 px-4 py-3 flex items-center justify-between">
          <div className="text-sm font-semibold text-charcoal flex items-center gap-2"><TypeIcon t={item.post_type} /> {item.platform} · {item.post_type} · <span className={`px-1.5 py-0.5 rounded-full text-[10px] ${STATUS_CLS[item.processing_status] ?? ''}`}>{item.processing_status}</span></div>
          <button type="button" onClick={onClose} className="text-charcoal/50 hover:text-charcoal"><X size={18} /></button>
        </div>
        <div className="p-4 space-y-4">
          {media.length > 0 && (
            <div className="grid grid-cols-3 gap-2">
              {media.map((m) => (
                <div key={m.id} className="aspect-square bg-charcoal/5 rounded-lg overflow-hidden relative">
                  {m.media_kind === 'video' ? <video src={m.stored_url ?? ''} controls className="w-full h-full object-cover" /> : <img src={m.stored_url ?? ''} alt="" className="w-full h-full object-cover" />}
                  <span className="absolute bottom-1 start-1 bg-black/50 text-white text-[9px] px-1 rounded">{m.media_kind}{m.duration_ms ? ` ${Math.round(m.duration_ms / 1000)}s` : ''}</span>
                </div>
              ))}
            </div>
          )}
          {item.mkt_content_media?.some((m) => m.download_status === 'failed') && (
            <div className="text-xs text-red-700 flex items-center gap-1"><AlertTriangle size={13} /> {L('فشل تنزيل بعض الوسائط', 'Some media failed to download')}: {item.mkt_content_media.filter((m) => m.download_status === 'failed').map((m) => m.failure_reason).join('; ')}</div>
          )}
          {item.caption && <div><div className="text-[11px] text-charcoal/40 mb-1">{L('التعليق', 'Caption')}</div><div className="text-sm text-charcoal/80 whitespace-pre-wrap">{item.caption}</div></div>}

          {item.mkt_transcripts?.filter((t) => t.status === 'done').map((t) => (
            <div key={t.id}>
              <div className="text-[11px] text-charcoal/40 mb-1 flex items-center gap-1"><FileText size={12} /> {L('النص المنطوق', 'Transcript')} · {t.language ?? '—'}</div>
              <div className="text-sm text-charcoal/80 bg-white rounded-lg p-2 max-h-40 overflow-y-auto whitespace-pre-wrap">{t.text || '—'}</div>
              {t.segments?.length > 0 && <div className="text-[10px] text-charcoal/40 mt-1">{t.segments.length} {L('مقطع زمني', 'timed segments')}</div>}
            </div>
          ))}
          {item.mkt_transcripts?.some((t) => t.status === 'failed') && <div className="text-xs text-red-700">{L('فشل التفريغ الصوتي', 'Transcription failed')}</div>}

          {(item.mkt_visual_text?.length ?? 0) > 0 && (
            <div>
              <div className="text-[11px] text-charcoal/40 mb-1">{L('النص المرئي (OCR)', 'Visual text (OCR)')}</div>
              <div className="text-sm text-charcoal/70 bg-white rounded-lg p-2 max-h-32 overflow-y-auto">{item.mkt_visual_text.map((v) => v.text).filter(Boolean).join(' · ') || '—'}</div>
              <div className="flex flex-wrap gap-1 mt-2">
                {(['prices', 'offers', 'payment_plans', 'unit_types', 'districts', 'phones', 'urls'] as const).flatMap((k) => collect(k).map((v) => <span key={k + v} className="text-[10px] px-1.5 py-0.5 rounded bg-copper/10 text-copper">{v}</span>))}
              </div>
            </div>
          )}

          <div className="grid grid-cols-2 gap-3">
            <div>
              <div className="text-[11px] text-charcoal/40 mb-1 flex items-center gap-1"><Tag size={12} /> {L('الإسناد', 'Attribution')}</div>
              {enr?.primary_project_id ? <div className="text-sm text-copper font-medium">{L('مشروع رئيسي', 'Primary project')}: {projectName(enr.primary_project_id)}</div> : <div className="text-sm text-charcoal/40">{L('محتوى علامة عام (غير مُسنَد)', 'General branding (unattributed)')}</div>}
              {(item.mkt_content_attributions ?? []).map((a, i) => <div key={i} className="text-[11px] text-charcoal/50">{projectName(a.project_id)} · {Math.round(a.confidence * 100)}%</div>)}
            </div>
            <div>
              <div className="text-[11px] text-charcoal/40 mb-1 flex items-center gap-1"><MapPin size={12} /> {L('الإثراء', 'Enrichment')}</div>
              {(['content_type', 'objective', 'offer', 'price', 'payment_plan', 'district', 'campaign_message'] as const).map((k) => typeof result[k] === 'string' && result[k] ? <div key={k} className="text-[11px] text-charcoal/60"><b>{k}:</b> {String(result[k])}</div> : null)}
            </div>
          </div>
          <div className="text-[10px] text-charcoal/30">{item.post_url && <a href={item.post_url} target="_blank" rel="noreferrer" className="text-copper hover:underline">{L('المنشور الأصلي', 'original post')} ↗</a>}</div>
        </div>
      </div>
    </div>
  );
}
