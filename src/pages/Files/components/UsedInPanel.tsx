/**
 * "Used in" — read-only Phase 1 panel showing which business records a file is
 * linked to.
 *
 * Ships behind VITE_FEATURE_FILE_LINKS and grants nothing: it renders a
 * projection of relationships that already exist. Every row shown has passed
 * BOTH gates server-side (caller may view the file AND the target record), so
 * this component never has to reason about permission itself — it only has to
 * avoid inventing rows the server did not return.
 *
 * Deliberately absent: provenance. Whether a link came from `units.unit_plan[0]`
 * or the legacy `files.record_id` column is implementation detail, not business
 * meaning. It is available in the admin/debug expansion only.
 */
import { useCallback, useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  UsedInLink, fetchUsedIn, fileLinksEnabled, groupByRecord,
} from '@/lib/files/usedIn';
import { roleLabel } from '@/lib/files/linkRoles';

/** A file shared across a whole unit type reaches 212 records in production.
 *  Render a readable slice and let the user ask for the rest. */
const INITIAL_VISIBLE = 12;

export default function UsedInPanel({ fileId, isAr }: { fileId: string; isAr: boolean }) {
  const navigate = useNavigate();
  const [links, setLinks] = useState<UsedInLink[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState(false);

  const load = useCallback(async () => {
    setError(null);
    try {
      const res = await fetchUsedIn(fileId);
      setLinks(res.links);
    } catch (e) {
      // Never a blank box with only a console line.
      setError(e instanceof Error ? e.message : String(e));
      setLinks([]);
    }
  }, [fileId]);

  useEffect(() => { if (fileLinksEnabled()) void load(); }, [load]);

  if (!fileLinksEnabled()) return null;

  if (error) {
    return (
      <div className="notice bad" role="alert" style={{ marginTop: 14 }}>
        <div>{isAr ? 'تعذّر تحميل الارتباطات.' : 'Links could not be loaded.'}</div>
        <button type="button" className="btn btn-sm" style={{ marginTop: 8 }} onClick={() => void load()}>
          {isAr ? 'إعادة المحاولة' : 'Try again'}
        </button>
      </div>
    );
  }

  // Still loading, or genuinely unlinked — an unlinked file renders NOTHING
  // rather than an empty card, matching how LinkedDocumentsPanel behaves.
  if (links === null || links.length === 0) return null;

  const grouped = groupByRecord(links);
  const shown = expanded ? grouped : grouped.slice(0, INITIAL_VISIBLE);

  return (
    <section style={{ marginTop: 16 }}>
      <h4 style={{ fontSize: 12, textTransform: 'uppercase', letterSpacing: '.07em', margin: '0 0 8px' }}>
        {isAr ? 'مستخدم في' : 'Used in'}{' '}
        <span style={{ opacity: .6 }}>({grouped.length})</span>
      </h4>
      <ul style={{ listStyle: 'none', margin: 0, padding: 0, display: 'grid', gap: 6 }}>
        {shown.map((g) => {
          // Deep-link only when the route is real. A frozen or custom-UI model
          // may have no /model/:name/:id route, and a dead link is worse than
          // plain text.
          const canNavigate = Boolean(g.model_name);
          const label = (isAr ? g.model_label_ar : g.model_label_en) ?? g.model_name ?? '';
          const title = g.title
            ?? `${label}${label ? ' · ' : ''}${g.record_id.slice(0, 8)}`;
          return (
            <li key={g.key}>
              <button
                type="button"
                disabled={!canNavigate}
                onClick={() => { if (g.model_name) navigate(`/model/${g.model_name}/${g.record_id}`); }}
                style={{
                  display: 'flex', gap: 10, alignItems: 'baseline', width: '100%',
                  textAlign: isAr ? 'right' : 'left', background: 'none',
                  border: '1px solid var(--line)', borderRadius: 8, padding: '7px 10px',
                  cursor: canNavigate ? 'pointer' : 'default', font: 'inherit',
                }}
              >
                <span style={{ fontWeight: 600, minWidth: 0, overflowWrap: 'anywhere' }}>{title}</span>
                <span style={{ marginInlineStart: 'auto', display: 'flex', gap: 5, flexWrap: 'wrap' }}>
                  {g.roles.map((r) => (
                    <span key={r} className="tag" style={{ fontSize: 11 }}>{roleLabel(r, isAr)}</span>
                  ))}
                </span>
              </button>
            </li>
          );
        })}
      </ul>
      {grouped.length > INITIAL_VISIBLE && !expanded && (
        <button type="button" className="btn btn-sm" style={{ marginTop: 8 }} onClick={() => setExpanded(true)}>
          {isAr
            ? `عرض الكل (${grouped.length})`
            : `Show all ${grouped.length}`}
        </button>
      )}
    </section>
  );
}
