/**
 * «الموقع الإلكتروني» — Website (2026-09-30).
 *
 * ONE page for the projects on the public site (wassel.re): every project
 * that is on the website, with its page photos and WhatsApp number edited in a
 * dialog, in place. It replaced the "Project Details Pages" picker (which led
 * to a third, per-project form) and the "Website Settings" card. The
 * site-wide settings record (site_settings: contact details, social links,
 * home page copy) has no settings entry since 2026-10-01 — the operator asked
 * for it to go; the record is still edited at /model/site_settings.
 *
 * Which projects are on the website is NOT decided here: a project is public
 * exactly while it is in Our Projects (the records_enforce_our_projects_public
 * trigger). The projects tab says so and links there.
 *
 * Deep link: /settings/website?project=<all_projects id> opens
 * that project's dialog (used by the Website tab on a project record, and by
 * the old /settings/project-details/:projectId URL).
 */
import { useMemo, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { Globe, Building2, Search, ImageOff, ExternalLink, Images, Loader2, MapPin } from 'lucide-react';
import { useAppStore } from '@/stores/appStore';
import BackToSettings from './components/BackToSettings';
import RecordFormModal from '@/pages/Records/components/RecordFormModal';
import Button from '@/components/ui/Button';
import { resolveProjectView, modelByName, type ProjectView } from '@/lib/projects/projectView';
import { getEntityFieldText, useRecordTranslationVersion } from '@/lib/recordTranslation/store';
import { useSignedThumb } from '@/lib/files/signedViewUrlBatch';
import ThumbImg from '@/pages/Files/components/ThumbImg';
import { projectImagesToDetailFields } from '@/lib/projectDetailsAi';
import { normalizeForSearch } from '@/lib/recordSearch';
import type { AppRecord } from '@/types';

const PAGE_IMAGE_FIELDS = [
  'hero_image_url',
  'gallery_image_1', 'gallery_image_2', 'gallery_image_3', 'gallery_image_4',
  'gallery_image_5', 'gallery_image_6', 'gallery_image_7', 'gallery_image_8',
] as const;

const filled = (v: unknown): v is string => typeof v === 'string' && v.trim() !== '';

/** The images the public page will show: the sidecar's when one exists, else the project's own. */
function pageImages(project: AppRecord, sidecar: AppRecord | undefined): { hero: string | null; count: number } {
  const source = sidecar
    ? (sidecar.data as Record<string, unknown>)
    : projectImagesToDetailFields(project.data as Record<string, unknown>);
  const refs = PAGE_IMAGE_FIELDS.map((f) => source[f]).filter(filled);
  const ownMain = (project.data as Record<string, unknown>).main_image;
  // The page falls back to the project's main image when the sidecar has no hero.
  const hero = filled(source.hero_image_url) ? source.hero_image_url : filled(ownMain) ? ownMain : null;
  return { hero, count: refs.length || (hero ? 1 : 0) };
}

function Loading({ isAr }: { isAr: boolean }) {
  return (
    <div className="flex items-center justify-center py-20 text-charcoal/40">
      <Loader2 size={20} className="animate-spin" />
      <span className="ms-2 text-sm">{isAr ? 'جارٍ التحميل…' : 'Loading…'}</span>
    </div>
  );
}

function ProjectCard({
  view, hero, count, isAr, onEdit,
}: {
  view: ProjectView;
  hero: string | null;
  count: number;
  isAr: boolean;
  onEdit: () => void;
}) {
  // Small batched thumbnail: 96 cards used to sign one by one and download
  // every full-size original.
  const signed = useSignedThumb(hero);
  const name = view.name ?? (isAr ? 'بدون اسم' : 'Untitled');
  const place = [view.district, view.city].filter(Boolean).join(isAr ? '، ' : ', ');
  return (
    <div className="card overflow-hidden flex flex-col">
      <button type="button" onClick={onEdit} className="relative h-36 bg-cream/40 overflow-hidden group text-start">
        {signed ? (
          <ThumbImg src={signed.thumb} fallbackSrc={signed.full} alt={name} className="w-full h-full object-cover group-hover:scale-105 transition-transform duration-500" />
        ) : hero ? (
          // The project HAS a photo; its signed link is still on its way. Saying
          // "no photo" here was wrong for every card during the first seconds.
          <div className="w-full h-full animate-pulse bg-sand/30" aria-label={isAr ? 'جارٍ تحميل الصورة' : 'Loading photo'} />
        ) : (
          <div className="w-full h-full flex flex-col items-center justify-center gap-1 text-charcoal/30">
            <ImageOff size={26} />
            <span className="text-[11px]">{isAr ? 'لا توجد صورة' : 'No photo'}</span>
          </div>
        )}
        {count > 0 && (
          <span className="absolute bottom-2 end-2 inline-flex items-center gap-1 rounded-full bg-charcoal/70 text-white text-[11px] px-2 py-0.5">
            <Images size={11} /> {count}
          </span>
        )}
      </button>
      <div className="p-4 flex-1 flex flex-col">
        <h3 className="font-bold text-charcoal text-sm leading-tight line-clamp-2 mb-1.5">{name}</h3>
        {place && (
          <p className="inline-flex items-center gap-1 text-[11px] text-charcoal/50 mb-3">
            <MapPin size={11} /> <span>{place}</span>
          </p>
        )}
        <div className="mt-auto pt-3 border-t border-sand/40 flex items-center justify-between gap-2 text-[11px]">
          <button type="button" onClick={onEdit} className="text-copper font-bold hover:underline">
            {isAr ? 'الصور ورقم الواتساب' : 'Photos and WhatsApp'}
          </button>
          <a
            href={`https://wassel.re/project?id=${encodeURIComponent(view.id)}`}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-1 text-charcoal/45 hover:text-copper transition"
          >
            <span>{isAr ? 'فتح في الموقع' : 'Open on site'}</span>
            <ExternalLink size={10} />
          </a>
        </div>
      </div>
    </div>
  );
}

function ProjectsList() {
  const navigate = useNavigate();
  const isAr = useAppStore((s) => s.language === 'ar');
  const models = useAppStore((s) => s.models);
  const records = useAppStore((s) => s.records);
  const initialized = useAppStore((s) => s.initialized);
  useRecordTranslationVersion();
  const [params, setParams] = useSearchParams();
  const [query, setQuery] = useState('');

  const projectsModel = modelByName(models, 'all_projects');
  const detailsModel = modelByName(models, 'project_details');
  const openProjectId = params.get('project');

  const sidecarByProject = useMemo(() => {
    const out = new Map<string, AppRecord>();
    if (!detailsModel) return out;
    for (const r of records[detailsModel.id] ?? []) {
      const pid = (r.data as { project_id?: unknown }).project_id;
      if (typeof pid === 'string' && pid) out.set(pid, r);
    }
    return out;
  }, [detailsModel, records]);

  const rows = useMemo(() => {
    if (!projectsModel) return [];
    return (records[projectsModel.id] ?? [])
      .filter((r) => (r.data as { is_public?: unknown }).is_public === true)
      .map((r) => {
        const view = resolveProjectView({ models, records }, r, { isAr, translate: getEntityFieldText });
        return { record: r, view, ...pageImages(r, sidecarByProject.get(r.id)) };
      })
      .sort((a, b) => (a.view.name ?? '').localeCompare(b.view.name ?? '', isAr ? 'ar' : 'en'));
  }, [projectsModel, records, models, isAr, sidecarByProject]);

  const shown = useMemo(() => {
    const q = normalizeForSearch(query.trim());
    if (!q) return rows;
    return rows.filter(({ view }) =>
      normalizeForSearch([view.name, view.district, view.city, view.developer].filter(Boolean).join(' ')).includes(q));
  }, [rows, query]);

  const setProject = (id: string | null) => {
    const next = new URLSearchParams(params);
    if (id) next.set('project', id); else next.delete('project');
    setParams(next, { replace: true });
  };

  if (!initialized) return <Loading isAr={isAr} />;
  if (!projectsModel || !detailsModel) {
    return (
      <div className="card p-8 text-center text-sm text-charcoal/50">
        {isAr ? 'نموذج صفحات المشاريع غير متاح.' : 'The project pages model is not available.'}
      </div>
    );
  }

  const open = openProjectId ? rows.find((r) => r.record.id === openProjectId) : undefined;
  const openSidecar = openProjectId ? sidecarByProject.get(openProjectId) : undefined;
  const withoutPhoto = rows.filter((r) => !r.hero).length;

  return (
    <div>
      <div className="card p-4 mb-4 flex flex-wrap items-center gap-3">
        <div className="flex-1 min-w-[220px] text-sm text-charcoal/70 leading-relaxed">
          {isAr
            ? `${rows.length} مشروعاً على الموقع. يظهر المشروع على الموقع عند إضافته إلى «مشاريعنا»، ويختفي عند إزالته منها.`
            : `${rows.length} projects are on the website. A project appears on the site when it is added to Our Projects, and leaves it when removed from there.`}
          {withoutPhoto > 0 && (
            <span className="block text-xs text-amber-600 mt-1">
              {isAr ? `${withoutPhoto} منها بلا صورة.` : `${withoutPhoto} of them have no photo.`}
            </span>
          )}
        </div>
        <Button variant="secondary" onClick={() => navigate('/model/our_projects')}>
          <Building2 size={15} /> {isAr ? 'إدارة «مشاريعنا»' : 'Manage Our Projects'}
        </Button>
      </div>

      <div className="relative mb-4 max-w-sm">
        <Search size={14} className="absolute top-1/2 -translate-y-1/2 start-3 text-charcoal/40 pointer-events-none" />
        <input
          type="search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder={isAr ? 'ابحث عن مشروع…' : 'Search projects…'}
          className="w-full bg-white border border-sand/60 rounded-full ps-9 pe-4 py-2 text-sm focus:outline-none focus:border-copper/60"
        />
      </div>

      {shown.length === 0 ? (
        <div className="card p-10 text-center text-sm text-charcoal/50">
          {rows.length === 0
            ? (isAr ? 'لا توجد مشاريع على الموقع بعد.' : 'No projects are on the website yet.')
            : (isAr ? 'لا توجد نتائج لبحثك.' : 'No results for your search.')}
        </div>
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
          {shown.map(({ record, view, hero, count }) => (
            <ProjectCard key={record.id} view={view} hero={hero} count={count} isAr={isAr} onEdit={() => setProject(record.id)} />
          ))}
        </div>
      )}

      {openProjectId && open && (
        <RecordFormModal
          key={openProjectId}
          modelId={detailsModel.id}
          recordId={openSidecar?.id ?? null}
          prefill={{
            project_id: openProjectId,
            show_units: true,
            ...projectImagesToDetailFields(open.record.data as Record<string, unknown>),
          }}
          title={`${isAr ? 'صفحة المشروع' : 'Project page'} — ${open.view.name ?? ''}`}
          onClose={() => setProject(null)}
        />
      )}
      {openProjectId && !open && (
        <div className="card p-4 mt-4 text-sm text-charcoal/60 flex items-center justify-between gap-3">
          <span>{isAr ? 'هذا المشروع ليس على الموقع، لذا لا توجد له صفحة.' : 'That project is not on the website, so it has no page.'}</span>
          <Button variant="ghost" onClick={() => setProject(null)}>{isAr ? 'إغلاق' : 'Dismiss'}</Button>
        </div>
      )}
    </div>
  );
}

export default function WebsitePage() {
  const isAr = useAppStore((s) => s.language === 'ar');
  return (
    <div className="max-w-6xl">
      <BackToSettings />
      <div className="flex items-center gap-3 mb-5">
        <div className="w-12 h-12 rounded-2xl flex items-center justify-center shrink-0" style={{ backgroundColor: '#B8734F14' }}>
          <Globe size={24} style={{ color: '#B8734F' }} />
        </div>
        <div className="min-w-0">
          <h1 className="text-2xl font-bold text-chocolate">{isAr ? 'الموقع الإلكتروني' : 'Website'}</h1>
          <p className="text-sm text-charcoal/45">
            {isAr ? 'المشاريع المعروضة على wassel.re، وصور صفحاتها ورقم الواتساب.' : 'The projects shown on wassel.re, with their page photos and WhatsApp number.'}
          </p>
        </div>
      </div>
      <ProjectsList />
    </div>
  );
}
