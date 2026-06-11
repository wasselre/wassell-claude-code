import { useEffect, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import { useNavigate } from 'react-router-dom';
import { useAppStore } from '@/stores/appStore';
import { supabase } from '@/lib/supabase';
import { X, Search, Loader2, Images, ExternalLink } from 'lucide-react';
import type { AppRecord } from '@/types';
import type { MediaAsset, Generation } from '@/lib/imageChat/client';
import AssetLightbox from './AssetLightbox';
import AssetActions from './AssetActions';

interface Props {
  onClose: () => void;
}

const PAGE_SIZE = 200;

/**
 * Cross-session Media Library (Image Chats v3). A gallery over ALL of the user's
 * `media_assets` (RLS owner-scoped, newest first) with prompt search. Clicking
 * an asset opens the SAME full-screen viewer as the workspace (AssetLightbox):
 * left = Branding/Design prompt sections (resolved from the asset's source
 * generation), center = the image, right = the asset actions (Download, Copy
 * URL, Add to Files, Add to Record, + Open source session). The branding/design
 * split is resolved by finding the source generation in the store; if it can't
 * be resolved (e.g. migrated outputs), the asset's stored prompt is shown as the
 * Design prompt.
 */
export default function MediaLibraryModal({ onClose }: Props) {
  const isAr = useAppStore((s) => s.language === 'ar');
  const addToast = useAppStore((s) => s.addToast);
  const models = useAppStore((s) => s.models);
  const recordsByModel = useAppStore((s) => s.records);
  const navigate = useNavigate();

  const [assets, setAssets] = useState<MediaAsset[]>([]);
  const [loading, setLoading] = useState(true);
  const [query, setQuery] = useState('');
  const [selected, setSelected] = useState<MediaAsset | null>(null);

  useEffect(() => {
    if (!supabase) {
      setLoading(false);
      return;
    }
    let cancelled = false;
    setLoading(true);
    void supabase
      .from('media_assets')
      .select('*')
      .order('created_at', { ascending: false })
      .limit(PAGE_SIZE)
      .then(({ data, error }) => {
        if (cancelled) return;
        if (error) addToast(isAr ? `تعذّر تحميل المكتبة: ${error.message}` : `Library load failed: ${error.message}`, 'error');
        setAssets((data as MediaAsset[]) ?? []);
        setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [addToast, isAr]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return assets;
    return assets.filter(
      (a) =>
        (a.prompt ?? '').toLowerCase().includes(q) || (a.model_id ?? '').toLowerCase().includes(q),
    );
  }, [assets, query]);

  // image_presets → prompt_text, for the Branding section.
  const presetById = useMemo(() => {
    const pModel = models.find((m) => m.name === 'image_presets');
    const recs = pModel ? (recordsByModel[pModel.id] ?? []) : [];
    const map = new Map<string, { promptText: string; name: string }>();
    for (const r of recs) {
      map.set(r.id, {
        promptText: String((r.data.prompt_text as string | undefined) ?? ''),
        name: String((r.data.name as string | undefined) ?? ''),
      });
    }
    return map;
  }, [models, recordsByModel]);

  // image_chats sessions → resolve an asset's source generation (preset + design prompt).
  const sessionsById = useMemo(() => {
    const icModel = models.find((m) => m.name === 'image_chats');
    const recs = icModel ? (recordsByModel[icModel.id] ?? []) : [];
    const map = new Map<string, AppRecord>();
    for (const r of recs) map.set(r.id, r);
    return map;
  }, [models, recordsByModel]);

  function partsFor(asset: MediaAsset): {
    brandingPrompt: string | null;
    brandingName: string | null;
    designPrompt: string;
    references: string[];
  } {
    const session = asset.source_session_id ? sessionsById.get(asset.source_session_id) : undefined;
    const gens = session && Array.isArray(session.data.generations) ? (session.data.generations as Generation[]) : [];
    const gen = asset.source_generation_id ? gens.find((g) => g.id === asset.source_generation_id) : undefined;
    const preset = gen?.preset_id ? presetById.get(gen.preset_id) : undefined;
    return {
      brandingPrompt: preset?.promptText ?? null,
      brandingName: gen?.preset_name ?? preset?.name ?? null,
      // Fallback: the asset's stored (merged) prompt as Design when the source
      // generation can't be resolved (e.g. migrated outputs).
      designPrompt: gen?.prompt ?? asset.prompt ?? '',
      references: gen?.reference_urls ?? [],
    };
  }

  const parts = selected ? partsFor(selected) : null;

  return (
    <>
      {createPortal(
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-charcoal/50 p-4"
          dir={isAr ? 'rtl' : 'ltr'}
          onClick={onClose}
        >
          <div
            className="w-full max-w-5xl h-[85vh] flex flex-col rounded-2xl bg-white shadow-2xl overflow-hidden"
            onClick={(e) => e.stopPropagation()}
          >
            {/* Header */}
            <div className="flex items-center gap-3 p-3 border-b border-sand/20">
              <Images size={18} className="text-copper shrink-0" />
              <div className="text-sm font-semibold text-charcoal">{isAr ? 'مكتبة الوسائط' : 'Media Library'}</div>
              <div className="relative flex-1 max-w-sm">
                <Search size={14} className="absolute top-1/2 -translate-y-1/2 start-2.5 text-charcoal/40" />
                <input
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  placeholder={isAr ? 'ابحث بالوصف…' : 'Search by prompt…'}
                  className="w-full ps-8 pe-3 py-1.5 rounded-lg border border-sand/40 focus:border-primary focus:ring-2 focus:ring-primary/20 outline-none text-sm bg-white"
                />
              </div>
              <div className="text-xs text-charcoal/50">
                {filtered.length} {isAr ? 'أصل' : filtered.length === 1 ? 'asset' : 'assets'}
              </div>
              <button onClick={onClose} className="p-1.5 rounded-lg hover:bg-cream text-charcoal/70" aria-label={isAr ? 'إغلاق' : 'Close'}>
                <X size={18} />
              </button>
            </div>

            {/* Grid */}
            <div className="flex-1 overflow-y-auto p-3">
              {loading ? (
                <div className="h-full flex items-center justify-center text-charcoal/50">
                  <Loader2 size={24} className="animate-spin text-copper" />
                </div>
              ) : filtered.length === 0 ? (
                <div className="h-full flex items-center justify-center text-sm text-charcoal/50">
                  {assets.length === 0
                    ? isAr
                      ? 'لا توجد وسائط بعد. أنشئ صورًا في الاستوديو.'
                      : 'No media yet. Generate images in the studio.'
                    : isAr
                      ? 'لا توجد نتائج مطابقة.'
                      : 'No matching assets.'}
                </div>
              ) : (
                <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 gap-2">
                  {filtered.map((a) => (
                    <button
                      key={a.id}
                      type="button"
                      onClick={() => setSelected(a)}
                      className="relative aspect-square rounded-lg overflow-hidden border border-sand/30 hover:border-copper/60 bg-cream/40 transition-all"
                      title={a.prompt ?? ''}
                    >
                      <img src={a.public_url} alt="" className="w-full h-full object-cover" loading="lazy" />
                    </button>
                  ))}
                </div>
              )}
            </div>
          </div>
        </div>,
        document.body,
      )}

      {/* Full-screen viewer — same layout as the workspace (left prompts /
          center image / right actions). Renders on top of the gallery. */}
      {selected && parts && (
        <AssetLightbox
          images={[{ url: selected.public_url }]}
          index={0}
          onIndexChange={() => undefined}
          onClose={() => setSelected(null)}
          brandingPrompt={parts.brandingPrompt}
          brandingName={parts.brandingName}
          designPrompt={parts.designPrompt}
          references={parts.references}
          meta={{
            model: selected.model_id,
            aspect: (selected.settings?.aspect_ratio as string | undefined) ?? null,
            created: selected.created_at,
          }}
          actions={
            <AssetActions
              output={{ url: selected.public_url }}
              extra={
                selected.source_session_id ? (
                  <button
                    type="button"
                    onClick={() => {
                      navigate(`/model/image_chats/${selected.source_session_id}`);
                      onClose();
                    }}
                    className="w-full inline-flex items-center gap-2 px-3 py-2 rounded-lg text-sm border border-sand/40 bg-white text-charcoal/80 hover:bg-cream transition-colors"
                  >
                    <ExternalLink size={15} className="text-charcoal/60" />
                    <span>{isAr ? 'فتح الجلسة' : 'Open session'}</span>
                  </button>
                ) : undefined
              }
            />
          }
        />
      )}
    </>
  );
}
