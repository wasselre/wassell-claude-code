/**
 * ProjectLink — the "open the project" affordance for any marketing record.
 *
 * A content item, a campaign, an asset or a task can be tied to a real-estate
 * project either DIRECTLY (its own `project_id`/`project_ids`) or INDIRECTLY
 * (through the campaign it belongs to). Wherever that link exists, the marketer
 * should be able to jump straight to that single project's record in the
 * **Our Projects** module — NOT the whole projects list, and never leaving them
 * to hunt for it.
 *
 * Marketing stores the `all_projects` master id (a project is "ours" iff
 * `all_projects.is_public = true` — the same membership flag Our Projects and
 * the website read). Each Our-Projects record links to its master through a
 * `project` lookup field, so we translate the stored `all_projects` id into the
 * `our_projects` record id and open `/model/our_projects/:ourId` (the same
 * mapping `OurProjectsPortfolioPage` uses). If that record can't be resolved —
 * the generic store hasn't loaded, or the caller can't see the Our-Projects
 * record — we fall back to `/model/all_projects/:id`, which renders the exact
 * same `ProjectDetailPage` and is always readable for a public project.
 *
 * It opens in a NEW TAB (real `<a target="_blank">`) so the marketer keeps their
 * place in the workspace — the marketing record and the project sit side by side.
 * Being a real anchor, middle-click / ⌘-click / right-click "open in new tab" all
 * work too. Rendered as a copper chip (default) that mirrors the clickable
 * «الحملة …» tag, or as an inline text link (`variant="link"`) for dense
 * list-row meta lines. The click stops propagation so a clickable parent row
 * doesn't ALSO navigate the current tab.
 */
import type { MouseEvent } from 'react';
import { useAppStore } from '@/stores/appStore';
import { modelByName, fieldByCandidates } from '@/lib/projects/projectView';
import { useWorkspace } from '../MarketingWorkspace';
import { IconForward } from './icons';

interface Props {
  /** One project id, or many — nulls/blanks/dupes are filtered out. */
  projectIds: Array<string | null | undefined>;
  /** `chip` (default) = copper tag; `link` = underlined inline text. */
  variant?: 'chip' | 'link';
}

export default function ProjectLink({ projectIds, variant = 'chip' }: Props) {
  const { isAr, projectName, projects } = useWorkspace();
  // Secondary source for the all_projects → our_projects mapping: the generic
  // records store. It's only reliably populated once appStore.initialize() has
  // loaded records, which is NOT guaranteed by the time the /m workspace paints
  // — so the PRIMARY source is the marketing `projects` list (always loaded
  // before render, carries `our_project_id` from the server).
  const models = useAppStore((s) => s.models);
  const records = useAppStore((s) => s.records);

  const ids = [...new Set(projectIds.filter((x): x is string => Boolean(x)))];
  if (ids.length === 0) return null;

  /** all_projects master id → the single-project route, preferring Our Projects. */
  const hrefFor = (allProjectsId: string): string => {
    // 1) Reliable: the marketing projects list carries the server-resolved id.
    const fromCtx = projects.find((p) => p.id === allProjectsId)?.our_project_id;
    if (fromCtx) return `/model/our_projects/${fromCtx}`;
    // 2) Fallback: the generic records store, IF it happens to be loaded.
    const ourModel = modelByName(models, 'our_projects');
    const projectField = fieldByCandidates(ourModel, ['project']);
    if (ourModel && projectField) {
      const ourRecords = records[ourModel.id] ?? [];
      const match = ourRecords.find((r) => {
        const link = (r.data as Record<string, unknown> | undefined)?.[projectField.name];
        const linkId = Array.isArray(link)
          ? (typeof link[0] === 'string' ? link[0] : null)
          : (typeof link === 'string' ? link : null);
        return linkId === allProjectsId;
      });
      if (match) return `/model/our_projects/${match.id}`;
    }
    // 3) Same ProjectDetailPage, always readable for a public project.
    return `/model/all_projects/${allProjectsId}`;
  };

  const title = isAr ? 'افتح المشروع في «مشاريعنا» (تبويب جديد)' : 'Open the project in Our Projects (new tab)';
  // A clickable parent row must not ALSO navigate the current tab — the anchor's
  // own target="_blank" handles the new tab, so only stop propagation here.
  const stop = (e: MouseEvent) => e.stopPropagation();

  return (
    <>
      {ids.map((id) => variant === 'link' ? (
        <a
          key={id}
          href={hrefFor(id)}
          target="_blank"
          rel="noopener noreferrer"
          title={title}
          onClick={stop}
          style={{
            cursor: 'pointer',
            color: 'var(--copper)',
            fontWeight: 700,
            textDecoration: 'underline',
            textUnderlineOffset: 2,
          }}
        >
          {projectName(id)}
        </a>
      ) : (
        <a
          key={id}
          href={hrefFor(id)}
          target="_blank"
          rel="noopener noreferrer"
          className="tag"
          title={title}
          onClick={stop}
          style={{
            cursor: 'pointer',
            borderColor: 'var(--copper)',
            color: 'var(--copper)',
            textDecoration: 'none',
            display: 'inline-flex',
            alignItems: 'center',
            gap: 4,
          }}
        >
          {projectName(id)}
          <IconForward style={{ width: 11, height: 11 }} />
        </a>
      ))}
    </>
  );
}
