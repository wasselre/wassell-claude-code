import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { Loader2, AlertCircle, Sparkles, FileText, ArrowLeft } from 'lucide-react';
import { useAppStore } from '@/stores/appStore';
import { draftProjectDetails } from '@/lib/projectDetailsAi';
import type { AppRecord } from '@/types';

/**
 * Bridge route: /settings/project-details/:projectId
 *
 * Resolves the project_details sidecar for the given all_projects record:
 *   1. If a sidecar exists, redirect immediately to the standard editor
 *      at /model/project_details/<id>.
 *   2. If not, present a small "How do you want to start?" picker:
 *        • Start empty — saves a blank sidecar and opens the editor.
 *        • Draft with AI — calls the project-details-ai edge function,
 *          maps its output onto the new sidecar's fields, then opens
 *          the editor with everything pre-filled for the admin to review.
 *
 * Why the picker (vs. always asking, or always AI):
 *   • AI takes ~10s — so making it the default would feel slow when the
 *     admin just wants a blank canvas.
 *   • Some projects don't have enough data on all_projects yet for the
 *     AI to write anything useful — empty + manual is the right default
 *     for those.
 */
export default function ProjectDetailsBridgePage() {
  const { projectId } = useParams<{ projectId: string }>();
  const navigate = useNavigate();
  const isAr = useAppStore((s) => s.language === 'ar');
  const models = useAppStore((s) => s.models);
  const records = useAppStore((s) => s.records);
  const saveRecord = useAppStore((s) => s.saveRecord);

  const [error, setError] = useState<string | null>(null);
  const [phase, setPhase] = useState<'loading' | 'choose' | 'creating' | 'drafting'>('loading');
  // Avoid double-creating the sidecar in StrictMode dev double-renders.
  const handledRef = useRef(false);

  const projectsModel = models.find((m) => m.name === 'all_projects');
  const detailsModel = models.find((m) => m.name === 'project_details');

  const project = useMemo(() => {
    if (!projectsModel || !projectId) return null;
    return (records[projectsModel.id] ?? []).find((r) => r.id === projectId) ?? null;
  }, [projectsModel, records, projectId]);

  const projectName = String(
    (project?.data as { project_name?: string })?.project_name ?? (isAr ? 'هذا المشروع' : 'this project'),
  );

  useEffect(() => {
    if (!projectId || handledRef.current) return;
    if (!projectsModel || !detailsModel) return;
    if (!project) {
      setError(isAr
        ? 'المشروع المطلوب غير موجود — قد يكون تم حذفه.'
        : 'Project not found — it may have been deleted.');
      return;
    }

    const existing = (records[detailsModel.id] ?? []).find(
      (r) => (r.data as { project_id?: string })?.project_id === projectId,
    );
    if (existing) {
      handledRef.current = true;
      navigate(`/model/project_details/${existing.id}`, { replace: true });
      return;
    }

    // No sidecar yet — let the admin pick start mode.
    setPhase('choose');
  }, [projectId, projectsModel, detailsModel, records, project, navigate, isAr]);

  // Pull every pd_*-prefixed field from the site_settings singleton so we
  // can seed new project_details records with the template text. Anything
  // the admin already has in site_settings becomes the project's override
  // value, so the editor opens with the template visible and tweakable
  // (vs. blank fields that fall back to the template silently).
  function templateOverridesFromSiteSettings(): Record<string, unknown> {
    const siteModel = models.find((m) => m.name === 'site_settings');
    if (!siteModel) return {};
    const record = (records[siteModel.id] ?? [])[0];
    const data = (record?.data ?? {}) as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(data)) {
      if (k.startsWith('pd_') && typeof v === 'string' && v.trim()) out[k] = v;
    }
    return out;
  }

  async function createSidecar(extras: Record<string, unknown> = {}) {
    if (!detailsModel || !projectId) return;
    handledRef.current = true;
    const template = templateOverridesFromSiteSettings();
    const blank: AppRecord = {
      id: crypto.randomUUID(),
      model_id: detailsModel.id,
      data: {
        project_id: projectId,
        accent_color: 'copper',
        show_gallery: true,
        show_features: true,
        show_map: true,
        show_brochure: true,
        show_units: true,
        show_form: true,
        show_agent: true,
        // Template text values from site_settings — admin can edit any of
        // these per-project in the new "نصوص الصفحة" section.
        ...template,
        // `extras` (AI-drafted content, etc.) win over the template defaults.
        ...extras,
      },
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };
    const result = await saveRecord(blank);
    if (result.status === 'conflict') {
      setError(result.message);
      handledRef.current = false;
      return;
    }
    navigate(`/model/project_details/${blank.id}`, { replace: true });
  }

  async function startEmpty() {
    setPhase('creating');
    await createSidecar();
  }

  async function startWithAi() {
    if (!projectId) return;
    setPhase('drafting');
    const result = await draftProjectDetails(projectId);
    if (!result.ok) {
      setError(result.ok === false ? result.error : (isAr ? 'فشل المساعد الذكي' : 'AI draft failed'));
      setPhase('choose');
      handledRef.current = false;
      return;
    }
    await createSidecar({
      hero_short_description: result.draft.hero_short_description,
      description: result.draft.description,
      features: result.draft.features,
      landmarks: result.draft.landmarks,
    });
  }

  if (error) {
    return (
      <div className="max-w-2xl mx-auto py-16 text-center">
        <AlertCircle size={32} className="mx-auto mb-3 text-red-500/60" />
        <p className="text-sm text-charcoal/70 mb-4">{error}</p>
        <button
          onClick={() => navigate('/settings/project-details')}
          className="text-sm text-copper hover:underline"
        >
          {isAr ? 'العودة لقائمة المشاريع' : 'Back to projects'}
        </button>
      </div>
    );
  }

  if (phase === 'loading' || phase === 'creating') {
    return (
      <div className="flex items-center justify-center py-20 text-charcoal/40">
        <Loader2 size={20} className="animate-spin" />
        <span className="ms-2 text-sm">
          {isAr ? 'جارٍ فتح صفحة التفاصيل…' : 'Opening details page…'}
        </span>
      </div>
    );
  }

  if (phase === 'drafting') {
    return (
      <div className="max-w-xl mx-auto py-20 text-center">
        <div className="w-14 h-14 mx-auto mb-4 rounded-2xl bg-copper/10 flex items-center justify-center">
          <Sparkles size={26} className="text-copper animate-pulse" />
        </div>
        <h2 className="heading text-xl font-bold text-chocolate mb-2">
          {isAr ? 'يكتب المساعد الذكي صفحة التفاصيل…' : 'AI is drafting the page…'}
        </h2>
        <p className="text-sm text-charcoal/50 leading-relaxed">
          {isAr
            ? 'يستخدم بيانات المشروع لكتابة الوصف، اقتراح المميزات، واختيار المعالم القريبة. عادة ما يستغرق 10–20 ثانية.'
            : 'Using the project data to write the description, suggest features, and pick nearby landmarks. Usually takes 10–20 seconds.'}
        </p>
        <Loader2 size={18} className="animate-spin text-copper/70 mx-auto mt-6" />
      </div>
    );
  }

  // phase === 'choose'
  return (
    <div className="max-w-3xl mx-auto py-12">
      <button
        onClick={() => navigate('/settings/project-details')}
        className="inline-flex items-center gap-1.5 text-xs text-charcoal/50 hover:text-copper transition mb-6"
      >
        <ArrowLeft size={14} className="rtl:rotate-180" />
        <span>{isAr ? 'كل المشاريع' : 'All projects'}</span>
      </button>

      <div className="text-center mb-10">
        <h1 className="heading text-2xl md:text-3xl font-bold text-chocolate mb-2">
          {isAr ? `إعداد صفحة التفاصيل لـ "${projectName}"` : `Set up the details page for "${projectName}"`}
        </h1>
        <p className="text-sm text-charcoal/50 leading-relaxed">
          {isAr
            ? 'كيف تريد أن تبدأ؟ يمكنك دائماً تعديل كل شيء بعد ذلك.'
            : 'How do you want to start? You can edit everything afterward.'}
        </p>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-5">
        {/* Empty start */}
        <button
          onClick={startEmpty}
          className="card p-7 text-start hover:border-copper/40 transition group flex flex-col"
        >
          <div className="w-12 h-12 rounded-xl bg-charcoal/5 flex items-center justify-center mb-4">
            <FileText size={22} className="text-charcoal/60" />
          </div>
          <h3 className="heading font-bold text-chocolate text-base mb-1.5 group-hover:text-copper transition">
            {isAr ? 'البدء من صفحة فارغة' : 'Start with an empty page'}
          </h3>
          <p className="text-xs text-charcoal/50 leading-relaxed">
            {isAr
              ? 'أنشئ صفحة فارغة ثم أملأها بنفسك — مناسب إذا كنت تعرف بالضبط ما تريد كتابته.'
              : 'Create a blank page and fill it in yourself — best when you know exactly what you want.'}
          </p>
        </button>

        {/* AI draft */}
        <button
          onClick={startWithAi}
          className="card p-7 text-start hover:border-copper/40 transition group flex flex-col bg-copper/5 border-copper/20"
        >
          <div className="w-12 h-12 rounded-xl bg-copper/15 flex items-center justify-center mb-4">
            <Sparkles size={22} className="text-copper" />
          </div>
          <h3 className="heading font-bold text-chocolate text-base mb-1.5 group-hover:text-copper transition flex items-center gap-2">
            {isAr ? 'كتابة مع المساعد الذكي' : 'Draft with AI'}
            <span className="text-[10px] bg-copper text-white px-2 py-0.5 rounded-full font-bold">
              {isAr ? 'موصى به' : 'Recommended'}
            </span>
          </h3>
          <p className="text-xs text-charcoal/50 leading-relaxed">
            {isAr
              ? 'يستخدم الذكاء الاصطناعي بيانات المشروع لاقتراح وصف، مميزات، ومعالم قريبة — يمنح كل صفحة طابعاً مختلفاً عن الأخرى. يمكنك تعديل كل شيء قبل النشر.'
              : 'Uses the project data to suggest a description, features, and nearby landmarks — every page comes out different. Edit everything before publishing.'}
          </p>
        </button>
      </div>
    </div>
  );
}
