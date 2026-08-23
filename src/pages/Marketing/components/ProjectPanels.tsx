/**
 * Project panels for the content detail page.
 *
 * A content piece runs under a project (its own, or inherited from its
 * campaign). These two tabs put that project's material in front of the writer:
 *
 *  - ProjectAssetsTab — every FILE linked to the project record (brochures,
 *    floor plans, gallery images…), via the shared RecordFilesPanel.
 *  - ProjectInfoTab — a curated, read-only sheet of the project's FACTS
 *    (developer, status, available price/area, handover, payment plan…) so the
 *    writer has accurate, customer-facing numbers without leaving the page.
 *
 * Both resolve the project through `project_info` (which also returns the
 * all_projects model id the files panel needs).
 */
import { useEffect, useState } from 'react';
import {
  ProjectInfo, ProjectInfoField, fetchProjectInfo,
} from '@/lib/marketingOS/client';
import RecordFilesPanel from '../../Records/components/RecordFilesPanel';
import { LoadError, Skeleton } from './kit';
import { fullDate, money, num } from '../lib/format';

/* ── Project marketing assets (linked files) ─────────────────────── */

export function ProjectAssetsTab({ projectId, isAr }: { projectId: string; isAr: boolean }): JSX.Element {
  const [modelId, setModelId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [reload, setReload] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    void (async () => {
      try {
        const res = await fetchProjectInfo(projectId);
        if (!cancelled) setModelId(res.model_id);
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [projectId, reload]);

  if (loading) return <div className="card"><div className="card-b"><Skeleton rows={4} /></div></div>;
  if (error) return <LoadError message={error} onRetry={() => setReload((n) => n + 1)} isAr={isAr} />;
  if (!modelId) return <div className="card"><div className="card-b" style={{ color: 'var(--mute)', fontSize: 13 }}>{isAr ? 'تعذّر تحديد المشروع.' : 'Could not resolve the project.'}</div></div>;

  return (
    <div className="card">
      <div className="card-h">
        <h4>{isAr ? 'مواد المشروع التسويقية' : 'Project marketing assets'}</h4>
        <span className="r" style={{ fontSize: 11.5, color: 'var(--mute)' }}>
          {isAr ? 'الملفات المرتبطة بسجل المشروع' : 'files linked to the project record'}
        </span>
      </div>
      <div className="card-b">
        <RecordFilesPanel modelId={modelId} recordId={projectId} />
      </div>
    </div>
  );
}

/* ── Project info (facts sheet) ──────────────────────────────────── */

function fieldValue(f: ProjectInfoField, isAr: boolean): string {
  switch (f.kind) {
    case 'range':
    case 'range_currency': {
      const r = (f.value ?? {}) as { min?: number | null; max?: number | null };
      const cur = f.kind === 'range_currency';
      const fmt = (n: number | null | undefined): string =>
        n === null || n === undefined ? '—' : cur ? money(n, isAr) : num(n, isAr);
      if ((r.min === null || r.min === undefined) && (r.max === null || r.max === undefined)) return '—';
      return `${fmt(r.min)} – ${fmt(r.max)}`;
    }
    case 'currency':
      return money(typeof f.value === 'number' ? f.value : null, isAr);
    case 'number':
      return num(typeof f.value === 'number' ? f.value : null, isAr);
    case 'date':
      return fullDate(typeof f.value === 'string' ? f.value : null, isAr);
    default:
      return (isAr ? f.value_ar : f.value_en) ?? '';
  }
}

export function ProjectInfoTab({ projectId, isAr }: { projectId: string; isAr: boolean }): JSX.Element {
  const [info, setInfo] = useState<ProjectInfo | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [reload, setReload] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    void (async () => {
      try {
        const res = await fetchProjectInfo(projectId);
        if (!cancelled) setInfo(res.project);
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [projectId, reload]);

  if (loading) return <div className="card"><div className="card-b"><Skeleton rows={6} /></div></div>;
  if (error) return <LoadError message={error} onRetry={() => setReload((n) => n + 1)} isAr={isAr} />;
  if (!info) {
    return (
      <div className="card"><div className="card-b" style={{ color: 'var(--mute)', fontSize: 13, lineHeight: 1.8 }}>
        {isAr ? 'لا تتوفّر معلومات هذا المشروع (قد لا يكون لديك صلاحية عرض سجله).' : 'This project’s info is unavailable (you may not have access to its record).'}
      </div></div>
    );
  }

  return (
    <div className="card">
      <div className="card-h">
        <h4>{isAr ? 'معلومات المشروع' : 'Project info'}</h4>
        {info.our_project_id && (
          <a
            className="r"
            href={`/model/our_projects/${info.our_project_id}`}
            target="_blank"
            rel="noreferrer"
            style={{ fontSize: 11.5 }}
          >
            {isAr ? 'فتح سجل المشروع ↗' : 'Open project record ↗'}
          </a>
        )}
      </div>
      <div className="card-b">
        {info.developer_name && (
          <div style={{ marginBottom: 12, fontSize: 12.5 }}>
            <span style={{ color: 'var(--mute)' }}>{isAr ? 'المطوّر' : 'Developer'}</span>
            <div style={{ fontWeight: 700, marginTop: 2 }}>{info.developer_name}</div>
          </div>
        )}
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(210px, 1fr))', gap: 12 }}>
          {info.fields.map((f) => {
            const label = isAr ? f.label_ar : f.label_en;
            if (f.kind === 'url') {
              const url = typeof f.value === 'string' ? f.value : '';
              return (
                <div key={f.key} style={{ fontSize: 12.5 }}>
                  <span style={{ color: 'var(--mute)' }}>{label}</span>
                  <div style={{ marginTop: 2 }}>
                    <a href={url} target="_blank" rel="noreferrer" className="ltr" style={{ wordBreak: 'break-all' }}>
                      {isAr ? 'فتح الرابط ↗' : 'Open link ↗'}
                    </a>
                  </div>
                </div>
              );
            }
            if (f.kind === 'long') {
              return (
                <div key={f.key} style={{ fontSize: 12.5, gridColumn: '1 / -1' }}>
                  <span style={{ color: 'var(--mute)' }}>{label}</span>
                  <div style={{ marginTop: 2, whiteSpace: 'pre-wrap', lineHeight: 1.8 }}>
                    {(isAr ? f.value_ar : f.value_en) ?? ''}
                  </div>
                </div>
              );
            }
            return (
              <div key={f.key} style={{ fontSize: 12.5 }}>
                <span style={{ color: 'var(--mute)' }}>{label}</span>
                <div style={{ fontWeight: 700, marginTop: 2 }}>{fieldValue(f, isAr)}</div>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
