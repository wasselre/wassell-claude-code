/**
 * The campaign content builder.
 *
 * Operational intent (owner's words): "when I create a campaign I should be able
 * to create content in bulk while customizing every piece — the manager makes a
 * campaign and its content all at once and the workflow starts."
 *
 * The flow, primary → secondary:
 *   1. WRITE CONTENT (the obvious default). Fill a template — type, a base
 *      headline, platforms, projects — pick "how many", and Generate populates
 *      that many rows into an editable table. Each row is then tweakable (its
 *      own headline, date, type…).
 *   2. SCHEDULE (an optional extra, tucked away). A weekly cadence that stamps
 *      evenly-spaced target dates across the rows — for the steady organic
 *      posting case. It is a tool applied to the rows, not the way you make them.
 *
 * Purpose is CONSTRAINED by the campaign: an organic campaign has no ad spend,
 * so its content can never be "paid" — the purpose control only appears for a
 * paid campaign. (Reported flaw: paid was selectable inside an organic campaign.)
 *
 * Self-contained + controlled: the parent holds `drafts` and does the create.
 * Styling rides the shared `mos.css` classes so it sits inside the campaign form.
 */
import { useMemo, useRef, useState } from 'react';
import type { MosContentType, MosProject } from '@/lib/marketingOS/client';
import { generateCadenceDates } from '../lib/campaignCadence';

export type ContentPurpose = 'organic' | 'paid' | 'both';

/** One planned content piece. `key` is local-only; the server assigns the real id. */
export interface ContentDraft {
  key: string;
  typeKey: string;
  title: string;
  /** `YYYY-MM-DD` (matches the date input), or '' for no target date. */
  targetDate: string;
  platforms: string[];
  projectIds: string[];
  purpose: ContentPurpose;
}

const PLATFORMS = ['instagram', 'tiktok', 'snapchat', 'x', 'linkedin'] as const;
type Platform = (typeof PLATFORMS)[number];

const PLATFORM_LABEL: Record<Platform, { ar: string; en: string }> = {
  instagram: { ar: 'إنستغرام', en: 'Instagram' },
  tiktok: { ar: 'تيك توك', en: 'TikTok' },
  snapchat: { ar: 'سناب شات', en: 'Snapchat' },
  x: { ar: 'إكس', en: 'X' },
  linkedin: { ar: 'لينكدإن', en: 'LinkedIn' },
};

const PURPOSE_LABEL: Record<ContentPurpose, { ar: string; en: string }> = {
  organic: { ar: 'عضوي', en: 'Organic' },
  paid: { ar: 'مدفوع', en: 'Paid' },
  both: { ar: 'كلاهما', en: 'Both' },
};
// Shown for a PAID campaign only. An organic campaign shows no purpose control —
// its content is always organic (no ad spend exists to make a piece "paid").
const PURPOSE_OPTS: ContentPurpose[] = ['organic', 'paid', 'both'];

const WEEKDAYS: Array<{ value: number; ar: string; en: string }> = [
  { value: 0, ar: 'الأحد', en: 'Sun' },
  { value: 1, ar: 'الاثنين', en: 'Mon' },
  { value: 2, ar: 'الثلاثاء', en: 'Tue' },
  { value: 3, ar: 'الأربعاء', en: 'Wed' },
  { value: 4, ar: 'الخميس', en: 'Thu' },
  { value: 5, ar: 'الجمعة', en: 'Fri' },
  { value: 6, ar: 'السبت', en: 'Sat' },
];

const INTERVALS: Array<{ days: number; ar: string; en: string }> = [
  { days: 1, ar: 'يوميًا', en: 'Daily' },
  { days: 3, ar: 'كل ٣ أيام', en: 'Every 3 days' },
  { days: 7, ar: 'أسبوعيًا', en: 'Weekly' },
  { days: 14, ar: 'كل أسبوعين', en: 'Biweekly' },
];

const MAX_BATCH = 100;

interface CampaignContentBuilderProps {
  isAr: boolean;
  /** Our Projects only — the parent passes the already-filtered list. */
  projects: MosProject[];
  contentTypes: MosContentType[];
  drafts: ContentDraft[];
  onChange: (drafts: ContentDraft[]) => void;
  /** Paid campaign → content purpose is selectable; organic → forced organic. */
  paid: boolean;
  /** The campaign's projects seed every new content template. */
  defaultProjectIds: string[];
}

const clampInt = (v: number, lo: number, hi: number): number =>
  Math.max(lo, Math.min(hi, Math.floor(Number.isFinite(v) ? v : lo)));

export default function CampaignContentBuilder({
  isAr, projects, contentTypes, drafts, onChange, paid, defaultProjectIds,
}: CampaignContentBuilderProps): JSX.Element {
  const seq = useRef(0);
  const newKey = (): string => { seq.current += 1; return `d${seq.current}`; };
  const firstType = contentTypes[0]?.key ?? '';

  // ── The template (the primary "write content" surface) ─────────────
  const [tType, setTType] = useState(firstType);
  const [tHeadline, setTHeadline] = useState('');
  const [tPlatforms, setTPlatforms] = useState<string[]>([]);
  const [tProjects, setTProjects] = useState<string[]>(defaultProjectIds);
  const [tPurpose, setTPurpose] = useState<ContentPurpose>(paid ? 'paid' : 'organic');
  const [count, setCount] = useState(4);

  const projectName = useMemo(() => {
    const byId = new Map(projects.map((p) => [p.id, p.project_name ?? p.id.slice(0, 8)]));
    return (id: string): string => byId.get(id) ?? id.slice(0, 8);
  }, [projects]);

  const rowTitle = (base: string, oneBasedIndex: number, batchSize: number): string => {
    const b = base.trim();
    if (b) return batchSize > 1 ? `${b} ${isAr ? toArabic(oneBasedIndex) : oneBasedIndex}` : b;
    return isAr ? `منشور ${toArabic(oneBasedIndex)}` : `Post ${oneBasedIndex}`;
  };

  const generate = (): void => {
    const n = clampInt(count, 1, MAX_BATCH);
    const start = drafts.length;
    const batch: ContentDraft[] = Array.from({ length: n }, (_, i) => ({
      key: newKey(),
      typeKey: tType || firstType,
      title: rowTitle(tHeadline, start + i + 1, n),
      targetDate: '',
      platforms: [...tPlatforms],
      projectIds: [...tProjects],
      purpose: paid ? tPurpose : 'organic',
    }));
    onChange([...drafts, ...batch]);
  };

  const addBlank = (): void => onChange([...drafts, {
    key: newKey(),
    typeKey: tType || firstType,
    title: '',
    targetDate: '',
    platforms: [...tPlatforms],
    projectIds: [...tProjects],
    purpose: paid ? tPurpose : 'organic',
  }]);

  const patch = (key: string, over: Partial<ContentDraft>): void =>
    onChange(drafts.map((d) => (d.key === key ? { ...d, ...over } : d)));
  const remove = (key: string): void => onChange(drafts.filter((d) => d.key !== key));

  // ── The optional weekly scheduler (applied to the existing rows) ────
  const [schedOpen, setSchedOpen] = useState(false);
  const [startDate, setStartDate] = useState('');
  const [intervalDays, setIntervalDays] = useState(7);
  const [weekday, setWeekday] = useState<number | null>(null);

  const applySchedule = (): void => {
    const dates = generateCadenceDates({ count: drafts.length, startDate, intervalDays, weekday });
    if (dates.length === 0) return;
    onChange(drafts.map((d, i) => {
      const nd = dates[i];
      return nd ? { ...d, targetDate: nd } : d;
    }));
  };

  const [openRow, setOpenRow] = useState<string | null>(null);

  const cols = paid
    ? '24px 116px minmax(130px,1fr) 140px 130px 30px 30px'
    : '24px 116px minmax(130px,1fr) 140px 30px 30px';

  return (
    <div style={{ display: 'grid', gap: 12 }}>
      {/* ── 1. Write content (the primary surface) ─────────────────── */}
      <div>
        <div className="lbl" style={{ marginBottom: 6 }}>{isAr ? 'المحتوى' : 'Content'}</div>
        <div
          style={{
            display: 'grid',
            gap: 9,
            padding: 11,
            borderRadius: 10,
            border: '1px solid var(--line, rgba(255,255,255,0.10))',
            background: 'var(--panel, rgba(255,255,255,0.03))',
          }}
        >
          <div style={{ fontSize: 11.5, color: 'var(--mute)' }}>
            {isAr
              ? 'اكتب عنوانًا وحدّد التفاصيل، ثم كم قطعة تريد — تُنسخ إلى جدول تُعدّل فيه كل صف.'
              : 'Write a headline and set the details, then how many you want — they populate a table you edit row by row.'}
          </div>

          {/* Headline is the emphasized, primary field. */}
          <input
            className="inp"
            style={{ fontSize: 15 }}
            placeholder={isAr ? 'العنوان المبدئي للمحتوى' : "The content's working headline"}
            value={tHeadline}
            onChange={(e) => setTHeadline(e.target.value)}
          />

          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'end' }}>
            <label style={{ display: 'grid', gap: 3 }}>
              <span className="lbl">{isAr ? 'النوع' : 'Type'}</span>
              <select className="inp" style={{ minWidth: 130 }} value={tType} onChange={(e) => setTType(e.target.value)}>
                {contentTypes.map((t) => (
                  <option key={t.key} value={t.key}>{isAr ? t.label_ar : t.label_en}</option>
                ))}
              </select>
            </label>
            {paid && (
              <label style={{ display: 'grid', gap: 3 }}>
                <span className="lbl">{isAr ? 'الغرض' : 'Purpose'}</span>
                <div className="seg">
                  {PURPOSE_OPTS.map((p) => (
                    <button key={p} type="button" className={tPurpose === p ? 'on' : ''} onClick={() => setTPurpose(p)}>
                      {isAr ? PURPOSE_LABEL[p].ar : PURPOSE_LABEL[p].en}
                    </button>
                  ))}
                </div>
              </label>
            )}
            <label style={{ display: 'grid', gap: 3 }}>
              <span className="lbl">{isAr ? 'كم قطعة' : 'How many'}</span>
              <input
                className="inp"
                style={{ width: 72 }}
                type="number"
                min={1}
                max={MAX_BATCH}
                value={count}
                onChange={(e) => setCount(clampInt(Number(e.target.value), 1, MAX_BATCH))}
              />
            </label>
            <button type="button" className="fbtn on" style={{ height: 38 }} onClick={generate}>
              {isAr ? '+ توليد المحتوى' : '+ Generate content'}
            </button>
            <button type="button" className="fbtn" style={{ height: 38 }} onClick={addBlank}>
              {isAr ? '+ صف واحد' : '+ One row'}
            </button>
          </div>

          {/* Shared platforms + projects — applied to every generated row. */}
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
            {PLATFORMS.map((p) => (
              <button
                key={p}
                type="button"
                className={`fbtn${tPlatforms.includes(p) ? ' on' : ''}`}
                onClick={() => setTPlatforms((cur) => (cur.includes(p) ? cur.filter((x) => x !== p) : [...cur, p]))}
              >
                {isAr ? PLATFORM_LABEL[p].ar : PLATFORM_LABEL[p].en}
              </button>
            ))}
          </div>
          <ProjectPicker isAr={isAr} projects={projects} selected={tProjects} projectName={projectName} onChange={setTProjects} />
        </div>
      </div>

      {/* ── 2. The editable table of rows ──────────────────────────── */}
      {drafts.length > 0 && (
        <div style={{ border: '1px solid var(--line, rgba(255,255,255,0.10))', borderRadius: 10, overflow: 'hidden' }}>
          <div style={{
            display: 'grid', gridTemplateColumns: cols, gap: 6, padding: '7px 9px',
            fontSize: 11, color: 'var(--mute)', background: 'var(--panel, rgba(255,255,255,0.03))',
            alignItems: 'center',
          }}>
            <span>#</span>
            <span>{isAr ? 'النوع' : 'Type'}</span>
            <span>{isAr ? 'العنوان' : 'Headline'}</span>
            <span>{isAr ? 'التاريخ' : 'Date'}</span>
            {paid && <span>{isAr ? 'الغرض' : 'Purpose'}</span>}
            <span />
            <span />
          </div>

          {drafts.map((d, i) => (
            <div key={d.key} style={{ borderTop: '1px solid var(--line, rgba(255,255,255,0.07))' }}>
              <div style={{ display: 'grid', gridTemplateColumns: cols, gap: 6, padding: '7px 9px', alignItems: 'center' }}>
                <span style={{ fontSize: 12, color: 'var(--mute)' }}>{isAr ? toArabic(i + 1) : i + 1}</span>
                <select className="inp" style={{ padding: '4px 6px', fontSize: 12 }} value={d.typeKey} onChange={(e) => patch(d.key, { typeKey: e.target.value })}>
                  {contentTypes.map((t) => (
                    <option key={t.key} value={t.key}>{isAr ? t.label_ar : t.label_en}</option>
                  ))}
                </select>
                <input
                  className="inp"
                  style={{ padding: '4px 8px', fontSize: 13 }}
                  placeholder={isAr ? 'العنوان المبدئي' : 'Working headline'}
                  value={d.title}
                  onChange={(e) => patch(d.key, { title: e.target.value })}
                />
                <input
                  className="inp ltr"
                  style={{ padding: '4px 8px', fontSize: 12 }}
                  type="date"
                  value={d.targetDate}
                  onChange={(e) => patch(d.key, { targetDate: e.target.value })}
                />
                {paid && (
                  <select className="inp" style={{ padding: '4px 6px', fontSize: 12 }} value={d.purpose} onChange={(e) => patch(d.key, { purpose: e.target.value as ContentPurpose })}>
                    {PURPOSE_OPTS.map((p) => (
                      <option key={p} value={p}>{isAr ? PURPOSE_LABEL[p].ar : PURPOSE_LABEL[p].en}</option>
                    ))}
                  </select>
                )}
                <button
                  type="button"
                  className="fbtn"
                  style={{ padding: '4px 6px' }}
                  title={isAr ? 'المنصات والمشاريع' : 'Platforms and projects'}
                  onClick={() => setOpenRow((r) => (r === d.key ? null : d.key))}
                >
                  {openRow === d.key ? '▴' : '▾'}
                </button>
                <button type="button" className="fbtn" style={{ padding: '4px 6px' }} title={isAr ? 'إزالة' : 'Remove'} onClick={() => remove(d.key)}>
                  ✕
                </button>
              </div>

              {openRow === d.key && (
                <div style={{ display: 'grid', gap: 8, padding: '2px 12px 12px' }}>
                  <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                    {PLATFORMS.map((p) => (
                      <button
                        key={p}
                        type="button"
                        className={`fbtn${d.platforms.includes(p) ? ' on' : ''}`}
                        onClick={() => patch(d.key, {
                          platforms: d.platforms.includes(p) ? d.platforms.filter((x) => x !== p) : [...d.platforms, p],
                        })}
                      >
                        {isAr ? PLATFORM_LABEL[p].ar : PLATFORM_LABEL[p].en}
                      </button>
                    ))}
                  </div>
                  <ProjectPicker isAr={isAr} projects={projects} selected={d.projectIds} projectName={projectName} onChange={(ids) => patch(d.key, { projectIds: ids })} />
                </div>
              )}
            </div>
          ))}
        </div>
      )}

      {/* ── 3. Optional weekly scheduler (secondary) ───────────────── */}
      {drafts.length > 0 && (
        <div style={{ border: '1px solid var(--line, rgba(255,255,255,0.10))', borderRadius: 10, overflow: 'hidden' }}>
          <button
            type="button"
            onClick={() => setSchedOpen((v) => !v)}
            style={{
              width: '100%', display: 'flex', alignItems: 'center', justifyContent: 'space-between',
              gap: 8, padding: '9px 11px', background: 'transparent', border: 'none', cursor: 'pointer',
              color: 'var(--ink)', fontFamily: 'inherit', fontSize: 13,
            }}
          >
            <span>{isAr ? '🗓 جدولة النشر أسبوعيًا (اختياري)' : '🗓 Schedule posting weekly (optional)'}</span>
            <span style={{ color: 'var(--mute)' }}>{schedOpen ? '▴' : '▾'}</span>
          </button>
          {schedOpen && (
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'end', padding: '0 11px 12px' }}>
              <label style={{ display: 'grid', gap: 3 }}>
                <span className="lbl">{isAr ? 'يبدأ' : 'Starts'}</span>
                <input className="inp ltr" type="date" value={startDate} onChange={(e) => setStartDate(e.target.value)} />
              </label>
              <label style={{ display: 'grid', gap: 3 }}>
                <span className="lbl">{isAr ? 'التكرار' : 'Cadence'}</span>
                <select className="inp" value={intervalDays} onChange={(e) => setIntervalDays(Number(e.target.value))}>
                  {INTERVALS.map((iv) => (<option key={iv.days} value={iv.days}>{isAr ? iv.ar : iv.en}</option>))}
                </select>
              </label>
              <label style={{ display: 'grid', gap: 3 }}>
                <span className="lbl">{isAr ? 'اليوم (اختياري)' : 'Weekday (optional)'}</span>
                <select className="inp" value={weekday ?? ''} onChange={(e) => setWeekday(e.target.value === '' ? null : Number(e.target.value))}>
                  <option value="">{isAr ? 'أي يوم' : 'Any day'}</option>
                  {WEEKDAYS.map((w) => (<option key={w.value} value={w.value}>{isAr ? w.ar : w.en}</option>))}
                </select>
              </label>
              <button type="button" className="fbtn on" style={{ height: 38 }} disabled={!startDate} onClick={applySchedule}>
                {isAr ? 'طبّق التواريخ على الصفوف' : 'Apply dates to the rows'}
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/**
 * A compact searchable multi-select for the project link. Restricted to whatever
 * `projects` the parent hands in (Our Projects). Kept inline for now.
 */
function ProjectPicker({
  isAr, projects, selected, projectName, onChange,
}: {
  isAr: boolean;
  projects: MosProject[];
  selected: string[];
  projectName: (id: string) => string;
  onChange: (ids: string[]) => void;
}): JSX.Element {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState('');

  const filtered = useMemo(() => {
    const needle = q.trim().toLowerCase();
    if (!needle) return projects;
    return projects.filter((p) => (p.project_name ?? '').toLowerCase().includes(needle));
  }, [projects, q]);

  const toggle = (id: string): void => {
    onChange(selected.includes(id) ? selected.filter((x) => x !== id) : [...selected, id]);
  };

  return (
    <div style={{ display: 'grid', gap: 6 }}>
      <button type="button" className="fbtn" style={{ justifySelf: 'start' }} onClick={() => setOpen((v) => !v)}>
        {selected.length === 0
          ? (isAr ? 'المشاريع: بدون' : 'Projects: none')
          : isAr ? `المشاريع: ${toArabic(selected.length)}` : `Projects: ${selected.length}`}{' '}▾
      </button>

      {selected.length > 0 && (
        <div style={{ display: 'flex', gap: 5, flexWrap: 'wrap' }}>
          {selected.map((id) => (
            <span key={id} className="fbtn on" style={{ cursor: 'pointer' }} onClick={() => toggle(id)} title={isAr ? 'إزالة' : 'Remove'}>
              {projectName(id)} ✕
            </span>
          ))}
        </div>
      )}

      {open && (
        <div style={{
          display: 'grid', gap: 4, padding: 8, borderRadius: 8, maxHeight: 220, overflowY: 'auto',
          border: '1px solid var(--line, rgba(255,255,255,0.10))',
        }}>
          <input className="inp" placeholder={isAr ? 'ابحث عن مشروع…' : 'Search a project…'} value={q} onChange={(e) => setQ(e.target.value)} autoFocus />
          {filtered.length === 0 && (
            <div style={{ fontSize: 12, color: 'var(--mute)', padding: '4px 2px' }}>{isAr ? 'لا نتائج' : 'No matches'}</div>
          )}
          {filtered.map((p) => (
            <button
              key={p.id}
              type="button"
              className={`fbtn${selected.includes(p.id) ? ' on' : ''}`}
              style={{ justifyContent: 'start', textAlign: isAr ? 'right' : 'left' }}
              onClick={() => toggle(p.id)}
            >
              {selected.includes(p.id) ? '✓ ' : ''}{p.project_name ?? p.id.slice(0, 8)}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

/** Western digits → Arabic-Indic, for the small inline counts/titles. */
function toArabic(n: number): string {
  return String(n).replace(/[0-9]/g, (ch) => '٠١٢٣٤٥٦٧٨٩'[Number(ch)] ?? ch);
}
