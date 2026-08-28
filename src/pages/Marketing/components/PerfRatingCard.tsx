/**
 * The manager's rating control for a FINISHED creative (status_key='done').
 *
 * One overall level (normal → outstanding) written for every contributor of
 * the creative, with optional per-person overrides — exactly the compromise
 * the operator picked in the spec. Points land on each contributor's XP via
 * the mos_perf_rate_content definer RPC; re-rating adjusts the difference.
 *
 * Renders nothing until the creative is done; the caller gates on
 * can('rate_creative') so a writer never sees a control that would 403.
 */
import { useCallback, useEffect, useState } from 'react';
import { useAppStore } from '@/stores/appStore';
import {
  PerfRatingLevel, RATING_LABELS, RATING_LEVELS, fetchPerfRatings, ratePerfContent,
} from '@/lib/marketingOS/client';
import { num } from '../lib/format';

interface Contributor {
  user_id: string;
  role_key: string;
  name_ar?: string | null;
  name_en?: string | null;
}

export default function PerfRatingCard({
  contentId, isAr,
}: {
  contentId: string;
  isAr: boolean;
}) {
  const addToast = useAppStore((s) => s.addToast);

  const [contributors, setContributors] = useState<Contributor[]>([]);
  const [existing, setExisting] = useState<Map<string, PerfRatingLevel>>(new Map());
  const [level, setLevel] = useState<PerfRatingLevel>('good');
  const [overrides, setOverrides] = useState<Record<string, PerfRatingLevel>>({});
  const [loaded, setLoaded] = useState(false);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const res = await fetchPerfRatings(contentId);
      setContributors(res.contributors as Contributor[]);
      const m = new Map<string, PerfRatingLevel>();
      for (const r of res.ratings) m.set(r.contributor_user_id, r.level);
      setExisting(m);
      // Seed the picker from the majority existing level so re-opening a rated
      // creative shows its current state, not the default.
      const first = res.ratings.find((r) => !r.is_override);
      if (first) setLevel(first.level);
    } catch (e) {
      console.error('[perf-rating] load failed', e);
    } finally {
      setLoaded(true);
    }
  }, [contentId]);

  useEffect(() => { void load(); }, [load]);

  const save = async (): Promise<void> => {
    setBusy(true);
    try {
      const res = await ratePerfContent(contentId, level, overrides);
      addToast(
        isAr ? `قُيّم ${num(res.rated, true)} مساهمين وأُضيفت نقاطهم.` : `${res.rated} contributors rated; points granted.`,
        'success',
      );
      void load();
    } catch (e) {
      addToast(e instanceof Error ? e.message : String(e), 'error');
    } finally {
      setBusy(false);
    }
  };

  if (!loaded || contributors.length === 0) return null;

  const rated = existing.size > 0;
  const name = (c: Contributor): string =>
    ((isAr ? c.name_ar : c.name_en) ?? c.name_en ?? c.name_ar ?? c.user_id.slice(0, 8));

  return (
    <div className="card" style={{ marginBottom: 16 }}>
      <div className="card-h">
        <h4>
          {isAr ? 'تقييم العمل' : 'Rate this creative'}
          {rated && <span className="tag" style={{ marginInlineStart: 8 }}>{isAr ? 'مُقيَّم' : 'rated'}</span>}
        </h4>
      </div>
      <div className="card-b" style={{ display: 'grid', gap: 12 }}>
        <div className="seg" style={{ flexWrap: 'wrap' }}>
          {RATING_LEVELS.map((lv) => (
            <button
              key={lv}
              type="button"
              className={level === lv ? 'on' : ''}
              onClick={() => setLevel(lv)}
            >
              {isAr ? RATING_LABELS[lv].ar : RATING_LABELS[lv].en}
              {' '}·{' '}{num(RATING_LABELS[lv].points, isAr)}
            </button>
          ))}
        </div>

        <div style={{ display: 'grid', gap: 6 }}>
          {contributors.map((c) => {
            const ov = overrides[c.user_id];
            return (
              <div key={c.user_id} style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap', fontSize: 12 }}>
                <b style={{ minWidth: 120 }}>{name(c)}</b>
                <span className="tag">{c.role_key}</span>
                <select
                  className="inp"
                  style={{ width: 'auto', paddingBlock: 4 }}
                  value={ov ?? ''}
                  onChange={(e) => {
                    const v = e.target.value as PerfRatingLevel | '';
                    setOverrides((o) => {
                      const next = { ...o };
                      if (v === '') delete next[c.user_id];
                      else next[c.user_id] = v;
                      return next;
                    });
                  }}
                >
                  <option value="">
                    {isAr
                      ? `التقييم العام (${RATING_LABELS[level].ar})`
                      : `Overall (${RATING_LABELS[level].en})`}
                  </option>
                  {RATING_LEVELS.map((lv) => (
                    <option key={lv} value={lv}>
                      {isAr ? RATING_LABELS[lv].ar : RATING_LABELS[lv].en}
                    </option>
                  ))}
                </select>
                {existing.has(c.user_id) && (
                  <span style={{ color: 'var(--mute)', fontSize: 11 }}>
                    {isAr ? 'الحالي: ' : 'current: '}
                    {isAr ? RATING_LABELS[existing.get(c.user_id) as PerfRatingLevel].ar
                      : RATING_LABELS[existing.get(c.user_id) as PerfRatingLevel].en}
                  </span>
                )}
              </div>
            );
          })}
        </div>

        <div>
          <button type="button" className="btn btn-p" disabled={busy} onClick={() => void save()}>
            {busy
              ? (isAr ? 'جارٍ الحفظ…' : 'Saving…')
              : rated ? (isAr ? 'تحديث التقييم' : 'Update rating') : (isAr ? 'اعتماد التقييم' : 'Submit rating')}
          </button>
        </div>
      </div>
    </div>
  );
}
