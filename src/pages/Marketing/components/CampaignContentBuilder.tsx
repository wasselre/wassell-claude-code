/**
 * The campaign content builder.
 *
 * Operational intent (owner's words): "when I create a campaign I should be able
 * to create content in bulk while customizing every piece — the manager makes a
 * campaign and its content all at once and the workflow starts, instead of making
 * the campaign then adding each post by hand."
 *
 * So this renders BELOW the campaign fields on the New Campaign screen: a list of
 * content drafts, each individually editable, plus a weekly-cadence generator that
 * spawns a batch of evenly-spaced drafts for the steady organic posting case. On
 * save the parent creates the campaign, then every draft as a content item linked
 * to it — each entering its workflow immediately.
 *
 * Self-contained + controlled: it owns no persistence and no server calls. The
 * parent holds `drafts` and does the create. Styling rides the shared `mos.css`
 * classes so it sits inside the campaign form seamlessly.
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

/** Campaign-level defaults new drafts inherit (so the operator sets them once). */
export interface ContentDefaults {
  projectIds: string[];
  platforms: string[];
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

interface CampaignContentBuilderProps {
  isAr: boolean;
  /** Our Projects only — the parent passes the already-filtered list. */
  projects: MosProject[];
  contentTypes: MosContentType[];
  drafts: ContentDraft[];
  onChange: (drafts: ContentDraft[]) => void;
  /** Campaign-level defaults new drafts inherit. */
  defaults: ContentDefaults;
}

export default function CampaignContentBuilder({
  isAr, projects, contentTypes, drafts, onChange, defaults,
}: CampaignContentBuilderProps): JSX.Element {
  const seq = useRef(0);
  const newKey = (): string => { seq.current += 1; return `d${seq.current}`; };

  const firstType = contentTypes[0]?.key ?? '';

  const makeDraft = (over: Partial<ContentDraft> = {}): ContentDraft => ({
    key: newKey(),
    typeKey: firstType,
    title: '',
    targetDate: '',
    platforms: [...defaults.platforms],
    projectIds: [...defaults.projectIds],
    purpose: defaults.purpose,
    ...over,
  });

  const patch = (key: string, over: Partial<ContentDraft>): void => {
    onChange(drafts.map((d) => (d.key === key ? { ...d, ...over } : d)));
  };
  const remove = (key: string): void => onChange(drafts.filter((d) => d.key !== key));
  const addOne = (): void => onChange([...drafts, makeDraft()]);

  // ── Cadence generator ──────────────────────────────────────────────
  const [count, setCount] = useState(4);
  const [intervalDays, setIntervalDays] = useState(7);
  const [startDate, setStartDate] = useState('');
  const [weekday, setWeekday] = useState<number | null>(null);

  const generate = (): void => {
    const dates = generateCadenceDates({ count, startDate, intervalDays, weekday });
    if (dates.length === 0) return;
    const batch = dates.map((targetDate, i) => makeDraft({
      targetDate,
      title: isAr ? `منشور ${toArabic(i + 1)}` : `Post ${i + 1}`,
    }));
    onChange([...drafts, ...batch]);
  };

  const projectName = useMemo(() => {
    const byId = new Map(projects.map((p) => [p.id, p.project_name ?? p.id.slice(0, 8)]));
    return (id: string): string => byId.get(id) ?? id.slice(0, 8);
  }, [projects]);

  return (
    <div style={{ display: 'grid', gap: 12 }}>
      <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between' }}>
        <div className="lbl">{isAr ? 'المحتوى المبدئي' : 'Initial content'}</div>
        <div style={{ fontSize: 12, color: 'var(--mute)' }}>
          {drafts.length === 0
            ? (isAr ? 'لا شيء بعد' : 'nothing yet')
            : isAr ? `${toArabic(drafts.length)} قطعة` : `${drafts.length} pieces`}
        </div>
      </div>

      {/* Weekly-cadence generator — the steady-posting shortcut. */}
      <div
        style={{
          display: 'grid',
          gap: 9,
          padding: 11,
          borderRadius: 10,
          background: 'var(--panel, rgba(255,255,255,0.03))',
          border: '1px solid var(--line, rgba(255,255,255,0.08))',
        }}
      >
        <div style={{ fontSize: 12, color: 'var(--mute)' }}>
          {isAr ? 'ولّد جدول نشر بالجملة، ثم عدّل كل قطعة' : 'Generate a posting schedule in bulk, then tweak each piece'}
        </div>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'end' }}>
          <label style={{ display: 'grid', gap: 3 }}>
            <span className="lbl">{isAr ? 'عدد' : 'How many'}</span>
            <input
              className="inp"
              style={{ width: 76 }}
              type="number"
              min={1}
              max={52}
              value={count}
              onChange={(e) => setCount(Math.max(1, Math.min(52, Number(e.target.value) || 1)))}
            />
          </label>
          <label style={{ display: 'grid', gap: 3 }}>
            <span className="lbl">{isAr ? 'التكرار' : 'Cadence'}</span>
            <select
              className="inp"
              value={intervalDays}
              onChange={(e) => setIntervalDays(Number(e.target.value))}
            >
              {INTERVALS.map((iv) => (
                <option key={iv.days} value={iv.days}>{isAr ? iv.ar : iv.en}</option>
              ))}
            </select>
          </label>
          <label style={{ display: 'grid', gap: 3 }}>
            <span className="lbl">{isAr ? 'يبدأ' : 'Starts'}</span>
            <input
              className="inp ltr"
              type="date"
              value={startDate}
              onChange={(e) => setStartDate(e.target.value)}
            />
          </label>
          <label style={{ display: 'grid', gap: 3 }}>
            <span className="lbl">{isAr ? 'اليوم (اختياري)' : 'Weekday (optional)'}</span>
            <select
              className="inp"
              value={weekday ?? ''}
              onChange={(e) => setWeekday(e.target.value === '' ? null : Number(e.target.value))}
            >
              <option value="">{isAr ? 'أي يوم' : 'Any day'}</option>
              {WEEKDAYS.map((w) => (
                <option key={w.value} value={w.value}>{isAr ? w.ar : w.en}</option>
              ))}
            </select>
          </label>
          <button
            type="button"
            className="fbtn on"
            style={{ height: 38 }}
            disabled={!startDate}
            onClick={generate}
          >
            {isAr ? '+ توليد' : '+ Generate'}
          </button>
        </div>
      </div>

      {/* Per-piece cards — every detail customizable. */}
      {drafts.map((d, i) => (
        <div
          key={d.key}
          style={{
            display: 'grid',
            gap: 9,
            padding: 11,
            borderRadius: 10,
            border: '1px solid var(--line, rgba(255,255,255,0.08))',
          }}
        >
          <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            <span style={{ fontSize: 12, color: 'var(--mute)', minWidth: 22 }}>
              {isAr ? toArabic(i + 1) : i + 1}
            </span>
            <select
              className="inp"
              style={{ width: 150 }}
              value={d.typeKey}
              onChange={(e) => patch(d.key, { typeKey: e.target.value })}
            >
              {contentTypes.map((t) => (
                <option key={t.key} value={t.key}>{isAr ? t.label_ar : t.label_en}</option>
              ))}
            </select>
            <input
              className="inp"
              style={{ flex: 1 }}
              placeholder={isAr ? 'العنوان المبدئي' : 'Working title'}
              value={d.title}
              onChange={(e) => patch(d.key, { title: e.target.value })}
            />
            <button
              type="button"
              className="fbtn"
              title={isAr ? 'إزالة' : 'Remove'}
              onClick={() => remove(d.key)}
            >
              ✕
            </button>
          </div>

          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
            <input
              className="inp ltr"
              style={{ width: 160 }}
              type="date"
              value={d.targetDate}
              onChange={(e) => patch(d.key, { targetDate: e.target.value })}
            />
            <div className="seg">
              {(['organic', 'paid', 'both'] as const).map((p) => (
                <button
                  key={p}
                  type="button"
                  className={d.purpose === p ? 'on' : ''}
                  onClick={() => patch(d.key, { purpose: p })}
                >
                  {isAr ? PURPOSE_LABEL[p].ar : PURPOSE_LABEL[p].en}
                </button>
              ))}
            </div>
          </div>

          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
            {PLATFORMS.map((p) => (
              <button
                key={p}
                type="button"
                className={`fbtn${d.platforms.includes(p) ? ' on' : ''}`}
                onClick={() => patch(d.key, {
                  platforms: d.platforms.includes(p)
                    ? d.platforms.filter((x) => x !== p)
                    : [...d.platforms, p],
                })}
              >
                {isAr ? PLATFORM_LABEL[p].ar : PLATFORM_LABEL[p].en}
              </button>
            ))}
          </div>

          <ProjectPicker
            isAr={isAr}
            projects={projects}
            selected={d.projectIds}
            projectName={projectName}
            onChange={(ids) => patch(d.key, { projectIds: ids })}
          />
        </div>
      ))}

      <button type="button" className="fbtn" onClick={addOne}>
        {isAr ? '+ إضافة محتوى' : '+ Add content'}
      </button>
    </div>
  );
}

/**
 * A compact searchable multi-select for the per-piece project link. Restricted to
 * whatever `projects` the parent hands in (Our Projects). Kept inline for now;
 * once the shared searchable project multi-select lands it can swap in here.
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
      <button
        type="button"
        className="fbtn"
        style={{ justifySelf: 'start' }}
        onClick={() => setOpen((v) => !v)}
      >
        {selected.length === 0
          ? (isAr ? 'المشاريع: بدون' : 'Projects: none')
          : isAr
            ? `المشاريع: ${toArabic(selected.length)}`
            : `Projects: ${selected.length}`}
        {' '}▾
      </button>

      {selected.length > 0 && (
        <div style={{ display: 'flex', gap: 5, flexWrap: 'wrap' }}>
          {selected.map((id) => (
            <span
              key={id}
              className="fbtn on"
              style={{ cursor: 'pointer' }}
              onClick={() => toggle(id)}
              title={isAr ? 'إزالة' : 'Remove'}
            >
              {projectName(id)} ✕
            </span>
          ))}
        </div>
      )}

      {open && (
        <div
          style={{
            display: 'grid',
            gap: 4,
            padding: 8,
            borderRadius: 8,
            maxHeight: 220,
            overflowY: 'auto',
            border: '1px solid var(--line, rgba(255,255,255,0.08))',
          }}
        >
          <input
            className="inp"
            placeholder={isAr ? 'ابحث عن مشروع…' : 'Search a project…'}
            value={q}
            onChange={(e) => setQ(e.target.value)}
            autoFocus
          />
          {filtered.length === 0 && (
            <div style={{ fontSize: 12, color: 'var(--mute)', padding: '4px 2px' }}>
              {isAr ? 'لا نتائج' : 'No matches'}
            </div>
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
