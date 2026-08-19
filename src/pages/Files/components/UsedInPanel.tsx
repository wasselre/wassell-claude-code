/**
 * "Used in" — which business records a file is actually used by.
 *
 * Shipped dark in Phase 1 behind VITE_FEATURE_FILE_LINKS. **B5 promotes it to
 * primary and retires the flag**: it is now the main answer to "can I safely
 * replace or delete this file?", which is the question the Library exists to
 * make answerable.
 *
 * It grants nothing. Every row shown has already passed BOTH gates server-side
 * — the caller may view the file AND the target record — so this component
 * never reasons about permission itself. Its only obligation is to avoid
 * inventing rows the server did not return.
 *
 * Deliberately absent: provenance. Whether a link came from `units.unit_plan[0]`
 * or from a manual `document_links` row is implementation detail, not business
 * meaning.
 *
 * ── ONE THING THAT CHANGED AT PROMOTION ───────────────────────────────────
 * While flag-gated this rendered with `.notice`, `.btn` and `.tag` classes.
 * None of those exist in the app's stylesheet — they are Marketing-workspace
 * classes — so the error state and the "show all" control were unstyled text.
 * A dark panel can carry that; a primary one cannot, so it is Tailwind now,
 * like the rest of the Files surface.
 */
import { useCallback, useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { AlertCircle, ArrowUpRight } from 'lucide-react';
import { UsedInLink, fetchUsedIn, groupByRecord } from '@/lib/files/usedIn';
import { roleLabel } from '@/lib/files/linkRoles';

/** A file shared across a whole unit type reaches 212 records in production
 *  (one townhouse layout, one project). Render a readable slice and let the
 *  user ask for the rest. */
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

  useEffect(() => { void load(); }, [load]);

  if (error) {
    return (
      <section className="pt-4" role="alert">
        <p className="flex items-start gap-2 text-xs text-red-700">
          <AlertCircle size={13} className="mt-0.5 shrink-0" aria-hidden />
          <span>{isAr ? 'تعذّر تحميل الارتباطات.' : 'Links could not be loaded.'}</span>
        </p>
        <button
          type="button"
          onClick={() => void load()}
          className="mt-2 px-2.5 py-1 rounded-lg bg-white border border-red-500/25 text-xs font-bold text-red-700 hover:bg-red-500/10"
        >
          {isAr ? 'إعادة المحاولة' : 'Try again'}
        </button>
      </section>
    );
  }

  // Still loading, or genuinely unlinked. An unlinked file renders NOTHING
  // rather than an empty card — the Library already badges it as unlinked, and
  // a second "no links" box beside that badge is noise.
  if (links === null || links.length === 0) return null;

  const grouped = groupByRecord(links);
  const shown = expanded ? grouped : grouped.slice(0, INITIAL_VISIBLE);

  return (
    <section className="pt-4">
      <h4 className="mb-2 text-[11px] font-bold uppercase tracking-widest text-charcoal/45">
        {isAr ? 'مستخدم في' : 'Used in'}{' '}
        <span className="text-charcoal/30 tabular-nums">({grouped.length})</span>
      </h4>

      <ul className="space-y-1.5 list-none p-0 m-0">
        {shown.map((g) => {
          // Deep-link only when the route is real. A frozen or custom-UI model
          // may have no /model/:name/:id route, and a dead link is worse than
          // plain text.
          const canNavigate = Boolean(g.model_name);
          const label = (isAr ? g.model_label_ar : g.model_label_en) ?? g.model_name ?? '';
          const title = g.title ?? `${label}${label ? ' · ' : ''}${g.record_id.slice(0, 8)}`;
          return (
            <li key={g.key}>
              <button
                type="button"
                disabled={!canNavigate}
                onClick={() => { if (g.model_name) navigate(`/model/${g.model_name}/${g.record_id}`); }}
                className={`w-full text-start flex items-baseline gap-2 px-2.5 py-1.5 rounded-lg border border-sand/30 bg-white text-xs transition-colors ${
                  canNavigate ? 'hover:bg-cream hover:border-copper/30' : 'cursor-default'
                }`}
              >
                <span className="font-bold text-charcoal min-w-0 break-words" dir="auto">{title}</span>
                <span className="ms-auto flex items-center gap-1 flex-wrap shrink-0">
                  {g.roles.map((r) => (
                    <span
                      key={r}
                      className="inline-flex items-center px-1.5 py-0.5 rounded-md bg-charcoal/8 text-[10px] font-bold text-charcoal/60 leading-none"
                    >
                      {roleLabel(r, isAr)}
                    </span>
                  ))}
                  {canNavigate && <ArrowUpRight size={11} className="text-charcoal/30" aria-hidden />}
                </span>
              </button>
            </li>
          );
        })}
      </ul>

      {grouped.length > INITIAL_VISIBLE && !expanded && (
        <button
          type="button"
          onClick={() => setExpanded(true)}
          className="mt-2 px-2.5 py-1 rounded-lg bg-white border border-sand/40 text-xs font-bold text-charcoal/60 hover:bg-cream hover:text-copper"
        >
          {isAr ? `عرض الكل (${grouped.length})` : `Show all ${grouped.length}`}
        </button>
      )}
    </section>
  );
}
