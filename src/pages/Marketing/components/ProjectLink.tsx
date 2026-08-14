/**
 * ProjectLink — the "open the project" affordance for any marketing record.
 *
 * A content item, a campaign, an asset or a task can be tied to a real-estate
 * project either DIRECTLY (its own `project_id`/`project_ids`) or INDIRECTLY
 * (through the campaign it belongs to). Wherever that link exists, the marketer
 * should be able to jump straight to that single project's page — NOT the whole
 * projects list, and never leaving them to hunt for it.
 *
 * Marketing stores the `all_projects` record id (the ~49 public "Our Projects"
 * masters — `projects_list` selects `v_all_projects WHERE is_public = true`), so
 * the deep link is `/model/all_projects/:id`, which renders the same custom
 * ProjectDetailPage the Our-Projects portfolio opens. That is the idiomatic
 * single-project route used across the main app (ProjectsListPage,
 * ProjectDetailPage, OurProjectsPortfolioPage).
 *
 * Rendered as a copper chip (default) that mirrors the clickable «الحملة …» tag,
 * or as an inline text link (`variant="link"`) for dense list-row meta lines.
 * Both stop propagation so the link works inside a clickable row.
 */
import type { KeyboardEvent, MouseEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import { useWorkspace } from '../MarketingWorkspace';
import { IconForward } from './icons';

/** Deep link to a single project's page in Our Projects (the all_projects detail). */
export function projectHref(projectId: string): string {
  return `/model/all_projects/${projectId}`;
}

interface Props {
  /** One project id, or many — nulls/blanks/dupes are filtered out. */
  projectIds: Array<string | null | undefined>;
  /** `chip` (default) = copper tag; `link` = underlined inline text. */
  variant?: 'chip' | 'link';
}

export default function ProjectLink({ projectIds, variant = 'chip' }: Props) {
  const { isAr, projectName } = useWorkspace();
  const navigate = useNavigate();

  const ids = [...new Set(projectIds.filter((x): x is string => Boolean(x)))];
  if (ids.length === 0) return null;

  const title = isAr ? 'افتح المشروع في «مشاريعنا»' : 'Open the project in Our Projects';
  const open = (id: string) => (e: MouseEvent | KeyboardEvent) => {
    // A row above us may itself be clickable — this link wins.
    e.stopPropagation();
    navigate(projectHref(id));
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
