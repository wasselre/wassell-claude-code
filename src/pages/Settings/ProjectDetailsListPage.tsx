import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  ArrowLeft, LayoutTemplate, MapPin, ImageOff,
  Sparkles, ExternalLink, Plus, X, Search,
} from 'lucide-react';
import { useAppStore } from '@/stores/appStore';

/**
 * Project Details Pages — picker.
 *
 * Lists ONLY projects that the admin has actively added to the website's
 * detail-page system (i.e., projects with an existing project_details
 * sidecar record). Projects without a sidecar are not shown here — adding
 * one is a deliberate user action via the "+ إضافة" button, which opens
 * a modal listing public projects (is_public = true on all_projects)
 * that don't yet have a detail page.
 *
 * This separates two concepts:
 *   • is_public on all_projects → "this project appears on the website"
 *     (handled in the all_projects record form)
 *   • project_details record exists → "I've curated a detail page for it"
 *     (handled here)
 *
 * Clicking a card navigates to /settings/project-details/<projectId>, which
 * is the ProjectDetailsBridgePage — that opens the existing sidecar's
 * standard form, or creates a blank one and then opens it.
 *
 * The model is hidden from the sidebar (Sidebar.SETTINGS_ONLY_MODEL_NAMES)
 * and the model list view at /model/project_details is redirected here.
 */
export default function ProjectDetailsListPage() {
  const navigate = useNavigate();
  const isAr = useAppStore((s) => s.language === 'ar');
  const models = useAppStore((s) => s.models);
  const records = useAppStore((s) => s.records);

  const projectsModel = models.find((m) => m.name === 'all_projects');
  const detailsModel = models.find((m) => m.name === 'project_details');

  const [pickerOpen, setPickerOpen] = useState(false);
  const [pickerSearch, setPickerSearch] = useState('');

  // Lock body scroll while the picker modal is open so the user doesn't
  // accidentally scroll the page underneath.
  useEffect(() => {
    if (!pickerOpen) return;
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setPickerOpen(false); };
    window.addEventListener('keydown', onKey);
    return () => {
      document.body.style.overflow = prev;
      window.removeEventListener('keydown', onKey);
    };
  }, [pickerOpen]);

  // project_id → details record id (if any). Used for both: filtering the
  // main grid (only show projects WITH a sidecar) and excluding from the
  // "add new" picker (only show projects WITHOUT one).
  const detailsByProjectId = useMemo(() => {
    if (!detailsModel) return new Map<string, string>();
    const out = new Map<string, string>();
    for (const r of records[detailsModel.id] ?? []) {
      const projectId = (r.data as { project_id?: string })?.project_id;
      if (typeof projectId === 'string' && projectId) out.set(projectId, r.id);
    }
    return out;
  }, [detailsModel, records]);

  // Pool of public projects (is_public = true on all_projects). The main
  // grid filters this further to those WITH a sidecar; the picker modal
  // shows the inverse (those WITHOUT one).
  const publicProjects = useMemo(() => {
    if (!projectsModel) return [];
    return (records[projectsModel.id] ?? [])
      .filter((r) => !!(r.data as { is_public?: boolean })?.is_public)
      .slice()
      .sort((a, b) => {
        const an = String((a.data as { project_name?: string })?.project_name ?? '');
        const bn = String((b.data as { project_name?: string })?.project_name ?? '');
        return an.localeCompare(bn, 'ar');
      });
  }, [projectsModel, records]);

  // Main grid: only projects the admin has actively added (sidecar exists).
  const addedProjects = useMemo(
    () => publicProjects.filter((r) => detailsByProjectId.has(r.id)),
    [publicProjects, detailsByProjectId],
  );

  // Picker modal pool: public projects not yet added.
  const candidateProjects = useMemo(() => {
    const remaining = publicProjects.filter((r) => !detailsByProjectId.has(r.id));
    if (!pickerSearch.trim()) return remaining;
    const q = pickerSearch.trim().toLowerCase();
    return remaining.filter((r) => {
      const data = r.data as Record<string, unknown>;
      const hay = [data.project_name, data.district, data.city]
        .filter((v): v is string => typeof v === 'string')
        .join(' ')
        .toLowerCase();
      return hay.includes(q);
    });
  }, [publicProjects, detailsByProjectId, pickerSearch]);

  if (!projectsModel || !detailsModel) {
    return (
      <div className="max-w-4xl">
        <div className="card p-8 text-center text-charcoal/40">
          <LayoutTemplate size={32} className="mx-auto mb-3 opacity-30" />
          <p className="text-sm">
            {isAr
              ? 'نموذج "تفاصيل المشاريع" غير متاح بعد. شغّل آخر ترحيل قاعدة البيانات.'
              : 'project_details model not present — run the latest migration.'}
          </p>
        </div>
      </div>
    );
  }

  const noPublic = publicProjects.length === 0;
  const noAdded = addedProjects.length === 0;

  return (
    <div className="max-w-6xl">
      {/* Back link */}
      <button
        onClick={() => navigate('/settings')}
        className="inline-flex items-center gap-1.5 text-xs text-charcoal/50 hover:text-copper transition mb-4"
      >
        <ArrowLeft size={14} className="rtl:rotate-180" />
        <span>{isAr ? 'الإعدادات' : 'Settings'}</span>
      </button>

      {/* Header — title + "+ Add" button */}
      <div className="flex items-start gap-3 mb-6">
        <div
          className="w-12 h-12 rounded-2xl flex items-center justify-center"
          style={{ backgroundColor: '#C4754A14' }}
        >
          <LayoutTemplate size={24} style={{ color: '#C4754A' }} />
        </div>
        <div className="flex-1 min-w-0">
          <h1 className="text-2xl font-bold text-chocolate">
            {isAr ? 'تفاصيل المشاريع' : 'Project Details Pages'}
          </h1>
          <p className="text-sm text-charcoal/50 mt-0.5 leading-relaxed">
            {isAr
              ? 'صفحات التفاصيل التي أعددتها للمشاريع المنشورة على الموقع.'
              : "Detail pages you've configured for projects published on the website."}
          </p>
        </div>
        {!noPublic && (
          <button
            onClick={() => { setPickerSearch(''); setPickerOpen(true); }}
            className="inline-flex items-center gap-2 bg-copper text-white text-sm font-bold px-4 py-2.5 rounded-full hover:bg-copper/90 transition shadow-sm shrink-0"
          >
            <Plus size={16} />
            <span>{isAr ? 'إضافة صفحة تفاصيل' : 'Add detail page'}</span>
          </button>
        )}
      </div>

      {/* Empty states */}
      {noPublic ? (
        <div className="card p-10 text-center text-charcoal/40">
          <LayoutTemplate size={32} className="mx-auto mb-3 opacity-30" />
          <p className="text-sm mb-2 text-charcoal/70">
            {isAr ? 'لا توجد مشاريع منشورة على الموقع بعد.' : 'No projects are published to the website yet.'}
          </p>
          <p className="text-xs leading-relaxed">
            {isAr
              ? 'لكي يمكنك إعداد صفحة تفاصيل لمشروع، فعّل أولاً خيار "عرض على الموقع" داخل سجل المشروع في نموذج "كل المشاريع".'
              : 'Before you can set up a detail page, turn on "Show on Website" inside the project record in the all_projects model.'}
          </p>
        </div>
      ) : noAdded ? (
        <div className="card p-10 text-center text-charcoal/40">
          <Sparkles size={32} className="mx-auto mb-3 opacity-30 text-copper" />
          <p className="text-sm mb-2 text-charcoal/70">
            {isAr ? 'لم تُعدّ صفحة تفاصيل لأي مشروع بعد.' : "You haven't set up any detail pages yet."}
          </p>
          <p className="text-xs leading-relaxed mb-5">
            {isAr
              ? `لديك ${publicProjects.length} مشروع منشور جاهز لإضافة صفحة تفاصيل له.`
              : `You have ${publicProjects.length} published project${publicProjects.length === 1 ? '' : 's'} ready for a detail page.`}
          </p>
          <button
            onClick={() => { setPickerSearch(''); setPickerOpen(true); }}
            className="inline-flex items-center gap-2 bg-copper text-white text-sm font-bold px-5 py-2.5 rounded-full hover:bg-copper/90 transition shadow-sm"
          >
            <Plus size={16} />
            <span>{isAr ? 'أضف أول صفحة' : 'Add your first page'}</span>
          </button>
        </div>
      ) : (
        <>
          <p className="text-xs text-charcoal/50 mb-4">
            {isAr
              ? `${addedProjects.length} صفحة تفاصيل مُعدّة`
              : `${addedProjects.length} detail page${addedProjects.length === 1 ? '' : 's'} configured`}
          </p>
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
            {addedProjects.map((rec) => {
              const data = rec.data as Record<string, unknown>;
              const name = String(data.project_name ?? (isAr ? 'بدون اسم' : 'Untitled'));
              const district = typeof data.district === 'string' ? data.district : '';
              const imageUrl = typeof data.image_url === 'string' ? data.image_url : '';

              return (
                <button
                  key={rec.id}
                  onClick={() => navigate(`/settings/project-details/${rec.id}`)}
                  className="card overflow-hidden text-start hover:border-copper/40 transition-all group flex flex-col"
                >
                  <div className="relative h-36 bg-cream/40 overflow-hidden">
                    {imageUrl ? (
                      <img
                        src={imageUrl}
                        alt={name}
                        className="w-full h-full object-cover group-hover:scale-105 transition-transform duration-500"
                        loading="lazy"
                      />
                    ) : (
                      <div className="w-full h-full flex items-center justify-center text-charcoal/20">
                        <ImageOff size={28} />
                      </div>
                    )}
                  </div>
                  <div className="p-4 flex-1 flex flex-col">
                    <h3 className="font-bold text-charcoal text-sm leading-tight line-clamp-2 mb-1.5 group-hover:text-copper transition-colors">
                      {name}
                    </h3>
                    {district && (
                      <p className="inline-flex items-center gap-1 text-[11px] text-charcoal/50 mb-3">
                        <MapPin size={11} />
                        <span>{district}</span>
                      </p>
                    )}
                    <div className="mt-auto pt-3 border-t border-sand/40 flex items-center justify-between text-[11px]">
                      <span className="text-copper font-bold">{isAr ? 'تعديل التفاصيل' : 'Edit details'}</span>
                      <a
                        href={`https://wassel-website.vercel.app/project.html?id=${encodeURIComponent(rec.id)}`}
                        target="_blank"
                        rel="noreferrer"
                        onClick={(e) => e.stopPropagation()}
                        className="inline-flex items-center gap-1 text-charcoal/40 hover:text-copper transition"
                      >
                        <span>{isAr ? 'فتح في الموقع' : 'Open on site'}</span>
                        <ExternalLink size={10} />
                      </a>
                    </div>
                  </div>
                </button>
              );
            })}
          </div>
        </>
      )}

      {/* Add picker modal */}
      {pickerOpen && (
        <div
          className="fixed inset-0 z-50 bg-charcoal/40 backdrop-blur-sm flex items-center justify-center p-4"
          onClick={() => setPickerOpen(false)}
        >
          <div
            className="bg-cream-light rounded-2xl shadow-2xl w-full max-w-2xl max-h-[80vh] flex flex-col overflow-hidden"
            onClick={(e) => e.stopPropagation()}
          >
            {/* Modal header */}
            <div className="flex items-center justify-between gap-3 p-5 border-b border-sand/50">
              <div>
                <h2 className="text-lg font-bold text-chocolate">
                  {isAr ? 'اختر مشروعاً لإضافة صفحة تفاصيل له' : 'Pick a project to add a detail page'}
                </h2>
                <p className="text-xs text-charcoal/50 mt-0.5">
                  {isAr
                    ? 'تظهر هنا المشاريع المنشورة على الموقع التي لم تُعدّ لها صفحة تفاصيل بعد.'
                    : 'Shows projects published on the website that don\'t have a detail page yet.'}
                </p>
              </div>
              <button
                onClick={() => setPickerOpen(false)}
                className="w-8 h-8 rounded-full hover:bg-charcoal/10 flex items-center justify-center text-charcoal/60 transition shrink-0"
                aria-label={isAr ? 'إغلاق' : 'Close'}
              >
                <X size={18} />
              </button>
            </div>

            {/* Search */}
            <div className="px-5 pt-4 pb-3 border-b border-sand/40">
              <div className="relative">
                <Search size={14} className="absolute top-1/2 -translate-y-1/2 start-3 text-charcoal/40 pointer-events-none" />
                <input
                  type="search"
                  value={pickerSearch}
                  onChange={(e) => setPickerSearch(e.target.value)}
                  placeholder={isAr ? 'ابحث في المشاريع...' : 'Search projects...'}
                  autoFocus
                  className="w-full bg-white border border-sand/60 rounded-full ps-9 pe-4 py-2 text-sm focus:outline-none focus:border-copper/60"
                />
              </div>
            </div>

            {/* Candidate list */}
            <div className="flex-1 overflow-y-auto p-3">
              {candidateProjects.length === 0 ? (
                <div className="p-8 text-center text-charcoal/40 text-sm">
                  {pickerSearch.trim()
                    ? (isAr ? 'لا توجد نتائج لبحثك.' : 'No results for your search.')
                    : (isAr
                      ? 'كل المشاريع المنشورة لديها صفحة تفاصيل بالفعل.'
                      : 'Every published project already has a detail page.')}
                </div>
              ) : (
                <ul className="space-y-1">
                  {candidateProjects.map((rec) => {
                    const data = rec.data as Record<string, unknown>;
                    const name = String(data.project_name ?? (isAr ? 'بدون اسم' : 'Untitled'));
                    const district = typeof data.district === 'string' ? data.district : '';
                    const imageUrl = typeof data.image_url === 'string' ? data.image_url : '';
                    return (
                      <li key={rec.id}>
                        <button
                          onClick={() => {
                            setPickerOpen(false);
                            navigate(`/settings/project-details/${rec.id}`);
                          }}
                          className="w-full flex items-center gap-3 p-2.5 rounded-xl hover:bg-cream/60 transition text-start group"
                        >
                          <div className="w-12 h-12 rounded-lg bg-cream overflow-hidden shrink-0 flex items-center justify-center text-charcoal/20">
                            {imageUrl ? (
                              <img src={imageUrl} alt="" className="w-full h-full object-cover" loading="lazy" />
                            ) : (
                              <ImageOff size={18} />
                            )}
                          </div>
                          <div className="flex-1 min-w-0">
                            <div className="font-bold text-sm text-charcoal truncate group-hover:text-copper transition">{name}</div>
                            {district && (
                              <div className="inline-flex items-center gap-1 text-[11px] text-charcoal/50">
                                <MapPin size={10} />
                                <span>{district}</span>
                              </div>
                            )}
                          </div>
                          <span className="text-xs font-bold text-copper opacity-0 group-hover:opacity-100 transition shrink-0">
                            {isAr ? 'إضافة' : 'Add'}
                          </span>
                        </button>
                      </li>
                    );
                  })}
                </ul>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
