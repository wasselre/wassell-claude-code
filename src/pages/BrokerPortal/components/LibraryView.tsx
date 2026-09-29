/**
 * The developer-wide library (e.g. «مكتبة الرمز»): every linked photo, video,
 * design, floor plan and brochure across all projects, plus the projects' reel
 * links. Filter by type / project, search names, video transcripts AND post captions.
 * Metadata arrives in one call; urls are signed per visible page (action 'sign').
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { FileText, Film, Images, LayoutGrid, Library, Loader2, Palette, Search } from 'lucide-react';
import {
  fetchPortalLibrary, signPortalFiles,
  type LibraryFile, type PortalFile, type PortalLibrary, type SignedUrls,
} from '../lib/api';
import { makeT, type TKey } from '../lib/i18n';
import { normalizeForSearch } from '@/lib/recordSearch';
import { DocumentsSection, EmptySection, MediaGrid, VideosSection } from './Media';

type Kind = 'all' | 'photos' | 'videos' | 'designs' | 'plans' | 'documents' | 'reels';
const PAGE = 36;

function kindOf(f: LibraryFile): Exclude<Kind, 'all' | 'reels'> {
  if (f.section === 'plans') return 'plans';
  if (f.kind === 'pdf' || f.section === 'documents') return 'documents';
  if (f.kind === 'video') return 'videos';
  if (f.section === 'library') return 'designs';
  return 'photos';
}

export default function LibraryView({ token, isAr, title }: { token: string; isAr: boolean; title: string }) {
  const t = makeT(isAr);
  const [lib, setLib] = useState<PortalLibrary | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [kind, setKind] = useState<Kind>('all');
  const [project, setProject] = useState('');
  const [query, setQuery] = useState('');
  const [onlyTranscribed, setOnlyTranscribed] = useState(false);
  const [limit, setLimit] = useState(PAGE);
  const [urls, setUrls] = useState<Record<string, SignedUrls>>({});
  const pending = useRef(new Set<string>());
  // Ids the server would not sign (unlinked / archived since) — never retried.
  const [unavailable, setUnavailable] = useState<Set<string>>(new Set());

  useEffect(() => {
    let cancelled = false;
    fetchPortalLibrary(token)
      .then((d) => { if (!cancelled) setLib(d); })
      .catch((e: Error) => {
        console.error('[broker-portal] library failed:', e.message);
        if (!cancelled) setErr(e.message);
      });
    return () => { cancelled = true; };
  }, [token]);

  const projectName = useMemo(() => new Map((lib?.projects ?? []).map((p) => [p.id, p.name])), [lib]);

  const filtered = useMemo(() => {
    if (!lib) return [];
    const q = normalizeForSearch(query.trim());
    return lib.files.filter((f) => {
      if (kind !== 'all' && kind !== 'reels' && kindOf(f) !== kind) return false;
      if (kind === 'reels') return false;
      if (project && !f.project_ids.includes(project)) return false;
      if (onlyTranscribed && !f.transcript && !f.caption) return false;
      if (q) {
        const hay = normalizeForSearch([f.name, f.transcript ?? '', f.caption ?? '', ...f.project_ids.map((id) => projectName.get(id) ?? '')].join(' '));
        if (!hay.includes(q)) return false;
      }
      return true;
    });
  }, [lib, kind, project, query, onlyTranscribed, projectName]);

  const reels = useMemo(() => {
    if (!lib || (kind !== 'all' && kind !== 'reels') || onlyTranscribed || query.trim()) return [];
    return lib.hosted_videos.filter((v) => !project || v.project_id === project);
  }, [lib, kind, project, onlyTranscribed, query]);

  useEffect(() => { setLimit(PAGE); }, [kind, project, query, onlyTranscribed]);

  const visible = useMemo(() => filtered.slice(0, limit), [filtered, limit]);

  // Sign whatever is visible and not yet signed (≤ 60 per request).
  const signMissing = useCallback(async (ids: string[]) => {
    const need = ids.filter((id) => !urls[id] && !pending.current.has(id) && !unavailable.has(id));
    for (let i = 0; i < need.length; i += 60) {
      const chunk = need.slice(i, i + 60);
      chunk.forEach((id) => pending.current.add(id));
      try {
        const r = await signPortalFiles(token, chunk);
        setUrls((prev) => ({ ...prev, ...r.urls }));
        const missing = chunk.filter((id) => !r.urls[id]?.url);
        if (missing.length) setUnavailable((prev) => new Set([...prev, ...missing]));
      } catch (e) {
        console.error('[broker-portal] sign failed:', e);
        setUnavailable((prev) => new Set([...prev, ...chunk]));
      } finally {
        chunk.forEach((id) => pending.current.delete(id));
      }
    }
  }, [token, urls, unavailable]);

  useEffect(() => { void signMissing(visible.map((f) => f.id)); }, [visible, signMissing]);

  const asPortalFile = (f: LibraryFile): PortalFile | null => {
    const u = urls[f.id];
    if (!u?.url) return null;
    return {
      id: f.id, section: f.section, kind: f.kind, mime_type: f.mime_type, name: f.name,
      size_bytes: f.size_bytes, width: f.width, height: f.height, duration_seconds: f.duration_seconds,
      url: u.url, thumb: u.thumb, download: u.download, unit_ids: [], created_at: f.created_at, transcript: f.transcript, caption: f.caption, audio: f.audio,
    };
  };
  const ready = visible.map(asPortalFile).filter((f): f is PortalFile => !!f);
  const waiting = visible.filter((f) => !urls[f.id] && !unavailable.has(f.id)).length;
  const media = ready.filter((f) => f.kind !== 'pdf' && f.section !== 'documents' && f.kind !== 'video');
  const videos = ready.filter((f) => f.kind === 'video');
  const docs = ready.filter((f) => f.kind === 'pdf' || f.section === 'documents');

  const counts = useMemo(() => {
    const c: Record<Kind, number> = { all: 0, photos: 0, videos: 0, designs: 0, plans: 0, documents: 0, reels: lib?.hosted_videos.length ?? 0 };
    for (const f of lib?.files ?? []) { c.all++; c[kindOf(f)]++; }
    return c;
  }, [lib]);

  if (err) return <div className="rounded-2xl bg-white border border-sand/50 p-8 text-center text-sm text-charcoal/60">{t('errorTitle')} — {err}</div>;
  if (!lib) return <div className="py-24 flex justify-center"><Loader2 className="animate-spin text-copper" size={28} /></div>;

  const chips: Array<{ k: Kind; label: TKey; icon: typeof Images }> = [
    { k: 'all', label: 'all', icon: Library },
    { k: 'photos', label: 'photos', icon: Images },
    { k: 'designs', label: 'designs', icon: Palette },
    { k: 'videos', label: 'videos', icon: Film },
    { k: 'reels', label: 'reels', icon: Film },
    { k: 'plans', label: 'plans', icon: LayoutGrid },
    { k: 'documents', label: 'documents', icon: FileText },
  ];
  const transcribed = lib.files.filter((f) => f.kind === 'video' && (f.transcript || f.caption)).length;

  return (
    <div className="space-y-5">
      <section className="rounded-3xl bg-white border border-sand/50 p-5 sm:p-6">
        <h2 className="text-2xl font-bold text-chocolate">{title}</h2>
        <p className="mt-1 text-sm text-charcoal/60 leading-7">{t('libraryIntro')}</p>
        <div className="mt-4 flex flex-col md:flex-row gap-2">
          <label className="relative flex-1">
            <Search size={16} className="absolute top-1/2 -translate-y-1/2 start-3 text-charcoal/40" />
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder={t('searchLibrary')}
              className="w-full h-11 rounded-xl border border-sand bg-white ps-9 pe-3 text-sm focus:outline-none focus:border-copper"
            />
          </label>
          <select
            value={project}
            onChange={(e) => setProject(e.target.value)}
            className="h-11 rounded-xl border border-sand bg-white px-3 text-sm text-charcoal focus:outline-none focus:border-copper md:w-64"
            aria-label={t('projects')}
          >
            <option value="">{t('allProjects')}</option>
            {lib.projects.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
          </select>
        </div>
        <div className="mt-3 flex gap-1.5 overflow-x-auto [scrollbar-width:none] pb-1">
          {chips.filter((c) => c.k === 'all' || counts[c.k] > 0).map(({ k, label, icon: Icon }) => (
            <button
              key={k}
              type="button"
              onClick={() => setKind(k)}
              className={`shrink-0 inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full text-sm font-bold border transition ${
                kind === k ? 'bg-chocolate text-white border-chocolate' : 'bg-white text-charcoal border-sand hover:border-copper'
              }`}
            >
              <Icon size={14} /> {t(label)} <span className="opacity-60">{counts[k]}</span>
            </button>
          ))}
          {transcribed > 0 && (
            <button
              type="button"
              onClick={() => setOnlyTranscribed((v) => !v)}
              className={`shrink-0 px-3 py-1.5 rounded-full text-sm font-bold border transition ${
                onlyTranscribed ? 'bg-copper text-white border-copper' : 'bg-white text-copper border-copper/40'
              }`}
            >
              {t('withText')} <span className="opacity-70">{transcribed}</span>
            </button>
          )}
        </div>
      </section>

      <div className="text-sm text-charcoal/60">{filtered.length + reels.length} {t('files')}</div>

      {filtered.length === 0 && reels.length === 0 && <EmptySection isAr={isAr} />}
      {media.length > 0 && <MediaGrid files={media} isAr={isAr} />}
      {(videos.length > 0 || reels.length > 0) && <VideosSection files={videos} hosted={reels} isAr={isAr} />}
      {docs.length > 0 && <DocumentsSection files={docs} externalLinks={[]} isAr={isAr} />}
      {waiting > 0 && <div className="flex justify-center py-6"><Loader2 className="animate-spin text-copper" /></div>}

      {filtered.length > limit && (
        <div className="flex justify-center">
          <button type="button" onClick={() => setLimit((l) => l + PAGE)} className="px-5 py-2.5 rounded-xl bg-white border border-sand font-bold text-sm text-charcoal hover:border-copper">
            {t('loadMore')} ({filtered.length - limit})
          </button>
        </div>
      )}
    </div>
  );
}
