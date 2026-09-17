/**
 * The new project-detail tabs (Phase 3 restructure): Files, Inventory Update,
 * Customer Demand, Website. Kept out of ProjectDetailPage.tsx to keep that file
 * readable. All read REAL records only — no fake data, no invented fields.
 */
import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  ExternalLink, FileText, Film, Image as ImageIcon, Globe, RefreshCw, Users,
  Eye, EyeOff, AlertTriangle, CheckCircle2, MapPin, ArrowLeftRight,
} from 'lucide-react';
import type { AppModel, AppRecord } from '@/types';
import { useAppStore } from '@/stores/appStore';
import Button from '@/components/ui/Button';
import {
  modelByName, fieldByCandidates, optionFor, asString, asFiniteNumber,
  type ProjectView,
} from '@/lib/projects/projectView';
import { auditProject } from '@/lib/projects/projectAi';
import RecordFilesPanel from '@/pages/Records/components/RecordFilesPanel';
import { recordFilesEnabled } from '@/lib/files/flags';
import { resolveClientView } from '@/pages/Clients/lib/clientView';
import { isActive, EMPTY_RELATED } from '@/pages/Sales/lib/salesClients';
import { emptyFollowupSummary } from '@/pages/Sales/lib/myWork';
import { getEntityFieldText, useRecordTranslationVersion } from '@/lib/recordTranslation/store';

// ── Files tab (replaces Media) ──────────────────────────────────────────────
// Two clearly-separated parts (decision #2, Option B): external URL media as
// links up top, then the central Files records below. External URLs are NEVER
// presented as managed files, and NOTHING is ingested or migrated here.

const isHttp = (u: unknown): u is string => typeof u === 'string' && /^https?:\/\//i.test(u);

export function FilesTab({ record, isAr }: { record: AppRecord; isAr: boolean }) {
  const d = (record.data ?? {}) as Record<string, unknown>;
  const images = Array.isArray(d.project_images) ? d.project_images.filter(isHttp) : [];
  const videos = Array.isArray(d.project_videos) ? d.project_videos.filter(isHttp) : [];
  const links: { icon: React.ReactNode; label: string; href: string }[] = [];
  if (asString(d.broucher_developer)) links.push({ icon: <FileText size={13} />, label: isAr ? 'بروشور المطور' : 'Developer brochure', href: asString(d.broucher_developer)! });
  if (asString(d.brochure_link)) links.push({ icon: <FileText size={13} />, label: isAr ? 'بروشورنا' : 'Our brochure', href: asString(d.brochure_link)! });
  if (asString(d.project_page_url)) links.push({ icon: <ExternalLink size={13} />, label: isAr ? 'صفحة المشروع (المطور)' : 'Developer project page', href: asString(d.project_page_url)! });

  const Chip = ({ icon, label, href }: { icon: React.ReactNode; label: string; href: string }) => (
    <a href={href} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg border border-sand/60 bg-white/70 text-sm text-charcoal/80 hover:border-copper/40 hover:text-copper transition-colors">
      {icon}<span className="truncate max-w-[16rem]">{label}</span>
    </a>
  );

  const hasExternal = images.length > 0 || videos.length > 0 || links.length > 0;

  return (
    <div className="space-y-5">
      {/* External links */}
      <section>
        <h3 className="text-[0.6875rem] font-bold text-charcoal/30 uppercase tracking-widest mb-2">
          {isAr ? 'روابط خارجية' : 'External links'}
        </h3>
        {!hasExternal ? (
          <div className="text-sm text-charcoal/40">{isAr ? 'لا توجد روابط خارجية.' : 'No external links.'}</div>
        ) : (
          <div className="flex flex-wrap gap-2">
            {links.map((l) => <Chip key={l.href} {...l} />)}
            {images.map((u, i) => <Chip key={`img${i}`} icon={<ImageIcon size={13} />} label={`${isAr ? 'صورة' : 'Image'} ${i + 1}`} href={u} />)}
            {videos.map((u, i) => <Chip key={`vid${i}`} icon={<Film size={13} />} label={`${isAr ? 'فيديو' : 'Video'} ${i + 1}`} href={u} />)}
          </div>
        )}
        <p className="text-[11px] text-charcoal/40 mt-2">
          {isAr ? 'روابط خارجية — ليست ملفات مُدارة في نظام الملفات.' : 'External links — not managed records in the Files system.'}
        </p>
      </section>

      {/* Managed Files (central Files system) */}
      <section>
        <h3 className="text-[0.6875rem] font-bold text-charcoal/30 uppercase tracking-widest mb-2">
          {isAr ? 'ملفات مُدارة' : 'Managed Files'}
        </h3>
        {recordFilesEnabled()
          ? <RecordFilesPanel modelId={record.model_id} recordId={record.id} />
          : <div className="text-sm text-charcoal/40">{isAr ? 'نظام الملفات غير مُفعّل.' : 'The Files system is not enabled.'}</div>}
      </section>
    </div>
  );
}

// ── Inventory Update tab (provisional, read-only) ───────────────────────────
// Real unit_updates facts for THIS project + a link into the Update Operations
// section. NO controls (decision #6).

export function InventoryUpdateTab({ project, isAr }: { project: ProjectView; isAr: boolean }) {
  const navigate = useNavigate();
  const { models, records } = useAppStore();
  const uModel = modelByName(models, 'unit_updates');
  const sourceField = fieldByCandidates(uModel, ['source_type']);
  const freqField = fieldByCandidates(uModel, ['update_frequency']);

  const rows = useMemo(() => {
    if (!uModel) return [];
    return (records[uModel.id] ?? []).filter((r) => {
      const raw = (r.data as Record<string, unknown> | undefined)?.project;
      const id = Array.isArray(raw) ? raw[0] : raw;
      return id === project.id;
    });
  }, [uModel, records, project.id]);

  const Fact = ({ label, value }: { label: string; value: React.ReactNode }) => (
    <div className="flex justify-between gap-3 py-1.5 border-b border-sand/30 text-sm">
      <span className="text-charcoal/50">{label}</span>
      <span className="text-charcoal font-medium text-end">{value}</span>
    </div>
  );
  const dash = isAr ? 'غير متوفر' : 'N/A';

  return (
    <div className="space-y-3 max-w-2xl">
      {rows.length === 0 ? (
        <div className="card p-8 text-center text-charcoal/45 text-sm">
          <RefreshCw size={20} className="mx-auto mb-2 opacity-40" />
          {isAr ? 'لا يوجد إعداد تحديث لهذا المشروع بعد.' : 'No update configuration for this project yet.'}
        </div>
      ) : rows.map((r) => {
        const d = (r.data ?? {}) as Record<string, unknown>;
        const src = optionFor(sourceField, d.source_type);
        const freq = optionFor(freqField, d.update_frequency);
        return (
          <div key={r.id} className="card p-4">
            <Fact label={isAr ? 'المصدر' : 'Source'} value={src ? (isAr ? src.label_ar : src.label_en) : (asString(d.source_type) ?? dash)} />
            <Fact label={isAr ? 'الدورية' : 'Frequency'} value={freq ? (isAr ? freq.label_ar : freq.label_en) : (asString(d.update_frequency) ?? dash)} />
            <Fact label={isAr ? 'آخر تحديث' : 'Last migrated'} value={asString(d.last_migrated_at) ?? dash} />
            <Fact label={isAr ? 'التحديث القادم' : 'Next due'} value={asString(d.next_due) ?? dash} />
            <Fact label={isAr ? 'الحالة' : 'Status'} value={d.is_active === true ? (isAr ? 'نشط' : 'Active') : (isAr ? 'متوقف' : 'Paused')} />
            {asString(d.source_url) && (
              <a href={asString(d.source_url)!} target="_blank" rel="noreferrer" className="text-copper hover:underline text-sm inline-flex items-center gap-1 mt-2"><ExternalLink size={13} /> {isAr ? 'رابط المصدر' : 'Source URL'}</a>
            )}
            {asString(d.migration_instructions) && (
              <div className="mt-2 text-xs text-charcoal/50 whitespace-pre-wrap border-t border-sand/30 pt-2">{asString(d.migration_instructions)}</div>
            )}
          </div>
        );
      })}
      <button onClick={() => navigate('/projects-inventory/updates')} className="text-sm text-copper hover:underline inline-flex items-center gap-1">
        <ArrowLeftRight size={14} /> {isAr ? 'فتح عمليات التحديث' : 'Open Update Operations'}
      </button>
      <p className="text-[11px] text-charcoal/40">
        {isAr ? 'عرض للقراءة فقط — الجدولة والتنفيذ الآلي يُصمَّمان لاحقاً.' : 'Read-only — scheduling and automated execution are designed later.'}
      </p>
    </div>
  );
}

// ── Customer Demand tab (deterministic) ─────────────────────────────────────
// Real, structured client preferences only. Active clients use the CANONICAL
// Sales resolver (isActive); a client is "interested in this project" when the
// project is in their preferred_projects OR the project's district is among
// their preferred districts. No AI, no off-plan facet (no such client field).

function fmtBudget(r: { min: number | null; max: number | null } | null, isAr: boolean): string | null {
  if (!r) return null;
  const f = (n: number) => n.toLocaleString(isAr ? 'ar-SA' : 'en-US');
  const sar = isAr ? 'ر.س' : 'SAR';
  if (r.min != null && r.max != null) return `${f(r.min)} – ${f(r.max)} ${sar}`;
  if (r.min != null) return `≥ ${f(r.min)} ${sar}`;
  if (r.max != null) return `≤ ${f(r.max)} ${sar}`;
  return null;
}

export function CustomerDemandTab({ view, isAr }: { view: ProjectView; isAr: boolean }) {
  const navigate = useNavigate();
  const { models, records, users } = useAppStore();
  const translationVersion = useRecordTranslationVersion();
  const clientsModel = modelByName(models, 'clients');

  const matched = useMemo(() => {
    if (!clientsModel) return [];
    const ctx = { models, records, users, language: (isAr ? 'ar' : 'en') as 'ar' | 'en', translate: getEntityFieldText };
    const projDistrict = (view.district ?? '').trim().toLowerCase();
    const out: { id: string; name: string | null; stage: string | null; status: string | null; budget: string | null; district: string | null; reason: string }[] = [];
    for (const rec of records[clientsModel.id] ?? []) {
      const cv = resolveClientView(rec, ctx);
      // Canonical active filter (reused, not reimplemented).
      if (!isActive({ view: cv, code: null, related: EMPTY_RELATED, followup: emptyFollowupSummary() })) continue;
      const inPreferred = cv.preferredProjects.some((p) => p.id === view.id);
      const districtNames = (cv.preferredDistrict ?? '').split(/،|,/).map((s) => s.trim().toLowerCase()).filter(Boolean);
      const inDistrict = !!projDistrict && districtNames.includes(projDistrict);
      if (!inPreferred && !inDistrict) continue;
      out.push({
        id: cv.id,
        name: cv.name,
        stage: cv.stage,
        status: cv.status,
        budget: fmtBudget(cv.budget, isAr),
        district: cv.preferredDistrict,
        reason: inPreferred ? (isAr ? 'في مشاريعه المفضلة' : 'In their preferred projects') : (isAr ? 'نفس الحي المطلوب' : 'Same requested district'),
      });
    }
    return out;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [clientsModel, models, records, users, isAr, view.id, view.district, translationVersion]);

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2">
        <Users size={18} className="text-copper" />
        <p className="text-sm text-charcoal/60">
          {isAr
            ? `عملاء نشطون طلبهم يتقاطع مع هذا المشروع (${matched.length}). مطابقة حتمية من التفضيلات المسجّلة — بدون ذكاء اصطناعي.`
            : `Active clients whose demand overlaps this project (${matched.length}). Deterministic match from recorded preferences — no AI.`}
        </p>
      </div>
      {matched.length === 0 ? (
        <div className="card p-8 text-center text-charcoal/45 text-sm">
          {isAr ? 'لا يوجد عملاء نشطون مطابقون حالياً.' : 'No matching active clients right now.'}
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
          {matched.map((c) => (
            <button key={c.id} onClick={() => navigate(`/model/clients/${c.id}`)} className="card p-3 text-start hover:border-copper/30 transition-all">
              <div className="flex items-center justify-between gap-2">
                <div className="font-bold text-charcoal text-sm truncate">{c.name ?? `#${c.id.slice(0, 8)}`}</div>
                <span className="text-[10px] px-1.5 py-0.5 rounded-full font-medium bg-copper/10 text-copper shrink-0">{c.reason}</span>
              </div>
              {(c.stage || c.status) && <div className="text-[11px] text-charcoal/45 mt-0.5 truncate">{[c.stage, c.status].filter(Boolean).join(' · ')}</div>}
              {c.budget && <div className="text-[11px] text-charcoal/55 mt-0.5">{isAr ? 'الميزانية: ' : 'Budget: '}{c.budget}</div>}
              {c.district && <div className="text-[11px] text-charcoal/45 mt-0.5 truncate inline-flex items-center gap-1"><MapPin size={10} /> {c.district}</div>}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

// ── Website tab (bridge; is_public is the sole publish authority) ────────────

export function WebsiteTab({
  view, record, portfolioRecord, isAr, onSaveMaster, onSavePortfolio,
}: {
  view: ProjectView;
  record: AppRecord;
  portfolioRecord: AppRecord | undefined;
  isAr: boolean;
  onSaveMaster: (data: Record<string, unknown>) => Promise<void>;
  onSavePortfolio?: (data: Record<string, unknown>) => Promise<void>;
}) {
  const navigate = useNavigate();
  const d = (record.data ?? {}) as Record<string, unknown>;
  const [isPublic, setIsPublic] = useState(d.is_public === true);
  const [order, setOrder] = useState(asFiniteNumber(portfolioRecord?.data?.website_display_order)?.toString() ?? '');
  const [busy, setBusy] = useState(false);

  // Website-content completeness = the deterministic publish blockers.
  const audit = auditProject(view, isAr);
  const blockers = audit.blockingWebsite;

  const savePublic = async (next: boolean) => {
    setBusy(true);
    setIsPublic(next);
    try { await onSaveMaster({ is_public: next }); } finally { setBusy(false); }
  };
  const saveOrder = async () => {
    if (!onSavePortfolio) return;
    setBusy(true);
    try { await onSavePortfolio({ website_display_order: order === '' ? null : Number(order) }); } finally { setBusy(false); }
  };

  return (
    <div className="space-y-4 max-w-2xl">
      <div className="card p-4">
        <div className="flex items-center justify-between gap-3">
          <div>
            <div className="font-bold text-charcoal inline-flex items-center gap-1.5">{isPublic ? <Eye size={15} className="text-green-600" /> : <EyeOff size={15} className="text-charcoal/40" />} {isAr ? 'منشور على الموقع' : 'Published on website'}</div>
            <div className="text-xs text-charcoal/45 mt-0.5">{isAr ? 'هذا هو مفتاح النشر الوحيد.' : 'This is the only publishing switch.'}</div>
          </div>
          <button
            role="switch"
            aria-checked={isPublic}
            disabled={busy}
            onClick={() => savePublic(!isPublic)}
            className={`relative w-12 h-6 rounded-full transition-colors shrink-0 ${isPublic ? 'bg-green-500' : 'bg-charcoal/20'} disabled:opacity-50`}
          >
            <span className={`absolute top-0.5 h-5 w-5 rounded-full bg-white transition-all ${isPublic ? 'start-6' : 'start-0.5'}`} />
          </button>
        </div>
      </div>

      {onSavePortfolio && (
        <div className="card p-4 flex items-end gap-3">
          <label className="text-sm flex-1">
            <span className="text-charcoal/60 block mb-1">{isAr ? 'ترتيب العرض على الموقع' : 'Website display order'}</span>
            <input type="number" className="form-input text-sm" value={order} onChange={(e) => setOrder(e.target.value)} onBlur={saveOrder} />
          </label>
        </div>
      )}

      <div className="card p-4">
        <div className="font-bold text-charcoal text-sm mb-2 inline-flex items-center gap-1.5">
          {blockers.length === 0 ? <CheckCircle2 size={15} className="text-green-600" /> : <AlertTriangle size={15} className="text-amber-500" />}
          {isAr ? 'اكتمال محتوى الموقع' : 'Website content completeness'}
        </div>
        {blockers.length === 0 ? (
          <p className="text-sm text-green-600">{isAr ? 'المحتوى الأساسي مكتمل.' : 'Essential content is complete.'}</p>
        ) : (
          <ul className="text-sm text-charcoal/70 space-y-1">
            {blockers.map((b, i) => <li key={i} className="flex items-center gap-1.5"><span className="w-1 h-1 rounded-full bg-amber-500" /> {b}</li>)}
          </ul>
        )}
      </div>

      <Button variant="secondary" onClick={() => navigate('/settings/website')}>
        <Globe size={14} className="inline -mt-0.5 me-1" /> {isAr ? 'الإدارة في إعدادات الموقع' : 'Manage in Website Management'}
      </Button>
    </div>
  );
}

export type { AppModel };
