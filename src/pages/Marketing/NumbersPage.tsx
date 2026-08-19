/**
 * Weekly numbers entry — design screen 50.
 *
 * Manual entry was a deliberate decision, which makes this screen necessary,
 * not optional. Its one important idea: rows are grouped BY PLATFORM, not by
 * content — the person entering opens one app at a time, keys every Instagram
 * number in one pass, then moves on. Ordering by content means opening three
 * apps per row.
 *
 * Three row states, visually distinct and never confused:
 * — entered (a reading exists — a real «٠» is a reading too),
 * — missing (an empty box; empty is NOT zero),
 * — skipped-with-reason (dimmed row + the stored reason, via metrics_skip),
 * so a gap never turns into a mystery two months later.
 *
 * Platform-specific columns: Instagram counts engagement; TikTok's middle
 * column is watch-time (stored in the snapshot's `extra`, not a core field).
 *
 * Numbers now also arrive AUTOMATICALLY for connected platforms: the daily
 * bundle.social cron (and the «سحب الأرقام من المنصات» button here) append `api`
 * snapshots, so many rows are already «تم» before anyone types. Manual entry
 * stays for unconnected platforms (X) and any figure the platform API omits.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAppStore } from '@/stores/appStore';
import { supabase } from '@/lib/supabase';
import {
  MosApiError, PLATFORM_LABELS, ROLE_LABELS, getActiveRole, recordMetrics, skipMetrics,
  pullAllMetrics,
} from '@/lib/marketingOS/client';
import { useWorkspace } from './MarketingWorkspace';
import { Empty, LoadError, Modal, PageHead, Pill, Skeleton } from './components/kit';
import { num, shortDate } from './lib/format';
import './styles/pages-remaining.css';

/* ------------------------------------------------------------------ */
/* numbers_week — local typed caller                                   */
/* ------------------------------------------------------------------ */

interface WeekLatest {
  captured_at?: string | null;
  views: number | null;
  engagement: number | null;
  enquiries: number | null;
  likes: number | null;
  comments: number | null;
  saves: number | null;
  extra?: Record<string, unknown> | null;
}

interface WeekPublication {
  publication_id: string;
  content_ref: string | null;
  title: string;
  published_at?: string | null;
  latest: WeekLatest | null;
  missing: boolean;
  skipped_reason?: string | null;
}

interface WeekPlatform {
  platform: string;
  account_handle?: string | null;
  account_label_ar?: string | null;
  account_label_en?: string | null;
  publications: WeekPublication[];
}

interface NumbersWeekResponse {
  week_start?: string | null;
  week_end?: string | null;
  platforms: WeekPlatform[];
  progress: { entered: number; total: number; estimate_minutes: number | null };
}

// TODO(client): src/lib/marketingOS/client.ts has no wrapper for the
// `numbers_week` action yet — move this local typed caller into the client lib
// once it grows one. Shape mirrors the lib's own `call<T>` transport
// (auth header + x-mos-active-role + the bilingual error envelope).
async function fetchNumbersWeek(weekStart?: string): Promise<NumbersWeekResponse> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (supabase) {
    const { data } = await supabase.auth.getSession();
    const token = data.session?.access_token;
    if (token) headers.Authorization = `Bearer ${token}`;
  }
  const activeRole = getActiveRole();
  if (activeRole) headers['x-mos-active-role'] = activeRole;
  const res = await fetch('/api/marketing-os', {
    method: 'POST',
    headers,
    body: JSON.stringify({ action: 'numbers_week', ...(weekStart ? { week_start: weekStart } : {}) }),
  });
  if (!res.ok) {
    const b = (await res.json().catch(() => ({}))) as Record<string, unknown> & {
      error?: string; error_ar?: string;
    };
    const isAr = useAppStore.getState().language === 'ar';
    throw new MosApiError(
      (isAr ? b?.error_ar || b?.error : b?.error) ?? `numbers_week failed (${res.status})`,
      res.status,
      b,
    );
  }
  return (await res.json()) as NumbersWeekResponse;
}

/* ------------------------------------------------------------------ */
/* platform column sets                                                */
/* ------------------------------------------------------------------ */

type ColKey = 'views' | 'engagement' | 'enquiries' | 'watch' | 'likes' | 'comments' | 'saves';

interface ColDef {
  key: ColKey;
  ar: string;
  en: string;
  width: number;
}

const COL_VIEWS: ColDef =     { key: 'views',      ar: 'المشاهدات',     en: 'Views',      width: 106 };
const COL_ENGAGE: ColDef =    { key: 'engagement', ar: 'التفاعل',       en: 'Engagement', width: 96 };
const COL_ENQUIRIES: ColDef = { key: 'enquiries',  ar: 'الاستفسارات',   en: 'Enquiries',  width: 96 };
/** TikTok's middle column — stored in the snapshot's `extra.watch_seconds`. */
const COL_WATCH: ColDef =     { key: 'watch',      ar: 'متوسط المشاهدة', en: 'Avg watch',  width: 96 };
/** The engagement breakdown — first-class columns on mos_metric_snapshots. */
const COL_LIKES: ColDef =     { key: 'likes',      ar: 'الإعجابات',     en: 'Likes',      width: 90 };
const COL_COMMENTS: ColDef =  { key: 'comments',   ar: 'التعليقات',     en: 'Comments',   width: 90 };
const COL_SAVES: ColDef =     { key: 'saves',      ar: 'الحفظ',         en: 'Saves',      width: 84 };

/** Exactly the mockup's per-platform column sets, plus the likes/comments/saves
 *  breakdown. Unknown platforms get the Instagram shape. */
function platformCols(platform: string): ColDef[] {
  if (platform === 'tiktok') {
    return [COL_VIEWS, COL_WATCH, COL_LIKES, COL_COMMENTS, COL_SAVES, COL_ENQUIRIES];
  }
  return [COL_VIEWS, COL_ENGAGE, COL_LIKES, COL_COMMENTS, COL_SAVES, COL_ENQUIRIES];
}

/** «المنشور» vs «الفيديو» — the mockup titles TikTok's item column differently. */
function itemColLabel(platform: string, isAr: boolean): string {
  if (platform === 'tiktok') return isAr ? 'الفيديو' : 'Video';
  return isAr ? 'المنشور' : 'Post';
}

const PLATFORM_COLORS: Record<string, string> = {
  instagram: '#C13584',
  tiktok: 'var(--ink)',
  snapchat: '#C8B400',
  x: 'var(--ink)',
  youtube: '#C4302B',
  whatsapp: '#25D366',
};

/** The header hint per platform. Snapchat's is the always-manual note. */
const PLATFORM_HINTS: Record<string, { ar: string; en: string }> = {
  instagram: { ar: 'افتح إحصاءات انستقرام مرة واحدة', en: 'Open Instagram insights once' },
  tiktok:    { ar: 'مدة المشاهدة هي الرقم المهم هنا', en: 'Watch time is the number that matters here' },
  snapchat:  { ar: 'لا توجد واجهة — الأرقام من التطبيق يدويًا دائمًا', en: 'No API — numbers come from the app, manually, always' },
};

/** The three canned skip reasons the mockup names, plus free text in the modal. */
const SKIP_REASONS: Array<{ ar: string; en: string }> = [
  { ar: 'المنشور محذوف', en: 'The post was deleted' },
  { ar: 'لا أستطيع الوصول للحساب', en: 'I cannot access the account' },
  { ar: 'سأدخلها لاحقًا', en: 'I will enter it later' },
];

/** «نحو ٦ دقائق» with Arabic number agreement. */
function minutesAr(n: number): string {
  if (n === 1) return 'دقيقة';
  if (n === 2) return 'دقيقتين';
  if (n <= 10) return `${num(n, true)} دقائق`;
  return `${num(n, true)} دقيقة`;
}

type RowState = 'entered' | 'missing' | 'skipped';

type Draft = Partial<Record<ColKey, string>>;

export default function NumbersPage() {
  const { isAr, can, role } = useWorkspace();
  const navigate = useNavigate();
  const addToast = useAppStore((s) => s.addToast);

  const [res, setRes] = useState<NumbersWeekResponse | null>(null);
  const [drafts, setDrafts] = useState<Record<string, Draft>>({});
  /** Values recorded THIS session — flips the row to «تم» without a refetch. */
  const [savedNow, setSavedNow] = useState<Record<string, Partial<Record<ColKey, number | null>>>>({});
  /** Reasons stored THIS session, keyed by publication. */
  const [skippedNow, setSkippedNow] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [byContent, setByContent] = useState(false);
  const [skipping, setSkipping] = useState<WeekPublication | null>(null);
  /** s52 phone1 — the position in the one-at-a-time queue (<760px). */
  const [mobIdx, setMobIdx] = useState(0);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const r = await fetchNumbersWeek();
      setRes(r);
      setDrafts({});
      setSavedNow({});
      setSkippedNow({});
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  /** Pull the latest numbers from bundle.social for every connected-platform
   *  post, then reload — the automatic figures land as `api` snapshots and the
   *  entered rows flip to «تم» without hand-keying. Manual rows are untouched. */
  const [pulling, setPulling] = useState(false);
  const pullFromPlatforms = useCallback(async () => {
    setPulling(true);
    try {
      const { summary } = await pullAllMetrics();
      const inserted = typeof summary.inserted === 'number' ? summary.inserted : 0;
      addToast(
        isAr
          ? (inserted > 0 ? `حُدِّثت أرقام ${num(inserted, true)} منشورًا من المنصات` : 'لا أرقام جديدة من المنصات بعد')
          : (inserted > 0 ? `Updated numbers for ${inserted} posts from the platforms` : 'No new platform numbers yet'),
        'success',
      );
      await load();
    } catch (e) {
      addToast(e instanceof Error ? e.message : String(e), 'error');
    } finally {
      setPulling(false);
    }
  }, [addToast, isAr, load]);

  const platforms = useMemo(() => res?.platforms ?? [], [res]);
  const allRows = useMemo(
    () => platforms.flatMap((p) => p.publications.map((pub) => ({ platform: p.platform, pub }))),
    [platforms],
  );

  const rowState = useCallback((pub: WeekPublication): RowState => {
    if (skippedNow[pub.publication_id] !== undefined || (pub.skipped_reason ?? null) !== null) return 'skipped';
    if (savedNow[pub.publication_id] !== undefined) return 'entered';
    return pub.missing ? 'missing' : 'entered';
  }, [savedNow, skippedNow]);

  const skipReasonOf = (pub: WeekPublication): string | null =>
    skippedNow[pub.publication_id] ?? pub.skipped_reason ?? null;

  /** The displayed value of an ENTERED cell — this session's save wins. */
  const colValue = useCallback((pub: WeekPublication, key: ColKey): number | null => {
    const saved = savedNow[pub.publication_id];
    if (saved !== undefined) return saved[key] ?? null;
    const l = pub.latest;
    if (!l) return null;
    if (key === 'watch') {
      const w = l.extra?.['watch_seconds'];
      return typeof w === 'number' && Number.isFinite(w) ? w : null;
    }
    return l[key];
  }, [savedNow]);

  /* ── progress ─────────────────────────────────────────────────── */

  const total = allRows.length;
  const entered = allRows.filter(({ pub }) => rowState(pub) === 'entered').length;
  const skipped = allRows.filter(({ pub }) => rowState(pub) === 'skipped').length;
  const remaining = total - entered - skipped;
  const pct = total > 0 ? Math.round(((entered + skipped) / total) * 100) : 0;
  // ~45 seconds a row — the mockup's own arithmetic (٨ صفوف ≈ ٦ دقائق).
  const estMinutes = remaining > 0 ? Math.max(1, Math.ceil(remaining * 0.75)) : 0;

  /* ── header line ──────────────────────────────────────────────── */

  const weekLabel = useMemo(() => {
    let ws = res?.week_start ?? null;
    let we = res?.week_end ?? null;
    if (!ws || !we) {
      const now = new Date();
      const start = new Date(now);
      start.setDate(now.getDate() - now.getDay()); // this week, from Sunday
      const end = new Date(start);
      end.setDate(start.getDate() + 6);
      ws = start.toISOString();
      we = end.toISOString();
    }
    return isAr
      ? `أسبوع ${shortDate(ws, true)} – ${shortDate(we, true)}`
      : `Week ${shortDate(ws, false)} – ${shortDate(we, false)}`;
  }, [res, isAr]);

  const roleLabel = ROLE_LABELS[role] ? (isAr ? ROLE_LABELS[role].ar : ROLE_LABELS[role].en) : role;

  /* ── drafts & saving ──────────────────────────────────────────── */

  const parse = (s: string | undefined): number | undefined => {
    const t = (s ?? '').trim();
    if (t === '') return undefined; // left empty = not measured. Empty is not zero.
    const n = Number(t);
    return Number.isFinite(n) ? Math.max(0, Math.floor(n)) : undefined;
  };

  const setDraft = (id: string, key: ColKey, value: string): void => {
    setDrafts((d) => ({ ...d, [id]: { ...(d[id] ?? {}), [key]: value } }));
  };

  const draftHasValue = (id: string): boolean => {
    const d = drafts[id];
    if (!d) return false;
    return (Object.keys(d) as ColKey[]).some((k) => parse(d[k]) !== undefined);
  };

  const filled = allRows.filter(({ pub }) =>
    rowState(pub) === 'missing' && draftHasValue(pub.publication_id));

  /* ── s52 phone1 — one publication at a time ───────────────────────
     The queue keeps allRows' platform grouping, so every Instagram item
     comes before the first TikTok one — the app is opened once, not once
     per row. Saved and skipped rows leave the queue on their own. */

  const queue = allRows.filter(({ pub }) => rowState(pub) === 'missing');
  const doneCount = entered + skipped;
  const cur = queue.length > 0 ? queue[Math.min(mobIdx, queue.length - 1)] : undefined;

  /** Save ONE row's filled boxes — the task mode's «التالي». */
  const saveOne = async (platform: string, pub: WeekPublication): Promise<void> => {
    const d = drafts[pub.publication_id] ?? {};
    const cols = platformCols(platform);
    const values: {
      views?: number | null; engagement?: number | null; enquiries?: number | null;
      likes?: number | null; comments?: number | null; saves?: number | null;
      extra?: Record<string, unknown>;
    } = {};
    const savedRow: Partial<Record<ColKey, number | null>> = {};
    for (const col of cols) {
      const v = parse(d[col.key]);
      if (v === undefined) continue;
      if (col.key === 'watch') {
        values.extra = { ...(values.extra ?? {}), watch_seconds: v };
      } else {
        values[col.key] = v;
      }
      savedRow[col.key] = v;
    }
    setBusy(true);
    try {
      await recordMetrics(pub.publication_id, values);
      setSavedNow((s) => ({ ...s, [pub.publication_id]: savedRow }));
    } catch (e) {
      console.error('[marketing] metric row failed', pub.publication_id, e);
      addToast(
        isAr ? 'تعذّر حفظ الصف — أعد المحاولة.' : 'The row failed to save — try again.',
        'error',
      );
    } finally {
      setBusy(false);
    }
  };

  /** «التالي»: a filled card saves (and leaves the queue); an empty one is
      passed over — empty is not zero, so nothing is written. */
  const mobNext = async (): Promise<void> => {
    if (!cur) return;
    if (draftHasValue(cur.pub.publication_id)) {
      await saveOne(cur.platform, cur.pub);
      return;
    }
    setMobIdx((i) => (queue.length <= 1 ? 0 : (Math.min(i, queue.length - 1) + 1) % queue.length));
  };

  /**
   * Save every filled row. Sequential on purpose: each row is its own append,
   * and a failure part-way must leave the rows that DID save recorded.
   * `finish` additionally closes the sitting and returns to «مهامي».
   */
  const saveAll = async (finish: boolean): Promise<void> => {
    setBusy(true);
    const ok: Record<string, Partial<Record<ColKey, number | null>>> = {};
    const failures: string[] = [];
    for (const { platform, pub } of filled) {
      const d = drafts[pub.publication_id] ?? {};
      const cols = platformCols(platform);
      const values: {
        views?: number | null; engagement?: number | null; enquiries?: number | null;
        likes?: number | null; comments?: number | null; saves?: number | null;
        extra?: Record<string, unknown>;
      } = {};
      const savedRow: Partial<Record<ColKey, number | null>> = {};
      for (const col of cols) {
        const v = parse(d[col.key]);
        if (v === undefined) continue;
        if (col.key === 'watch') {
          values.extra = { ...(values.extra ?? {}), watch_seconds: v };
        } else {
          values[col.key] = v;
        }
        savedRow[col.key] = v;
      }
      try {
        await recordMetrics(pub.publication_id, values);
        ok[pub.publication_id] = savedRow;
      } catch (e) {
        console.error('[marketing] metric row failed', pub.publication_id, e);
        failures.push(pub.publication_id);
      }
    }
    setSavedNow((s) => ({ ...s, ...ok }));
    setBusy(false);

    const okCount = Object.keys(ok).length;
    if (failures.length > 0) {
      // Partial success is reported as partial — never as success.
      addToast(
        isAr
          ? `سُجِّلت ${num(okCount, true)} قراءة، وفشلت ${num(failures.length, true)}.`
          : `Recorded ${okCount}, ${failures.length} failed.`,
        'error',
      );
      return;
    }
    if (!finish) {
      addToast(
        isAr
          ? okCount > 0
            ? `حُفظت ${num(okCount, true)} قراءة — أكمل البقية متى شئت.`
            : 'لا جديد للحفظ — أكمل متى شئت.'
          : okCount > 0
            ? `Saved ${okCount} readings — finish the rest whenever.`
            : 'Nothing new to save — come back whenever.',
        'success',
      );
      return;
    }
    // Finishing with gaps is allowed — the gaps stay honest (empty, not zero).
    const left = remaining - okCount;
    addToast(
      isAr
        ? left > 0
          ? `أُنهيت المهمة — بقي ${num(left, true)} صفًا بلا أرقام، تُرك فارغًا لا صفرًا.`
          : 'أُنهيت مهمة أرقام الأسبوع — كل الصفوف مُدخلة أو متخطّاة بسبب.'
        : left > 0
          ? `Task closed — ${left} rows left blank, not zero.`
          : 'Weekly numbers done — every row entered or skipped with a reason.',
      'success',
    );
    navigate('/m/my-work');
  };

  /* ── skip ─────────────────────────────────────────────────────── */

  const doSkip = async (pub: WeekPublication, reason: string): Promise<void> => {
    setBusy(true);
    try {
      await skipMetrics(pub.publication_id, reason);
      setSkippedNow((s) => ({ ...s, [pub.publication_id]: reason }));
      setSkipping(null);
      addToast(
        isAr ? 'سُجِّل التخطي — السبب يبقى على الصف.' : 'Skipped — the reason stays on the row.',
        'success',
      );
    } catch (e) {
      addToast(e instanceof Error ? e.message : String(e), 'error');
    } finally {
      setBusy(false);
    }
  };

  /* ── one metric cell ──────────────────────────────────────────── */

  const metricCell = (
    pub: WeekPublication,
    col: ColDef,
    state: RowState,
    isFirstMissing: boolean,
    firstCol: boolean,
  ): JSX.Element => {
    if (state === 'entered') {
      const v = colValue(pub, col.key);
      // A stored zero renders as a real «٠» — present, measured, zero. Only a
      // truly absent metric renders the muted dash.
      return (
        <td key={col.key} className="num">
          {v === null
            ? <span className="inp nm-inp" style={{ color: 'var(--mute)' }}>—</span>
            : (
              <span className="inp nm-inp">
                {num(v, isAr)}
                {col.key === 'watch' ? (isAr ? 'ث' : 's') : ''}
              </span>
            )}
        </td>
      );
    }
    if (state === 'skipped') {
      return (
        <td key={col.key} className="num">
          <span className="inp nm-inp" style={{ color: 'var(--mute)' }}>—</span>
        </td>
      );
    }
    const d = drafts[pub.publication_id]?.[col.key] ?? '';
    return (
      <td key={col.key} className="num" style={{ padding: 6 }}>
        <input
          className={`inp nm-inp${isFirstMissing && firstCol ? ' first' : ''}`}
          inputMode="numeric"
          disabled={!can('enter_metrics') || busy}
          value={d}
          onChange={(e) => setDraft(pub.publication_id, col.key, e.target.value)}
          placeholder={isFirstMissing && firstCol ? (isAr ? 'أدخل' : 'enter') : '—'}
          aria-label={isAr ? col.ar : col.en}
        />
      </td>
    );
  };

  /** The trailing action cell: تم / تخطٍ / the stored skip reason. */
  const actionCell = (pub: WeekPublication, state: RowState): JSX.Element => (
    <td style={{ width: 84 }}>
      {state === 'entered' && <Pill tone="go">{isAr ? 'تم' : 'Done'}</Pill>}
      {state === 'skipped' && (
        <span className="nm-reason" title={skipReasonOf(pub) ?? undefined}>
          {isAr ? 'تخطٍ: ' : 'Skipped: '}{skipReasonOf(pub)}
        </span>
      )}
      {state === 'missing' && can('enter_metrics') && (
        <button
          type="button"
          className="btn btn-d btn-sm"
          disabled={busy}
          onClick={() => setSkipping(pub)}
        >
          {isAr ? 'تخطٍ' : 'Skip'}
        </button>
      )}
    </td>
  );

  const rowClass = (state: RowState, isFirstMissing: boolean): string | undefined => {
    if (state === 'skipped') return 'nm-skip';
    if (isFirstMissing) return 'hl';
    return undefined;
  };

  /* ── render ───────────────────────────────────────────────────── */

  return (
    <>
      <PageHead
        title={isAr ? 'إدخال أرقام الأسبوع' : 'Weekly numbers entry'}
        crumb={
          <>
            <button type="button" onClick={() => navigate('/m/my-work')}>
              {isAr ? 'مهامي' : 'My work'}
            </button>
            <span className="sep">/</span>
            <span>{isAr ? 'مهمة أسبوعية متكررة' : 'A recurring weekly task'}</span>
          </>
        }
        sub={isAr
          ? `${weekLabel} · ${num(total, true)} عملية نشر تحتاج أرقامًا · ${roleLabel}`
          : `${weekLabel} · ${total} publications need numbers · ${roleLabel}`}
      >
        <div className="seg">
          <button type="button" className={!byContent ? 'on' : ''} onClick={() => setByContent(false)}>
            {isAr ? 'حسب المنصة' : 'By platform'}
          </button>
          <button type="button" className={byContent ? 'on' : ''} onClick={() => setByContent(true)}>
            {isAr ? 'حسب المحتوى' : 'By content'}
          </button>
        </div>
        {can('enter_metrics') && (
          <>
            <button type="button" className="btn btn-d" disabled={pulling || busy} onClick={() => void pullFromPlatforms()}>
              {pulling
                ? (isAr ? 'جارٍ السحب…' : 'Pulling…')
                : (isAr ? 'سحب الأرقام من المنصات' : 'Pull numbers from platforms')}
            </button>
            <button type="button" className="btn btn-d" disabled={busy} onClick={() => void saveAll(false)}>
              {isAr ? 'حفظ ومتابعة لاحقًا' : 'Save, continue later'}
            </button>
            <button type="button" className="btn btn-p" disabled={busy} onClick={() => void saveAll(true)}>
              {busy
                ? isAr ? 'جارٍ الحفظ…' : 'Saving…'
                : isAr ? 'حفظ وإنهاء المهمة' : 'Save and finish'}
            </button>
          </>
        )}
      </PageHead>

      <div className="body">
        {error && <LoadError message={error} onRetry={() => void load()} isAr={isAr} />}
        {loading && !res && <Skeleton rows={6} />}

        {!loading && total === 0 && !error && (
          <Empty
            title={isAr ? 'لا منشورات بعد' : 'Nothing published yet'}
            body={isAr
              ? 'تظهر الصفوف هنا بعد أن يُعلَّم صف نشر «منشور».'
              : 'Rows appear here once a publication is marked published.'}
          />
        )}

        {total > 0 && (
          <>
          <div className="m4-desk">
            {/* ── progress header ──────────────────────────────────── */}
            <div className="card" style={{ marginBottom: 16 }}>
              <div className="card-b" style={{ display: 'flex', alignItems: 'center', gap: 20, padding: '13px 16px', flexWrap: 'wrap' }}>
                <div style={{ flex: 1, minWidth: 220 }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12, marginBottom: 7 }}>
                    <span style={{ fontWeight: 700 }}>
                      {isAr
                        ? `${num(entered, true)} من ${num(total, true)} مُدخلة`
                        : `${entered} of ${total} entered`}
                    </span>
                    <span style={{ color: 'var(--mute)' }}>
                      {remaining > 0
                        ? isAr
                          ? `تبقّى ${num(remaining, true)} · نحو ${minutesAr(estMinutes)}`
                          : `${remaining} left · about ${estMinutes} min`
                        : isAr ? 'اكتمل الأسبوع' : 'week complete'}
                    </span>
                  </div>
                  <div className="meter" style={{ height: 6 }}>
                    <i style={{ width: `${pct}%`, background: 'var(--copper)' }} />
                  </div>
                </div>
                <div style={{ display: 'flex', gap: 20, textAlign: 'center' }}>
                  {platforms.map((p) => {
                    const pTotal = p.publications.length;
                    const pEntered = p.publications.filter((pub) => rowState(pub) === 'entered').length;
                    return (
                      <div key={p.platform}>
                        <div className="lbl">
                          {(isAr ? PLATFORM_LABELS[p.platform]?.ar : PLATFORM_LABELS[p.platform]?.en) ?? p.platform}
                        </div>
                        <div style={{ fontFamily: 'var(--serif)', fontSize: 17 }}>
                          {num(pEntered, isAr)}/{num(pTotal, isAr)}
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>
            </div>

            {/* ── the cards ────────────────────────────────────────── */}
            {!byContent && platforms.map((p) => {
              const cols = platformCols(p.platform);
              const pRemaining = p.publications.filter((pub) => rowState(pub) === 'missing').length;
              const pEntered = p.publications.filter((pub) => rowState(pub) === 'entered').length;
              const hint = PLATFORM_HINTS[p.platform];
              const color = PLATFORM_COLORS[p.platform] ?? 'var(--copper)';
              const label = (isAr ? PLATFORM_LABELS[p.platform]?.ar : PLATFORM_LABELS[p.platform]?.en) ?? p.platform;
              const accountBit = p.account_handle
                ? <> · <span className="ltr">{p.account_handle}</span></>
                : (isAr ? p.account_label_ar : p.account_label_en)
                  ? <> · {isAr ? p.account_label_ar : p.account_label_en}</>
                  : null;
              const firstMissingId = p.publications.find((pub) => rowState(pub) === 'missing')?.publication_id;
              return (
                <div key={p.platform} className="card" style={{ marginBottom: 13 }}>
                  <div
                    className="card-h"
                    style={{ background: `color-mix(in srgb, ${color} 7%, transparent)` }}
                  >
                    <span className="pdot" style={{ background: color }} />
                    <h4>{label}{accountBit}</h4>
                    {hint && <span className="tag tag-t">{isAr ? hint.ar : hint.en}</span>}
                    <span style={{ marginInlineStart: 'auto' }}>
                      {pRemaining === 0
                        ? <Pill tone="go">{isAr ? 'اكتمل' : 'done'}</Pill>
                        : pEntered === 0
                          ? <Pill tone="late">{isAr ? `${num(pRemaining, true)} لم تُدخل` : `${pRemaining} not entered`}</Pill>
                          : <Pill tone="wait">{isAr ? `تبقّى ${num(pRemaining, true)}` : `${pRemaining} left`}</Pill>}
                    </span>
                  </div>
                  <div className="tbl-wrap">
                    <table className="tbl">
                      <thead>
                        <tr>
                          <th style={{ width: 62 }}>{isAr ? 'الرقم' : 'Ref'}</th>
                          <th>{itemColLabel(p.platform, isAr)}</th>
                          <th style={{ width: 84 }}>{isAr ? 'تاريخ النشر' : 'Published'}</th>
                          {cols.map((c) => (
                            <th key={c.key} className="num" style={{ width: c.width }}>
                              {isAr ? c.ar : c.en}
                            </th>
                          ))}
                          <th style={{ width: 84 }} />
                        </tr>
                      </thead>
                      <tbody>
                        {p.publications.map((pub) => {
                          const state = rowState(pub);
                          const isFirstMissing = pub.publication_id === firstMissingId;
                          return (
                            <tr key={pub.publication_id} className={rowClass(state, isFirstMissing)}>
                              <td className="id">{pub.content_ref ?? '—'}</td>
                              <td className="ttl">{pub.title}</td>
                              <td style={{ color: 'var(--mute)' }}>
                                {pub.published_at ? shortDate(pub.published_at, isAr) : '—'}
                              </td>
                              {cols.map((c, ci) => metricCell(pub, c, state, isFirstMissing, ci === 0))}
                              {actionCell(pub, state)}
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                  {p.platform === 'snapchat' && (
                    <div className="card-b" style={{ fontSize: 12, color: 'var(--mute)', lineHeight: 1.85, borderTop: '1px solid var(--line-soft)' }}>
                      {isAr
                        ? 'سناب شات لن يُربط لاحقًا كذلك — لا واجهة نشر ولا سحب أرقام للستوري. هذه الصفوف ستبقى يدوية حتى بعد ربط ميتا وتيك توك.'
                        : 'Snapchat will not be connected later either — no publishing API, no story-metrics pull. These rows stay manual even after Meta and TikTok are wired up.'}
                    </div>
                  )}
                </div>
              );
            })}

            {/* «حسب المحتوى» — the same rows, flat, sorted by item. Kept so a
                person chasing ONE item's week can scan it; the platform
                grouping remains the default for a reason. */}
            {byContent && (
              <div className="card" style={{ marginBottom: 13 }}>
                <div className="tbl-wrap">
                  <table className="tbl">
                    <thead>
                      <tr>
                        <th style={{ width: 62 }}>{isAr ? 'الرقم' : 'Ref'}</th>
                        <th>{isAr ? 'المنشور' : 'Post'}</th>
                        <th style={{ width: 100 }}>{isAr ? 'المنصة' : 'Platform'}</th>
                        <th style={{ width: 84 }}>{isAr ? 'تاريخ النشر' : 'Published'}</th>
                        <th className="num" style={{ width: 106 }}>{isAr ? 'المشاهدات' : 'Views'}</th>
                        <th className="num" style={{ width: 106 }}>{isAr ? 'التفاعل / المشاهدة' : 'Engage / watch'}</th>
                        <th className="num" style={{ width: 96 }}>{isAr ? 'الاستفسارات' : 'Enquiries'}</th>
                        <th style={{ width: 84 }} />
                      </tr>
                    </thead>
                    <tbody>
                      {[...allRows]
                        .sort((a, b) =>
                          (a.pub.content_ref ?? '').localeCompare(b.pub.content_ref ?? '')
                          || a.pub.title.localeCompare(b.pub.title))
                        .map(({ platform, pub }) => {
                          const state = rowState(pub);
                          const cols = platformCols(platform);
                          return (
                            <tr key={pub.publication_id} className={rowClass(state, false)}>
                              <td className="id">{pub.content_ref ?? '—'}</td>
                              <td className="ttl">{pub.title}</td>
                              <td>
                                <span className="tag">
                                  {(isAr ? PLATFORM_LABELS[platform]?.ar : PLATFORM_LABELS[platform]?.en) ?? platform}
                                </span>
                              </td>
                              <td style={{ color: 'var(--mute)' }}>
                                {pub.published_at ? shortDate(pub.published_at, isAr) : '—'}
                              </td>
                              {cols.map((c) => metricCell(pub, c, state, false, false))}
                              {actionCell(pub, state)}
                            </tr>
                          );
                        })}
                    </tbody>
                  </table>
                </div>
              </div>
            )}

            {/* ── the skip rule + closing bar — mockup verbatim ─────── */}
            <div
              style={{
                marginTop: 16, background: 'var(--sand-2)', border: '1px solid var(--line)',
                borderRadius: 9, padding: '13px 16px', display: 'flex', alignItems: 'center', gap: 18,
                flexWrap: 'wrap',
              }}
            >
              <div style={{ fontSize: 12.5, color: 'var(--ink-2)', lineHeight: 1.85, maxWidth: '70ch' }}>
                {isAr
                  ? <><b>«تخطٍ» تطلب سببًا</b> — «المنشور محذوف» أو «لا أستطيع الوصول للحساب» أو «سأدخلها لاحقًا». السبب يبقى على الصف، فلا تتحول الفجوة إلى لغز بعد شهرين.</>
                  : <><b>Skip asks for a reason</b> — “post deleted”, “no account access”, or “later”. The reason stays on the row, so a gap never becomes a mystery two months on.</>}
              </div>
              {can('enter_metrics') && (
                <button
                  type="button"
                  className="btn btn-p btn-sm"
                  style={{ marginInlineStart: 'auto' }}
                  disabled={busy}
                  onClick={() => void saveAll(true)}
                >
                  {isAr ? 'حفظ وإنهاء المهمة' : 'Save and finish'}
                </button>
              )}
            </div>
          </div>

          {/* ── s52 phone1 — the one-at-a-time task mode (<760px): three
                big boxes per screen, progress on top, the buttons mid-screen
                because the keyboard owns the bottom half. ─────────────── */}
          <div className="m4-mob">
            <div className="m4-task-head">
              <div className="crumb-ln">
                {isAr ? 'مهمة أسبوعية · إدخال أرقام الأسبوع' : 'Weekly task · numbers entry'}
              </div>
              <div className="cnt">
                {isAr ? `${num(doneCount, true)} من ${num(total, true)}` : `${doneCount} of ${total}`}
              </div>
              <div className="meter">
                <i style={{ width: `${pct}%`, background: 'var(--copper)' }} />
              </div>
            </div>

            {cur ? (() => {
              const cols = platformCols(cur.platform);
              const color = PLATFORM_COLORS[cur.platform] ?? 'var(--copper)';
              const plat = platforms.find((p) => p.platform === cur.platform);
              const label = (isAr ? PLATFORM_LABELS[cur.platform]?.ar : PLATFORM_LABELS[cur.platform]?.en)
                ?? cur.platform;
              return (
                <>
                  <div className="card m4-task-pub">
                    <div className="plat">
                      <span className="pdot" style={{ background: color }} />
                      <span>
                        {label}
                        {plat?.account_handle && <> · <span className="ltr">{plat.account_handle}</span></>}
                      </span>
                    </div>
                    <div className="t">
                      {cur.pub.content_ref ? <>{cur.pub.content_ref} · </> : null}
                      {cur.pub.title}
                    </div>
                    <div className="mt">
                      {cur.pub.published_at
                        ? isAr
                          ? `نُشر ${shortDate(cur.pub.published_at, true)}`
                          : `Published ${shortDate(cur.pub.published_at, false)}`
                        : isAr ? 'بلا تاريخ نشر' : 'No publish date'}
                    </div>
                  </div>

                  <div className="m4-task-fields">
                    {cols.map((c, ci) => (
                      <div key={c.key}>
                        <div className="lbl" style={{ margin: '0 0 6px' }}>{isAr ? c.ar : c.en}</div>
                        <input
                          className={`inp m4-task-inp${ci === 0 ? ' first' : ''}`}
                          inputMode="numeric"
                          disabled={!can('enter_metrics') || busy}
                          value={drafts[cur.pub.publication_id]?.[c.key] ?? ''}
                          onChange={(e) => setDraft(cur.pub.publication_id, c.key, e.target.value)}
                          placeholder={ci === 0 ? (isAr ? 'أدخل' : 'enter') : '—'}
                          aria-label={isAr ? c.ar : c.en}
                        />
                      </div>
                    ))}
                  </div>

                  <div className="m4-task-nav">
                    <button
                      type="button"
                      className="btn skip"
                      disabled={busy || !can('enter_metrics')}
                      onClick={() => setSkipping(cur.pub)}
                    >
                      {isAr ? 'تخطٍ' : 'Skip'}
                    </button>
                    <button
                      type="button"
                      className="btn btn-p next"
                      disabled={busy || !can('enter_metrics')}
                      onClick={() => void mobNext()}
                    >
                      {busy
                        ? isAr ? 'جارٍ الحفظ…' : 'Saving…'
                        : isAr ? 'التالي ←' : 'Next →'}
                    </button>
                  </div>

                  <div className="m4-task-note">
                    {isAr
                      ? 'عناصر كل منصة تأتي متتالية — تفتح التطبيق مرة واحدة، لا مرة لكل صف.'
                      : 'Each platform’s items come in a row — the app opens once, not once per row.'}
                  </div>
                </>
              );
            })() : (
              <div className="card m4-task-done">
                <div className="n">
                  {isAr ? `${num(doneCount, true)} من ${num(total, true)}` : `${doneCount} of ${total}`}
                </div>
                <div className="tx">
                  {isAr
                    ? 'اكتمل الأسبوع — كل الصفوف مُدخلة أو متخطّاة بسبب.'
                    : 'Week complete — every row entered or skipped with a reason.'}
                </div>
                <button
                  type="button"
                  className="btn btn-p"
                  style={{ marginTop: 12, minHeight: 48 }}
                  onClick={() => navigate('/m/my-work')}
                >
                  {isAr ? 'العودة إلى مهامي' : 'Back to my work'}
                </button>
              </div>
            )}
          </div>
          </>
        )}
      </div>

      {skipping && (
        <SkipModal
          isAr={isAr}
          pub={skipping}
          busy={busy}
          onClose={() => setSkipping(null)}
          onSkip={(reason) => void doSkip(skipping, reason)}
        />
      )}
    </>
  );
}

/* ------------------------------------------------------------------ */
/* «تخطٍ» — the reason is the whole point                              */
/* ------------------------------------------------------------------ */

function SkipModal({
  isAr, pub, busy, onClose, onSkip,
}: {
  isAr: boolean;
  pub: WeekPublication;
  busy: boolean;
  onClose: () => void;
  onSkip: (reason: string) => void;
}) {
  const [reason, setReason] = useState('');

  return (
    <Modal
      title={isAr ? 'تخطٍ — ما السبب؟' : 'Skip — what is the reason?'}
      sub={`${pub.content_ref ?? ''} ${pub.title}`.trim()}
      onClose={onClose}
      footer={
        <>
          <button type="button" className="btn" onClick={onClose} disabled={busy}>
            {isAr ? 'إلغاء' : 'Cancel'}
          </button>
          <button
            type="button"
            className="btn btn-p"
            disabled={busy || reason.trim() === ''}
            onClick={() => onSkip(reason.trim())}
          >
            {busy ? (isAr ? 'جارٍ…' : 'Working…') : isAr ? 'تسجيل التخطي' : 'Record the skip'}
          </button>
        </>
      }
    >
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 12 }}>
        {SKIP_REASONS.map((r) => {
          const label = isAr ? r.ar : r.en;
          return (
            <button
              key={r.ar}
              type="button"
              className={`fbtn${reason === label ? ' on' : ''}`}
              onClick={() => setReason(label)}
            >
              {label}
            </button>
          );
        })}
      </div>
      <input
        className="inp"
        value={reason}
        onChange={(e) => setReason(e.target.value)}
        placeholder={isAr ? 'أو اكتب سببًا آخر' : 'or write another reason'}
      />
      <div style={{ fontSize: 11.5, color: 'var(--mute)', marginTop: 10, lineHeight: 1.8 }}>
        {isAr
          ? 'السبب يبقى على الصف — التخطي ليس صفرًا وليس نسيانًا.'
          : 'The reason stays on the row — a skip is not a zero and not a lapse.'}
      </div>
    </Modal>
  );
}
