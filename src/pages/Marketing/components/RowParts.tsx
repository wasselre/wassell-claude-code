/**
 * The pieces a ROW is drawn from — shared by the designer pane and the one
 * approval component so the two can never disagree about what a post looks
 * like, what order it publishes in, or whether its caption is confirmed.
 *
 * Nothing here fetches and nothing here acts. Every piece takes what
 * `row_detail` already returned.
 */
import { ReactNode } from 'react';
import type { MosAsset, MosAssetLink, MosStep } from '@/lib/marketingOS/client';
import {
  MosRowDetail, MosRowMember, RowSlotRole,
  captionSourceOf, captionStateOf, designBriefOf, hashtagsOf, headlinesOf,
  publishPosition, slotLink,
} from '@/lib/marketingOS/rowClient';
import { Pill } from './kit';
import { IconCheck, IconLibrary } from './icons';
import { num, pct } from '../lib/format';

/* ── the two slots, named once ──────────────────────────────────────── */

export const SLOT_META: Record<RowSlotRole, {
  ar: string; en: string; ratio: string; hintAr: string; hintEn: string; vertical: boolean;
}> = {
  final_square: {
    ar: 'مربّع ١:١ · منشور الفيد', en: 'Square 1:1 · the feed post',
    ratio: '1:1', hintAr: 'وهو وحده الذي يحمل التعليق والهاشتاقات',
    hintEn: 'the only one that carries the caption and hashtags', vertical: false,
  },
  final_vertical: {
    ar: 'عمودي ٩:١٦ · الستوري', en: 'Vertical 9:16 · the story',
    ratio: '9:16', hintAr: 'صورة فقط، بلا تعليق، في نفس الفتحة',
    hintEn: 'image only, no caption, in the same slot', vertical: true,
  },
};

export const SLOTS: RowSlotRole[] = ['final_square', 'final_vertical'];

/* ── small primitives ───────────────────────────────────────────────── */

/** The reading-order badge — «١» / «٢» / «٣». */
export function OrderBadge({ n, isAr, tone }: { n: number; isAr: boolean; tone?: 'ok' | 'gap' }) {
  return (
    <span
      style={{
        display: 'inline-grid', placeItems: 'center', minWidth: 26, height: 26,
        borderRadius: 8, fontSize: 12.5, fontWeight: 700,
        background: tone === 'gap' ? 'color-mix(in srgb, var(--late) 16%, transparent)' : 'var(--line)',
        color: tone === 'gap' ? 'var(--late)' : 'var(--ink)',
      }}
    >
      {num(n, isAr)}
    </span>
  );
}

/** One `label: value` fact. */
export function Fact({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div style={{ fontSize: 12.5, lineHeight: 1.9 }}>
      <span style={{ color: 'var(--mute)' }}>{label}: </span>
      <b style={{ fontWeight: 700 }}>{children}</b>
    </div>
  );
}

/**
 * The step rail, read off the version pinned on the ROW — never the workflow's
 * current definition, so a path edit cannot relabel a row already walking it.
 */
export function RowTimeline({
  steps, currentKey, isAr,
}: { steps: MosStep[]; currentKey: string | null; isAr: boolean }) {
  const ordered = [...steps].sort((a, b) => a.position - b.position);
  const at = ordered.findIndex((s) => s.key === currentKey);
  return (
    <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 6 }}>
      {ordered.map((s, i) => {
        const state = at < 0 ? 'todo' : i < at ? 'done' : i === at ? 'now' : 'todo';
        return (
          <span key={s.key} style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
            {i > 0 && <span style={{ color: 'var(--mute)', fontSize: 11 }}>‹</span>}
            <span
              style={{
                fontSize: 11.5, padding: '3px 9px', borderRadius: 999,
                fontWeight: state === 'now' ? 700 : 400,
                background: state === 'now' ? 'var(--copper, #B8734F)' : 'var(--line)',
                color: state === 'now' ? '#fff' : state === 'done' ? 'var(--ink)' : 'var(--mute)',
              }}
            >
              {isAr ? s.label_ar : s.label_en}
            </span>
          </span>
        );
      })}
    </div>
  );
}

/* ── the writing, read-only ─────────────────────────────────────────── */

/**
 * «أسطر المنشور» — the ordered lines that land ON the design. This is the main
 * object of the writing task and the thing the designer lays out; it is NOT a
 * list of alternative titles and nothing here picks one.
 */
export function PostLines({ member, isAr }: { member: MosRowMember; isAr: boolean }) {
  const lines = headlinesOf(member);
  return (
    <div>
      <div className="lbl" style={{ marginBottom: 6 }}>
        {isAr ? 'أسطر المنشور — النص الذي يظهر على التصميم' : 'Post lines — the copy that lands on the design'}
        <span style={{ fontWeight: 400, color: 'var(--mute)' }}> · {num(lines.length, isAr)}</span>
      </div>
      {lines.length === 0 ? (
        <div style={{ fontSize: 12.5, color: 'var(--late)' }}>
          {isAr ? 'لا أسطر بعد — لا يمكن تصميم هذا المنشور.' : 'No lines yet — this post cannot be designed.'}
        </div>
      ) : (
        <ol style={{ margin: 0, paddingInlineStart: 20, display: 'grid', gap: 5 }}>
          {lines.map((l, i) => (
            <li key={`${i}-${l.slice(0, 12)}`} style={{ fontSize: 13, lineHeight: 1.85 }}>{l}</li>
          ))}
        </ol>
      )}
    </div>
  );
}

/** «موجز التصميم» — one sentence to the designer. */
export function DesignBrief({ member, isAr }: { member: MosRowMember; isAr: boolean }) {
  const brief = designBriefOf(member);
  if (!brief) return null;
  return (
    <div>
      <div className="lbl" style={{ marginBottom: 5 }}>{isAr ? 'موجز التصميم' : 'Design brief'}</div>
      <div style={{ fontSize: 12.5, lineHeight: 1.9 }}>{brief}</div>
    </div>
  );
}

/**
 * The caption, read-only, with its provenance.
 *
 * Two things are always visible: whether the WRITER confirmed this exact text
 * (an AI draft is never pre-confirmed), and who drafted it. A manager approving
 * writing should be able to see at a glance which captions the AI wrote and the
 * writer merely accepted.
 */
export function CaptionBlock({
  member, isAr, label, tone,
}: {
  member: MosRowMember;
  isAr: boolean;
  label?: string;
  /** 'context' dims it — the designer is not laying the caption out. */
  tone?: 'primary' | 'context';
}) {
  const { text, confirmed } = captionStateOf(member);
  const source = captionSourceOf(member);
  const tags = hashtagsOf(member);
  const dim = tone === 'context';
  return (
    <div style={{ opacity: dim ? 0.82 : 1 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', marginBottom: 5 }}>
        <span className="lbl" style={{ margin: 0 }}>
          {label ?? (isAr ? 'التعليق — للقراءة فقط' : 'The caption — read only')}
        </span>
        {text === '' ? (
          <Pill tone="late">{isAr ? 'لا تعليق' : 'no caption'}</Pill>
        ) : confirmed ? (
          <Pill tone="go">{isAr ? 'أكّده الكاتب' : 'writer-confirmed'}</Pill>
        ) : (
          <Pill tone="late">{isAr ? 'غير مؤكَّد' : 'unconfirmed'}</Pill>
        )}
        {source === 'ai' && (
          <span className="tag">{isAr ? 'مسودة ذكاء اصطناعي' : 'AI draft'}</span>
        )}
        {source === 'fallback' && (
          <span className="tag">{isAr ? 'مسودة من الأسطر' : 'drafted from the lines'}</span>
        )}
      </div>
      <div style={{ fontSize: 13, lineHeight: 1.95, whiteSpace: 'pre-wrap' }}>
        {text || (isAr ? '—' : '—')}
      </div>
      {tags.length > 0 && (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginTop: 7 }}>
          {tags.map((t) => <span key={t} className="tag ltr">{t}</span>)}
        </div>
      )}
    </div>
  );
}

/* ── material ───────────────────────────────────────────────────────── */

export interface SlotView {
  role: RowSlotRole;
  link: MosAssetLink | null;
  asset: MosAsset | null;
}

/** The two slots of one member, resolved against the row's links and assets. */
export function slotsOfMember(
  detail: Pick<MosRowDetail, 'links' | 'assets'>,
  contentId: string,
): SlotView[] {
  return SLOTS.map((role) => {
    const link = slotLink(detail.links, contentId, role);
    const asset = link ? detail.assets.find((a) => a.id === link.asset_id) ?? null : null;
    return { role, link, asset };
  });
}

/** How many of the row's six slots are filled. */
export function slotsFilled(
  detail: Pick<MosRowDetail, 'links' | 'assets' | 'members'>,
): { filled: number; total: number } {
  let filled = 0;
  for (const m of detail.members) {
    for (const s of slotsOfMember(detail, m.id)) if (s.link) filled += 1;
  }
  return { filled, total: detail.members.length * SLOTS.length };
}

/**
 * The picture in a slot. `url`/`thumb` come from the caller's `useAssetUrls`
 * so one signing round-trip serves the whole row.
 */
export function SlotFrame({
  role, asset, url, thumb, empty, children,
}: {
  role: RowSlotRole;
  asset: MosAsset | null;
  url: string | null;
  thumb: string | null;
  empty?: ReactNode;
  children?: ReactNode;
}) {
  const meta = SLOT_META[role];
  return (
    <div
      style={{
        aspectRatio: meta.vertical ? '9 / 16' : '1 / 1',
        width: meta.vertical ? 132 : 180, maxWidth: '100%', maxHeight: 250,
        borderRadius: 10, background: 'var(--line)', overflow: 'hidden',
        display: 'grid', placeItems: 'center', justifySelf: 'center',
        border: asset ? 'none' : '1px dashed var(--line-strong, var(--mute))',
      }}
    >
      {asset && asset.kind === 'video' && url
        ? <video src={url} controls style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
        : asset && thumb
          ? <img src={thumb} alt="" style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
          : asset
            ? <IconLibrary />
            : <span style={{ fontSize: 11.5, color: 'var(--mute)', textAlign: 'center', padding: 8 }}>{empty}</span>}
      {children}
    </div>
  );
}

/* ── the post shell both panes hang their body inside ───────────────── */

/**
 * One post of the row, with its reading position and what that means for when
 * it goes out.
 *
 * The writer's FIRST-read post publishes LAST — Instagram shows the newest
 * first, so the reverse of the reading order is what makes the profile read the
 * way it was composed. Every pane says so in the same words.
 */
export function PostShell({
  member, index, total, isAr, right, children, tone,
}: {
  member: MosRowMember;
  index: number;
  total: number;
  isAr: boolean;
  /** The status pill / controls on the far side of the header. */
  right?: ReactNode;
  children: ReactNode;
  tone?: 'ok' | 'gap';
}) {
  const pos = publishPosition(index, total);
  const when = pos === total
    ? (isAr ? 'يُنشر أوّلًا داخل الدفعة' : 'publishes first in the batch')
    : pos === 1
      ? (isAr ? 'يُنشر أخيرًا داخل الدفعة' : 'publishes last in the batch')
      : (isAr ? 'يُنشر في منتصف الدفعة' : 'publishes in the middle of the batch');
  return (
    <div
      className="card"
      style={{
        padding: 13, display: 'grid', gap: 11,
        borderColor: tone === 'gap' ? 'color-mix(in srgb, var(--late) 40%, transparent)' : undefined,
      }}
    >
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 10, flexWrap: 'wrap' }}>
        <OrderBadge n={index + 1} isAr={isAr} tone={tone} />
        <div style={{ minWidth: 0, flex: 1 }}>
          <div style={{ fontSize: 12.5, fontWeight: 700 }}>
            <span className="ltr">{member.ref ?? ''}</span>
            {member.ref ? ' · ' : ''}
            {member.title}
          </div>
          <div style={{ fontSize: 11.5, color: 'var(--mute)', marginTop: 2 }}>
            {isAr
              ? `المرتبة ${num(index + 1, true)} في القراءة — ${when}`
              : `#${index + 1} in reading order — ${when}`}
          </div>
        </div>
        {right}
      </div>
      {children}
    </div>
  );
}

/* ── refusal ────────────────────────────────────────────────────────── */

/**
 * The engine's refusal, named.
 *
 * `MOS:REQUIREMENTS_MISSING` carries WHICH post and WHICH slot; without this
 * card that becomes «رفضت قاعدة البيانات هذا التغيير» and the designer has to
 * ask the manager what is missing. The row goes out whole or not at all, so
 * there is no partial-send escape and none is offered.
 */
export function MissingCard({
  missing, isAr, title, why, children,
}: {
  missing: Array<{ member: string | null; label_ar: string; label_en: string }>;
  isAr: boolean;
  title: string;
  why?: string;
  children?: ReactNode;
}) {
  return (
    <div className="notice bad" role="alert">
      <div style={{ fontWeight: 700, marginBottom: 5 }}>{title}</div>
      {why && <div style={{ marginBottom: 8, lineHeight: 1.9 }}>{why}</div>}
      <ul style={{ margin: 0, paddingInlineStart: 20, display: 'grid', gap: 4 }}>
        {missing.map((m, i) => (
          <li key={`${m.member ?? ''}-${m.label_en}-${i}`} style={{ fontSize: 12.5, lineHeight: 1.8 }}>
            {m.member && <b className="ltr" style={{ fontWeight: 700 }}>{m.member}</b>}
            {m.member ? ' — ' : ''}
            {isAr ? m.label_ar : m.label_en}
          </li>
        ))}
      </ul>
      {children && <div style={{ marginTop: 10 }}>{children}</div>}
    </div>
  );
}

/* ── preflight ──────────────────────────────────────────────────────── */

/** One line of the pre-publish check. */
export function CheckLine({
  ok, label, value,
}: { ok: boolean; label: ReactNode; value: ReactNode }) {
  return (
    <div
      style={{
        display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap',
        padding: '9px 0', borderTop: '1px solid var(--line)',
      }}
    >
      <span style={{ color: ok ? 'var(--go, #2E7D32)' : 'var(--late)', display: 'inline-flex' }}>
        {ok ? <IconCheck /> : <span style={{ fontWeight: 700 }}>×</span>}
      </span>
      <span style={{ fontSize: 12.5, flex: 1, minWidth: 140 }}>{label}</span>
      <Pill tone={ok ? 'go' : 'late'}>{value}</Pill>
    </div>
  );
}

/** «٥ من ٦ · ٨٣٪» — readiness as one bar. */
export function ReadinessMeter({
  filled, total, isAr,
}: { filled: number; total: number; isAr: boolean }) {
  const frac = total === 0 ? 0 : filled / total;
  const done = filled === total;
  return (
    <div style={{ display: 'grid', gap: 6, minWidth: 190 }}>
      <div className="lbl" style={{ margin: 0 }}>{isAr ? 'جاهزية الدفعة' : 'Batch readiness'}</div>
      <div style={{ height: 7, borderRadius: 999, background: 'var(--line)', overflow: 'hidden' }}>
        <div
          style={{
            height: '100%', width: `${Math.round(frac * 100)}%`,
            background: done ? 'var(--go, #2E7D32)' : 'var(--gold, #C09B5F)',
          }}
        />
      </div>
      <div style={{ fontSize: 12, color: 'var(--mute)' }}>
        {isAr
          ? `${num(filled, true)} من ${num(total, true)} · ${pct(frac * 100, true)}`
          : `${filled} of ${total} · ${pct(frac * 100, false)}`}
      </div>
    </div>
  );
}
