/**
 * `/m/content/:contentId` — no longer a page. A forwarder.
 *
 * The old per-item content page lived here until 2026-09-16. It was deleted
 * because month work kept landing on it: a row's writing task belongs to the
 * ROW (`mos_content_rows`), the page only ever looked for tasks on the post,
 * and so it rendered every month post read-only — for the writer too.
 *
 * The ADDRESS is kept on purpose. Stored notifications, three SQL notification
 * producers and a dozen in-app lists all build `/m/content/<id>`; rewriting all
 * of them would leave any link already sent pointing at nothing. Instead every
 * such link now lands on the one working screen for what it names:
 *
 *   • a post that belongs to a row → its row in «مهامي» (`?row=`);
 *   • any single item (a paid creative, a standalone post) → «مهامي» (`?item=`).
 *
 * The old `?tab=` / `?step=` query is ignored: both screens open on the work.
 */
import { useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { fetchItemDetail } from '@/lib/marketingOS/rowClient';
import { useWorkspace } from './MarketingWorkspace';
import { LoadError, Skeleton } from './components/kit';

export default function ContentRedirect() {
  const { contentId } = useParams<{ contentId: string }>();
  const navigate = useNavigate();
  const { isAr } = useWorkspace();
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    if (!contentId) {
      navigate('/m/my-work', { replace: true });
      return undefined;
    }
    let alive = true;
    setError(null);
    fetchItemDetail(contentId)
      .then((detail) => {
        if (!alive) return;
        const rowId = detail.members[0]?.row_id ?? null;
        navigate(
          rowId
            ? `/m/my-work?row=${encodeURIComponent(rowId)}`
            : `/m/my-work?item=${encodeURIComponent(contentId)}`,
          { replace: true },
        );
      })
      .catch((e: unknown) => {
        // Shown, never swallowed: a link that cannot be resolved must say so,
        // not silently drop the reader somewhere else.
        console.error('[marketing] content link could not be resolved', contentId, e);
        if (alive) setError(e instanceof Error ? e.message : String(e));
      });
    return () => { alive = false; };
  }, [contentId, navigate, attempt]);

  if (error) {
    return <LoadError message={error} onRetry={() => setAttempt((n) => n + 1)} isAr={isAr} />;
  }
  return <Skeleton rows={4} />;
}
