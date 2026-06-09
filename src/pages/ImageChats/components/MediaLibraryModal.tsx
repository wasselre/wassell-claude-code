import { useEffect, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import { useNavigate } from 'react-router-dom';
import { useAppStore } from '@/stores/appStore';
import { supabase } from '@/lib/supabase';
import { X, Search, Download, Link2, FolderPlus, Database, ExternalLink, Loader2, Images } from 'lucide-react';
import type { MediaAsset } from '@/lib/imageChat/client';
import AddImageToFilesModal from './AddImageToFilesModal';
import AddImageToRecordModal from './AddImageToRecordModal';

interface Props {
  onClose: () => void;
}

const PAGE_SIZE = 200;

/**
 * Cross-session Media Library (Image Chats v3, Part 6 foundation). A gallery
 * over ALL of the user's `media_assets` (RLS owner-scoped, newest first), with
 * prompt search + a kind filter. Selecting an asset shows its preview +
 * provenance + reuse actions (Download, Copy URL, Add to Files, Add to Record)
 * and a jump to the source session. The "shared media library" surface — the
 * generic asset browser the workspace was built toward.
 */
export default function MediaLibraryModal({ onClose }: Props) {
  const isAr = useAppStore((s) => s.language === 'ar');
  const addToast = useAppStore((s) => s.addToast);
  const navigate = useNavigate();

  const [assets, setAssets] = useState<MediaAsset[]>([]);
  const [loading, setLoading] = useState(true);
  const [query, setQuery] = useState('');
  const [selected, setSelected] = useState<MediaAsset | null>(null);
  const [filesOpen, setFilesOpen] = useState(false);
  const [recordOpen, setRecordOpen] = useState(false);

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

  async function copyUrl(url: string) {
    try {
      await navigator.clipboard.writeText(url);
      addToast(isAr ? 'تم نسخ الرابط' : 'URL copied', 'success');
    } catch {
      addToast(isAr ? 'تعذّر النسخ' : 'Copy failed', 'error');
    }
  }

  const pseudoImage = selected ? { url: selected.public_url, name: 'wassel-image.png' } : null;

  return createPortal(
    <div
      className="fixed inset-0 z-[60] flex items-center justify-center bg-charcoal/50 p-4"
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

        {/* Body: grid + detail */}
        <div className="flex-1 flex min-h-0">
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
                    className={`relative aspect-square rounded-lg overflow-hidden border bg-cream/40 transition-all ${
                      selected?.id === a.id ? 'border-copper ring-2 ring-copper/30' : 'border-sand/30 hover:border-copper/50'
                    }`}
                    title={a.prompt ?? ''}
                  >
                    <img src={a.public_url} alt="" className="w-full h-full object-cover" loading="lazy" />
                  </button>
                ))}
              </div>
            )}
          </div>

          {/* Detail */}
          {selected && pseudoImage && (
            <div className="w-[300px] shrink-0 border-s border-sand/20 flex flex-col overflow-y-auto p-3 space-y-3">
              <div className="rounded-xl overflow-hidden border border-sand/30 bg-cream/40">
                <img src={selected.public_url} alt="" className="w-full h-auto object-contain" />
              </div>
              <div className="space-y-2 text-xs">
                <Meta label={isAr ? 'الوصف' : 'Prompt'} value={selected.prompt || '—'} />
                <div className="flex gap-3">
                  <Meta label={isAr ? 'النموذج' : 'Model'} value={selected.model_id ?? '—'} />
                  <Meta label={isAr ? 'النوع' : 'Kind'} value={selected.kind} ltr />
                </div>
                <Meta label={isAr ? 'وقت الإنشاء' : 'Created'} value={formatTime(selected.created_at, isAr)} />
              </div>
              <div className="space-y-1.5 pt-1">
                <a
                  href={selected.public_url}
                  download="wassel-image.png"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="w-full inline-flex items-center gap-2 px-3 py-2 rounded-lg text-sm border border-sand/40 bg-white text-charcoal/80 hover:bg-cream transition-colors"
                >
                  <Download size={15} className="text-charcoal/60" /> {isAr ? 'تنزيل' : 'Download'}
                </a>
                <Btn icon={<Link2 size={15} className="text-charcoal/60" />} label={isAr ? 'نسخ الرابط' : 'Copy URL'} onClick={() => void copyUrl(selected.public_url)} />
                <Btn icon={<FolderPlus size={15} className="text-copper" />} label={isAr ? 'إضافة إلى الملفات' : 'Add to Files'} onClick={() => setFilesOpen(true)} />
                <Btn icon={<Database size={15} className="text-copper" />} label={isAr ? 'إضافة إلى سجل' : 'Add to Record'} onClick={() => setRecordOpen(true)} />
                {selected.source_session_id && (
                  <Btn
                    icon={<ExternalLink size={15} className="text-charcoal/60" />}
                    label={isAr ? 'فتح الجلسة' : 'Open session'}
                    onClick={() => {
                      navigate(`/model/image_chats/${selected.source_session_id}`);
                      onClose();
                    }}
                  />
                )}
              </div>
            </div>
          )}
        </div>
      </div>

      {filesOpen && pseudoImage && (
        <AddImageToFilesModal image={pseudoImage} imageIndex={0} messageId="" chatRecordId="" onClose={() => setFilesOpen(false)} />
      )}
      {recordOpen && pseudoImage && (
        <AddImageToRecordModal image={pseudoImage} imageIndex={0} messageId="" chatRecordId="" onClose={() => setRecordOpen(false)} />
      )}
    </div>,
    document.body,
  );
}

function Btn({ icon, label, onClick }: { icon: React.ReactNode; label: string; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="w-full inline-flex items-center gap-2 px-3 py-2 rounded-lg text-sm border border-sand/40 bg-white text-charcoal/80 hover:bg-cream transition-colors"
    >
      {icon}
      <span>{label}</span>
    </button>
  );
}

function Meta({ label, value, ltr }: { label: string; value: string; ltr?: boolean }) {
  return (
    <div className="min-w-0">
      <div className="text-charcoal/50">{label}</div>
      <div className="text-charcoal/90 break-words whitespace-pre-wrap" dir={ltr ? 'ltr' : undefined}>
        {value}
      </div>
    </div>
  );
}

function formatTime(iso: string, isAr: boolean): string {
  try {
    return new Date(iso).toLocaleString(isAr ? 'ar' : 'en', { dateStyle: 'medium', timeStyle: 'short' });
  } catch {
    return iso;
  }
}
