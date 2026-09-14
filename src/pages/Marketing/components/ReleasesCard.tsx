/**
 * «عمليات النشر» — this creative's RELEASES, one row per destination per date.
 *
 * A publication row on the Publish tab is the PLAN; a release is the JOB of
 * putting it out — and since 2026-09-14 that job has its own screen and, when a
 * person is actually needed, its own task. This card is the bridge between the
 * two: it lists what this creative is scheduled to release, says for each
 * whether the platform posts it by itself or a person must, and sends you to
 * the release screen where the work happens.
 *
 * Deliberately a LIST and nothing more — the release screen owns the material,
 * the destination and the platform's requirements. Duplicating any of that here
 * would recreate the "one screen tries to be every screen" problem the split
 * exists to fix.
 */
import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { PLATFORM_LABELS, PUB_STATUS_LABELS, fetchReleases } from '@/lib/marketingOS/client';
import { Pill, type Tone } from './kit';
import { dateTimeShort, num } from '../lib/format';

/** The columns of `mos_release_v` this list reads. */
interface ReleaseRow {
  id: string;
  platform: string;
  accountHandle: string | null;
  dueAt: string | null;
  status: string;
  automatable: boolean;
  hasOpenTask: boolean;
}

const str = (v: unknown): string | null =>
  (typeof v === 'string' && v.trim() !== '' ? v : null);

/**
 * `release_list` returns raw view rows, so every field is narrowed here rather
 * than cast. A row without an id is DROPPED — it could not be linked to — and
 * the count below says how many rows arrived, so a silent drop is impossible.
 */
function toRow(raw: Record<string, unknown>): ReleaseRow | null {
  const id = str(raw.release_id) ?? str(raw.id);
  if (!id) return null;
  return {
    id,
    platform: str(raw.platform) ?? '—',
    accountHandle: str(raw.account_handle),
    dueAt: str(raw.due_at),
    status: str(raw.status) ?? 'draft',
    automatable: raw.automatable === true,
    hasOpenTask: str(raw.open_task_id) !== null,
  };
}

function statusTone(status: string): Tone {
  if (status === 'published') return 'live';
  if (status === 'cancelled') return 'idle';
  if (status === 'scheduled') return 'go';
  return 'now';
}

function statusLabel(status: string, isAr: boolean): string {
  const hit = PUB_STATUS_LABELS[status];
  if (hit) return isAr ? hit.ar : hit.en;
  if (status === 'planned') return isAr ? 'مخطط' : 'Planned';
  return status;
}

export default function ReleasesCard({ contentId, isAr }: { contentId: string; isAr: boolean }) {
  const [rows, setRows] = useState<ReleaseRow[]>([]);
  const [dropped, setDropped] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetchReleases({ content_id: contentId });
      const parsed = res.releases.map(toRow);
      setRows(parsed.filter((r): r is ReleaseRow => r !== null));
      setDropped(parsed.filter((r) => r === null).length);
    } catch (e) {
      // Surfaced in place, never swallowed: an empty list and a failed list are
      // different facts and must not look the same.
      setError(e instanceof Error ? e.message : String(e));
      console.error('[marketing] release list failed', e);
    } finally {
      setLoading(false);
    }
  }, [contentId]);

  useEffect(() => { void load(); }, [load]);

  // Nothing scheduled and nothing broken: the publication rows above already
  // say everything there is to say, so the card stays out of the way.
  if (!loading && !error && rows.length === 0) return null;

  return (
    <div className="card">
      <div className="card-h">
        <h4>{isAr ? 'عمليات النشر' : 'Releases'}</h4>
        <span className="r">
          {isAr
            ? `${num(rows.length, true)} وجهة`
            : `${rows.length} destination${rows.length === 1 ? '' : 's'}`}
        </span>
      </div>
      <div className="card-b" style={{ padding: rows.length > 0 ? 0 : 16 }}>
        {error && (
          <div className="notice bad" role="alert" style={{ margin: 16 }}>
            <div style={{ fontWeight: 700, marginBottom: 4 }}>
              {isAr ? 'تعذّر تحميل عمليات النشر' : 'The releases could not be loaded'}
            </div>
            <div style={{ overflowWrap: 'anywhere' }}>{error}</div>
            <button type="button" className="btn btn-sm" style={{ marginTop: 10 }} onClick={() => void load()}>
              {isAr ? 'إعادة المحاولة' : 'Try again'}
            </button>
          </div>
        )}

        {loading && rows.length === 0 && !error && (
          <div style={{ padding: 16, fontSize: 12.5, color: 'var(--mute)' }}>
            {isAr ? 'جارٍ التحميل…' : 'Loading…'}
          </div>
        )}

        {dropped > 0 && (
          <div className="notice bad" role="alert" style={{ margin: 16 }}>
            {isAr
              ? `${num(dropped, true)} من الصفوف بلا معرّف ولم تُعرض.`
              : `${dropped} row${dropped === 1 ? '' : 's'} carried no id and could not be shown.`}
          </div>
        )}

        {rows.length > 0 && (
          <div className="tbl-wrap">
            <table className="tbl">
              <tbody>
                {rows.map((r) => (
                  <tr key={r.id}>
                    <td>
                      <div className="ttl">
                        {(isAr ? PLATFORM_LABELS[r.platform]?.ar : PLATFORM_LABELS[r.platform]?.en) ?? r.platform}
                      </div>
                      {r.accountHandle && (
                        <div className="ltr" style={{ fontSize: 11.5, color: 'var(--mute)', marginTop: 3 }}>
                          {r.accountHandle}
                        </div>
                      )}
                    </td>
                    <td style={{ width: 170, fontSize: 12 }}>
                      {r.dueAt ? dateTimeShort(r.dueAt, isAr) : (isAr ? 'بلا موعد' : 'no slot')}
                    </td>
                    <td style={{ width: 120 }}>
                      <Pill tone={statusTone(r.status)}>{statusLabel(r.status, isAr)}</Pill>
                    </td>
                    <td style={{ width: 150 }}>
                      <span className="tag">
                        {r.automatable
                          ? (isAr ? 'تلقائي' : 'Automatic')
                          : (isAr ? 'يحتاج شخصًا' : 'Needs a person')}
                      </span>
                      {r.hasOpenTask && (
                        <span className="tag" style={{ marginInlineStart: 5 }}>
                          {isAr ? 'مهمة مفتوحة' : 'task open'}
                        </span>
                      )}
                    </td>
                    <td style={{ width: 96, textAlign: 'end' }}>
                      <Link className="btn btn-sm" to={`/m/releases/${r.id}`}>
                        {isAr ? 'فتح' : 'Open'}
                      </Link>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
