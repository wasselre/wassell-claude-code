/**
 * المحتوى — the canonical content module.
 *
 * ONE board, ONE detail surface, ONE service layer (lib/marketingMgmt/contentOps).
 * This replaces the previous split where the board wrote platform-shaped fields
 * straight onto the content item and the detail panel showed the same fixed
 * twelve tasks for every kind of work.
 *
 * The shape it renders is the shape the database enforces:
 *   brief → deliverables → artifacts → publications → results
 *
 * Readiness is never recomputed here. `missing`, `blockers` and `next_action`
 * arrive from the same functions that gate the writes, so a disabled button and
 * the reason it gives cannot drift from what a save would actually do. The
 * checklist is a compact row of clickable chips that jump to the tab holding
 * the missing thing — not a warning banner repeated on every screen.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Plus, Search, ChevronDown, AlertTriangle, Check, Lock, LayoutGrid, Table2,
  CalendarDays, ExternalLink, Layers, Clapperboard, Send, BarChart3, History,
  FileText, Sparkles,
} from 'lucide-react';
import Button from '@/components/ui/Button';
import { useAppStore } from '@/stores/appStore';
import { Section, Stat, EmptyHint, Spinner, fmtDate }
  from '@/pages/MarketingIntelligence/components/shared';
import { lbl } from '@/lib/marketingMgmt/labels';
import {
  fetchContentBoard, fetchContentDetail, saveBrief, saveDeliverable,
  fetchSocialAccounts, type SocialAccount,
  generateDeliverableTasks, fetchArtifactTypes, saveArtifact, decideArtifact,
  saveContentTask, savePublication, markPublished, recordResult,
  bulkAssign, bulkSchedule, duplicateContent,
  SCOPE_LABEL, DELIVERABLE_STATUS_LABEL, FORMAT_LABEL, PLATFORM_LABEL,
  DISTRIBUTION_LABEL, APPROVAL_LABEL, TASK_STATUS_LABEL, RECOMMENDATION_LABEL,
  BRIEF_MISSING_LABEL, blockerLabel,
  type ContentBrief, type ContentOpsDetail, type Deliverable, type Artifact,
  type ArtifactType, type ContentTask, type VideoScene,
} from '@/lib/marketingMgmt/contentOps';

const FIELD = 'w-full rounded-lg border border-sand/60 bg-white px-2.5 py-1.5 text-[12.5px] '
  + 'text-charcoal focus:border-copper focus:outline-none';
const err = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** Content ids, URLs and handles stay left-to-right inside an Arabic page.
 *  Without the isolation "C-00011" renders with its parts reordered. */
const Ltr = ({ children, className = '' }: { children: React.ReactNode; className?: string }) => (
  <span dir="ltr" className={`inline-block ${className}`}>{children}</span>
);

function Field({ label, children, hint, required, span = '' }: {
  label: string; children: React.ReactNode; hint?: string; required?: boolean; span?: string;
}) {
  return (
    <label className={`block ${span}`}>
      <span className="mb-1 block text-[11.5px] font-medium text-charcoal/70">
        {label}{required && <span className="text-copper"> *</span>}
      </span>
      {children}
      {hint && <span className="mt-0.5 block text-[10.5px] leading-snug text-charcoal/55">{hint}</span>}
    </label>
  );
}

const STAGE_LABEL: Record<string, { ar: string; en: string }> = {
  idea: { ar: 'فكرة', en: 'Idea' },
  brief: { ar: 'موجز', en: 'Brief' },
  writing: { ar: 'كتابة', en: 'Writing' },
  awaiting_script_approval: { ar: 'اعتماد النص', en: 'Script approval' },
  approved_for_production: { ar: 'جاهز للإنتاج', en: 'Ready for production' },
  raw_assets_required: { ar: 'يحتاج مواد', en: 'Assets required' },
  recording: { ar: 'تصوير', en: 'Recording' },
  designing: { ar: 'تصميم', en: 'Designing' },
  editing: { ar: 'مونتاج', en: 'Editing' },
  internal_review: { ar: 'مراجعة داخلية', en: 'Internal review' },
  revision_requested: { ar: 'مطلوب تعديل', en: 'Changes requested' },
  awaiting_final_approval: { ar: 'اعتماد نهائي', en: 'Final approval' },
  approved: { ar: 'معتمد', en: 'Approved' },
  ready_to_publish: { ar: 'جاهز للنشر', en: 'Ready to publish' },
  scheduled: { ar: 'مجدول', en: 'Scheduled' },
  published: { ar: 'منشور', en: 'Published' },
  cancelled: { ar: 'ملغى', en: 'Cancelled' },
  archived: { ar: 'مؤرشف', en: 'Archived' },
};

const PIPELINE = ['idea', 'brief', 'writing', 'approved_for_production', 'recording',
  'designing', 'editing', 'internal_review', 'approved', 'scheduled', 'published'];

// ══ Readiness ══════════════════════════════════════════════════════════════
/** Compact, clickable, and stated once. Each chip jumps to the tab that owns
 *  the missing thing rather than telling the user to go find it. */
function Readiness({ missing, isAr, onJump }: {
  missing: string[]; isAr: boolean; onJump?: (tab: TabKey) => void;
}) {
  if (missing.length === 0) {
    return (
      <span className="inline-flex items-center gap-1 rounded-full border border-emerald-200 bg-emerald-50 px-2 py-0.5 text-[11px] font-medium text-emerald-700">
        <Check className="h-3 w-3" />{isAr ? 'مكتمل' : 'Ready'}
      </span>
    );
  }
  const tabFor = (k: string): TabKey =>
    k === 'at_least_one_deliverable' ? 'deliverables' : 'brief';
  return (
    <span className="inline-flex flex-wrap items-center gap-1">
      <span className="inline-flex items-center gap-1 text-[11px] font-medium text-amber-700">
        <AlertTriangle className="h-3 w-3" />{missing.length}
      </span>
      {missing.map((m) => (
        <button key={m} type="button" onClick={() => onJump?.(tabFor(m))}
          className="rounded-full border border-amber-200 bg-amber-50 px-2 py-0.5 text-[10.5px] text-amber-800 hover:border-amber-400">
          {lbl(BRIEF_MISSING_LABEL, m, isAr)}
        </button>
      ))}
    </span>
  );
}

// ══ Board ══════════════════════════════════════════════════════════════════
type BoardView = 'pipeline' | 'table' | 'calendar';

export function ContentBoard({ isAr, onOpen, onError, onToast }: {
  isAr: boolean; onOpen: (id: string) => void;
  onError: (m: string) => void; onToast: (m: string) => void;
}) {
  const users = useAppStore((s) => s.users);
  const [view, setView] = useState<BoardView>('pipeline');
  const [rows, setRows] = useState<ContentBrief[]>([]);
  const [loading, setLoading] = useState(true);
  const [q, setQ] = useState('');
  const [owner, setOwner] = useState('');
  const [platform, setPlatform] = useState('');
  const [onlyBlocked, setOnlyBlocked] = useState(false);
  const [creating, setCreating] = useState(false);
  const [newTitle, setNewTitle] = useState('');
  const [busy, setBusy] = useState(false);
  const [sel, setSel] = useState<Set<string>>(new Set());
  const [types, setTypes] = useState<ArtifactType[]>([]);
  const [sheet, setSheet] = useState<'assign' | 'schedule' | 'duplicate' | null>(null);
  /** Kept on screen rather than toasted: a bulk run reports per-row outcomes,
   *  and a toast that vanishes cannot show which rows are still blocked. */
  const [report, setReport] = useState<React.ReactNode>(null);

  const load = useCallback((spinner = false) => {
    if (spinner) setLoading(true);
    fetchContentBoard().then((r) => setRows(r.items))
      .catch((e) => onError(err(e)))
      .finally(() => { if (spinner) setLoading(false); });
  }, [onError]);
  useEffect(() => { load(true); }, [load]);
  useEffect(() => { fetchArtifactTypes().then((r) => setTypes(r.types)).catch(() => {}); }, []);

  const ownerName = (id: string | null) => {
    if (!id) return null;
    const u = users.find((x) => x.id === id);
    return u ? ((isAr ? u.name_ar : u.name_en) || u.name_en) : null;
  };

  const filtered = useMemo(() => rows.filter((r) => {
    const needle = q.trim().toLowerCase();
    // Search covers the ID too: people quote "C-00011", not the title.
    if (needle && !(`${r.content_number} ${r.title}`.toLowerCase().includes(needle))) return false;
    if (owner && r.owner_user_id !== owner) return false;
    if (platform && !(r.mkt_content_deliverables ?? []).some((d) => d.platform === platform)) return false;
    if (onlyBlocked && !(r.state?.blockers?.length || (r.state?.missing?.length ?? 0) > 0)) return false;
    return true;
  }), [rows, q, owner, platform, onlyBlocked]);

  /** Quick create is an Idea Inbox record — a title is genuinely enough. The
   *  database refuses to let it leave the idea stage until it earns it. */
  const quickCreate = async () => {
    if (!newTitle.trim()) return;
    setBusy(true);
    try {
      const { call } = await import('@/lib/marketingMgmt/client');
      await call('content_create', { title: newTitle.trim(), content_type: 'reel' });
      setNewTitle(''); setCreating(false);
      onToast(isAr ? 'أُضيفت الفكرة' : 'Idea captured'); load();
    } catch (e) { onError(err(e)); } finally { setBusy(false); }
  };

  const toggle = (id: string) => setSel((s) => {
    const n = new Set(s); if (n.has(id)) n.delete(id); else n.add(id); return n;
  });
  const clearSel = () => { setSel(new Set()); setSheet(null); };

  if (loading) return <Spinner label={isAr ? 'جارٍ التحميل…' : 'Loading…'} />;

  const card = (c: ContentBrief) => {
    const dels = c.mkt_content_deliverables ?? [];
    const picked = sel.has(c.id);
    return (
      <div key={c.id} className={`relative rounded-xl border bg-white ${
        picked ? 'border-copper ring-1 ring-copper/30' : 'border-sand/50'}`}>
        {/* Outside the button: a checkbox nested in a button is invalid markup
            and the click would fight the card's own handler. */}
        <label className="absolute top-2 z-10 flex cursor-pointer items-center end-2"
          onClick={(e) => e.stopPropagation()}>
          <input type="checkbox" checked={picked} onChange={() => toggle(c.id)}
            aria-label={isAr ? `تحديد ${c.content_number}` : `Select ${c.content_number}`} />
        </label>
      <button type="button" onClick={() => onOpen(c.id)}
        className="w-full rounded-xl p-2.5 pe-8 text-start hover:bg-cream-light/60">
        <div className="flex items-start justify-between gap-2">
          <span className="text-[12.5px] font-medium leading-snug text-charcoal line-clamp-2">{c.title}</span>
          <Ltr className="shrink-0 text-[10px] tabular-nums text-charcoal/50">{c.content_number}</Ltr>
        </div>
        <div className="mt-1.5 flex flex-wrap items-center gap-1">
          {dels.length === 0 ? (
            <span className="rounded bg-amber-50 px-1.5 py-0.5 text-[10px] text-amber-800">
              {isAr ? 'بلا مخرجات' : 'no deliverables'}
            </span>
          ) : dels.slice(0, 3).map((d) => (
            <span key={d.id} className="rounded bg-cream px-1.5 py-0.5 text-[10px] text-charcoal/70">
              {d.platform ? lbl(PLATFORM_LABEL, d.platform, isAr) : (isAr ? 'منصة؟' : 'platform?')}
              {' · '}{lbl(FORMAT_LABEL, d.format, isAr)}
            </span>
          ))}
          {dels.length > 3 && (
            <span className="text-[10px] text-charcoal/45">+{dels.length - 3}</span>
          )}
        </div>
        {c.state?.next_action && (
          <div className="mt-1.5 truncate text-[10.5px] text-copper">
            → {c.state.next_action.title}
          </div>
        )}
        <div className="mt-1 flex items-center justify-between gap-2 text-[10.5px] text-charcoal/50">
          <span className="truncate">{ownerName(c.owner_user_id) ?? (isAr ? 'بلا مسؤول' : 'unassigned')}</span>
          <span className={`shrink-0 ${c.state?.is_overdue ? 'font-medium text-red-600' : ''}`}>
            {c.due_date ? fmtDate(c.due_date, isAr) : '—'}
          </span>
        </div>
        {(c.state?.missing?.length ?? 0) > 0 && (
          <div className="mt-1.5 border-t border-sand/40 pt-1.5">
            <Readiness missing={c.state!.missing} isAr={isAr} />
          </div>
        )}
      </button>
      </div>
    );
  };

  return (
    <div className="space-y-3">
      <Section title={isAr ? 'المحتوى' : 'Content'}
        subtitle={isAr ? 'من الفكرة إلى النتيجة — الموجز ثم المخرجات لكل منصة'
                       : 'Idea to result — the brief, then one deliverable per platform'}
        right={
          <div className="flex items-center gap-1.5">
            {([['pipeline', LayoutGrid], ['table', Table2], ['calendar', CalendarDays]] as const).map(([v, Icon]) => (
              <button key={v} type="button" onClick={() => setView(v)} aria-pressed={view === v}
                className={`rounded-lg border p-1.5 ${view === v
                  ? 'border-copper bg-copper text-white' : 'border-sand/60 bg-white text-charcoal/55 hover:border-copper/40'}`}>
                <Icon className="h-4 w-4" />
              </button>
            ))}
            <Button onClick={() => setCreating((v) => !v)}>
              <Plus className="h-4 w-4" />{isAr ? 'فكرة جديدة' : 'New idea'}
            </Button>
          </div>
        }>

        {creating && (
          <div className="mb-3 rounded-xl border border-copper/30 bg-copper/5 p-3">
            <div className="flex flex-wrap items-end gap-2">
              <div className="min-w-[220px] flex-1">
                <Field label={isAr ? 'العنوان' : 'Title'} required
                  hint={isAr ? 'العنوان وحده يكفي لالتقاط الفكرة — البقية تُستكمل قبل بدء الإنتاج.'
                             : 'A title alone is enough to capture it — the rest is required before production starts.'}>
                  <input value={newTitle} onChange={(e) => setNewTitle(e.target.value)}
                    onKeyDown={(e) => { if (e.key === 'Enter') void quickCreate(); }} className={FIELD} autoFocus />
                </Field>
              </div>
              <Button onClick={quickCreate} disabled={busy || !newTitle.trim()}>
                {isAr ? 'التقاط' : 'Capture'}
              </Button>
            </div>
          </div>
        )}

        <div className="mb-3 flex flex-wrap items-center gap-2">
          <div className="relative min-w-[190px] flex-1">
            <Search className="pointer-events-none absolute top-1/2 h-4 w-4 -translate-y-1/2 text-charcoal/35 start-3" />
            <input type="search" value={q} onChange={(e) => setQ(e.target.value)}
              placeholder={isAr ? 'بحث بالعنوان أو الرقم…' : 'Search by title or ID…'}
              className="w-full rounded-xl border border-sand/60 bg-white py-2 text-[12.5px] focus:border-copper focus:outline-none ps-9 pe-3" />
          </div>
          <select value={owner} onChange={(e) => setOwner(e.target.value)} className={`${FIELD} w-auto`}>
            <option value="">{isAr ? 'كل المسؤولين' : 'All owners'}</option>
            {users.map((u) => <option key={u.id} value={u.id}>{(isAr ? u.name_ar : u.name_en) || u.name_en}</option>)}
          </select>
          <select value={platform} onChange={(e) => setPlatform(e.target.value)} className={`${FIELD} w-auto`}>
            <option value="">{isAr ? 'كل المنصات' : 'All platforms'}</option>
            {Object.keys(PLATFORM_LABEL).map((p) => (
              <option key={p} value={p}>{lbl(PLATFORM_LABEL, p, isAr)}</option>))}
          </select>
          <label className="inline-flex items-center gap-1.5 text-[11.5px] text-charcoal/70">
            <input type="checkbox" checked={onlyBlocked} onChange={(e) => setOnlyBlocked(e.target.checked)} />
            {isAr ? 'غير المكتمل فقط' : 'Incomplete only'}
          </label>
          <span className="text-[11.5px] tabular-nums text-charcoal/50">{filtered.length}/{rows.length}</span>
        </div>

        {sel.size > 0 && (
          <BulkBar
            selected={[...sel]} rows={filtered} isAr={isAr} types={types}
            sheet={sheet} setSheet={setSheet}
            onClear={clearSel}
            onError={onError} onToast={onToast}
            onReport={setReport}
            onDone={() => { clearSel(); load(); }} />
        )}

        {report && <div className="mb-3">{report}</div>}

        {filtered.length === 0 ? (
          <EmptyHint>{isAr ? 'لا محتوى مطابق' : 'Nothing matches'}</EmptyHint>
        ) : view === 'pipeline' ? (
          <div className="overflow-x-auto">
            <div className="flex gap-3 pb-2" style={{ minWidth: 'min-content' }}>
              {PIPELINE.map((st) => {
                const col = filtered.filter((c) => c.status === st);
                if (col.length === 0) return null;
                return (
                  <div key={st} className="w-56 shrink-0">
                    <div className="mb-2 flex items-center justify-between px-1">
                      <span className="text-[11.5px] font-semibold text-charcoal/75">
                        {lbl(STAGE_LABEL, st, isAr)}
                      </span>
                      <span className="text-[11px] tabular-nums text-charcoal/45">{col.length}</span>
                    </div>
                    <div className="space-y-2">{col.map(card)}</div>
                  </div>
                );
              })}
            </div>
          </div>
        ) : view === 'table' ? (
          <div className="overflow-x-auto">
            <table className="w-full text-[12px]">
              <thead>
                <tr className="border-b border-sand/60 text-[11px] text-charcoal/60">
                  <th className="w-8 py-2">
                    <input type="checkbox"
                      checked={filtered.length > 0 && filtered.every((c) => sel.has(c.id))}
                      aria-label={isAr ? 'تحديد الكل' : 'Select all'}
                      onChange={(e) => setSel(e.target.checked
                        ? new Set(filtered.map((c) => c.id)) : new Set())} />
                  </th>
                  <th className="py-2 text-start font-medium">{isAr ? 'الرقم' : 'ID'}</th>
                  <th className="py-2 text-start font-medium">{isAr ? 'العنوان' : 'Title'}</th>
                  <th className="py-2 text-start font-medium">{isAr ? 'المرحلة' : 'Stage'}</th>
                  <th className="py-2 text-start font-medium">{isAr ? 'المخرجات' : 'Deliverables'}</th>
                  <th className="py-2 text-start font-medium">{isAr ? 'المسؤول' : 'Owner'}</th>
                  <th className="py-2 text-start font-medium">{isAr ? 'الاستحقاق' : 'Due'}</th>
                  <th className="py-2 text-start font-medium">{isAr ? 'الخطوة التالية' : 'Next action'}</th>
                  <th className="py-2 text-start font-medium">{isAr ? 'الجاهزية' : 'Readiness'}</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-sand/30">
                {filtered.map((c) => (
                  <tr key={c.id} className={`cursor-pointer hover:bg-cream-light ${
                    sel.has(c.id) ? 'bg-copper/5' : ''}`} onClick={() => onOpen(c.id)}>
                    <td className="py-2" onClick={(e) => e.stopPropagation()}>
                      <input type="checkbox" checked={sel.has(c.id)} onChange={() => toggle(c.id)}
                        aria-label={isAr ? `تحديد ${c.content_number}` : `Select ${c.content_number}`} />
                    </td>
                    <td className="py-2"><Ltr className="tabular-nums text-charcoal/60">{c.content_number}</Ltr></td>
                    <td className="max-w-[16rem] truncate py-2 text-charcoal">{c.title}</td>
                    <td className="py-2 text-charcoal/70">{lbl(STAGE_LABEL, c.status, isAr)}</td>
                    <td className="py-2 text-charcoal/70 tabular-nums">{(c.mkt_content_deliverables ?? []).length}</td>
                    <td className="py-2 text-charcoal/70">{ownerName(c.owner_user_id) ?? '—'}</td>
                    <td className={`py-2 ${c.state?.is_overdue ? 'font-medium text-red-600' : 'text-charcoal/70'}`}>
                      {c.due_date ? fmtDate(c.due_date, isAr) : '—'}
                    </td>
                    <td className="max-w-[12rem] truncate py-2 text-copper">{c.state?.next_action?.title ?? '—'}</td>
                    <td className="py-2"><Readiness missing={c.state?.missing ?? []} isAr={isAr} /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <CalendarView rows={filtered} isAr={isAr} onOpen={onOpen} />
        )}
      </Section>
    </div>
  );
}

/**
 * Bulk actions.
 *
 * Assignment operates on BRIEFS; scheduling operates on their DELIVERABLES,
 * because a deliverable is the thing that goes out on a date. Selecting three
 * briefs that carry five outputs schedules five slots, and the bar says so
 * before you commit rather than after.
 *
 * Nothing here reports a clean success it did not earn: the RPCs return how
 * many rows RLS actually moved and which deliverables are still blocked, and
 * both are rendered.
 */
function BulkBar({ selected, rows, isAr, types, sheet, setSheet, onClear, onError, onToast, onReport, onDone }: {
  selected: string[]; rows: ContentBrief[]; isAr: boolean; types: ArtifactType[];
  sheet: 'assign' | 'schedule' | 'duplicate' | null;
  setSheet: (s: 'assign' | 'schedule' | 'duplicate' | null) => void;
  onClear: () => void; onError: (m: string) => void; onToast: (m: string) => void;
  onReport: (n: React.ReactNode) => void; onDone: () => void;
}) {
  const users = useAppStore((s) => s.users);
  const [busy, setBusy] = useState(false);
  const [owner, setOwner] = useState('');
  const [alsoDel, setAlsoDel] = useState(true);
  const [startAt, setStartAt] = useState(() => {
    // Tomorrow 19:00 — a sane default for a posting slot, not "now".
    const d = new Date(); d.setDate(d.getDate() + 1); d.setHours(19, 0, 0, 0);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}T19:00`;
  });
  const [everyMins, setEveryMins] = useState(1440);
  const [dupTitle, setDupTitle] = useState('');
  const [dupKind, setDupKind] = useState('refresh');
  const [dupCopy, setDupCopy] = useState(false);

  const picked = rows.filter((r) => selected.includes(r.id));
  const delIds = picked.flatMap((r) => (r.mkt_content_deliverables ?? []).map((d) => d.id));
  const one = picked.length === 1 ? picked[0] : null;

  const run = async (fn: () => Promise<React.ReactNode>) => {
    setBusy(true);
    try { onReport(await fn()); onDone(); }
    catch (e) { onError(err(e)); }
    finally { setBusy(false); }
  };

  const doAssign = () => run(async () => {
    const { result } = await bulkAssign(selected, owner || null, alsoDel);
    onToast(isAr ? 'حُدّث التعيين' : 'Assignment updated');
    if (result.refused > 0) {
      return (
        <div className="rounded-xl border border-amber-200 bg-amber-50 px-3 py-2 text-[11.5px] text-amber-800">
          {isAr
            ? `حُدِّث ${result.items_updated} من ${result.requested}. رُفض ${result.refused} — صلاحياتك لا تسمح بتعديلها.`
            : `${result.items_updated} of ${result.requested} updated. ${result.refused} refused — your permissions do not cover them.`}
        </div>
      );
    }
    return null;
  });

  const doSchedule = () => run(async () => {
    const iso = new Date(startAt).toISOString();
    const { result } = await bulkSchedule(delIds, iso, everyMins);
    onToast(isAr ? `جُدولت ${result.scheduled} مخرجات` : `${result.scheduled} deliverable(s) scheduled`);
    if (result.still_blocked.length === 0) return null;
    // The important half of the answer: a time is set, but these cannot publish.
    return (
      <div className="rounded-xl border border-amber-200 bg-amber-50 px-3 py-2.5">
        <div className="mb-1 text-[11.5px] font-semibold text-amber-900">
          {isAr
            ? `حُدِّد الموعد لـ${result.scheduled}، لكن ${result.still_blocked.length} منها لا يمكن نشرها بعد:`
            : `${result.scheduled} given a time, but ${result.still_blocked.length} cannot publish yet:`}
        </div>
        <ul className="space-y-0.5">
          {result.still_blocked.map((b) => (
            <li key={b.deliverable_id} className="text-[11px] text-amber-800">
              <Ltr className="font-medium">{b.label}</Ltr>{' — '}
              {/* Same translation the board chips use. Raw keys like
                  approved_final_media are for the database, not the reader. */}
              {b.blockers.map((x) => blockerLabel(x, isAr, types)).join(isAr ? '، ' : ', ')}
            </li>))}
        </ul>
      </div>
    );
  });

  const doDuplicate = () => run(async () => {
    if (!one) return null;
    const { result } = await duplicateContent(one.id, dupTitle.trim() || undefined, dupKind, dupCopy);
    onToast(isAr
      ? `أُنشئت ${result.content_number} — ${result.deliverables} مخرجات و${result.tasks} مهمة`
      : `${result.content_number} created — ${result.deliverables} deliverables, ${result.tasks} tasks`);
    return (
      <div className="rounded-xl border border-emerald-200 bg-emerald-50 px-3 py-2 text-[11.5px] text-emerald-800">
        {isAr
          ? `نُسخت ${result.source_number} إلى ${result.content_number}: ${result.deliverables} مخرجات، ${result.tasks} مهمة جديدة، ${result.artifacts_copied} نص منسوخ كمسودة. لم تُنسخ أي اعتمادات أو مواعيد — النسخة تبدأ من مرحلة الفكرة.`
          : `${result.source_number} copied to ${result.content_number}: ${result.deliverables} deliverables, ${result.tasks} fresh tasks, ${result.artifacts_copied} text(s) copied as drafts. No approvals or schedules were carried over — the copy starts at the idea stage.`}
      </div>
    );
  });

  return (
    <div className="mb-3 rounded-xl border border-copper/40 bg-copper/5 p-2.5">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-[12px] font-medium text-charcoal">
          {isAr ? `${picked.length} محدَّد` : `${picked.length} selected`}
          <span className="text-charcoal/50">
            {' · '}{isAr ? `${delIds.length} مخرَج` : `${delIds.length} deliverable(s)`}
          </span>
        </span>
        <span className="grow" />
        <Button variant="secondary" onClick={() => setSheet(sheet === 'assign' ? null : 'assign')}>
          {isAr ? 'تعيين مسؤول' : 'Assign owner'}
        </Button>
        <Button variant="secondary" disabled={delIds.length === 0}
          onClick={() => setSheet(sheet === 'schedule' ? null : 'schedule')}>
          {isAr ? 'جدولة' : 'Schedule'}
        </Button>
        <Button variant="secondary" disabled={!one}
          title={one ? undefined : (isAr ? 'اختر عنصراً واحداً' : 'Pick exactly one')}
          onClick={() => setSheet(sheet === 'duplicate' ? null : 'duplicate')}>
          {isAr ? 'نسخ إلى حزمة جديدة' : 'Duplicate into a new package'}
        </Button>
        <button type="button" onClick={onClear} className="text-[11.5px] text-charcoal/55 hover:underline">
          {isAr ? 'إلغاء التحديد' : 'Clear'}
        </button>
      </div>

      {sheet === 'assign' && (
        <div className="mt-2.5 flex flex-wrap items-end gap-2 border-t border-copper/20 pt-2.5">
          <Field label={isAr ? 'المسؤول' : 'Owner'}>
            <select value={owner} onChange={(e) => setOwner(e.target.value)} className={FIELD}>
              <option value="">{isAr ? '— إزالة المسؤول —' : '— unassign —'}</option>
              {users.map((u) => (
                <option key={u.id} value={u.id}>{(isAr ? u.name_ar : u.name_en) || u.name_en}</option>))}
            </select>
          </Field>
          <label className="mb-1.5 inline-flex items-center gap-1.5 text-[11.5px] text-charcoal/70">
            <input type="checkbox" checked={alsoDel} onChange={(e) => setAlsoDel(e.target.checked)} />
            {isAr ? 'والمخرجات أيضاً' : 'and their deliverables'}
          </label>
          <div className="mb-1"><Button onClick={doAssign} disabled={busy}>{isAr ? 'تطبيق' : 'Apply'}</Button></div>
        </div>
      )}

      {sheet === 'schedule' && (
        <div className="mt-2.5 space-y-2 border-t border-copper/20 pt-2.5">
          <div className="flex flex-wrap items-end gap-2">
            <Field label={isAr ? 'أول موعد (بتوقيت الرياض)' : 'First slot (Riyadh time)'}>
              <input type="datetime-local" value={startAt} className={FIELD}
                onChange={(e) => setStartAt(e.target.value)} />
            </Field>
            <Field label={isAr ? 'الفاصل بين المخرجات' : 'Gap between deliverables'}>
              <select value={everyMins} className={FIELD}
                onChange={(e) => setEveryMins(Number(e.target.value))}>
                <option value={60}>{isAr ? 'ساعة' : '1 hour'}</option>
                <option value={180}>{isAr ? '3 ساعات' : '3 hours'}</option>
                <option value={1440}>{isAr ? 'يوم' : '1 day'}</option>
                <option value={2880}>{isAr ? 'يومان' : '2 days'}</option>
                <option value={10080}>{isAr ? 'أسبوع' : '1 week'}</option>
              </select>
            </Field>
            <div className="mb-1"><Button onClick={doSchedule} disabled={busy}>{isAr ? 'جدولة' : 'Schedule'}</Button></div>
          </div>
          <p className="text-[10.5px] leading-snug text-charcoal/55">
            {isAr
              ? 'يحدد موعد النشر المخطط لكل مخرَج بالتتابع. لا يتجاوز شروط النشر — المخرَج بلا مادة أو نص معتمد يبقى محجوباً وسيُذكر بعد التنفيذ.'
              : 'Sets each deliverable’s planned time in sequence. It does not bypass the publish gate — anything without approved media or copy stays blocked and is listed afterwards.'}
          </p>
        </div>
      )}

      {sheet === 'duplicate' && one && (
        <div className="mt-2.5 space-y-2 border-t border-copper/20 pt-2.5">
          <div className="flex flex-wrap items-end gap-2">
            <div className="min-w-[220px] flex-1">
              <Field label={isAr ? 'عنوان النسخة' : 'Title of the copy'}>
                <input value={dupTitle} className={FIELD}
                  placeholder={`${one.title} — ${isAr ? 'نسخة' : 'copy'}`}
                  onChange={(e) => setDupTitle(e.target.value)} />
              </Field>
            </div>
            <Field label={isAr ? 'نوع إعادة الاستخدام' : 'Reuse kind'}>
              <select value={dupKind} onChange={(e) => setDupKind(e.target.value)} className={FIELD}>
                <option value="refresh">{isAr ? 'تحديث' : 'Refresh'}</option>
                <option value="series_episode">{isAr ? 'حلقة من سلسلة' : 'Series episode'}</option>
                <option value="platform_variant">{isAr ? 'نسخة لمنصة أخرى' : 'Platform variant'}</option>
                <option value="translation">{isAr ? 'ترجمة' : 'Translation'}</option>
                <option value="recut">{isAr ? 'إعادة مونتاج' : 'Recut'}</option>
              </select>
            </Field>
            <label className="mb-1.5 inline-flex items-center gap-1.5 text-[11.5px] text-charcoal/70">
              <input type="checkbox" checked={dupCopy} onChange={(e) => setDupCopy(e.target.checked)} />
              {isAr ? 'انسخ النصوص المعتمدة كمسودات' : 'copy approved text as drafts'}
            </label>
            <div className="mb-1"><Button onClick={doDuplicate} disabled={busy}>{isAr ? 'نسخ' : 'Duplicate'}</Button></div>
          </div>
          <p className="text-[10.5px] leading-snug text-charcoal/55">
            {isAr
              ? 'تنتقل الحجّة الاستراتيجية وشكل كل مخرَج والأدوار. لا تنتقل الاعتمادات ولا المواعيد ولا التقدّم — النسخة تبدأ من مرحلة الفكرة، ويُسجَّل أصلها كعلاقة أب لا كملاحظة.'
              : 'The strategic argument, the shape of each deliverable and the role assignments carry over. Approvals, schedules and progress do not — the copy starts at the idea stage, and its origin is recorded as a parent relationship rather than a note.'}
          </p>
        </div>
      )}
    </div>
  );
}

/** Calendar keyed on the DELIVERABLE's planned publish time, because that is
 *  what actually goes out on a date — the brief has a window, not a slot. */
function CalendarView({ rows, isAr, onOpen }: {
  rows: ContentBrief[]; isAr: boolean; onOpen: (id: string) => void;
}) {
  const slots = useMemo(() => {
    const byDay = new Map<string, Array<{ c: ContentBrief; d: Deliverable }>>();
    for (const c of rows) {
      for (const d of c.mkt_content_deliverables ?? []) {
        if (!d.planned_publish_at) continue;
        const day = d.planned_publish_at.slice(0, 10);
        if (!byDay.has(day)) byDay.set(day, []);
        byDay.get(day)!.push({ c, d });
      }
    }
    return [...byDay.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  }, [rows]);

  if (slots.length === 0) {
    return (
      <EmptyHint>
        {isAr ? 'لا مخرجات لها وقت نشر مخطّط بعد — حدّد وقتاً على المخرَج ليظهر هنا.'
              : 'No deliverable has a planned publish time yet — set one on a deliverable and it appears here.'}
      </EmptyHint>
    );
  }
  return (
    <div className="space-y-2.5">
      {slots.map(([day, entries]) => (
        <div key={day} className="rounded-xl border border-sand/50 bg-white p-2.5">
          <div className="mb-1.5 text-[11.5px] font-semibold text-charcoal/75">{fmtDate(day, isAr)}</div>
          <ul className="space-y-1">
            {entries.map(({ c, d }) => (
              <li key={d.id}>
                <button type="button" onClick={() => onOpen(c.id)}
                  className="flex w-full items-center justify-between gap-2 rounded-lg px-2 py-1.5 text-start hover:bg-cream-light">
                  <span className="min-w-0 truncate text-[12px] text-charcoal">
                    {c.title}
                    <span className="text-charcoal/45">
                      {' · '}{d.platform ? lbl(PLATFORM_LABEL, d.platform, isAr) : (isAr ? 'منصة؟' : 'platform?')}
                    </span>
                  </span>
                  <Ltr className="shrink-0 text-[11px] tabular-nums text-charcoal/55">
                    {new Date(d.planned_publish_at!).toLocaleTimeString(isAr ? 'ar-SA' : 'en-GB',
                      { hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Riyadh' })}
                  </Ltr>
                </button>
              </li>
            ))}
          </ul>
        </div>
      ))}
    </div>
  );
}

// ══ Detail ═════════════════════════════════════════════════════════════════
type TabKey = 'overview' | 'brief' | 'deliverables' | 'writing' | 'production'
            | 'publishing' | 'results' | 'history';

const TABS: Array<[TabKey, string, string, typeof Layers]> = [
  ['overview', 'نظرة', 'Overview', Sparkles],
  ['brief', 'الملخص', 'Brief', FileText],
  ['deliverables', 'المخرجات', 'Deliverables', Layers],
  ['writing', 'الكتابة', 'Writing', FileText],
  ['production', 'الإنتاج', 'Production', Clapperboard],
  ['publishing', 'النشر', 'Publishing', Send],
  ['results', 'النتائج', 'Results', BarChart3],
  ['history', 'السجل', 'History', History],
];

export function ContentDetail({ id, isAr, onBack, onError, onToast, onChanged }: {
  id: string; isAr: boolean; onBack: () => void;
  onError: (m: string) => void; onToast: (m: string) => void; onChanged: () => void;
}) {
  const users = useAppStore((s) => s.users);
  const [d, setD] = useState<ContentOpsDetail | null>(null);
  const [types, setTypes] = useState<ArtifactType[]>([]);
  const [tab, setTab] = useState<TabKey>('overview');
  const [loading, setLoading] = useState(true);
  const [sel, setSel] = useState<string | null>(null);

  const load = useCallback(async (spinner = false) => {
    if (spinner) setLoading(true);
    try {
      const r = await fetchContentDetail(id);
      setD(r);
      setSel((s) => s && r.deliverables.some((x) => x.id === s) ? s : (r.deliverables[0]?.id ?? null));
    } catch (e) { onError(err(e)); } finally { if (spinner) setLoading(false); }
  }, [id, onError]);

  useEffect(() => { void load(true); }, [load]);
  useEffect(() => { fetchArtifactTypes().then((r) => setTypes(r.types)).catch(() => {}); }, []);

  const refresh = () => { void load(); onChanged(); };
  const ownerName = (uid: string | null) => {
    if (!uid) return null;
    const u = users.find((x) => x.id === uid);
    return u ? ((isAr ? u.name_ar : u.name_en) || u.name_en) : null;
  };

  if (loading || !d) return <div className="py-6"><Spinner label={isAr ? 'جارٍ التحميل…' : 'Loading…'} /></div>;

  const st = d.state;
  const deliverable = d.deliverables.find((x) => x.id === sel) ?? null;

  return (
    <div className="space-y-3">
      {/* Sticky header: stage, owner, due, progress, next action, blocker. */}
      <div className="sticky top-0 z-10 -mx-1 rounded-xl border border-sand/60 bg-cream-light/95 px-3 py-2.5 backdrop-blur">
        <div className="flex flex-wrap items-start justify-between gap-2">
          <div className="min-w-0">
            <button type="button" onClick={onBack} className="mb-0.5 text-[11.5px] text-copper hover:underline">
              ← {isAr ? 'رجوع' : 'Back'}
            </button>
            <div className="flex flex-wrap items-baseline gap-2">
              <Ltr className="text-[11px] tabular-nums text-charcoal/55">{d.item.content_number}</Ltr>
              <h3 className="truncate text-[14px] font-semibold text-charcoal">{d.item.title}</h3>
              <span className="rounded-full border border-sand/60 bg-white px-2 py-0.5 text-[10.5px] text-charcoal/70">
                {lbl(STAGE_LABEL, d.item.status, isAr)}
              </span>
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Readiness missing={d.missing} isAr={isAr} onJump={setTab} />
          </div>
        </div>

        <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-[11.5px] text-charcoal/70">
          <span>{isAr ? 'المسؤول:' : 'Owner:'}{' '}
            <span className={d.item.owner_user_id ? '' : 'text-amber-700'}>
              {ownerName(d.item.owner_user_id) ?? (isAr ? 'بلا مسؤول' : 'unassigned')}
            </span>
          </span>
          <span className={st?.is_overdue ? 'font-medium text-red-600' : ''}>
            {isAr ? 'الاستحقاق:' : 'Due:'} {d.item.due_date ? fmtDate(d.item.due_date, isAr) : '—'}
          </span>
          <span>{isAr ? 'التقدّم:' : 'Progress:'}{' '}
            {st?.progress_pct == null
              ? <span className="text-charcoal/45">{isAr ? 'لا مهام' : 'no tasks'}</span>
              : <span className="tabular-nums">{st.progress_pct}% ({st.tasks_done}/{st.tasks_total})</span>}
          </span>
          {st?.next_action && (
            <span className="text-copper">→ {st.next_action.title}</span>
          )}
          {(st?.blockers?.length ?? 0) > 0 && (
            <span className="inline-flex items-center gap-1 text-amber-700">
              <AlertTriangle className="h-3.5 w-3.5" />
              {st!.blockers.length} {isAr ? 'معوّق' : 'blocker(s)'}
            </span>
          )}
          {(st?.waiting_on_predecessor ?? 0) > 0 && (
            <span className="text-charcoal/50">
              {st!.waiting_on_predecessor} {isAr ? 'بانتظار خطوة سابقة' : 'waiting on an earlier step'}
            </span>
          )}
        </div>

        <div className="mt-2 flex flex-wrap gap-1">
          {TABS.map(([k, ar, en, Icon]) => (
            <button key={k} type="button" onClick={() => setTab(k)}
              className={`inline-flex items-center gap-1 rounded-full px-2.5 py-1 text-[11.5px] font-medium ${
                tab === k ? 'bg-copper text-white' : 'bg-white text-charcoal/65 hover:bg-sand/25'}`}>
              <Icon className="h-3.5 w-3.5" />{isAr ? ar : en}
              {k === 'deliverables' && d.deliverables.length > 0 && (
                <span className="tabular-nums opacity-70">{d.deliverables.length}</span>)}
            </button>
          ))}
        </div>
      </div>

      {tab === 'overview' && <OverviewTab d={d} isAr={isAr} types={types} onJump={setTab} />}
      {tab === 'brief' && <BriefTab d={d} isAr={isAr} onError={onError} onSaved={refresh} />}
      {tab === 'deliverables' && (
        <DeliverablesTab d={d} isAr={isAr} types={types} sel={sel} setSel={setSel}
          onError={onError} onToast={onToast} onChanged={refresh} />
      )}
      {tab === 'writing' && (
        <WritingTab d={d} isAr={isAr} types={types} deliverable={deliverable}
          setSel={setSel} onError={onError} onToast={onToast} onChanged={refresh} />
      )}
      {tab === 'production' && (
        <ProductionTab d={d} isAr={isAr} deliverable={deliverable} setSel={setSel}
          onError={onError} onChanged={refresh} />
      )}
      {tab === 'publishing' && (
        <PublishingTab d={d} isAr={isAr} types={types} onError={onError}
          onToast={onToast} onChanged={refresh} onJump={setTab} />
      )}
      {tab === 'results' && (
        <ResultsTab d={d} isAr={isAr} onError={onError} onToast={onToast} onChanged={refresh} />
      )}
      {tab === 'history' && <HistoryTab d={d} isAr={isAr} />}
    </div>
  );
}

// ── Overview ───────────────────────────────────────────────────────────────
function OverviewTab({ d, isAr, types, onJump }: {
  d: ContentOpsDetail; isAr: boolean; types: ArtifactType[]; onJump: (t: TabKey) => void;
}) {
  const st = d.state;
  return (
    <div className="space-y-3">
      <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-4">
        <Stat label={isAr ? 'المخرجات' : 'Deliverables'} value={d.deliverables.length || null} />
        <Stat label={isAr ? 'المهام' : 'Tasks'}
          value={st ? `${st.tasks_done}/${st.tasks_total}` : null} />
        <Stat label={isAr ? 'المنشورات' : 'Publications'}
          value={d.publications.filter((p) => p.status === 'published').length || null} />
        <Stat label={isAr ? 'قراءات النتائج' : 'Result readings'} value={d.results.length || null} />
      </div>

      {st?.next_action && (
        <div className="rounded-xl border border-copper/30 bg-copper/5 px-3 py-2.5">
          <div className="text-[11px] font-medium uppercase tracking-wide text-charcoal/50">
            {isAr ? 'الخطوة التالية' : 'Next action'}
          </div>
          <div className="mt-0.5 text-[13px] font-medium text-charcoal">{st.next_action.title}</div>
        </div>
      )}

      {(st?.waiting_on_predecessor ?? 0) > 0 && (st?.blockers?.length ?? 0) === 0 && (
        <p className="text-[11.5px] text-charcoal/55">
          {isAr ? `${st!.waiting_on_predecessor} خطوة تنتظر ما قبلها — لا شيء عالق، فقط لم يحن دورها.`
                : `${st!.waiting_on_predecessor} step(s) are queued behind an earlier one — nothing is stuck.`}
        </p>
      )}

      {(st?.blockers?.length ?? 0) > 0 && (
        <div className="rounded-xl border border-amber-200 bg-amber-50 px-3 py-2.5">
          <div className="mb-1 text-[11.5px] font-semibold text-amber-800">
            {isAr ? 'ما الذي يوقف التقدّم' : 'What is holding this up'}
          </div>
          <ul className="space-y-0.5">
            {st!.blockers.map((b) => (
              <li key={b.id} className="text-[11.5px] text-amber-800">
                · {b.label}{b.reason ? ` — ${b.reason}` : ''}
              </li>))}
          </ul>
        </div>
      )}

      <Section title={isAr ? 'المخرجات وجاهزيتها' : 'Deliverables and their readiness'}>
        {d.deliverables.length === 0 ? (
          <EmptyHint>
            {isAr ? 'لا مخرجات بعد. المخرَج هو ما يُنشر فعلاً — أضف واحداً لتبدأ.'
                  : 'No deliverables yet. A deliverable is the thing that actually publishes — add one to begin.'}
          </EmptyHint>
        ) : (
          <ul className="space-y-2">
            {d.deliverables.map((x) => (
              <li key={x.id} className="rounded-lg border border-sand/50 bg-white px-3 py-2">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span className="text-[12.5px] text-charcoal">
                    <Ltr className="text-charcoal/45">D{x.deliverable_number}</Ltr>{' '}
                    {x.platform ? lbl(PLATFORM_LABEL, x.platform, isAr)
                                : <span className="text-amber-700">{isAr ? 'منصة غير محددة' : 'no platform'}</span>}
                    <span className="text-charcoal/50"> · {lbl(FORMAT_LABEL, x.format, isAr)}</span>
                  </span>
                  <span className="text-[11px] text-charcoal/60">
                    {lbl(DELIVERABLE_STATUS_LABEL, x.status, isAr)}
                  </span>
                </div>
                <div className="mt-1 flex flex-wrap items-center gap-1">
                  {(x.blockers ?? []).length === 0 ? (
                    <span className="text-[10.5px] text-emerald-700">
                      {isAr ? 'جاهز للجدولة' : 'ready to schedule'}
                    </span>
                  ) : (x.blockers ?? []).map((b) => (
                    <span key={b} className="rounded-full border border-amber-200 bg-amber-50 px-1.5 py-0.5 text-[10px] text-amber-800">
                      {blockerLabel(b, isAr, types)}
                    </span>))}
                </div>
              </li>))}
          </ul>
        )}
        <div className="mt-2">
          <button type="button" onClick={() => onJump('deliverables')}
            className="text-[11.5px] text-copper hover:underline">
            {isAr ? 'إدارة المخرجات ←' : 'Manage deliverables →'}
          </button>
        </div>
      </Section>
    </div>
  );
}

// ── Brief ──────────────────────────────────────────────────────────────────
function BriefTab({ d, isAr, onError, onSaved }: {
  d: ContentOpsDetail; isAr: boolean; onError: (m: string) => void; onSaved: () => void;
}) {
  const users = useAppStore((s) => s.users);
  const [saving, setSaving] = useState<Set<string>>(new Set());

  /** Per-field save. A single global busy flag disables every other input while
   *  one save is in flight and silently drops the keystrokes typed into them —
   *  that bug has already been fixed once in this module. */
  const save = async (patch: Record<string, unknown>, key: string) => {
    setSaving((s) => new Set(s).add(key));
    try { await saveBrief(d.item.id, patch); onSaved(); }
    catch (e) { onError(err(e)); }
    finally { setSaving((s) => { const n = new Set(s); n.delete(key); return n; }); }
  };
  const dis = (k: string) => saving.has(k);
  const need = (k: string) => d.missing.includes(k);

  const txt = (key: string, label: string, value: string | null, opts: {
    hint?: string; required?: boolean; area?: boolean; type?: string; span?: string;
  } = {}) => (
    <Field label={label} hint={opts.hint} required={opts.required} span={opts.span}>
      {opts.area ? (
        <textarea defaultValue={value ?? ''} rows={2} disabled={dis(key)}
          className={`${FIELD} ${opts.required && !value ? 'border-amber-300' : ''}`}
          onBlur={(e) => { const v = e.target.value.trim();
            if ((v || null) !== (value ?? null)) void save({ [key]: v || null }, key); }} />
      ) : (
        <input type={opts.type ?? 'text'} defaultValue={value ?? ''} disabled={dis(key)}
          className={`${FIELD} ${opts.required && !value ? 'border-amber-300' : ''}`}
          onBlur={(e) => { const v = e.target.value.trim();
            if ((v || null) !== (value ?? null)) void save({ [key]: v || null }, key); }} />
      )}
    </Field>
  );

  return (
    <div className="space-y-3">
      <Section title={isAr ? 'المصدر الاستراتيجي' : 'Strategic source'}
        subtitle={isAr ? 'مرتبط بنسخة استراتيجية بعينها — اعتماد نسخة أحدث لا ينقل هذا المحتوى تلقائياً.'
                       : 'Bound to one exact strategy version — approving a newer one never moves this content.'}>
        <div className="grid gap-2.5 sm:grid-cols-3">
          <Field label={isAr ? 'النطاق' : 'Scope'} required>
            <select defaultValue={d.item.scope_kind ?? ''} disabled={dis('scope_kind')}
              className={`${FIELD} ${need('scope') ? 'border-amber-300' : ''}`}
              onChange={(e) => void save({ scope_kind: e.target.value || null }, 'scope_kind')}>
              <option value="">{isAr ? '— اختر —' : '— select —'}</option>
              {Object.keys(SCOPE_LABEL).map((k) => (
                <option key={k} value={k}>{lbl(SCOPE_LABEL, k, isAr)}</option>))}
            </select>
          </Field>
          <Field label={isAr ? 'المسؤول' : 'Owner'} required>
            <select defaultValue={d.item.owner_user_id ?? ''} disabled={dis('owner_user_id')}
              className={`${FIELD} ${need('owner') ? 'border-amber-300' : ''}`}
              onChange={(e) => void save({ owner_user_id: e.target.value || null }, 'owner_user_id')}>
              <option value="">{isAr ? '— بلا مسؤول —' : '— unassigned —'}</option>
              {users.map((u) => <option key={u.id} value={u.id}>{(isAr ? u.name_ar : u.name_en) || u.name_en}</option>)}
            </select>
          </Field>
          {txt('always_on_reason', isAr ? 'سبب استمراري (بدل الهدف)' : 'Always-on reason (instead of a goal)',
            d.item.always_on_reason,
            { hint: isAr ? 'يُملأ فقط حين لا يوجد هدف حملة مرتبط.'
                         : 'Only when there is no campaign goal to attach to.' })}
        </div>
        {(need('strategy_version') || need('approved_strategy_version') || need('plan')) && (
          <p className="mt-2 text-[11px] leading-snug text-amber-700">
            {isAr ? 'الاستراتيجية والخطة تُربطان من تبويب «الاستراتيجية والتخطيط» — هذا المحتوى غير مرتبط بأيهما بعد.'
                  : 'Strategy and plan are linked from the Strategy & Planning tab — this content is bound to neither yet.'}
          </p>
        )}
      </Section>

      <Section title={isAr ? 'الرسالة' : 'The message'}>
        <div className="grid gap-2.5 sm:grid-cols-2">
          {txt('target_audience', isAr ? 'الجمهور' : 'Audience', d.item.target_audience,
            { required: true, hint: isAr ? 'من نخاطب تحديداً؟' : 'Exactly who is this for?' })}
          {txt('audience_insight', isAr ? 'رؤية عن الجمهور' : 'Audience insight', d.item.audience_insight,
            { hint: isAr ? 'ما الذي نعرفه عنهم ويغيّر الرسالة؟' : 'What we know about them that changes the message.' })}
          {txt('hook', isAr ? 'الخطّاف' : 'Hook', d.item.hook)}
          {txt('core_promise', isAr ? 'الوعد الأساسي' : 'Core promise', d.item.core_promise,
            { required: true, area: true })}
          {txt('content_angle', isAr ? 'الزاوية' : 'Angle', d.item.content_angle)}
          {txt('evidence', isAr ? 'الدليل' : 'Evidence', d.item.evidence,
            { area: true, hint: isAr ? 'ما الذي يجعل الوعد قابلاً للتصديق؟' : 'What makes the promise believable.' })}
          {txt('desired_action', isAr ? 'الإجراء المطلوب' : 'Desired action', d.item.desired_action,
            { required: true })}
          {txt('mandatory_info', isAr ? 'معلومات إلزامية' : 'Mandatory information', d.item.mandatory_info,
            { area: true })}
          {txt('prohibited_claims', isAr ? 'ادعاءات ممنوعة' : 'Prohibited claims', d.item.prohibited_claims,
            { area: true, span: 'sm:col-span-2',
              hint: isAr ? 'ما الذي يجب ألا يُقال — تعهدات عائد، مقارنات، أرقام غير موثّقة.'
                         : 'What must not be said — yield promises, comparisons, unverified numbers.' })}
        </div>
      </Section>

      <Section title={isAr ? 'المواعيد' : 'Dates'}
        subtitle={isAr ? 'نافذة الموجز — وقت النشر لكل مخرَج على حدة.'
                       : 'The brief has a window; publish times belong to each deliverable.'}>
        <div className="grid gap-2.5 sm:grid-cols-3">
          {txt('brief_due_date', isAr ? 'اعتماد الموجز' : 'Brief approval due', d.item.brief_due_date, { type: 'date' })}
          {txt('production_due_date', isAr ? 'انتهاء الإنتاج' : 'Production due', d.item.production_due_date, { type: 'date' })}
          {txt('review_due_date', isAr ? 'انتهاء المراجعة' : 'Review due', d.item.review_due_date, { type: 'date' })}
          {txt('window_start', isAr ? 'بداية نافذة النشر' : 'Publication window from', d.item.window_start, { type: 'date' })}
          {txt('window_end', isAr ? 'نهاية نافذة النشر' : 'Publication window to', d.item.window_end, { type: 'date' })}
        </div>
      </Section>
    </div>
  );
}

// ── Deliverables ───────────────────────────────────────────────────────────
function DeliverablesTab({ d, isAr, types, sel, setSel, onError, onToast, onChanged }: {
  d: ContentOpsDetail; isAr: boolean; types: ArtifactType[];
  sel: string | null; setSel: (v: string) => void;
  onError: (m: string) => void; onToast: (m: string) => void; onChanged: () => void;
}) {
  const users = useAppStore((s) => s.users);
  const [adding, setAdding] = useState(false);
  const [f, setF] = useState({ platform: 'instagram', format: 'reel', language: 'ar', distribution: 'organic' });
  const [busy, setBusy] = useState(false);
  const [saving, setSaving] = useState<Set<string>>(new Set());
  const [accounts, setAccounts] = useState<SocialAccount[]>([]);

  // Loaded once for the publishing-account picker. A failure here must be
  // visible: an empty list is indistinguishable from "this platform has no
  // accounts", and that is exactly the confusion that hid this gap.
  useEffect(() => {
    fetchSocialAccounts().then((r) => setAccounts(r.accounts)).catch((e) => onError(err(e)));
  }, [onError]);

  const add = async () => {
    setBusy(true);
    try {
      const r = await saveDeliverable({ ...f }, undefined, d.item.id);
      onToast(isAr ? `أُضيف المخرَج وتولّدت ${r.tasks_generated ?? 0} مهمة`
                   : `Deliverable added with ${r.tasks_generated ?? 0} tasks`);
      setAdding(false); onChanged();
    } catch (e) { onError(err(e)); } finally { setBusy(false); }
  };

  const patch = async (id: string, p: Record<string, unknown>, key: string) => {
    const k = `${id}:${key}`;
    setSaving((s) => new Set(s).add(k));
    try { await saveDeliverable(p, id); onChanged(); }
    catch (e) { onError(err(e)); }
    finally { setSaving((s) => { const n = new Set(s); n.delete(k); return n; }); }
  };

  return (
    <div className="space-y-3">
      <Section title={isAr ? 'المخرجات' : 'Deliverables'}
        subtitle={isAr ? 'مخرَج واحد لكل منصة/حساب/صيغة/لغة. كلٌّ له مالكه وموعده وجدولته.'
                       : 'One per platform / account / format / language. Each has its own owner, date and schedule.'}
        right={<Button onClick={() => setAdding((v) => !v)}>
          <Plus className="h-4 w-4" />{isAr ? 'مخرَج' : 'Deliverable'}</Button>}>

        {adding && (
          <div className="mb-3 grid gap-2 rounded-xl border border-copper/30 bg-copper/5 p-3 sm:grid-cols-5">
            <Field label={isAr ? 'المنصة' : 'Platform'}>
              <select value={f.platform} onChange={(e) => setF({ ...f, platform: e.target.value })} className={FIELD}>
                {Object.keys(PLATFORM_LABEL).map((p) => (
                  <option key={p} value={p}>{lbl(PLATFORM_LABEL, p, isAr)}</option>))}
              </select>
            </Field>
            <Field label={isAr ? 'الصيغة' : 'Format'}
              hint={isAr ? 'تحدد سير العمل' : 'decides the workflow'}>
              <select value={f.format} onChange={(e) => setF({ ...f, format: e.target.value })} className={FIELD}>
                {Object.keys(FORMAT_LABEL).map((p) => (
                  <option key={p} value={p}>{lbl(FORMAT_LABEL, p, isAr)}</option>))}
              </select>
            </Field>
            <Field label={isAr ? 'اللغة' : 'Language'}>
              <select value={f.language} onChange={(e) => setF({ ...f, language: e.target.value })} className={FIELD}>
                <option value="ar">{isAr ? 'عربي' : 'Arabic'}</option>
                <option value="en">{isAr ? 'إنجليزي' : 'English'}</option>
                <option value="both">{isAr ? 'الاثنان' : 'Both'}</option>
              </select>
            </Field>
            <Field label={isAr ? 'التوزيع' : 'Distribution'}>
              <select value={f.distribution} onChange={(e) => setF({ ...f, distribution: e.target.value })} className={FIELD}>
                {Object.keys(DISTRIBUTION_LABEL).map((p) => (
                  <option key={p} value={p}>{lbl(DISTRIBUTION_LABEL, p, isAr)}</option>))}
              </select>
            </Field>
            <div className="sm:self-end"><Button onClick={add} disabled={busy}>{isAr ? 'إضافة' : 'Add'}</Button></div>
          </div>
        )}

        {d.deliverables.length === 0 ? (
          <EmptyHint>{isAr ? 'لا مخرجات بعد' : 'No deliverables yet'}</EmptyHint>
        ) : (
          <ul className="space-y-2">
            {d.deliverables.map((x) => {
              const open = sel === x.id;
              const tasks = d.tasks.filter((t) => t.deliverable_id === x.id);
              const done = tasks.filter((t) => ['completed', 'skipped'].includes(t.status)).length;
              return (
                <li key={x.id} className="rounded-xl border border-sand/50 bg-white">
                  <button type="button" onClick={() => setSel(open ? '' : x.id)}
                    className="flex w-full flex-wrap items-center justify-between gap-2 px-3 py-2 text-start">
                    <span className="min-w-0">
                      <span className="text-[12.5px] text-charcoal">
                        <Ltr className="text-charcoal/45">D{x.deliverable_number}</Ltr>{' '}
                        {x.platform ? lbl(PLATFORM_LABEL, x.platform, isAr)
                                    : <span className="text-amber-700">{isAr ? 'منصة غير محددة' : 'no platform'}</span>}
                        <span className="text-charcoal/50"> · {lbl(FORMAT_LABEL, x.format, isAr)} · {x.language}</span>
                      </span>
                      {x.needs_classification && (
                        <span className="ms-2 rounded bg-amber-50 px-1.5 py-0.5 text-[10px] text-amber-800">
                          {isAr ? 'يحتاج تصنيف' : 'needs classification'}
                        </span>
                      )}
                    </span>
                    <span className="flex shrink-0 items-center gap-2 text-[11px] text-charcoal/60">
                      <span className="tabular-nums">{done}/{tasks.length}</span>
                      <span>{lbl(DELIVERABLE_STATUS_LABEL, x.status, isAr)}</span>
                      <ChevronDown className={`h-4 w-4 transition-transform ${open ? 'rotate-180' : ''}`} />
                    </span>
                  </button>

                  {open && (
                    <div className="space-y-2.5 border-t border-sand/40 p-3">
                      {(x.blockers ?? []).length > 0 && (
                        <div className="flex flex-wrap items-center gap-1">
                          <span className="text-[11px] text-charcoal/55">{isAr ? 'قبل الجدولة:' : 'Before scheduling:'}</span>
                          {(x.blockers ?? []).map((b) => (
                            <span key={b} className="rounded-full border border-amber-200 bg-amber-50 px-1.5 py-0.5 text-[10px] text-amber-800">
                              {blockerLabel(b, isAr, types)}
                            </span>))}
                        </div>
                      )}
                      <div className="grid gap-2.5 sm:grid-cols-3">
                        <Field label={isAr ? 'المنصة' : 'Platform'} required>
                          <select defaultValue={x.platform ?? ''} disabled={saving.has(`${x.id}:platform`)}
                            className={`${FIELD} ${x.platform ? '' : 'border-amber-300'}`}
                            onChange={(e) => void patch(x.id, { platform: e.target.value || null }, 'platform')}>
                            <option value="">{isAr ? '— غير محددة —' : '— not set —'}</option>
                            {Object.keys(PLATFORM_LABEL).map((p) => (
                              <option key={p} value={p}>{lbl(PLATFORM_LABEL, p, isAr)}</option>))}
                          </select>
                        </Field>
                        {/* mkt_deliverable_schedule_blockers demands a
                            `platform_account`, and social_account_id appeared in
                            no screen — so that blocker could never be cleared
                            and nothing could be scheduled, while 29 accounts sat
                            in the database unreachable. Filtered to the chosen
                            platform: offering an Instagram account for a TikTok
                            deliverable is a guaranteed mis-post. */}
                        <Field label={isAr ? 'حساب النشر' : 'Publishing account'} required>
                          <select defaultValue={x.social_account_id ?? ''}
                            disabled={saving.has(`${x.id}:social_account_id`) || !x.platform}
                            className={`${FIELD} ${x.social_account_id ? '' : 'border-amber-300'}`}
                            onChange={(e) => void patch(x.id, { social_account_id: e.target.value || null }, 'social_account_id')}>
                            <option value="">{isAr ? '— غير محدد —' : '— not set —'}</option>
                            {accounts.filter((a) => a.platform === x.platform).map((a) => (
                              <option key={a.id} value={a.id}>
                                {a.handle || a.display_name || a.id.slice(0, 8)}
                                {a.is_own_account === false ? (isAr ? ' (خارجي)' : ' (external)') : ''}
                              </option>))}
                          </select>
                          {!x.platform && (
                            <span className="mt-0.5 block text-[10.5px] text-charcoal/40">
                              {isAr ? 'اختر المنصة أولاً.' : 'Choose the platform first.'}
                            </span>
                          )}
                          {x.platform && accounts.filter((a) => a.platform === x.platform).length === 0 && (
                            <span className="mt-0.5 block text-[10.5px] text-amber-700">
                              {isAr ? 'لا حسابات مسجّلة لهذه المنصة.' : 'No accounts registered for this platform.'}
                            </span>
                          )}
                        </Field>
                        <Field label={isAr ? 'المسؤول' : 'Owner'}>
                          <select defaultValue={x.owner_user_id ?? ''} disabled={saving.has(`${x.id}:owner_user_id`)} className={FIELD}
                            onChange={(e) => void patch(x.id, { owner_user_id: e.target.value || null }, 'owner_user_id')}>
                            <option value="">{isAr ? '— بلا —' : '— none —'}</option>
                            {users.map((u) => <option key={u.id} value={u.id}>{(isAr ? u.name_ar : u.name_en) || u.name_en}</option>)}
                          </select>
                        </Field>
                        <Field label={isAr ? 'الحالة' : 'Status'}>
                          <select defaultValue={x.status} disabled={saving.has(`${x.id}:status`)} className={FIELD}
                            onChange={(e) => void patch(x.id, { status: e.target.value }, 'status')}>
                            {Object.keys(DELIVERABLE_STATUS_LABEL).map((s) => (
                              <option key={s} value={s}>{lbl(DELIVERABLE_STATUS_LABEL, s, isAr)}</option>))}
                          </select>
                        </Field>
                        <Field label={isAr ? 'نسبة العرض' : 'Aspect ratio'}>
                          <select defaultValue={x.aspect_ratio ?? ''} disabled={saving.has(`${x.id}:aspect_ratio`)} className={FIELD}
                            onChange={(e) => void patch(x.id, { aspect_ratio: e.target.value || null }, 'aspect_ratio')}>
                            <option value="">—</option>
                            {['9:16', '1:1', '4:5', '16:9', '2:3', '3:2', 'other'].map((a) => (
                              <option key={a} value={a}>{a}</option>))}
                          </select>
                        </Field>
                        <Field label={isAr ? 'المدة المستهدفة (ث)' : 'Target duration (s)'}>
                          <input type="number" defaultValue={x.target_seconds ?? ''} className={FIELD}
                            onBlur={(e) => { const v = e.target.value === '' ? null : Number(e.target.value);
                              if (v !== x.target_seconds) void patch(x.id, { target_seconds: v }, 'target_seconds'); }} />
                        </Field>
                        <Field label={isAr ? 'الاستحقاق' : 'Due date'}>
                          <input type="date" defaultValue={x.due_date ?? ''} className={FIELD}
                            onBlur={(e) => { const v = e.target.value || null;
                              if (v !== x.due_date) void patch(x.id, { due_date: v }, 'due_date'); }} />
                        </Field>
                        <Field label={isAr ? 'المقياس الأساسي' : 'Primary KPI'}>
                          <input defaultValue={x.primary_kpi ?? ''} className={FIELD}
                            onBlur={(e) => { const v = e.target.value.trim() || null;
                              if (v !== x.primary_kpi) void patch(x.id, { primary_kpi: v }, 'primary_kpi'); }} />
                        </Field>
                        <Field label={isAr ? 'الوحدة' : 'Unit'}
                          hint={isAr ? 'رقم بلا وحدة لا يعني شيئاً' : 'a number without a unit says nothing'}>
                          <input defaultValue={x.kpi_unit ?? ''} className={FIELD}
                            onBlur={(e) => { const v = e.target.value.trim() || null;
                              if (v !== x.kpi_unit) void patch(x.id, { kpi_unit: v }, 'kpi_unit'); }} />
                        </Field>
                        <Field label={isAr ? 'المستهدف' : 'Target'}>
                          <input type="number" defaultValue={x.kpi_target ?? ''} className={FIELD}
                            onBlur={(e) => { const v = e.target.value === '' ? null : Number(e.target.value);
                              if (v !== x.kpi_target) void patch(x.id, { kpi_target: v }, 'kpi_target'); }} />
                        </Field>
                      </div>

                      <div className="flex flex-wrap items-center gap-2 border-t border-sand/40 pt-2">
                        <span className="text-[11px] text-charcoal/55">
                          {isAr ? 'سير العمل:' : 'Workflow:'} {x.workflow_template_key ?? '—'}
                        </span>
                        <button type="button"
                          onClick={async () => {
                            try {
                              const r = await generateDeliverableTasks(x.id, false);
                              onToast(isAr ? `أُضيفت ${r.created} مهمة` : `${r.created} task(s) added`);
                              onChanged();
                            } catch (e) { onError(err(e)); }
                          }}
                          className="text-[11.5px] text-copper hover:underline">
                          {isAr ? 'توليد مهام سير العمل' : 'Generate workflow tasks'}
                        </button>
                      </div>
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </Section>
    </div>
  );
}

/** Picks which deliverable the tab is showing. Everything below the brief is
 *  per-deliverable, so every one of those tabs needs this. */
function DeliverablePicker({ d, sel, setSel, isAr }: {
  d: ContentOpsDetail; sel: string | null; setSel: (v: string) => void; isAr: boolean;
}) {
  if (d.deliverables.length === 0) return null;
  return (
    <div className="flex flex-wrap gap-1">
      {d.deliverables.map((x) => (
        <button key={x.id} type="button" onClick={() => setSel(x.id)}
          className={`rounded-full px-2.5 py-1 text-[11.5px] ${sel === x.id
            ? 'bg-charcoal text-white' : 'bg-white text-charcoal/65 hover:bg-sand/25'}`}>
          <Ltr>D{x.deliverable_number}</Ltr>{' '}
          {x.platform ? lbl(PLATFORM_LABEL, x.platform, isAr) : (isAr ? 'منصة؟' : 'platform?')}
        </button>
      ))}
    </div>
  );
}

function NoDeliverable({ isAr }: { isAr: boolean }) {
  return (
    <EmptyHint>
      {isAr ? 'أضف مخرَجاً أولاً — المخرَج هو ما يُكتب له وينتَج ويُنشر.'
            : 'Add a deliverable first — it is the thing that gets written, produced and published.'}
    </EmptyHint>
  );
}

// ── Writing (artifacts) ────────────────────────────────────────────────────
function WritingTab({ d, isAr, types, deliverable, setSel, onError, onToast, onChanged }: {
  d: ContentOpsDetail; isAr: boolean; types: ArtifactType[]; deliverable: Deliverable | null;
  setSel: (v: string) => void; onError: (m: string) => void;
  onToast: (m: string) => void; onChanged: () => void;
}) {
  const [expected, setExpected] = useState<string[]>([]);
  const [openType, setOpenType] = useState<string | null>(null);
  const [draft, setDraft] = useState('');
  const [summary, setSummary] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!deliverable) return;
    fetchArtifactTypes(deliverable.id).then((r) => setExpected(r.expected)).catch(() => {});
  }, [deliverable]);

  if (!deliverable) return <NoDeliverable isAr={isAr} />;

  const forDel = d.artifacts.filter((a) => a.deliverable_id === deliverable.id);
  const byType = new Map<string, Artifact[]>();
  for (const a of forDel) {
    if (!byType.has(a.version_type)) byType.set(a.version_type, []);
    byType.get(a.version_type)!.push(a);
  }
  // The workflow's own artifacts first, then anything else already written.
  const shown = [...new Set([...expected, ...byType.keys()])];

  const create = async (t: string) => {
    setBusy(true);
    try {
      await saveArtifact({
        content_item_id: d.item.id, deliverable_id: deliverable.id, version_type: t,
        payload: { text: draft }, change_summary: summary.trim() || null,
      });
      setDraft(''); setSummary(''); setOpenType(null);
      onToast(isAr ? 'أُنشئت نسخة جديدة' : 'New version created'); onChanged();
    } catch (e) { onError(err(e)); } finally { setBusy(false); }
  };

  const decide = async (a: Artifact, decision: 'approved' | 'changes_requested', comment?: string) => {
    setBusy(true);
    try {
      const r = await decideArtifact(a.id, decision, comment);
      onToast(r.stale.length
        ? (isAr ? `تم — و${r.stale.length} عنصر تابع يحتاج مراجعة`
                : `Done — ${r.stale.length} dependent artifact(s) now need review`)
        : (isAr ? 'تم' : 'Done'));
      onChanged();
    } catch (e) { onError(err(e)); } finally { setBusy(false); }
  };

  return (
    <div className="space-y-3">
      <DeliverablePicker d={d} sel={deliverable.id} setSel={setSel} isAr={isAr} />
      <Section title={isAr ? 'الكتابة والمواد' : 'Writing and artifacts'}
        subtitle={isAr ? 'الأنواع المطلوبة تأتي من سير عمل هذه الصيغة. النسخة المعتمدة لا تُعدَّل — التعديل يُنشئ نسخة جديدة.'
                       : 'The types come from this format’s workflow. An approved version is never edited — a change makes a new version.'}>
        {shown.length === 0 ? (
          <EmptyHint>{isAr ? 'لا مواد لهذه الصيغة' : 'No artifacts for this format'}</EmptyHint>
        ) : (
          <ul className="space-y-2">
            {shown.map((t) => {
              const meta = types.find((x) => x.key === t);
              const versions = (byType.get(t) ?? []).sort((a, b) => b.version_number - a.version_number);
              const approved = versions.find((v) => v.approval_state === 'approved');
              const latest = versions[0];
              const fileOnly = meta && ['file', 'media'].includes(meta.editor_kind);
              return (
                <li key={t} className="rounded-xl border border-sand/50 bg-white p-3">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <span className="text-[12.5px] font-medium text-charcoal">
                      {meta ? (isAr ? meta.label_ar : meta.label_en) : t}
                      {approved && (
                        <span className="ms-2 inline-flex items-center gap-1 rounded-full border border-emerald-200 bg-emerald-50 px-1.5 py-0.5 text-[10px] text-emerald-700">
                          <Lock className="h-2.5 w-2.5" />v{approved.version_number}
                        </span>)}
                      {approved?.is_stale && (
                        <span className="ms-1 rounded-full border border-amber-200 bg-amber-50 px-1.5 py-0.5 text-[10px] text-amber-800">
                          {isAr ? 'يحتاج مراجعة' : 'needs review'}
                        </span>)}
                    </span>
                    <span className="text-[11px] text-charcoal/50">
                      {versions.length ? `${versions.length} ${isAr ? 'نسخة' : 'version(s)'}` : (isAr ? 'لم تبدأ' : 'not started')}
                    </span>
                  </div>

                  {meta?.hint_ar && !versions.length && (
                    <p className="mt-1 text-[10.5px] text-charcoal/55">{isAr ? meta.hint_ar : meta.hint_en}</p>
                  )}

                  {latest && (
                    <div className="mt-2 rounded-lg border border-sand/40 bg-cream-light px-2.5 py-2">
                      <div className="flex flex-wrap items-center justify-between gap-2 text-[11px]">
                        <span className="text-charcoal/60">
                          v{latest.version_number} · {lbl(APPROVAL_LABEL, latest.approval_state, isAr)}
                        </span>
                        {latest.change_summary && (
                          <span className="text-charcoal/50">{latest.change_summary}</span>)}
                      </div>
                      {typeof latest.payload?.text === 'string' && latest.payload.text && (
                        <p className="mt-1 whitespace-pre-wrap text-[12px] leading-relaxed text-charcoal">
                          {String(latest.payload.text)}
                        </p>)}
                      {latest.review_comment && (
                        <p className="mt-1 text-[11px] text-amber-800">
                          {isAr ? 'ملاحظة المراجعة:' : 'Review note:'} {latest.review_comment}
                        </p>)}
                      {latest.approval_state !== 'approved' && (
                        <div className="mt-1.5 flex flex-wrap gap-2">
                          <Button variant="secondary" onClick={() => void decide(latest, 'approved')} disabled={busy}>
                            <Check className="h-3.5 w-3.5" />{isAr ? 'اعتماد' : 'Approve'}
                          </Button>
                          <button type="button" disabled={busy}
                            onClick={() => {
                              const c = window.prompt(isAr ? 'ما التعديل المطلوب؟' : 'What needs changing?');
                              if (c) void decide(latest, 'changes_requested', c);
                            }}
                            className="text-[11.5px] text-charcoal/60 hover:underline">
                            {isAr ? 'طلب تعديل' : 'Request changes'}
                          </button>
                        </div>)}
                    </div>
                  )}

                  <div className="mt-2">
                    {openType === t ? (
                      <div className="space-y-2">
                        {fileOnly ? (
                          <p className="rounded-lg border border-sand/50 bg-cream-light px-2.5 py-2 text-[11.5px] text-charcoal/70">
                            {isAr ? 'هذا النوع ملف وليس نصاً — ارفعه من تبويب «الإنتاج» ثم اربطه، ولا يُكتب في مربع نص.'
                                  : 'This type is a file, not text — upload it in Production and link it; it does not belong in a textarea.'}
                          </p>
                        ) : (
                          <textarea value={draft} onChange={(e) => setDraft(e.target.value)} rows={4}
                            className={FIELD} autoFocus
                            placeholder={meta ? (isAr ? meta.hint_ar ?? '' : meta.hint_en ?? '') : ''} />
                        )}
                        <input value={summary} onChange={(e) => setSummary(e.target.value)} className={FIELD}
                          placeholder={isAr ? 'ملخّص التغيير (ما الذي تغيّر ولماذا)' : 'Change summary (what changed and why)'} />
                        <div className="flex gap-2">
                          <Button onClick={() => void create(t)} disabled={busy || (!fileOnly && !draft.trim())}>
                            {versions.length ? (isAr ? `حفظ v${versions.length + 1}` : `Save v${versions.length + 1}`)
                                             : (isAr ? 'حفظ v1' : 'Save v1')}
                          </Button>
                          <button type="button" onClick={() => { setOpenType(null); setDraft(''); setSummary(''); }}
                            className="text-[11.5px] text-charcoal/55 hover:underline">
                            {isAr ? 'إلغاء' : 'Cancel'}
                          </button>
                        </div>
                      </div>
                    ) : (
                      <button type="button"
                        onClick={() => {
                          setOpenType(t);
                          setDraft(typeof latest?.payload?.text === 'string' ? String(latest.payload.text) : '');
                        }}
                        className="text-[11.5px] text-copper hover:underline">
                        {approved ? (isAr ? 'إنشاء نسخة جديدة' : 'Create a new version')
                                  : (isAr ? '+ نسخة' : '+ version')}
                      </button>
                    )}
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </Section>
    </div>
  );
}

// ── Production ─────────────────────────────────────────────────────────────
function ProductionTab({ d, isAr, deliverable, setSel, onError, onChanged }: {
  d: ContentOpsDetail; isAr: boolean; deliverable: Deliverable | null;
  setSel: (v: string) => void; onError: (m: string) => void; onChanged: () => void;
}) {
  const users = useAppStore((s) => s.users);
  const [busy, setBusy] = useState<string | null>(null);
  if (!deliverable) return <NoDeliverable isAr={isAr} />;

  const isVideo = ['reel', 'short_video', 'long_form_video', 'story', 'paid_video_ad']
    .includes(deliverable.format);
  const scenes = d.scenes.filter((s: VideoScene) => s.deliverable_id === deliverable.id);
  const tasks = d.tasks.filter((t) => t.deliverable_id === deliverable.id);
  const planned = scenes.reduce((a, s) => a + (s.planned_seconds ?? 0), 0);
  const assets = d.assets.filter((a) => a.target_id === deliverable.id);

  const setTask = async (t: ContentTask, patch: Record<string, unknown>) => {
    setBusy(t.id);
    try { await saveContentTask(t.id, patch); onChanged(); }
    catch (e) { onError(err(e)); } finally { setBusy(null); }
  };

  return (
    <div className="space-y-3">
      <DeliverablePicker d={d} sel={deliverable.id} setSel={setSel} isAr={isAr} />

      <Section title={isAr ? 'المهام' : 'Tasks'}
        subtitle={isAr ? 'مولّدة من صيغة هذا المخرَج — لا قائمة ثابتة لكل شيء.'
                       : 'Generated from this deliverable’s format — not one fixed list for everything.'}>
        {tasks.length === 0 ? (
          <EmptyHint>{isAr ? 'لا مهام — ولّدها من تبويب المخرجات' : 'No tasks — generate them from the Deliverables tab'}</EmptyHint>
        ) : (
          <ul className="divide-y divide-sand/30">
            {tasks.map((t) => (
              <li key={t.id} className="flex flex-wrap items-center gap-2 py-2">
                <span className="min-w-0 flex-1 truncate text-[12.5px] text-charcoal">
                  {t.title}
                  {t.template_key === 'legacy_fixed_12' && (
                    <span className="ms-1.5 rounded bg-charcoal/5 px-1.5 py-0.5 text-[10px] text-charcoal/45">
                      {isAr ? 'قديمة' : 'legacy'}
                    </span>)}
                  {t.blocked_reason && (
                    <span className="ms-1.5 text-[10.5px] text-amber-700">{t.blocked_reason}</span>)}
                </span>
                <select value={t.assigned_user_id ?? ''} disabled={busy === t.id}
                  className={`${FIELD} w-auto`}
                  onChange={(e) => void setTask(t, { assigned_user_id: e.target.value || null })}>
                  <option value="">{isAr ? '— بلا —' : '— none —'}</option>
                  {users.map((u) => <option key={u.id} value={u.id}>{(isAr ? u.name_ar : u.name_en) || u.name_en}</option>)}
                </select>
                <select value={t.status} disabled={busy === t.id} className={`${FIELD} w-auto`}
                  onChange={(e) => {
                    const v = e.target.value;
                    // A skip must say why — the database refuses one without a reason.
                    if (v === 'skipped') {
                      const r = window.prompt(isAr ? 'سبب التجاوز؟' : 'Why is this being skipped?');
                      if (!r) return;
                      void setTask(t, { status: v, skipped_reason: r });
                    } else void setTask(t, { status: v });
                  }}>
                  {Object.keys(TASK_STATUS_LABEL).map((s) => (
                    <option key={s} value={s}>{lbl(TASK_STATUS_LABEL, s, isAr)}</option>))}
                </select>
              </li>))}
          </ul>
        )}
      </Section>

      {isVideo ? (
        <Section title={isAr ? 'المشاهد' : 'Scenes'}
          right={<span className="text-[11.5px] text-charcoal/60">
            {scenes.length === 0
              ? (isAr ? 'لم تُخطَّط بعد' : 'not planned yet')
              : <>{isAr ? 'المدة المخطّطة' : 'Planned'} <span className="tabular-nums">{planned}s</span></>}
          </span>}>
          {scenes.length === 0 ? (
            <EmptyHint>{isAr ? 'لا مشاهد بعد' : 'No scenes yet'}</EmptyHint>
          ) : (
            <ul className="space-y-2">
              {scenes.map((s) => (
                <li key={s.id} className="rounded-lg border border-sand/50 bg-white px-3 py-2">
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-[12px] font-medium text-charcoal">
                      <Ltr className="text-charcoal/45">#{s.scene_number}</Ltr> {s.scene_type}
                    </span>
                    <span className="text-[11px] tabular-nums text-charcoal/55">
                      {s.planned_seconds ? `${s.planned_seconds}s` : '—'}
                    </span>
                  </div>
                  {s.visual_description && (
                    <p className="mt-0.5 text-[11.5px] text-charcoal/70">{s.visual_description}</p>)}
                  {s.voice_over && (
                    <p className="mt-0.5 text-[11.5px] text-charcoal/55">🎙 {s.voice_over}</p>)}
                  {s.location && (
                    <p className="mt-0.5 text-[10.5px] text-charcoal/45">{s.location}</p>)}
                </li>))}
            </ul>
          )}
        </Section>
      ) : (
        <Section title={isAr ? 'الإنتاج' : 'Production'}>
          <p className="text-[12px] text-charcoal/60">
            {isAr ? `صيغة «${lbl(FORMAT_LABEL, deliverable.format, true)}» لا تُخطَّط بالمشاهد. الإنتاج هنا هو التصميم والمواد المرتبطة أدناه.`
                  : `A ${lbl(FORMAT_LABEL, deliverable.format, false).toLowerCase()} is not planned in scenes. Production here is the design and the linked assets below.`}
          </p>
        </Section>
      )}

      <Section title={isAr ? 'المواد المرتبطة' : 'Linked assets'}
        subtitle={isAr ? 'الربط لا ينسخ الملف — المادة تبقى في المكتبة ويمكن أن يستخدمها أكثر من محتوى.'
                       : 'Linking never copies the file — the asset stays in the library and can serve several content items.'}>
        {assets.length === 0 ? (
          <EmptyHint>{isAr ? 'لا مواد مرتبطة بهذا المخرَج' : 'No assets linked to this deliverable'}</EmptyHint>
        ) : (
          <ul className="space-y-1.5">
            {assets.map((a) => (
              <li key={`${a.asset_id}-${a.target_id}`}
                className="flex items-center justify-between gap-2 rounded-lg border border-sand/50 bg-white px-2.5 py-1.5">
                <span className="min-w-0 truncate text-[12px] text-charcoal">
                  {String((a.mkt_raw_assets as { asset_name?: string } | null)?.asset_name ?? a.asset_id)}
                </span>
                <span className="shrink-0 text-[10.5px] text-charcoal/50">{a.role ?? '—'}</span>
              </li>))}
          </ul>
        )}
      </Section>
    </div>
  );
}

// ── Publishing ─────────────────────────────────────────────────────────────
function PublishingTab({ d, isAr, types, onError, onToast, onChanged, onJump }: {
  d: ContentOpsDetail; isAr: boolean; types: ArtifactType[];
  onError: (m: string) => void; onToast: (m: string) => void;
  onChanged: () => void; onJump: (t: TabKey) => void;
}) {
  const [busy, setBusy] = useState(false);

  // The honest empty state: the thing you need is a deliverable, not a
  // "platform" checkbox somewhere.
  if (d.deliverables.length === 0) {
    return (
      <Section title={isAr ? 'النشر' : 'Publishing'}>
        <EmptyHint>
          <div className="space-y-2">
            <p>{isAr ? 'لا شيء لنشره بعد — النشر يتم لكل مخرَج على حدة.'
                     : 'Nothing to publish yet — publishing happens per deliverable.'}</p>
            <Button onClick={() => onJump('deliverables')}>
              <Plus className="h-4 w-4" />{isAr ? 'أضف مخرَجاً' : 'Add a deliverable'}
            </Button>
          </div>
        </EmptyHint>
      </Section>
    );
  }

  const schedule = async (x: Deliverable) => {
    const when = window.prompt(
      isAr ? 'وقت النشر (بتوقيت الرياض) — مثال 2026-08-30 19:30' : 'Publish time (Riyadh) — e.g. 2026-08-30 19:30');
    if (!when) return;
    setBusy(true);
    try {
      const iso = new Date(when.replace(' ', 'T')).toISOString();
      await saveDeliverable({ planned_publish_at: iso }, x.id);
      const existing = d.publications.find((p) => p.deliverable_id === x.id);
      await savePublication({
        content_item_id: d.item.id, deliverable_id: x.id,
        platform: x.platform, channel: x.distribution === 'paid' ? 'paid' : 'organic',
        scheduled_for: iso, status: 'scheduled', publish_method: 'manual',
      }, existing?.id);
      onToast(isAr ? 'جُدول' : 'Scheduled'); onChanged();
    } catch (e) { onError(err(e)); } finally { setBusy(false); }
  };

  const publish = async (pubId: string) => {
    const url = window.prompt(isAr ? 'رابط المنشور بعد نشره يدوياً' : 'The post URL after publishing it manually');
    if (!url) return;
    setBusy(true);
    try { await markPublished(pubId, { published_url: url }); onToast(isAr ? 'سُجّل النشر' : 'Recorded'); onChanged(); }
    catch (e) { onError(err(e)); } finally { setBusy(false); }
  };

  return (
    <div className="space-y-3">
      <Section title={isAr ? 'النشر' : 'Publishing'}
        subtitle={isAr ? 'لا يوجد ربط آلي بأي منصة — النشر يدوي، ويُسجَّل الرابط بعده.'
                       : 'No platform API is connected — publishing is manual and the URL is recorded afterwards.'}>
        <ul className="space-y-2">
          {d.deliverables.map((x) => {
            const pub = d.publications.find((p) => p.deliverable_id === x.id);
            const blockers = x.blockers ?? [];
            return (
              <li key={x.id} className="rounded-xl border border-sand/50 bg-white p-3">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span className="text-[12.5px] text-charcoal">
                    <Ltr className="text-charcoal/45">D{x.deliverable_number}</Ltr>{' '}
                    {x.platform ? lbl(PLATFORM_LABEL, x.platform, isAr) : (isAr ? 'منصة؟' : 'platform?')}
                    <span className="text-charcoal/50"> · {lbl(DISTRIBUTION_LABEL, x.distribution, isAr)}</span>
                  </span>
                  <span className="text-[11px] text-charcoal/60">
                    {pub ? pub.status : (isAr ? 'غير مجدول' : 'not scheduled')}
                  </span>
                </div>

                {x.planned_publish_at && (
                  <div className="mt-1 text-[11.5px] text-charcoal/65">
                    {isAr ? 'الموعد:' : 'When:'}{' '}
                    {fmtDate(x.planned_publish_at, isAr)}{' '}
                    <Ltr className="tabular-nums">
                      {new Date(x.planned_publish_at).toLocaleTimeString(isAr ? 'ar-SA' : 'en-GB',
                        { hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Riyadh' })}
                    </Ltr>
                    <span className="text-charcoal/45"> {isAr ? '(الرياض)' : '(Riyadh)'}</span>
                  </div>
                )}

                {blockers.length > 0 ? (
                  <div className="mt-1.5 flex flex-wrap items-center gap-1">
                    <span className="text-[11px] text-amber-800">{isAr ? 'قبل الجدولة:' : 'Before scheduling:'}</span>
                    {blockers.map((b) => (
                      <span key={b} className="rounded-full border border-amber-200 bg-amber-50 px-1.5 py-0.5 text-[10px] text-amber-800">
                        {blockerLabel(b, isAr, types)}
                      </span>))}
                  </div>
                ) : (
                  <div className="mt-2 flex flex-wrap items-center gap-2">
                    {pub?.status !== 'published' && (
                      <Button variant="secondary" onClick={() => void schedule(x)} disabled={busy}>
                        {isAr ? 'جدولة' : 'Schedule'}
                      </Button>
                    )}
                    {pub && pub.status === 'scheduled' && (
                      <Button onClick={() => void publish(pub.id)} disabled={busy}>
                        <Send className="h-3.5 w-3.5" />{isAr ? 'نُشر يدوياً — سجّل الرابط' : 'Published manually — record URL'}
                      </Button>
                    )}
                  </div>
                )}

                {pub?.published_url && (
                  <a href={pub.published_url} target="_blank" rel="noreferrer"
                    className="mt-1.5 inline-flex items-center gap-1 text-[11.5px] text-copper hover:underline">
                    <ExternalLink className="h-3.5 w-3.5" />
                    <Ltr className="max-w-[22rem] truncate">{pub.published_url}</Ltr>
                  </a>
                )}
              </li>
            );
          })}
        </ul>
      </Section>
    </div>
  );
}

// ── Results ────────────────────────────────────────────────────────────────
function ResultsTab({ d, isAr, onError, onToast, onChanged }: {
  d: ContentOpsDetail; isAr: boolean; onError: (m: string) => void;
  onToast: (m: string) => void; onChanged: () => void;
}) {
  const [openFor, setOpenFor] = useState<string | null>(null);
  const [f, setF] = useState({ kpi_actual: '', leads: '', clicks: '', spend: '', learning: '', recommendation: '' });
  const [busy, setBusy] = useState(false);

  const submit = async (deliverableId: string) => {
    setBusy(true);
    try {
      await recordResult({
        content_item_id: d.item.id, deliverable_id: deliverableId,
        goal_id: d.item.primary_goal_id,
        kpi_actual: f.kpi_actual === '' ? null : Number(f.kpi_actual),
        measured_at: new Date().toISOString().slice(0, 10),
        leads: f.leads === '' ? null : Number(f.leads),
        clicks: f.clicks === '' ? null : Number(f.clicks),
        spend: f.spend === '' ? null : Number(f.spend),
        learning: f.learning.trim() || null,
        recommendation: f.recommendation || null,
      });
      setF({ kpi_actual: '', leads: '', clicks: '', spend: '', learning: '', recommendation: '' });
      setOpenFor(null); onToast(isAr ? 'سُجّلت النتيجة' : 'Result recorded'); onChanged();
    } catch (e) { onError(err(e)); } finally { setBusy(false); }
  };

  return (
    <div className="space-y-3">
      <Section title={isAr ? 'النتائج' : 'Results'}
        subtitle={isAr ? 'النشر شيء والنتيجة شيء آخر. لا أرقام آلية من المنصات — تُدخل يدوياً وتُقارن بمستهدف المخرَج.'
                       : 'Publishing and performance are separate. No platform metrics are wired — figures are entered by hand and compared with the deliverable’s own target.'}>
        {d.deliverables.length === 0 ? <NoDeliverable isAr={isAr} /> : (
          <ul className="space-y-2">
            {d.deliverables.map((x) => {
              const at = x.attainment;
              const rows = d.results.filter((r) => r.deliverable_id === x.id);
              return (
                <li key={x.id} className="rounded-xl border border-sand/50 bg-white p-3">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <span className="text-[12.5px] text-charcoal">
                      <Ltr className="text-charcoal/45">D{x.deliverable_number}</Ltr>{' '}
                      {x.platform ? lbl(PLATFORM_LABEL, x.platform, isAr) : (isAr ? 'منصة؟' : 'platform?')}
                    </span>
                    <button type="button" onClick={() => setOpenFor(openFor === x.id ? null : x.id)}
                      className="text-[11.5px] text-copper hover:underline">
                      {isAr ? '+ قراءة' : '+ reading'}
                    </button>
                  </div>

                  <div className="mt-2 grid grid-cols-2 gap-2.5 sm:grid-cols-4">
                    <Stat label={isAr ? 'المستهدف' : 'Target'}
                      value={at?.target != null ? `${at.target}${at.unit ? ` ${at.unit}` : ''}` : null} />
                    <Stat label={isAr ? 'الفعلي' : 'Actual'}
                      value={at?.is_measured ? String(at.actual) : null}
                      hint={at?.is_measured ? undefined : (isAr ? 'لم يُقس بعد' : 'not measured yet')} />
                    <Stat label={isAr ? 'نسبة التحقيق' : 'Attainment'}
                      value={at?.attainment_pct != null ? `${at.attainment_pct}%` : null} />
                    <Stat label={isAr ? 'القراءات' : 'Readings'} value={rows.length || null} />
                  </div>

                  {openFor === x.id && (
                    <div className="mt-2 grid gap-2 rounded-lg border border-copper/30 bg-copper/5 p-2.5 sm:grid-cols-4">
                      <Field label={`${isAr ? 'الفعلي' : 'Actual'}${x.kpi_unit ? ` (${x.kpi_unit})` : ''}`}>
                        <input type="number" value={f.kpi_actual} className={FIELD}
                          onChange={(e) => setF({ ...f, kpi_actual: e.target.value })} />
                      </Field>
                      <Field label={isAr ? 'العملاء المحتملون' : 'Leads'}>
                        <input type="number" value={f.leads} className={FIELD}
                          onChange={(e) => setF({ ...f, leads: e.target.value })} />
                      </Field>
                      <Field label={isAr ? 'النقرات' : 'Clicks'}>
                        <input type="number" value={f.clicks} className={FIELD}
                          onChange={(e) => setF({ ...f, clicks: e.target.value })} />
                      </Field>
                      <Field label={isAr ? 'الإنفاق' : 'Spend'}>
                        <input type="number" value={f.spend} className={FIELD}
                          onChange={(e) => setF({ ...f, spend: e.target.value })} />
                      </Field>
                      <Field label={isAr ? 'ما تعلّمناه' : 'What we learned'} span="sm:col-span-3">
                        <input value={f.learning} className={FIELD}
                          onChange={(e) => setF({ ...f, learning: e.target.value })} />
                      </Field>
                      <Field label={isAr ? 'التوصية' : 'Recommendation'}>
                        <select value={f.recommendation} className={FIELD}
                          onChange={(e) => setF({ ...f, recommendation: e.target.value })}>
                          <option value="">—</option>
                          {Object.keys(RECOMMENDATION_LABEL).map((r) => (
                            <option key={r} value={r}>{lbl(RECOMMENDATION_LABEL, r, isAr)}</option>))}
                        </select>
                      </Field>
                      <div className="sm:col-span-4">
                        <Button onClick={() => void submit(x.id)} disabled={busy}>{isAr ? 'تسجيل' : 'Record'}</Button>
                      </div>
                    </div>
                  )}

                  {rows.length > 0 && (
                    <ul className="mt-2 space-y-1">
                      {rows.map((r) => (
                        <li key={r.id} className="flex flex-wrap items-center gap-x-3 gap-y-0.5 border-t border-sand/30 pt-1.5 text-[11.5px]">
                          <span className="tabular-nums text-charcoal">{r.kpi_actual ?? '—'}</span>
                          <span className="text-charcoal/50">{r.measured_at ? fmtDate(r.measured_at, isAr) : '—'}</span>
                          {r.leads != null && <span className="text-charcoal/60">{isAr ? 'عملاء:' : 'leads:'} {r.leads}</span>}
                          {r.recommendation && (
                            <span className="rounded bg-cream px-1.5 py-0.5 text-[10px] text-charcoal/70">
                              {lbl(RECOMMENDATION_LABEL, r.recommendation, isAr)}
                            </span>)}
                          {r.learning && <span className="text-charcoal/55">{r.learning}</span>}
                        </li>))}
                    </ul>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </Section>
    </div>
  );
}

// ── History ────────────────────────────────────────────────────────────────
function HistoryTab({ d, isAr }: { d: ContentOpsDetail; isAr: boolean }) {
  const users = useAppStore((s) => s.users);
  const name = (id: string | null) => {
    if (!id) return isAr ? 'النظام' : 'system';
    const u = users.find((x) => x.id === id);
    return u ? ((isAr ? u.name_ar : u.name_en) || u.name_en) : '—';
  };

  // One stream: state transitions and approvals in the order they happened.
  const stream = [
    ...d.history.map((h) => ({
      at: h.changed_at, who: h.changed_by_user_id,
      what: isAr ? `${h.from_status ? `${lbl(STAGE_LABEL, h.from_status, true)} ← ` : ''}${lbl(STAGE_LABEL, h.to_status, true)}`
                 : `${h.from_status ? `${lbl(STAGE_LABEL, h.from_status, false)} → ` : ''}${lbl(STAGE_LABEL, h.to_status, false)}`,
      note: h.reason, kind: 'stage' as const, id: h.id,
    })),
    ...d.artifacts.filter((a) => a.approved_at).map((a) => ({
      at: a.approved_at!, who: a.approved_by_user_id,
      what: `${a.version_type} v${a.version_number} — ${lbl(APPROVAL_LABEL, 'approved', isAr)}`,
      note: a.change_summary, kind: 'approval' as const, id: a.id,
    })),
  ].sort((a, b) => b.at.localeCompare(a.at));

  if (stream.length === 0) {
    return <EmptyHint>{isAr ? 'لا سجل بعد' : 'Nothing recorded yet'}</EmptyHint>;
  }
  return (
    <Section title={isAr ? 'السجل' : 'Activity'}>
      <ul className="space-y-1.5">
        {stream.map((e) => (
          <li key={`${e.kind}-${e.id}`} className="flex flex-wrap items-baseline gap-x-2 border-b border-sand/25 pb-1.5 text-[11.5px] last:border-0">
            <span className="text-charcoal/45">{fmtDate(e.at, isAr)}</span>
            <span className="text-charcoal/70">{name(e.who)}</span>
            <span className="text-charcoal">{e.what}</span>
            {e.note && <span className="text-charcoal/50">— {e.note}</span>}
          </li>))}
      </ul>
    </Section>
  );
}
