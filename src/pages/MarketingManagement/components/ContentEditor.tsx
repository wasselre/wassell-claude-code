/**
 * Where the work is actually written.
 *
 * Field order is deliberate: THE MESSAGE comes first. An earlier version laid
 * all twenty fields out in one flat grid, so the hook and the main idea — the
 * only fields that decide whether the content is any good — sat below eight
 * admin dropdowns with identical visual weight. Planning and team metadata now
 * live in groups below the creative work, and the groups a person rarely opens
 * start collapsed.
 *
 * Fields save on blur, per field, and confirm. Status is NOT editable here: it
 * moves through the transition buttons, which offer only the moves the database
 * will actually accept.
 */
import { useEffect, useMemo, useState } from 'react';
import { FileText, Plus, Lock, ChevronDown, Send, Check } from 'lucide-react';
import Button from '@/components/ui/Button';
import { useAppStore } from '@/stores/appStore';
import { Section, EmptyHint, fmtDate } from '@/pages/MarketingIntelligence/components/shared';
import { useProjectOptions, useOurProjectOptions } from '@/lib/marketingMgmt/projects';
import { ProjectSelect } from './portfolio/ProjectPicker';
import {
  CONTENT_TYPE_LABEL, PURPOSE_LABEL, PRIORITY_LABEL, ORGANIC_PAID_LABEL,
  FUNNEL_STAGE_LABEL, CTA_DESTINATION_LABEL, LANGUAGE_LABEL, PLATFORM_LABEL,
  VERSION_TYPE_LABEL, ASSET_TYPE_LABEL, lbl,
} from '@/lib/marketingMgmt/labels';
import {
  updateContent, createVersion, transitionContent, fetchCampaigns, setPlatforms,
  CONTENT_TYPES, PLATFORMS, type ContentItem, type ContentVersion, type Campaign,
} from '@/lib/marketingMgmt/client';

type AssetLink = { asset_id: string; mkt_raw_assets: Record<string, unknown> | null };

const PURPOSES = Object.keys(PURPOSE_LABEL);
const PRIORITIES = ['low', 'normal', 'high', 'urgent'];
const ORGANIC_PAID = Object.keys(ORGANIC_PAID_LABEL);
const FUNNEL_STAGES = Object.keys(FUNNEL_STAGE_LABEL);
const CTA_DESTINATIONS = Object.keys(CTA_DESTINATION_LABEL);

const FIELD = 'w-full rounded-lg border border-sand/60 bg-white px-2.5 py-1.5 text-[12.5px] '
  + 'text-charcoal transition-colors focus:border-copper focus:outline-none';

/** A labelled group of fields; the rarely-opened ones start collapsed. */
function Group({ title, hint, defaultOpen = true, children }: {
  title: string; hint?: string; defaultOpen?: boolean; children: React.ReactNode;
}) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div className="rounded-xl border border-sand/50 bg-white/60">
      <button type="button" onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center justify-between gap-2 px-3 py-2 text-start">
        <span className="min-w-0">
          <span className="block text-[12.5px] font-semibold text-charcoal">{title}</span>
          {hint && <span className="block text-[11px] text-charcoal/45">{hint}</span>}
        </span>
        <ChevronDown className={`h-4 w-4 shrink-0 text-charcoal/35 transition-transform ${open ? 'rotate-180' : ''}`} />
      </button>
      {open && <div className="grid gap-3 border-t border-sand/40 p-3 sm:grid-cols-2 lg:grid-cols-3">{children}</div>}
    </div>
  );
}

export function ContentFields({ item, assets, isAr, onSaved, onError }: {
  item: ContentItem; assets: AssetLink[]; isAr: boolean;
  /** Receives the UPDATED row so the page can merge it without refetching
   *  content_detail — eleven queries per blur is what made typing feel like a
   *  reload. */
  onSaved: (updated: ContentItem) => void;
  onError: (m: string) => void;
}) {
  const users = useAppStore((s) => s.users);
  // Two lists on purpose: `ourProjects` is what may be CHOSEN, `projects` is
  // every project and is used only to NAME a value the record already holds
  // and to derive its developer. Narrowing the resolver too would make an
  // item linked to a market project read as "no project".
  const ourProjects = useOurProjectOptions();
  const projects = useProjectOptions();
  const [campaigns, setCampaigns] = useState<Campaign[]>([]);
  // In-flight and just-saved fields, NOT one global "busy". An earlier version
  // disabled every input while any save ran, so tabbing to the next field while
  // the first was saving silently dropped the second edit.
  const [saving, setSaving] = useState<ReadonlySet<string>>(new Set());
  const [saved, setSaved] = useState<ReadonlySet<string>>(new Set());

  useEffect(() => { fetchCampaigns(200).then((r) => setCampaigns(r.campaigns)).catch(() => {}); }, []);

  const save = async (patch: Record<string, unknown>, key: string) => {
    setSaving((s) => new Set(s).add(key));
    try {
      const r = await updateContent(item.id, patch);
      onSaved(r.item);
      // Confirm rather than just stopping: a spinner that vanishes is
      // indistinguishable from a save that never happened.
      setSaved((s) => new Set(s).add(key));
      setTimeout(() => setSaved((s) => { const n = new Set(s); n.delete(key); return n; }), 2000);
    } catch (e) { onError(e instanceof Error ? e.message : String(e)); }
    finally { setSaving((s) => { const n = new Set(s); n.delete(key); return n; }); }
  };

  const personName = (u: { name_ar: string; name_en: string }) =>
    (isAr ? u.name_ar : u.name_en) || u.name_en || u.name_ar;

  const F = (key: string, label: string, node: React.ReactNode, span = '') => (
    <label className={`block ${span}`}>
      <span className="mb-1 flex items-center gap-1 text-[11px] font-medium text-charcoal/55">
        {label}
        {saving.has(key) && <span className="text-copper">•</span>}
        {saved.has(key) && <Check className="h-3 w-3 text-emerald-600" />}
      </span>
      {node}
    </label>
  );

  const text = (key: string, label: string, value: string | null | undefined, col: string,
                placeholder: string, span = '') =>
    F(key, label, <input defaultValue={value ?? ''} className={FIELD} placeholder={placeholder}
      onBlur={(e) => { const v = e.target.value.trim(); if (v !== (value ?? '')) void save({ [col]: v || null }, key); }} />, span);

  const area = (key: string, label: string, value: string | null | undefined, col: string,
                placeholder: string, rows = 3, span = 'sm:col-span-2 lg:col-span-3') =>
    F(key, label, <textarea defaultValue={value ?? ''} rows={rows} className={FIELD} placeholder={placeholder}
      onBlur={(e) => { const v = e.target.value.trim(); if (v !== (value ?? '')) void save({ [col]: v || null }, key); }} />, span);

  const enumSel = (key: string, label: string, value: string | null | undefined, col: string,
                   keys: string[], map: Record<string, { ar: string; en: string }>, allowEmpty = true) =>
    F(key, label,
      <select defaultValue={value ?? ''} className={FIELD}
        onChange={(e) => void save({ [col]: e.target.value || null }, key)}>
        {allowEmpty && <option value="">{isAr ? '— غير محدد —' : '— not set —'}</option>}
        {keys.map((k) => <option key={k} value={k}>{lbl(map, k, isAr)}</option>)}
      </select>);

  const userSel = (key: string, label: string, value: string | null | undefined, col: string) =>
    F(key, label,
      <select defaultValue={value ?? ''} className={FIELD}
        onChange={(e) => void save({ [col]: e.target.value || null }, key)}>
        <option value="">{isAr ? '— غير محدد —' : '— unassigned —'}</option>
        {users.map((u) => <option key={u.id} value={u.id}>{personName(u)}</option>)}
      </select>);

  // ── platforms: a set, toggled as chips ────────────────────────────────────
  const current = useMemo(
    () => new Set((item.mkt_content_platforms ?? []).map((p) => p.platform)),
    [item.mkt_content_platforms],
  );
  const togglePlatform = async (p: string) => {
    const next = new Set(current);
    if (next.has(p)) next.delete(p); else next.add(p);
    setSaving((s) => new Set(s).add('platforms'));
    // setPlatforms returns the platform list, not the row — so hand the page the
    // item with exactly what the server now holds. Still no refetch.
    try {
      await setPlatforms(item.id, [...next]);
      onSaved({ ...item, mkt_content_platforms: [...next].map((platform) => ({ platform })) });
    }
    catch (e) { onError(e instanceof Error ? e.message : String(e)); }
    finally { setSaving((s) => { const n = new Set(s); n.delete('platforms'); return n; }); }
  };

  const selectedProject = projects.find((p) => p.id === item.project_id) ?? null;

  return (
    <div className="space-y-3">
      {/* 1 — the actual creative work, first and widest */}
      <Group title={isAr ? 'الرسالة' : 'The message'}
        hint={isAr ? 'ما نقوله، وكيف نقوله' : 'What we say, and how we say it'}>
        {area('hook', isAr ? 'الخطاف (أول 3 ثوانٍ)' : 'Hook (first 3 seconds)', item.hook, 'hook',
          isAr ? 'ما الذي يوقف التمرير؟' : 'What stops the scroll?', 2)}
        {area('idea', isAr ? 'الفكرة الرئيسية' : 'Main idea', item.main_idea, 'main_idea',
          isAr ? 'الرسالة الواحدة التي يجب أن تصل' : 'The one message this must land', 3)}
        {area('angle', isAr ? 'زاوية الطرح' : 'Content angle', item.content_angle, 'content_angle',
          isAr ? 'كيف نقولها — الزاوية أو المدخل' : 'How we say it — the angle or hook we take', 2)}
        {area('offer', isAr ? 'العرض أو خطة السداد' : 'Offer / payment plan', item.offer_message, 'offer_message',
          isAr ? 'الخصم، خطة السداد، شروط التسليم — ما يراجعه قسم المبيعات'
               : 'Discount, payment plan, handover terms — what Sales must check', 2)}
        {area('caption', isAr ? 'التعليق المنشور' : 'Published caption', item.caption, 'caption',
          isAr ? 'النص الذي سيُنشر فعلياً' : 'The text that will actually be posted', 4)}
        {text('cta', isAr ? 'دعوة الإجراء' : 'Call to action', item.cta, 'cta',
          isAr ? 'مثال: احجز جولة' : 'e.g. Book a tour')}
        {enumSel('cta_dest', isAr ? 'وجهة الدعوة' : 'CTA destination', item.cta_destination,
          'cta_destination', CTA_DESTINATIONS, CTA_DESTINATION_LABEL)}
        {text('tracking', isAr ? 'رابط التتبع' : 'Tracking link', item.tracking_link, 'tracking_link',
          'https://wa.me/…  ·  utm_…')}
        {F('hashtags', isAr ? 'الوسوم' : 'Hashtags',
          <input defaultValue={(item.hashtags ?? []).join(' ')} className={FIELD} placeholder="#وصل #الرياض"
            onBlur={(e) => void save({ hashtags: e.target.value.split(/\s+/).map((h) => h.trim()).filter(Boolean) }, 'hashtags')} />,
          'sm:col-span-2')}
      </Group>

      {/* 2 — marketing direction */}
      <Group title={isAr ? 'التوجيه التسويقي' : 'Marketing direction'}
        hint={isAr ? 'لأي مشروع، لأي مرحلة، وعلى أي منصة' : 'Which project, which funnel stage, which platforms'}>
        {F('project', isAr ? 'المشروع' : 'Project',
          <ProjectSelect options={ourProjects} resolve={(id) => projects.find((p) => p.id === id)}
            value={item.project_id ?? null} isAr={isAr}
            onChange={(id) => void save({ project_id: id }, 'project')} />)}
        {/* Derived, never stored: the project stays the source of truth. */}
        {F('developer', isAr ? 'المطوّر' : 'Developer',
          <div className={`${FIELD} flex items-center bg-cream-light text-charcoal/70`}>
            {selectedProject
              ? (selectedProject.developer ?? (isAr ? 'غير محدد في المشروع' : 'not set on the project'))
              : <span className="text-charcoal/35">{isAr ? 'اختر مشروعاً أولاً' : 'pick a project first'}</span>}
          </div>)}
        {F('campaign', isAr ? 'الحملة' : 'Campaign',
          <select defaultValue={item.campaign_id ?? ''} className={FIELD}
            onChange={(e) => void save({ campaign_id: e.target.value || null }, 'campaign')}>
            <option value="">{isAr ? '— بلا حملة —' : '— no campaign —'}</option>
            {campaigns.map((c) => (
              <option key={c.id} value={c.id}>{c.code} · {isAr ? c.name_ar : (c.name_en ?? c.name_ar)}</option>
            ))}
          </select>)}
        {enumSel('paid', isAr ? 'عضوي أم مدفوع' : 'Organic or paid', item.organic_or_paid,
          'organic_or_paid', ORGANIC_PAID, ORGANIC_PAID_LABEL)}
        {enumSel('funnel', isAr ? 'مرحلة القمع' : 'Funnel stage', item.funnel_stage,
          'funnel_stage', FUNNEL_STAGES, FUNNEL_STAGE_LABEL)}
        {enumSel('purpose', isAr ? 'الغرض' : 'Purpose', item.purpose, 'purpose', PURPOSES, PURPOSE_LABEL)}
        {text('audience', isAr ? 'الجمهور المستهدف' : 'Target audience', item.target_audience, 'target_audience',
          isAr ? 'مثال: مشترٍ أول، ٣٠–٤٥' : 'e.g. first-time buyer, 30–45', 'sm:col-span-2')}
        {text('pillar', isAr ? 'محور المحتوى' : 'Content pillar', item.content_pillar, 'content_pillar',
          isAr ? 'مثال: جولات الوحدات' : 'e.g. unit tours')}
        {F('platforms', isAr ? 'منصات النشر' : 'Target platforms',
          <div className="flex flex-wrap gap-1.5">
            {PLATFORMS.map((p) => {
              const on = current.has(p);
              return (
                <button key={p} type="button" onClick={() => void togglePlatform(p)}
                  className={`rounded-lg border px-2 py-1 text-[11.5px] transition-colors ${
                    on ? 'border-copper bg-copper/10 font-medium text-copper-500'
                       : 'border-sand/60 bg-white text-charcoal/55 hover:border-copper/40'}`}>
                  {lbl(PLATFORM_LABEL, p, isAr)}
                </button>
              );
            })}
          </div>, 'sm:col-span-2 lg:col-span-3')}
      </Group>

      {/* 3 — who and when */}
      <Group title={isAr ? 'الفريق والمواعيد' : 'Team and dates'} defaultOpen={false}>
        {userSel('owner', isAr ? 'المسؤول' : 'Owner', item.owner_user_id, 'owner_user_id')}
        {userSel('writer', isAr ? 'الكاتب' : 'Writer', item.writer_user_id, 'writer_user_id')}
        {userSel('designer', isAr ? 'المصمم' : 'Designer', item.designer_user_id, 'designer_user_id')}
        {userSel('editor', isAr ? 'المونتير' : 'Video editor', item.editor_user_id, 'editor_user_id')}
        {userSel('presenter', isAr ? 'مقدّم المحتوى' : 'Presenter', item.presenter_user_id, 'presenter_user_id')}
        {userSel('photographer', isAr ? 'المصوّر' : 'Photographer', item.photographer_user_id, 'photographer_user_id')}
        {F('due', isAr ? 'تاريخ الاستحقاق' : 'Due date',
          <input type="date" defaultValue={item.due_date ?? ''} className={FIELD}
            onChange={(e) => void save({ due_date: e.target.value || null }, 'due')} />)}
        {F('planned', isAr ? 'تاريخ النشر المخطط' : 'Planned publish',
          <input type="datetime-local" className={FIELD}
            defaultValue={item.planned_publish_at ? item.planned_publish_at.slice(0, 16) : ''}
            onChange={(e) => void save({ planned_publish_at: e.target.value ? new Date(e.target.value).toISOString() : null }, 'planned')} />)}
        {enumSel('priority', isAr ? 'الأولوية' : 'Priority', item.priority, 'priority', PRIORITIES, PRIORITY_LABEL, false)}
      </Group>

      {/* 4 — format, references, deliverable */}
      <Group title={isAr ? 'الصيغة والمراجع' : 'Format and references'} defaultOpen={false}>
        {enumSel('type', isAr ? 'النوع' : 'Type', item.content_type, 'content_type',
          [...CONTENT_TYPES], CONTENT_TYPE_LABEL, false)}
        {enumSel('language', isAr ? 'اللغة' : 'Language', item.language, 'language',
          ['ar', 'en', 'both'], LANGUAGE_LABEL, false)}
        {F('final_asset', isAr ? 'الملف النهائي' : 'Final asset',
          <select defaultValue={item.final_asset_id ?? ''} className={FIELD}
            onChange={(e) => void save({ final_asset_id: e.target.value || null }, 'final_asset')}>
            <option value="">{isAr ? '— لم يُحدد —' : '— not set —'}</option>
            {assets.map((a) => {
              const raw = a.mkt_raw_assets ?? {};
              const name = String(raw.asset_name ?? a.asset_id);
              const kind = lbl(ASSET_TYPE_LABEL, String(raw.asset_type ?? ''), isAr);
              return <option key={a.asset_id} value={a.asset_id}>{name} · {kind}</option>;
            })}
          </select>)}
        {assets.length === 0 && (
          <p className="text-[11px] text-charcoal/45 sm:col-span-2 lg:col-span-3">
            {isAr ? 'لا مواد مرتبطة بعد — اربط ملفاً من تبويب المواد الخام ليظهر هنا.'
                  : 'No linked assets yet — link one from the Raw Assets tab and it appears here.'}
          </p>
        )}
        {/* text[] — split on save, not a plain text column */}
        {F('refs', isAr ? 'مراجع وروابط' : 'References & links',
          <textarea defaultValue={(item.reference_links ?? []).join('\n')} rows={2} className={FIELD}
            placeholder={isAr ? 'رابط في كل سطر' : 'One link per line'}
            onBlur={(e) => void save(
              { reference_links: e.target.value.split('\n').map((x) => x.trim()).filter(Boolean) }, 'refs')} />,
          'sm:col-span-2 lg:col-span-3')}
        {area('notes', isAr ? 'ملاحظات الإنتاج' : 'Production notes', item.production_notes, 'production_notes',
          isAr ? 'أي شيء يحتاجه المنفّذ' : 'Anything the producer needs to know', 2)}
      </Group>
    </div>
  );
}

// ── Versions: where drafts get written ──────────────────────────────────────
const WRITABLE = ['brief', 'script', 'caption', 'post_design', 'carousel_design', 'final'];

export function VersionWriter({ item, versions, isAr, onChanged, onError }: {
  item: ContentItem; versions: ContentVersion[]; isAr: boolean;
  onChanged: () => void; onError: (m: string) => void;
}) {
  const [type, setType] = useState('brief');
  const [body, setBody] = useState('');
  const [summary, setSummary] = useState('');
  const [busy, setBusy] = useState(false);
  const [openId, setOpenId] = useState<string | null>(null);

  const latest = useMemo(() => {
    const m = new Map<string, ContentVersion>();
    for (const v of versions) {
      const prev = m.get(v.version_type);
      if (!prev || v.version_number > prev.version_number) m.set(v.version_type, v);
    }
    return m;
  }, [versions]);

  const write = async () => {
    if (!body.trim()) return;
    setBusy(true);
    try {
      // A new draft is a NEW version — approved ones are locked, so editing in
      // place is impossible by design and the history stays intact.
      await createVersion(item.id, type, { body: body.trim() }, summary.trim() || undefined);
      setBody(''); setSummary(''); onChanged();
    } catch (e) { onError(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(false); }
  };

  // Requesting approval is a STATUS move; an approval row is written when
  // someone decides. The database owns which moves are legal.
  const requestApproval = async (v: ContentVersion) => {
    const to = v.version_type === 'brief' || v.version_type === 'script'
      ? 'awaiting_script_approval' : 'awaiting_final_approval';
    setBusy(true);
    try { await transitionContent(item.id, to); onChanged(); }
    catch (e) { onError(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(false); }
  };

  const cur = latest.get(type);

  return (
    <Section title={isAr ? 'الكتابة والنسخ' : 'Drafts & versions'}
      subtitle={isAr ? 'كل حفظ ينشئ نسخة جديدة — النسخ المعتمدة لا تُعدّل'
                     : 'Each save creates a new version — approved versions are never edited'}>
      <div className="mb-3 grid gap-2 sm:grid-cols-4">
        <select value={type} onChange={(e) => setType(e.target.value)} className={FIELD}>
          {WRITABLE.map((t) => <option key={t} value={t}>{lbl(VERSION_TYPE_LABEL, t, isAr)}</option>)}
        </select>
        <input value={summary} onChange={(e) => setSummary(e.target.value)} className={`${FIELD} sm:col-span-2`}
          placeholder={isAr ? 'ما الذي تغيّر؟ (اختياري)' : 'What changed? (optional)'} />
        <Button onClick={write} disabled={busy || !body.trim()}>
          <Plus className="h-4 w-4" />
          {isAr ? `حفظ نسخة ${(cur?.version_number ?? 0) + 1}` : `Save v${(cur?.version_number ?? 0) + 1}`}
        </Button>
      </div>

      <textarea value={body} onChange={(e) => setBody(e.target.value)} rows={8} className={FIELD}
        placeholder={isAr
          ? (type === 'brief' ? 'اكتب الموجز: لمن؟ ما الرسالة؟ ما المطلوب من المشاهد؟'
            : type === 'script' ? 'اكتب السيناريو الكامل — سطراً بسطر' : 'اكتب النص هنا…')
          : (type === 'brief' ? 'Write the brief: who is it for, what is the message, what should the viewer do?'
            : type === 'script' ? 'Write the full script, line by line' : 'Write here…')} />

      {cur && (
        <p className="mt-2 text-[11px] text-charcoal/45">
          {isAr ? `آخر نسخة محفوظة: ${cur.version_number} (${cur.approval_state})`
                : `Latest saved: v${cur.version_number} (${cur.approval_state})`}
        </p>
      )}

      <div className="mt-4">
        <h3 className="mb-2 text-[12px] font-semibold text-charcoal/70">{isAr ? 'المحفوظ' : 'Saved drafts'}</h3>
        {versions.length === 0 ? (
          <EmptyHint>{isAr ? 'لم يُكتب شيء بعد' : 'Nothing written yet'}</EmptyHint>
        ) : (
          <ul className="space-y-2">
            {versions.map((v) => {
              const open = openId === v.id;
              const text = String((v.payload as Record<string, unknown>)?.body ?? '');
              return (
                <li key={v.id} className="rounded-xl border border-sand/50 bg-white">
                  <div className="flex flex-wrap items-center gap-2 px-3 py-2">
                    <FileText className="h-3.5 w-3.5 shrink-0 text-charcoal/30" />
                    <button type="button" onClick={() => setOpenId(open ? null : v.id)}
                      className="min-w-0 flex-1 truncate text-start text-[12.5px] text-charcoal">
                      {lbl(VERSION_TYPE_LABEL, v.version_type, isAr)} v{v.version_number}
                      {v.change_summary && <span className="text-charcoal/40"> — {v.change_summary}</span>}
                    </button>
                    {v.is_locked ? (
                      <span className="inline-flex shrink-0 items-center gap-1 rounded-full border border-emerald-200 bg-emerald-50 px-2 py-0.5 text-[10.5px] text-emerald-700">
                        <Lock className="h-3 w-3" />{isAr ? 'معتمد' : 'approved'}
                      </span>
                    ) : (
                      <button type="button" disabled={busy} onClick={() => void requestApproval(v)}
                        className="shrink-0 text-[11.5px] font-medium text-copper hover:underline disabled:opacity-40">
                        <Send className="me-1 inline h-3 w-3" />{isAr ? 'أرسل للاعتماد' : 'Send for approval'}
                      </button>
                    )}
                    <ChevronDown className={`h-3.5 w-3.5 shrink-0 text-charcoal/30 transition-transform ${open ? 'rotate-180' : ''}`} />
                  </div>
                  {open && (
                    <div className="border-t border-sand/40 p-3">
                      <pre className="whitespace-pre-wrap break-words font-[inherit] text-[12.5px] leading-relaxed text-charcoal/80">
                        {text || (isAr ? '(فارغ)' : '(empty)')}
                      </pre>
                      <p className="mt-2 text-[10.5px] text-charcoal/40">{fmtDate(v.created_at, isAr)}</p>
                      {!v.is_locked && text && (
                        <button type="button"
                          onClick={() => { setType(v.version_type); setBody(text); setSummary(isAr ? `مبني على نسخة ${v.version_number}` : `based on v${v.version_number}`); }}
                          className="mt-2 text-[11.5px] font-medium text-copper hover:underline">
                          {isAr ? 'نسخ إلى المحرر كنسخة جديدة' : 'Copy into the editor as a new version'}
                        </button>
                      )}
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </Section>
  );
}
