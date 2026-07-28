/**
 * Where the work is actually written.
 *
 * The content item carries the PLAN — hook, main idea, CTA, caption, audience,
 * owners, dates. Versions carry the DRAFTS — brief, script, caption, design
 * notes — each one immutable once approved, which is why writing a new draft
 * creates a version rather than editing the last one in place.
 *
 * Fields save on blur, like the scene editor, so nothing is lost to a forgotten
 * Save button. Status is deliberately NOT editable here: it moves through the
 * transition buttons, because the database rejects invalid jumps and a plain
 * dropdown would invite them.
 */
import { useEffect, useMemo, useState } from 'react';
import { FileText, Plus, Lock, ChevronDown, Send } from 'lucide-react';
import Button from '@/components/ui/Button';
import { useAppStore } from '@/stores/appStore';
import { Section, EmptyHint, fmtDate } from '@/pages/MarketingIntelligence/components/shared';
import {
  updateContent, createVersion, transitionContent, fetchCampaigns,
  CONTENT_TYPES, type ContentItem, type ContentVersion, type Campaign,
} from '@/lib/marketingMgmt/client';

const PURPOSES = ['awareness','engagement','lead_generation','retargeting','branding',
  'education','conversion','project_launch','offer_promotion','investor'] as const;
const PRIORITIES = ['low','normal','high','urgent'] as const;

const L = {
  title:      { ar: 'العنوان', en: 'Title' },
  type:       { ar: 'النوع', en: 'Type' },
  priority:   { ar: 'الأولوية', en: 'Priority' },
  purpose:    { ar: 'الغرض', en: 'Purpose' },
  language:   { ar: 'اللغة', en: 'Language' },
  campaign:   { ar: 'الحملة', en: 'Campaign' },
  due:        { ar: 'تاريخ الاستحقاق', en: 'Due date' },
  planned:    { ar: 'تاريخ النشر المخطط', en: 'Planned publish' },
  owner:      { ar: 'المسؤول', en: 'Owner' },
  writer:     { ar: 'الكاتب', en: 'Writer' },
  designer:   { ar: 'المصمم', en: 'Designer' },
  editor:     { ar: 'المونتير', en: 'Video editor' },
  presenter:  { ar: 'مقدّم المحتوى', en: 'Presenter' },
  audience:   { ar: 'الجمهور المستهدف', en: 'Target audience' },
  pillar:     { ar: 'محور المحتوى', en: 'Content pillar' },
  hook:       { ar: 'الخطاف (أول 3 ثوانٍ)', en: 'Hook (first 3 seconds)' },
  idea:       { ar: 'الفكرة الرئيسية', en: 'Main idea' },
  cta:        { ar: 'دعوة الإجراء', en: 'Call to action' },
  caption:    { ar: 'التعليق المنشور', en: 'Published caption' },
  hashtags:   { ar: 'الوسوم (مفصولة بمسافة)', en: 'Hashtags (space separated)' },
  refs:       { ar: 'مراجع وروابط', en: 'References & links' },
  notes:      { ar: 'ملاحظات الإنتاج', en: 'Production notes' },
} as const;

export function ContentFields({ item, isAr, onSaved, onError }: {
  item: ContentItem; isAr: boolean; onSaved: () => void; onError: (m: string) => void;
}) {
  const users = useAppStore((s) => s.users);
  const [campaigns, setCampaigns] = useState<Campaign[]>([]);
  // In-flight fields, NOT a single global "busy". An earlier version disabled
  // every input while any save was in flight, so tabbing from one field to the
  // next while the first was still saving silently dropped the second edit —
  // the blur never reached a disabled input. Each save patches its own column,
  // so letting them overlap is both safe and what typing actually looks like.
  const [saving, setSaving] = useState<ReadonlySet<string>>(new Set());

  useEffect(() => { fetchCampaigns(200).then((r) => setCampaigns(r.campaigns)).catch(() => {}); }, []);

  const save = async (patch: Record<string, unknown>, label: string) => {
    setSaving((s) => new Set(s).add(label));
    try { await updateContent(item.id, patch); onSaved(); }
    catch (e) { onError(e instanceof Error ? e.message : String(e)); }
    finally { setSaving((s) => { const n = new Set(s); n.delete(label); return n; }); }
  };

  const lbl = (k: keyof typeof L) => (isAr ? L[k].ar : L[k].en);
  const person = (id: string | null) => users.find((u) => u.id === id);
  const personName = (u: { name_ar: string; name_en: string }) => (isAr ? u.name_ar : u.name_en) || u.name_en || u.name_ar;

  const field = 'w-full rounded-lg border border-sand/60 bg-white px-2.5 py-1.5 text-[12.5px] text-charcoal focus:border-copper focus:outline-none';
  const wrap = (k: keyof typeof L, node: React.ReactNode, span = '') => (
    <label className={`block ${span}`}>
      <span className="mb-1 block text-[11px] font-medium text-charcoal/55">
        {lbl(k)}{saving.has(k) && <span className="ms-1 text-copper">•</span>}
      </span>
      {node}
    </label>
  );

  const userSelect = (k: keyof typeof L, col: string, val: string | null) => wrap(k,
    <select defaultValue={val ?? ''} className={field}
      onChange={(e) => save({ [col]: e.target.value || null }, k)}>
      <option value="">{isAr ? '— غير محدد —' : '— unassigned —'}</option>
      {users.map((u) => <option key={u.id} value={u.id}>{personName(u)}</option>)}
    </select>);

  return (
    <Section title={isAr ? 'تفاصيل المحتوى' : 'Content details'}
      subtitle={isAr ? 'يُحفظ تلقائياً عند الخروج من الحقل' : 'Saves automatically when you leave a field'}>
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {wrap('title',
          <input defaultValue={item.title} className={field}
            onBlur={(e) => e.target.value.trim() && e.target.value !== item.title && save({ title: e.target.value.trim() }, 'title')} />,
          'sm:col-span-2')}

        {wrap('type',
          <select defaultValue={item.content_type} className={field}
            onChange={(e) => save({ content_type: e.target.value }, 'type')}>
            {CONTENT_TYPES.map((t) => <option key={t} value={t}>{t}</option>)}
          </select>)}

        {wrap('priority',
          <select defaultValue={item.priority} className={field}
            onChange={(e) => save({ priority: e.target.value }, 'priority')}>
            {PRIORITIES.map((p) => <option key={p} value={p}>{p}</option>)}
          </select>)}

        {wrap('purpose',
          <select defaultValue={item.purpose ?? ''} className={field}
            onChange={(e) => save({ purpose: e.target.value || null }, 'purpose')}>
            <option value="">{isAr ? '— غير محدد —' : '— none —'}</option>
            {PURPOSES.map((p) => <option key={p} value={p}>{p}</option>)}
          </select>)}

        {wrap('language',
          <select defaultValue={item.language} className={field}
            onChange={(e) => save({ language: e.target.value }, 'language')}>
            <option value="ar">{isAr ? 'عربي' : 'Arabic'}</option>
            <option value="en">{isAr ? 'إنجليزي' : 'English'}</option>
            <option value="both">{isAr ? 'الاثنان' : 'Both'}</option>
          </select>)}

        {wrap('campaign',
          <select defaultValue={item.campaign_id ?? ''} className={field}
            onChange={(e) => save({ campaign_id: e.target.value || null }, 'campaign')}>
            <option value="">{isAr ? '— بلا حملة —' : '— no campaign —'}</option>
            {campaigns.map((c) => (
              <option key={c.id} value={c.id}>{c.code} · {isAr ? c.name_ar : (c.name_en ?? c.name_ar)}</option>
            ))}
          </select>)}

        {wrap('due',
          <input type="date" defaultValue={item.due_date ?? ''} className={field}
            onChange={(e) => save({ due_date: e.target.value || null }, 'due')} />)}

        {wrap('planned',
          <input type="datetime-local" className={field}
            defaultValue={item.planned_publish_at ? item.planned_publish_at.slice(0, 16) : ''}
            onChange={(e) => save({ planned_publish_at: e.target.value ? new Date(e.target.value).toISOString() : null }, 'planned')} />)}

        {userSelect('owner', 'owner_user_id', item.owner_user_id)}
        {userSelect('writer', 'writer_user_id', item.writer_user_id)}
        {userSelect('designer', 'designer_user_id', item.designer_user_id)}
        {userSelect('editor', 'editor_user_id', item.editor_user_id)}
        {userSelect('presenter', 'presenter_user_id', item.presenter_user_id)}

        {wrap('pillar',
          <input defaultValue={item.content_pillar ?? ''} className={field}
            placeholder={isAr ? 'مثال: جولات الوحدات' : 'e.g. unit tours'}
            onBlur={(e) => save({ content_pillar: e.target.value || null }, 'pillar')} />)}

        {wrap('audience',
          <input defaultValue={item.target_audience ?? ''} className={field}
            placeholder={isAr ? 'مثال: مشترٍ أول، ٣٠–٤٥' : 'e.g. first-time buyer, 30–45'}
            onBlur={(e) => save({ target_audience: e.target.value || null }, 'audience')} />,
          'sm:col-span-2')}

        {wrap('hook',
          <textarea defaultValue={item.hook ?? ''} rows={2} className={field}
            placeholder={isAr ? 'ما الذي يوقف التمرير؟' : 'What stops the scroll?'}
            onBlur={(e) => save({ hook: e.target.value || null }, 'hook')} />,
          'sm:col-span-2 lg:col-span-3')}

        {wrap('idea',
          <textarea defaultValue={item.main_idea ?? ''} rows={3} className={field}
            placeholder={isAr ? 'ما الرسالة الواحدة التي يجب أن تصل؟' : 'The one message this must land'}
            onBlur={(e) => save({ main_idea: e.target.value || null }, 'idea')} />,
          'sm:col-span-2 lg:col-span-3')}

        {wrap('cta',
          <input defaultValue={item.cta ?? ''} className={field}
            placeholder={isAr ? 'مثال: احجز جولة' : 'e.g. Book a tour'}
            onBlur={(e) => save({ cta: e.target.value || null }, 'cta')} />)}

        {wrap('hashtags',
          <input defaultValue={(item.hashtags ?? []).join(' ')} className={field}
            placeholder="#وصل #الرياض"
            onBlur={(e) => save({ hashtags: e.target.value.split(/\s+/).map((h) => h.trim()).filter(Boolean) }, 'hashtags')} />,
          'sm:col-span-2')}

        {wrap('caption',
          <textarea defaultValue={item.caption ?? ''} rows={4} className={field}
            placeholder={isAr ? 'النص الذي سيُنشر فعلياً' : 'The text that will actually be posted'}
            onBlur={(e) => save({ caption: e.target.value || null }, 'caption')} />,
          'sm:col-span-2 lg:col-span-3')}

        {wrap('refs',
          <textarea defaultValue={(item.reference_links ?? []).join('\n')} rows={2} className={field}
            placeholder={isAr ? 'رابط في كل سطر' : 'One link per line'}
            onBlur={(e) => save({ reference_links: e.target.value.split('\n').map((x) => x.trim()).filter(Boolean) }, 'refs')} />,
          'sm:col-span-2 lg:col-span-3')}

        {wrap('notes',
          <textarea defaultValue={item.production_notes ?? ''} rows={2} className={field}
            placeholder={isAr ? 'أي شيء يحتاجه المنفّذ' : 'Anything the producer needs to know'}
            onBlur={(e) => save({ production_notes: e.target.value || null }, 'notes')} />,
          'sm:col-span-2 lg:col-span-3')}
      </div>

      {item.owner_user_id && person(item.owner_user_id) && (
        <p className="mt-2 text-[11px] text-charcoal/45">
          {isAr ? 'المسؤول: ' : 'Owner: '}{personName(person(item.owner_user_id)!)}
        </p>
      )}
    </Section>
  );
}

// ── Versions: where drafts get written ──────────────────────────────────────
const WRITABLE = ['brief','script','caption','post_design','carousel_design','final'] as const;
const V_LABEL: Record<string, { ar: string; en: string }> = {
  brief:{ar:'الموجز',en:'Brief'}, script:{ar:'السيناريو',en:'Script'},
  caption:{ar:'التعليق',en:'Caption'}, post_design:{ar:'تصميم المنشور',en:'Post design'},
  carousel_design:{ar:'تصميم الكاروسيل',en:'Carousel design'}, final:{ar:'النسخة النهائية',en:'Final'},
  video_edit:{ar:'مونتاج',en:'Video edit'}, platform_variant:{ar:'نسخة منصة',en:'Platform variant'},
  published:{ar:'المنشور',en:'Published'},
};

export function VersionWriter({ item, versions, isAr, onChanged, onError }: {
  item: ContentItem; versions: ContentVersion[]; isAr: boolean;
  onChanged: () => void; onError: (m: string) => void;
}) {
  const [type, setType] = useState<string>('brief');
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

  // Requesting approval is a STATUS move, not an approval row: an approval
  // record is written when someone actually decides. The database owns which
  // moves are legal, so an illegal one surfaces as its error rather than being
  // second-guessed here.
  const requestApproval = async (v: ContentVersion) => {
    const to = v.version_type === 'brief' || v.version_type === 'script'
      ? 'awaiting_script_approval' : 'awaiting_final_approval';
    setBusy(true);
    try { await transitionContent(item.id, to); onChanged(); }
    catch (e) { onError(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(false); }
  };

  const field = 'w-full rounded-lg border border-sand/60 bg-white px-2.5 py-1.5 text-[12.5px] text-charcoal focus:border-copper focus:outline-none';
  const cur = latest.get(type);

  return (
    <Section title={isAr ? 'الكتابة والنسخ' : 'Drafts & versions'}
      subtitle={isAr ? 'كل حفظ ينشئ نسخة جديدة — النسخ المعتمدة لا تُعدّل'
                     : 'Each save creates a new version — approved versions are never edited'}>
      <div className="mb-3 grid gap-2 sm:grid-cols-4">
        <select value={type} onChange={(e) => setType(e.target.value)} className={field}>
          {WRITABLE.map((t) => (
            <option key={t} value={t}>{isAr ? V_LABEL[t]?.ar : V_LABEL[t]?.en}</option>
          ))}
        </select>
        <input value={summary} onChange={(e) => setSummary(e.target.value)} className={`${field} sm:col-span-2`}
          placeholder={isAr ? 'ما الذي تغيّر؟ (اختياري)' : 'What changed? (optional)'} />
        <Button onClick={write} disabled={busy || !body.trim()}>
          <Plus className="h-4 w-4" />
          {cur ? (isAr ? `حفظ نسخة ${cur.version_number + 1}` : `Save v${cur.version_number + 1}`)
               : (isAr ? 'حفظ نسخة 1' : 'Save v1')}
        </Button>
      </div>

      <textarea value={body} onChange={(e) => setBody(e.target.value)} rows={8} className={field}
        placeholder={isAr
          ? (type === 'brief' ? 'اكتب الموجز: لمن؟ ما الرسالة؟ ما المطلوب من المشاهد؟'
            : type === 'script' ? 'اكتب السيناريو الكامل — سطراً بسطر'
            : 'اكتب النص هنا…')
          : (type === 'brief' ? 'Write the brief: who is it for, what is the message, what should the viewer do?'
            : type === 'script' ? 'Write the full script, line by line'
            : 'Write here…')} />

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
                  <div className="flex items-center gap-2 px-3 py-2">
                    <FileText className="h-3.5 w-3.5 shrink-0 text-charcoal/30" />
                    <button type="button" onClick={() => setOpenId(open ? null : v.id)}
                      className="min-w-0 flex-1 truncate text-start text-[12.5px] text-charcoal">
                      {(isAr ? V_LABEL[v.version_type]?.ar : V_LABEL[v.version_type]?.en) ?? v.version_type}
                      {' '}v{v.version_number}
                      {v.change_summary && <span className="text-charcoal/40"> — {v.change_summary}</span>}
                    </button>
                    {v.is_locked && (
                      <span className="inline-flex shrink-0 items-center gap-1 rounded-full border border-emerald-200 bg-emerald-50 px-2 py-0.5 text-[10.5px] text-emerald-700">
                        <Lock className="h-3 w-3" />{isAr ? 'معتمد' : 'approved'}
                      </span>
                    )}
                    {!v.is_locked && (
                      <button type="button" disabled={busy} onClick={() => requestApproval(v)}
                        className="shrink-0 text-[11.5px] font-medium text-copper hover:underline disabled:opacity-40">
                        <Send className="me-1 inline h-3 w-3" />{isAr ? 'طلب اعتماد' : 'Request approval'}
                      </button>
                    )}
                    <ChevronDown className={`h-3.5 w-3.5 shrink-0 text-charcoal/30 transition-transform ${open ? 'rotate-180' : ''}`} />
                  </div>
                  {open && (
                    <div className="border-t border-sand/40 p-3">
                      <pre className="whitespace-pre-wrap break-words text-[12.5px] leading-relaxed text-charcoal/80">
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
