import { useState } from 'react';
import { Loader2, Sparkles, Image as ImageIcon } from 'lucide-react';
import Modal from '@/components/ui/Modal';
import { useAppStore } from '@/stores/appStore';
import { supabase } from '@/lib/supabase';
import {
  FEATURE_ICONS,
  LANDMARK_ICONS,
  libraryIconUrl,
  type IconLibraryEntry,
} from '@/data/iconLibrary';

interface IconPickerModalProps {
  open: boolean;
  onClose: () => void;
  /** Currently-stored value (a URL). Used to highlight the active library tile. */
  selected?: string;
  onSelect: (url: string) => void;
}

type Tab = 'library' | 'generate';

export default function IconPickerModal({ open, onClose, selected, onSelect }: IconPickerModalProps) {
  const isAr = useAppStore((s) => s.language === 'ar');
  const addToast = useAppStore((s) => s.addToast);
  const [tab, setTab] = useState<Tab>('library');
  const [prompt, setPrompt] = useState('');
  const [busy, setBusy] = useState(false);
  const [preview, setPreview] = useState<string | null>(null);

  if (!open) return null;

  const t = (ar: string, en: string) => (isAr ? ar : en);

  const handleGenerate = async () => {
    const trimmed = prompt.trim();
    if (!trimmed) return;
    setBusy(true);
    setPreview(null);
    try {
      const token = supabase ? (await supabase.auth.getSession()).data.session?.access_token : undefined;
      if (!token) throw new Error(t('انتهت الجلسة. يرجى إعادة تسجيل الدخول.', 'Session expired. Please sign in again.'));
      const res = await fetch('/api/icons/generate', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ prompt: trimmed }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        const msg = (body as { error?: string }).error ?? `HTTP ${res.status}`;
        throw new Error(msg);
      }
      const { url } = (await res.json()) as { url?: string };
      if (!url) throw new Error(t('لم يُرجع الخادم رابطًا.', 'Server returned no URL.'));
      setPreview(url);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      addToast(t(`فشل إنشاء الأيقونة: ${msg}`, `Icon generation failed: ${msg}`), 'error');
    } finally {
      setBusy(false);
    }
  };

  const closeAndReset = () => {
    setTab('library');
    setPrompt('');
    setPreview(null);
    setBusy(false);
    onClose();
  };

  return (
    <Modal
      open={open}
      onClose={closeAndReset}
      title={t('اختيار أيقونة', 'Pick an Icon')}
      maxWidth="max-w-2xl"
    >
      {/* Tabs */}
      <div className="flex items-center gap-1 mb-4 border-b border-sand/40">
        <TabButton
          active={tab === 'library'}
          onClick={() => setTab('library')}
          icon={<ImageIcon size={14} />}
          label={t('المكتبة', 'Library')}
        />
        <TabButton
          active={tab === 'generate'}
          onClick={() => setTab('generate')}
          icon={<Sparkles size={14} />}
          label={t('إنشاء بالذكاء الاصطناعي', 'Generate with AI')}
        />
      </div>

      {tab === 'library' && (
        <div className="space-y-4 max-h-[60vh] overflow-y-auto">
          <LibrarySection
            label={t('المميزات', 'Features')}
            entries={FEATURE_ICONS}
            selected={selected}
            onPick={(url) => {
              onSelect(url);
              closeAndReset();
            }}
            isAr={isAr}
          />
          <LibrarySection
            label={t('المعالم القريبة', 'Landmarks')}
            entries={LANDMARK_ICONS}
            selected={selected}
            onPick={(url) => {
              onSelect(url);
              closeAndReset();
            }}
            isAr={isAr}
          />
        </div>
      )}

      {tab === 'generate' && (
        <div className="space-y-4">
          <div>
            <label className="block text-xs font-bold text-charcoal/70 mb-1">
              {t('صف الأيقونة', 'Describe the icon')}
            </label>
            <textarea
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              placeholder={t(
                'مثال: مسبح على السطح، نادي صحي، تراس بإطلالة',
                'e.g. rooftop pool, wellness club, terrace view',
              )}
              rows={2}
              maxLength={300}
              className="w-full bg-white border border-sand/50 rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-copper"
            />
            <p className="text-[10px] text-charcoal/40 mt-1">
              {t(
                'سيتم تطبيق الهوية البصرية لـوصل تلقائيًا (نحاسي على خلفية شفافة، خطوط بسيطة).',
                'Wassel branding (copper on transparent, minimal lines) is applied automatically.',
              )}
            </p>
          </div>

          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={handleGenerate}
              disabled={busy || !prompt.trim()}
              className="inline-flex items-center gap-2 px-4 py-2 rounded-lg bg-copper text-white text-sm font-bold hover:bg-terracotta disabled:opacity-40 disabled:cursor-not-allowed"
            >
              {busy ? <Loader2 size={14} className="animate-spin" /> : <Sparkles size={14} />}
              {busy
                ? t('جاري الإنشاء…', 'Generating…')
                : preview
                  ? t('أنشئ مرة أخرى', 'Regenerate')
                  : t('إنشاء', 'Generate')}
            </button>
            {busy && (
              <span className="text-xs text-charcoal/50">
                {t('قد تستغرق ١٠ ثوانٍ تقريبًا', 'takes ~10s')}
              </span>
            )}
          </div>

          {preview && !busy && (
            <div className="border border-sand/40 rounded-xl p-4 bg-cream/40 flex items-center gap-4">
              <img
                src={preview}
                alt="generated preview"
                className="w-24 h-24 rounded-lg bg-white object-contain border border-sand/30"
              />
              <div className="flex-1">
                <div className="text-xs text-charcoal/60 mb-2">
                  {t('معاينة', 'Preview')}
                </div>
                <button
                  type="button"
                  onClick={() => {
                    onSelect(preview);
                    closeAndReset();
                  }}
                  className="px-3 py-1.5 rounded-lg bg-copper text-white text-xs font-bold hover:bg-terracotta"
                >
                  {t('استخدم هذه الأيقونة', 'Use this icon')}
                </button>
              </div>
            </div>
          )}
        </div>
      )}
    </Modal>
  );
}

function TabButton({
  active,
  onClick,
  icon,
  label,
}: {
  active: boolean;
  onClick: () => void;
  icon: React.ReactNode;
  label: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`inline-flex items-center gap-1.5 px-3 py-2 text-sm font-bold border-b-2 -mb-px transition-colors ${
        active
          ? 'border-copper text-copper'
          : 'border-transparent text-charcoal/50 hover:text-charcoal'
      }`}
    >
      {icon}
      {label}
    </button>
  );
}

function LibrarySection({
  label,
  entries,
  selected,
  onPick,
  isAr,
}: {
  label: string;
  entries: IconLibraryEntry[];
  selected?: string;
  onPick: (url: string) => void;
  isAr: boolean;
}) {
  return (
    <div>
      <div className="text-[10px] font-bold uppercase tracking-wider text-charcoal/40 mb-2">{label}</div>
      <div className="grid grid-cols-4 sm:grid-cols-6 gap-2">
        {entries.map((entry) => {
          const url = libraryIconUrl(entry.slug);
          const isSelected = selected === url;
          return (
            <button
              key={entry.slug}
              type="button"
              onClick={() => onPick(url)}
              title={isAr ? entry.label_ar : entry.label_en}
              className={`flex flex-col items-center gap-1 p-2 rounded-lg border transition-colors ${
                isSelected
                  ? 'border-copper bg-copper/10'
                  : 'border-sand/40 hover:border-copper/60 hover:bg-cream/50'
              }`}
            >
              <img
                src={url}
                alt={entry.slug}
                className="w-10 h-10 object-contain"
                onError={(e) => {
                  // Library asset missing in storage — fall back to a placeholder so
                  // the tile is still pickable and the rest of the grid still renders.
                  (e.currentTarget as HTMLImageElement).style.opacity = '0.25';
                }}
              />
              <span className="text-[10px] text-charcoal/60 text-center leading-tight line-clamp-2">
                {isAr ? entry.label_ar : entry.label_en}
              </span>
            </button>
          );
        })}
      </div>
    </div>
  );
}
