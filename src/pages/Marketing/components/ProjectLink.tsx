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
 * Rendered as a copper chip (default) that mirrors the clickable «الحملة …» tag,
 * or as an inline text link (`variant="link"`) for dense list-row meta lines.
 * Both stop propagation so the link works inside a clickable row.
 */
import type { KeyboardEvent, MouseEvent } from 'react';
import { useNavigate } from 'react-router-dom';
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
  const { isAr, projectName } = useWorkspace();
  const navigate = useNavigate();
  // The Our-Projects membership lives in the generic records store (loaded by
  // appStore.initialize() at the app root, so it's present in the /m workspace
  // too). We read it to map an all_projects master id → its our_projects record.
  const models = useAppStore((s) => s.models);
  const records = useAppStore((s) => s.records);

  const ids = [...new Set(projectIds.filter((x): x is string => Boolean(x)))];
  if (ids.length === 0) return null;

  /** all_projects master id → the single-project route, preferring Our Projects. */
  const hrefFor = (allProjectsId: string): string => {
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
    // Same ProjectDetailPage, always readable for a public project.
    return `/model/all_projects/${allProjectsId}`;
  };

  const title = isAr ? 'افتح المشروع في «مشاريعنا»' : 'Open the project in Our Projects';
  const open = (id: string) => (e: MouseEvent | KeyboardEvent) => {
    // A row above us may itself be clickable — this link wins.
    e.stopPropagation();
    navigate(hrefFor(id));
  };
  const onKey = (id: string) => (e: KeyboardEvent) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      open(id)(e);
    }
  };

  return (
    <>
      {ids.map((id) => variant === 'link' ? (
        <a
          key={id}
          role="button"
          tabIndex={0}
          title={title}
          onClick={open(id)}
          onKeyDown={onKey(id)}
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
        <span
          key={id}
          className="tag"
          role="button"
          tabIndex={0}
          title={title}
          onClick={open(id)}
          onKeyDown={onKey(id)}
          style={{
            cursor: 'pointer',
            borderColor: 'var(--copper)',
            color: 'var(--copper)',
            display: 'inline-flex',
            alignItems: 'center',
            gap: 4,
          }}
        >
          {projectName(id)}
          <IconForward style={{ width: 11, height: 11 }} />
        </span>
      ))}
    </>
  );
}
