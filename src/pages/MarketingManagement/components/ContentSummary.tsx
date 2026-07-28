/**
 * The "what is going on with this piece" strip, the status controls, and the
 * results summary.
 *
 * Two things this fixes. The header used to show four counts and nothing a
 * person could act on — you had to scroll to learn who owns it or why it is
 * stuck. And the status control rendered ALL seventeen other statuses as
 * buttons, with a caption admitting the database would reject the wrong ones;
 * that is a state machine handed to the user with validation outsourced.
 *
 * Legal moves now come from the database (mkt_content_next_statuses, derived
 * from the same rule the trigger enforces) so the two can never disagree. When
 * a move a person expects is absent, the panel says which state it needs.
 */
import { AlertTriangle, ArrowRight, User, CalendarClock, Building2, CircleDot } from 'lucide-react';
import { Section, Stat, EmptyHint, CaveatStrip, fmtDate } from '@/pages/MarketingIntelligence/components/shared';
import { useAppStore } from '@/stores/appStore';
import { useProject } from '@/lib/marketingMgmt/projects';
import {
  PLATFORM_LABEL, PUBLICATION_STATUS_LABEL, ORGANIC_PAID_LABEL, FUNNEL_STAGE_LABEL, lbl,
} from '@/lib/marketingMgmt/labels';
import { STATUS_LABEL, CONTENT_STATUSES, type ContentDetail, type ContentStatus } from '@/lib/marketingMgmt/client';

/** Which state each status can be reached FROM — used to explain an absent move.
 *  Mirrors mkt_content_status_allowed for MESSAGING ONLY; the buttons themselves
 *  come from the database, so a drift here changes wording, never behaviour. */
const REACHED_FROM: Partial<Record<string, string[]>> = {
  approved_for_production: ['awaiting_script_approval'],
  recording: ['approved_for_production', 'raw_assets_required', 'revision_requested'],
  designing: ['approved_for_production', 'raw_assets_required', 'revision_requested'],
  editing: ['approved_for_production', 'raw_assets_required', 'recording', 'revision_requested'],
  internal_review: ['recording', 'designing', 'editing', 'revision_requested'],
  awaiting_final_approval: ['internal_review'],
  approved: ['awaiting_final_approval'],
  ready_to_publish: ['approved', 'scheduled'],
  scheduled: ['ready_to_publish'],
  published: ['ready_to_publish', 'scheduled'],
};

export function ContentSummary({ detail, isAr, busy, onMove, onError }: {
  detail: ContentDetail; isAr: boolean; busy: boolean;
  onMove: (id: string, to: ContentStatus) => void; onError: (m: string) => void;
}) {
  void onError;
  const i = detail.item;
  const users = useAppStore((s) => s.users);
  const project = useProject(i.project_id);

  const owner = users.find((u) => u.id === i.owner_user_id);
  const ownerName = owner ? ((isAr ? owner.name_ar : owner.name_en) || owner.name_en) : null;

  const openTasks = detail.tasks.filter((t) => t.status !== 'completed');
  const blockedTask = detail.tasks.find((t) => t.status === 'blocked');
  const done = detail.tasks.length - openTasks.length;

  // Deadline honesty: overdue is a fact worth colouring, "no date" is not zero.
  const due = i.due_date ? new Date(i.due_date) : null;
  const overdue = due != null && due < new Date(new Date().toDateString())
    && i.status !== 'published' && i.status !== 'archived';

  const allowed = detail.allowed_transitions;
  const forward = (allowed ?? []).filter((s) => s !== 'cancelled' && s !== 'archived');
  const terminal = (allowed ?? []).filter((s) => s === 'cancelled' || s === 'archived');

  const missingFor = (target: string): string | null => {
    const from = REACHED_FROM[target];
    if (!from || from.length === 0) return null;
    const names = from.map((s) => (isAr ? STATUS_LABEL[s as ContentStatus]?.ar : STATUS_LABEL[s as ContentStatus]?.en) ?? s);
    return isAr ? `يتطلب الحالة: ${names.join(' أو ')}` : `needs: ${names.join(' or ')}`;
  };

  return (
    <Section title={`${i.content_number} · ${i.title}`}
      subtitle={project ? `${project.name}${project.developer ? ` · ${project.developer}` : ''}` : undefined}>
      {/* ── the five things worth knowing at a glance ── */}
      <div className="grid gap-2.5 sm:grid-cols-2 lg:grid-cols-4">
        <div className="rounded-xl border border-copper/25 bg-copper/5 p-2.5">
          <div className="mb-1 flex items-center gap-1 text-[10.5px] font-medium text-charcoal/50">
            <CircleDot className="h-3 w-3" />{isAr ? 'الحالة' : 'Status'}
          </div>
          <div className="text-[13px] font-semibold text-copper-500">
            {isAr ? STATUS_LABEL[i.status].ar : STATUS_LABEL[i.status].en}
          </div>
        </div>
        <div className="rounded-xl border border-sand/50 bg-white p-2.5">
          <div className="mb-1 flex items-center gap-1 text-[10.5px] font-medium text-charcoal/50">
            <User className="h-3 w-3" />{isAr ? 'المسؤول' : 'Owner'}
          </div>
          <div className={`text-[13px] ${ownerName ? 'text-charcoal' : 'text-amber-700'}`}>
            {ownerName ?? (isAr ? 'بلا مسؤول' : 'unassigned')}
          </div>
        </div>
        <div className={`rounded-xl border p-2.5 ${overdue ? 'border-red-200 bg-red-50' : 'border-sand/50 bg-white'}`}>
          <div className="mb-1 flex items-center gap-1 text-[10.5px] font-medium text-charcoal/50">
            <CalendarClock className="h-3 w-3" />{isAr ? 'الاستحقاق' : 'Due'}
          </div>
          <div className={`text-[13px] ${overdue ? 'font-semibold text-red-700' : 'text-charcoal'}`}>
            {i.due_date ? fmtDate(i.due_date, isAr) : '—'}
            {overdue && <span className="ms-1 text-[11px]">{isAr ? '(متأخر)' : '(overdue)'}</span>}
          </div>
        </div>
        <div className="rounded-xl border border-sand/50 bg-white p-2.5">
          <div className="mb-1 flex items-center gap-1 text-[10.5px] font-medium text-charcoal/50">
            <Building2 className="h-3 w-3" />{isAr ? 'المشروع' : 'Project'}
          </div>
          <div className={`truncate text-[13px] ${project ? 'text-charcoal' : 'text-charcoal/35'}`}>
            {project?.name ?? (isAr ? 'غير مرتبط' : 'not linked')}
          </div>
        </div>
      </div>

      {/* ── next action / blocker ── */}
      <div className="mt-2.5 grid gap-2.5 sm:grid-cols-2">
        <div className="rounded-xl border border-sand/50 bg-white p-2.5">
          <div className="mb-1 flex items-center gap-1 text-[10.5px] font-medium text-charcoal/50">
            <ArrowRight className={`h-3 w-3 ${isAr ? 'rotate-180' : ''}`} />{isAr ? 'الإجراء التالي' : 'Next action'}
          </div>
          <div className="text-[12.5px] text-charcoal">
            {i.next_action || (
              <span className="text-charcoal/35">
                {openTasks.length > 0
                  ? (isAr ? `أقرب مهمة: ${openTasks[0]!.title}` : `next task: ${openTasks[0]!.title}`)
                  : (isAr ? 'لم يُحدد' : 'not set')}
              </span>
            )}
          </div>
        </div>
        <div className={`rounded-xl border p-2.5 ${(i.blocker || blockedTask) ? 'border-amber-200 bg-amber-50' : 'border-sand/50 bg-white'}`}>
          <div className="mb-1 flex items-center gap-1 text-[10.5px] font-medium text-charcoal/50">
            <AlertTriangle className="h-3 w-3" />{isAr ? 'المعوّق' : 'Blocker'}
          </div>
          <div className="text-[12.5px] text-charcoal">
            {i.blocker
              || (blockedTask
                ? (isAr ? `مهمة محجوبة: ${blockedTask.title}` : `blocked task: ${blockedTask.title}`)
                : <span className="text-charcoal/35">{isAr ? 'لا يوجد' : 'none'}</span>)}
          </div>
        </div>
      </div>

      {/* ── counts ── */}
      <div className="mt-2.5 grid grid-cols-2 gap-2.5 sm:grid-cols-4">
        <Stat label={isAr ? 'المهام' : 'Tasks'} value={`${done}/${detail.tasks.length}`} />
        <Stat label={isAr ? 'النسخ' : 'Versions'} value={detail.versions.length} />
        <Stat label={isAr ? 'المنشورات' : 'Publications'} value={detail.publications.length} />
        <Stat label={isAr ? 'المنصات' : 'Platforms'}
          value={(i.mkt_content_platforms ?? []).length || null} />
      </div>

      {/* ── status moves: only the legal ones ── */}
      <div className="mt-3 border-t border-sand/40 pt-3">
        {allowed === null ? (
          /* The RPC is missing, so this build is deployed ahead of its migration.
             Fall back to the OLD behaviour — offer every status, let the database
             reject the wrong ones — because showing NO buttons would remove a
             control that works today. Deliberately not a local copy of the
             transition map: a wrong guess here is worse than offering a move
             Postgres refuses with a clear message. */
          <>
            <div className="mb-2">
              <CaveatStrip>
                {isAr ? 'قاعدة البيانات تفتقد دالة mkt_content_next_statuses، لذا تُعرض كل الحالات وسترفض القاعدة غير المسموح منها. طبّق آخر ترحيل لعرض الخطوات الصحيحة فقط.'
                      : 'The database is missing mkt_content_next_statuses, so every status is listed and the database rejects invalid ones. Apply the latest migration to see only the legal steps.'}
              </CaveatStrip>
            </div>
            <div className="flex flex-wrap gap-1.5">
              {CONTENT_STATUSES.filter((s) => s !== i.status).map((s) => (
                <button key={s} type="button" disabled={busy} onClick={() => onMove(i.id, s)}
                  className="rounded-lg border border-sand/60 bg-white px-2 py-1 text-[11px] text-charcoal/70 hover:border-copper/50 hover:text-charcoal disabled:opacity-40">
                  {isAr ? STATUS_LABEL[s].ar : STATUS_LABEL[s].en}
                </button>
              ))}
            </div>
          </>
        ) : (
          <>
            <div className="mb-1.5 text-[11px] font-medium text-charcoal/50">
              {isAr ? 'الانتقال إلى' : 'Move to'}
            </div>
            {forward.length === 0 ? (
              <EmptyHint>{isAr ? 'لا انتقالات متاحة من هذه الحالة' : 'No forward moves from this status'}</EmptyHint>
            ) : (
              <div className="flex flex-wrap gap-1.5">
                {forward.map((s) => (
                  <button key={s} type="button" disabled={busy}
                    onClick={() => onMove(i.id, s as ContentStatus)}
                    className="rounded-lg border border-copper/40 bg-copper/5 px-2.5 py-1 text-[11.5px] font-medium text-copper-500 hover:bg-copper/10 disabled:opacity-40">
                    {isAr ? STATUS_LABEL[s as ContentStatus]?.ar : STATUS_LABEL[s as ContentStatus]?.en}
                  </button>
                ))}
              </div>
            )}

            {/* What a person might be looking for and cannot see */}
            {(() => {
              const wanted = ['approved_for_production', 'awaiting_final_approval', 'approved', 'ready_to_publish', 'published']
                .filter((s) => s !== i.status && !forward.includes(s));
              const explained = wanted.map((s) => ({ s, why: missingFor(s) })).filter((x) => x.why);
              if (explained.length === 0) return null;
              return (
                <details className="mt-2">
                  <summary className="cursor-pointer text-[11px] text-charcoal/45 hover:text-charcoal/70">
                    {isAr ? 'لماذا لا أرى خطوة معيّنة؟' : "Why can't I see a particular step?"}
                  </summary>
                  <ul className="mt-1.5 space-y-1">
                    {explained.map(({ s, why }) => (
                      <li key={s} className="text-[11px] text-charcoal/55">
                        <span className="font-medium text-charcoal/70">
                          {isAr ? STATUS_LABEL[s as ContentStatus]?.ar : STATUS_LABEL[s as ContentStatus]?.en}
                        </span>
                        {' — '}{why}
                      </li>
                    ))}
                  </ul>
                </details>
              );
            })()}

            {terminal.length > 0 && (
              <div className="mt-2 flex flex-wrap gap-1.5 border-t border-sand/30 pt-2">
                {terminal.map((s) => (
                  <button key={s} type="button" disabled={busy}
                    onClick={() => onMove(i.id, s as ContentStatus)}
                    className="rounded-lg border border-sand/60 bg-white px-2.5 py-1 text-[11px] text-charcoal/50 hover:border-red-300 hover:text-red-700 disabled:opacity-40">
                    {isAr ? STATUS_LABEL[s as ContentStatus]?.ar : STATUS_LABEL[s as ContentStatus]?.en}
                  </button>
                ))}
              </div>
            )}
          </>
        )}
      </div>
    </Section>
  );
}

// ── Results: publications + performance + attribution, compactly ────────────
const num = (v: unknown): number | null => {
  const n = typeof v === 'number' ? v : typeof v === 'string' ? Number(v) : NaN;
  return Number.isFinite(n) ? n : null;
};

export function ContentResults({ detail, isAr }: { detail: ContentDetail; isAr: boolean }) {
  const pubs = detail.publications;
  const snaps = detail.performance;
  const attrib = detail.attributions;

  // Latest snapshot per publication — performance is append-only, so "current"
  // is the newest row, never a sum across captures of the same post.
  const latestByPub = new Map<string, Record<string, unknown>>();
  for (const s of snaps) {
    const pid = String(s.publication_id ?? '');
    if (!latestByPub.has(pid)) latestByPub.set(pid, s);   // API already sorts desc
  }
  const totals = { views: 0, engagement: 0, clicks: 0 };
  let measured = 0;
  for (const s of latestByPub.values()) {
    const v = num(s.views) ?? num(s.impressions);
    const likes = num(s.likes) ?? 0, comments = num(s.comments) ?? 0, shares = num(s.shares) ?? 0;
    const clicks = num(s.link_clicks);
    if (v != null) { totals.views += v; measured += 1; }
    totals.engagement += likes + comments + shares;
    if (clicks != null) totals.clicks += clicks;
  }
  const leads = attrib.length;
  const published = pubs.filter((p) => p.status === 'published');

  return (
    <Section title={isAr ? 'النتيجة' : 'Results'}
      subtitle={isAr ? 'من بيانات النشر والأداء والإسناد الموجودة — لا يوجد جمع تلقائي بعد'
                     : 'From existing publication, performance and attribution data — no automatic collection yet'}>
      {pubs.length === 0 ? (
        <EmptyHint>
          {isAr ? 'لم يُجدول هذا المحتوى بعد — لا توجد نتيجة تُقاس.'
                : 'This content has not been scheduled yet — there is nothing to measure.'}
        </EmptyHint>
      ) : (
        <>
          <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-4">
            <Stat label={isAr ? 'منشور' : 'Published'} value={`${published.length}/${pubs.length}`} />
            <Stat label={isAr ? 'مشاهدات' : 'Views'} value={measured > 0 ? totals.views : null} />
            <Stat label={isAr ? 'تفاعل' : 'Engagement'} value={measured > 0 ? totals.engagement : null} />
            <Stat label={isAr ? 'عملاء مُسندون' : 'Attributed leads'} value={leads > 0 ? leads : null} />
          </div>

          {published.length > 0 && measured === 0 && (
            <div className="mt-2.5">
              <CaveatStrip>
                {isAr ? 'نُشر بلا بيانات أداء — لم تُسجَّل أي قراءة بعد (بانتظار البيانات، وليس صفراً).'
                      : 'Published with no performance data — nothing captured yet (awaiting data, not zero).'}
              </CaveatStrip>
            </div>
          )}

          <ul className="mt-3 divide-y divide-sand/40">
            {pubs.map((p) => {
              const s = latestByPub.get(p.id);
              const v = s ? (num(s.views) ?? num(s.impressions)) : null;
              return (
                <li key={p.id} className="flex flex-wrap items-center justify-between gap-2 py-2 text-[12px]">
                  <span className="flex min-w-0 items-center gap-2">
                    <span className="font-medium text-charcoal">{lbl(PLATFORM_LABEL, p.platform, isAr)}</span>
                    <span className="text-charcoal/50">{lbl(PUBLICATION_STATUS_LABEL, p.status, isAr)}</span>
                  </span>
                  <span className="flex shrink-0 items-center gap-3 text-charcoal/55">
                    <span>{p.published_at ? fmtDate(p.published_at, isAr)
                      : p.scheduled_for ? fmtDate(p.scheduled_for, isAr) : '—'}</span>
                    <span className="tabular-nums">
                      {v != null ? v.toLocaleString(isAr ? 'ar-SA' : 'en-US')
                        : <span className="text-charcoal/30">{isAr ? 'بلا قياس' : 'no data'}</span>}
                    </span>
                  </span>
                </li>
              );
            })}
          </ul>

          <p className="mt-2 text-[11px] text-charcoal/45">
            {isAr
              ? `${lbl(ORGANIC_PAID_LABEL, detail.item.organic_or_paid ?? '', isAr)} · ${lbl(FUNNEL_STAGE_LABEL, detail.item.funnel_stage ?? '', isAr)}`
              : `${lbl(ORGANIC_PAID_LABEL, detail.item.organic_or_paid ?? '', isAr)} · ${lbl(FUNNEL_STAGE_LABEL, detail.item.funnel_stage ?? '', isAr)}`}
          </p>
        </>
      )}
    </Section>
  );
}
