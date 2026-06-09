import { useMemo, useState } from 'react';
import { useAppStore } from '@/stores/appStore';
import { Plus, Sparkles, Loader2, Clock, RefreshCw, X, ImageIcon } from 'lucide-react';
import type { AppRecord } from '@/types';
import {
  enqueueGeneration,
  cancelImageJob,
  type ChatAspectRatio,
  type ChatModelId,
  type Generation,
} from '@/lib/imageChat/client';
import Composer, { type ComposerSeed } from './Composer';
import SelectedAssetPanel from './SelectedAssetPanel';
import AssetLightbox from './AssetLightbox';
import AssetActions from './AssetActions';
import { chatModelDisplayName } from './ModelDropdown';
import { useSessionAssets, generationOutputs, generationThumbUrl, type OutputItem } from '../lib/generations';

interface Props {
  recordId: string;
  modelId: string;
  onNewChat: () => void;
}

const MAX_INFLIGHT = 3;
const ASPECT_CSS: Record<ChatAspectRatio, string> = {
  '1:1': '1 / 1',
  '9:16': '9 / 16',
  '16:9': '16 / 9',
  '4:3': '4 / 3',
  '3:4': '3 / 4',
};

/**
 * The Creative Workspace (Image Chats v3) — replaces the chat thread. Center
 * canvas shows the selected generation's outputs; a timeline strip lists
 * generations; the bottom Composer fires ONE generation (enqueueGeneration);
 * the right panel shows the selected output asset + its actions. Generations
 * run concurrently in the background and fill in via Realtime.
 */
export default function StudioWorkspace({ recordId, modelId, onNewChat }: Props) {
  const isAr = useAppStore((s) => s.language === 'ar');
  const recordsByModel = useAppStore((s) => s.records);
  const models = useAppStore((s) => s.models);
  const addToast = useAppStore((s) => s.addToast);

  const record = useMemo<AppRecord | undefined>(
    () => (recordsByModel[modelId] ?? []).find((r) => r.id === recordId),
    [recordsByModel, modelId, recordId],
  );

  const generations = useMemo<Generation[]>(() => {
    const raw = record?.data.generations;
    return Array.isArray(raw) ? (raw as Generation[]) : [];
  }, [record]);

  const assetsById = useSessionAssets(recordId, generations);

  // Brand presets (image_presets) → resolve a generation's preset_id to its
  // prompt_text for the "Branding prompt" section in the full-screen viewer.
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

  const lastAspect = (record?.data.last_aspect_ratio as ChatAspectRatio | undefined) ?? '1:1';
  const lastPresetId = (record?.data.last_preset_id as string | undefined | null) ?? null;
  const lastModelId = record?.data.last_model as string | undefined | null;

  // selectedGenerationId === null ⇒ follow the latest generation.
  const [selectedGenerationId, setSelectedGenerationId] = useState<string | null>(null);
  const [selectedOutputIdx, setSelectedOutputIdx] = useState<number | null>(null);
  const [lightboxOpen, setLightboxOpen] = useState(false);
  const [seed, setSeed] = useState<ComposerSeed | null>(null);
  const [basedOn, setBasedOn] = useState<string | null>(null);

  const selectedGen = useMemo<Generation | null>(() => {
    if (generations.length === 0) return null;
    if (selectedGenerationId) {
      return generations.find((g) => g.id === selectedGenerationId) ?? generations[generations.length - 1]!;
    }
    return generations[generations.length - 1]!;
  }, [generations, selectedGenerationId]);

  const selectedOutputs = useMemo<OutputItem[]>(
    () => (selectedGen ? generationOutputs(selectedGen, assetsById) : []),
    [selectedGen, assetsById],
  );

  const inFlight = useMemo(
    () => generations.filter((g) => g.status === 'queued' || g.status === 'generating').length,
    [generations],
  );

  const prevImageUrl = useMemo<string | null>(() => {
    for (let i = generations.length - 1; i >= 0; i--) {
      const g = generations[i]!;
      if (g.status === undefined || g.status === 'completed') {
        const out = generationOutputs(g, assetsById)[0];
        if (out) return out.url;
      }
    }
    return null;
  }, [generations, assetsById]);

  async function handleGenerate(params: {
    prompt: string;
    attachmentUrls: string[];
    attachmentSources: Array<'user' | 'preset' | 'snippet'>;
    aspectRatio: ChatAspectRatio;
    numVariations: number;
    presetId: string | null;
    modelId: ChatModelId;
  }) {
    try {
      await enqueueGeneration({
        sessionId: recordId,
        prompt: params.prompt,
        referenceUrls: params.attachmentUrls,
        referenceAssetIds: [],
        presetId: params.presetId,
        modelId: params.modelId,
        aspectRatio: params.aspectRatio,
        numVariations: params.numVariations,
        basedOn,
      });
      setBasedOn(null);
      setSelectedGenerationId(null); // follow the new latest generation
      setSelectedOutputIdx(null);
    } catch (err) {
      addToast(err instanceof Error ? err.message : String(err), 'error');
    }
  }

  function regenerate(gen: Generation) {
    void enqueueGeneration({
      sessionId: recordId,
      prompt: gen.prompt,
      referenceUrls: gen.reference_urls ?? [],
      referenceAssetIds: gen.reference_asset_ids ?? [],
      presetId: gen.preset_id ?? null,
      modelId: gen.model_id,
      aspectRatio: gen.aspect_ratio,
      numVariations: gen.num_variations,
      basedOn: gen.based_on ?? null,
    }).catch((err) => addToast(err instanceof Error ? err.message : String(err), 'error'));
    setSelectedGenerationId(null);
    setSelectedOutputIdx(null);
  }

  function handleCancel(jobId: string) {
    void cancelImageJob(jobId).catch((err) =>
      addToast(err instanceof Error ? err.message : String(err), 'error'),
    );
  }

  function createVariation(output: OutputItem, gen: Generation) {
    setBasedOn(gen.id);
    setSeed({
      attachmentUrl: output.url,
      attachmentName: 'reference.png',
      prompt: isAr
        ? 'أنشئ نسخة مختلفة من هذه الصورة مع الحفاظ على نفس التكوين والأسلوب.'
        : 'Create a variation of this image, keeping the same composition and style.',
    });
  }

  function useAsReference(output: OutputItem) {
    setSeed({ attachmentUrl: output.url, attachmentName: 'reference.png' });
  }

  if (!record) {
    return (
      <div className="flex-1 flex items-center justify-center text-charcoal/60">
        {isAr ? 'الجلسة غير موجودة' : 'Session not found'}
      </div>
    );
  }

  const selectedOutput = selectedOutputIdx !== null ? selectedOutputs[selectedOutputIdx] : null;
  const selPreset = selectedGen?.preset_id ? presetById.get(selectedGen.preset_id) : undefined;

  return (
    <div className="flex-1 flex flex-col min-h-0">
      {/* Header */}
      <div className="p-3 border-b border-sand/20 flex items-center gap-2">
        <div className="w-8 h-8 rounded-full bg-copper/10 flex items-center justify-center shrink-0">
          <Sparkles size={16} className="text-copper" />
        </div>
        <div className="min-w-0 flex-1">
          <div className="font-medium text-sm truncate">
            {(record.data.title as string | undefined) ?? (isAr ? 'جلسة إبداعية' : 'Creative session')}
          </div>
          <div className="text-xs text-charcoal/60">
            {chatModelDisplayName(lastModelId, isAr)} • {generations.length}{' '}
            {isAr ? 'إنشاء' : generations.length === 1 ? 'generation' : 'generations'}
          </div>
        </div>
        <button
          onClick={onNewChat}
          className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-copper text-white hover:bg-terracotta transition-colors text-xs font-medium shrink-0"
        >
          <Plus size={14} />
          <span className="hidden sm:inline">{isAr ? 'جديدة' : 'New'}</span>
        </button>
      </div>

      {/* Main: canvas (+ timeline) and the selected-asset panel */}
      <div className="flex-1 flex min-h-0">
        <div className="flex-1 flex flex-col min-h-0">
          {/* Canvas */}
          <div className="flex-1 overflow-y-auto p-6 flex items-center justify-center">
            {!selectedGen ? (
              <WelcomeHint isAr={isAr} />
            ) : (
              <Canvas
                gen={selectedGen}
                outputs={selectedOutputs}
                isAr={isAr}
                selectedOutputIdx={selectedOutputIdx}
                onSelectOutput={(i) => {
                  setSelectedOutputIdx(i);
                  setLightboxOpen(true);
                }}
                onCancel={handleCancel}
                onRetry={() => regenerate(selectedGen)}
              />
            )}
          </div>

          {/* Timeline strip */}
          {generations.length > 0 && (
            <Timeline
              generations={generations}
              assetsById={assetsById}
              activeId={selectedGen?.id ?? null}
              isAr={isAr}
              onPick={(id) => {
                setSelectedGenerationId(id);
                setSelectedOutputIdx(null);
              }}
            />
          )}
        </div>

        {selectedOutput && selectedGen && (
          <SelectedAssetPanel
            output={selectedOutput}
            generation={selectedGen}
            onClose={() => setSelectedOutputIdx(null)}
            onExpand={() => setLightboxOpen(true)}
            onCreateVariation={() => createVariation(selectedOutput, selectedGen)}
            onUseAsReference={() => useAsReference(selectedOutput)}
            onRegenerate={() => regenerate(selectedGen)}
          />
        )}
      </div>

      {/* Composer */}
      <Composer
        atCapacity={inFlight >= MAX_INFLIGHT}
        initialAspectRatio={lastAspect}
        initialPresetId={lastPresetId}
        seed={seed}
        onSeedConsumed={() => setSeed(null)}
        onSend={handleGenerate}
      />
      {/* prevImageUrl is computed for parity with v2 auto-chain; references are
          explicit in v3 (Use as Reference), so it isn't auto-attached. */}
      <span className="hidden">{prevImageUrl ?? ''}</span>

      {/* Full-screen viewer — opened by clicking a canvas image or the panel
          preview. Variation / Reference / Regenerate close it so the seeded
          composer is back in view. */}
      {lightboxOpen && selectedGen && selectedOutput && selectedOutputIdx !== null && (
        <AssetLightbox
          images={selectedOutputs.map((o) => ({ url: o.url }))}
          index={selectedOutputIdx}
          onIndexChange={(i) => setSelectedOutputIdx(i)}
          onClose={() => setLightboxOpen(false)}
          brandingPrompt={selPreset?.promptText ?? null}
          brandingName={selectedGen.preset_name ?? selPreset?.name ?? null}
          designPrompt={selectedGen.prompt}
          meta={{
            model: chatModelDisplayName(selectedGen.model_id, isAr),
            aspect: selectedGen.aspect_ratio,
            created: selectedGen.created_at,
          }}
          actions={
            <AssetActions
              output={selectedOutput}
              onCreateVariation={() => {
                createVariation(selectedOutput, selectedGen);
                setLightboxOpen(false);
              }}
              onUseAsReference={() => {
                useAsReference(selectedOutput);
                setLightboxOpen(false);
              }}
              onRegenerate={() => {
                regenerate(selectedGen);
                setLightboxOpen(false);
              }}
            />
          }
        />
      )}
    </div>
  );
}

function Canvas({
  gen,
  outputs,
  isAr,
  selectedOutputIdx,
  onSelectOutput,
  onCancel,
  onRetry,
}: {
  gen: Generation;
  outputs: OutputItem[];
  isAr: boolean;
  selectedOutputIdx: number | null;
  onSelectOutput: (i: number) => void;
  onCancel: (jobId: string) => void;
  onRetry: () => void;
}) {
  const aspectCss = ASPECT_CSS[gen.aspect_ratio ?? '1:1'];
  const pending = gen.status === 'queued' || gen.status === 'generating';

  if (pending) {
    return (
      <div className="relative w-full max-w-[520px]">
        <div
          className="rounded-2xl overflow-hidden border border-sand/30 bg-cream/40 animate-pulse"
          style={{ aspectRatio: aspectCss }}
        >
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 text-charcoal/60">
            {gen.status === 'queued' ? (
              <Clock size={28} className="text-copper" />
            ) : (
              <Loader2 size={28} className="text-copper animate-spin" />
            )}
            <span className="text-sm">
              {gen.status === 'queued' ? (isAr ? 'في الانتظار…' : 'Queued…') : isAr ? 'يتم الإنشاء…' : 'Generating…'}
            </span>
          </div>
        </div>
        {gen.job_id && (
          <button
            type="button"
            onClick={() => onCancel(gen.job_id!)}
            className="absolute top-3 end-3 p-2 rounded-full bg-charcoal/70 text-white hover:bg-charcoal transition-colors"
            aria-label={isAr ? 'إلغاء' : 'Cancel'}
          >
            <X size={14} />
          </button>
        )}
      </div>
    );
  }

  if (gen.status === 'failed' || gen.status === 'cancelled') {
    return (
      <div className="flex flex-col items-center gap-3 max-w-[480px] text-center">
        {gen.status === 'failed' ? (
          <div className="rounded-xl bg-red-50 border border-red-200 text-red-700 text-sm p-4 whitespace-pre-wrap w-full">
            {gen.error || (isAr ? 'فشل الإنشاء' : 'Generation failed')}
          </div>
        ) : (
          <div className="rounded-xl border border-sand/30 bg-cream text-charcoal/50 text-sm px-4 py-3 italic">
            {isAr ? 'تم الإلغاء' : 'Cancelled'}
          </div>
        )}
        <button
          type="button"
          onClick={onRetry}
          className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-sand/40 bg-white hover:bg-cream text-charcoal/80 transition-colors text-xs font-medium"
        >
          <RefreshCw size={12} />
          <span>{isAr ? 'إعادة المحاولة' : 'Retry'}</span>
        </button>
      </div>
    );
  }

  if (outputs.length === 0) {
    return <div className="text-sm text-charcoal/50 italic">{isAr ? '(لا توجد نتيجة)' : '(no result)'}</div>;
  }

  const cols = outputs.length <= 1 ? 'grid-cols-1' : 'grid-cols-2';
  return (
    <div className={`grid ${cols} gap-3 w-full max-w-[640px]`}>
      {outputs.map((o, i) => (
        <button
          key={o.url + i}
          type="button"
          onClick={() => onSelectOutput(i)}
          className={`relative rounded-2xl overflow-hidden border bg-cream/40 transition-all ${
            selectedOutputIdx === i ? 'border-copper ring-2 ring-copper/30' : 'border-sand/30 hover:border-copper/50'
          }`}
          style={{ aspectRatio: aspectCss }}
        >
          <img src={o.url} alt="" className="w-full h-full object-cover" loading="lazy" />
          {outputs.length > 1 && (
            <span className="absolute bottom-2 start-2 text-[10px] font-bold bg-charcoal/70 text-white rounded px-1.5 py-0.5">
              #{i + 1}
            </span>
          )}
        </button>
      ))}
    </div>
  );
}

function Timeline({
  generations,
  assetsById,
  activeId,
  isAr,
  onPick,
}: {
  generations: Generation[];
  assetsById: Map<string, import('@/lib/imageChat/client').MediaAsset>;
  activeId: string | null;
  isAr: boolean;
  onPick: (id: string) => void;
}) {
  return (
    <div className="border-t border-sand/20 bg-cream/30 p-2">
      <div className="flex items-center gap-2 overflow-x-auto">
        {generations.map((g, idx) => {
          const thumb = generationThumbUrl(g, assetsById);
          const pending = g.status === 'queued' || g.status === 'generating';
          const failed = g.status === 'failed' || g.status === 'cancelled';
          return (
            <button
              key={g.id}
              type="button"
              onClick={() => onPick(g.id)}
              title={g.prompt || `#${idx + 1}`}
              className={`relative w-14 h-14 shrink-0 rounded-lg overflow-hidden border transition-all ${
                activeId === g.id ? 'border-copper ring-2 ring-copper/30' : 'border-sand/40 hover:border-copper/50'
              }`}
            >
              {thumb ? (
                <img src={thumb} alt="" className="w-full h-full object-cover" loading="lazy" />
              ) : (
                <div className="w-full h-full flex items-center justify-center bg-cream/60">
                  {pending ? (
                    <Loader2 size={16} className="text-copper animate-spin" />
                  ) : failed ? (
                    <X size={16} className="text-red-400" />
                  ) : (
                    <ImageIcon size={16} className="text-charcoal/30" />
                  )}
                </div>
              )}
              <span className="absolute top-0.5 start-0.5 text-[8px] font-bold bg-charcoal/60 text-white rounded px-1">
                {idx + 1}
              </span>
            </button>
          );
        })}
        <span className="sr-only">{isAr ? 'مخطط الإنشاءات الزمني' : 'Generation timeline'}</span>
      </div>
    </div>
  );
}

function WelcomeHint({ isAr }: { isAr: boolean }) {
  return (
    <div className="text-center p-6 text-sm text-charcoal/60 max-w-md">
      <Sparkles size={28} className="mx-auto mb-3 text-copper" />
      <div className="font-medium text-charcoal mb-1">{isAr ? 'مساحة العمل الإبداعية' : 'Creative workspace'}</div>
      <div>
        {isAr
          ? 'اكتب وصفًا في الأسفل واضغط إرسال لإنشاء صورتك الأولى. كل نتيجة تصبح أصلاً قابلاً لإعادة الاستخدام.'
          : 'Describe what you want below and hit Send to create your first image. Every result becomes a reusable asset.'}
      </div>
    </div>
  );
}
