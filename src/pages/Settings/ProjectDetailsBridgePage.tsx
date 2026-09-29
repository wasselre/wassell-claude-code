import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { Loader2, AlertCircle } from 'lucide-react';
import { useAppStore } from '@/stores/appStore';
import { projectImagesToDetailFields } from '@/lib/projectDetailsAi';
import type { AppRecord } from '@/types';

/**
 * Bridge route: /settings/project-details/:projectId
 *
 * Opens the project_details sidecar for the given all_projects record in the
 * standard editor — creating it first when it does not exist yet.
 *
 * Since the 2026-09-29 short project page, the sidecar holds only what that
 * page reads: an optional hero-image override, up to eight extra gallery
 * images, an optional WhatsApp number and the show-units switch. The old
 * "start empty / draft with AI" picker is gone: the AI drafted a description
 * and features, and the page no longer shows either. A new sidecar is created
 * straight away with the project's own photos pre-filled.
 */
export default function ProjectDetailsBridgePage() {
  const { projectId } = useParams<{ projectId: string }>();
  const navigate = useNavigate();
  const isAr = useAppStore((s) => s.language === 'ar');
  const models = useAppStore((s) => s.models);
  const records = useAppStore((s) => s.records);
  const saveRecord = useAppStore((s) => s.saveRecord);

  const [error, setError] = useState<string | null>(null);
  // Avoid double-creating the sidecar in StrictMode dev double-renders.
  const handledRef = useRef(false);

  const projectsModel = models.find((m) => m.name === 'all_projects');
  const detailsModel = models.find((m) => m.name === 'project_details');

  const project = useMemo(() => {
    if (!projectsModel || !projectId) return null;
    return (records[projectsModel.id] ?? []).find((r) => r.id === projectId) ?? null;
  }, [projectsModel, records, projectId]);

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
    handledRef.current = true;
    if (existing) {
      navigate(`/model/project_details/${existing.id}`, { replace: true });
      return;
    }

    // No sidecar yet — create one with the project's own photos in place.
    const now = new Date().toISOString();
    const blank: AppRecord = {
      id: crypto.randomUUID(),
      model_id: detailsModel.id,
      data: {
        project_id: projectId,
        show_units: true,
        ...projectImagesToDetailFields(project.data as Record<string, unknown>),
      },
      created_at: now,
      updated_at: now,
    };
    void saveRecord(blank).then((result) => {
      if (result.status === 'conflict') {
        setError(result.message);
        handledRef.current = false;
        return;
      }
      navigate(`/model/project_details/${blank.id}`, { replace: true });
    });
  }, [projectId, projectsModel, detailsModel, records, project, navigate, isAr, saveRecord]);

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

  return (
    <div className="flex items-center justify-center py-20 text-charcoal/40">
      <Loader2 size={20} className="animate-spin" />
      <span className="ms-2 text-sm">
        {isAr ? 'جارٍ فتح صفحة المشروع…' : 'Opening the project page…'}
      </span>
    </div>
  );
}
