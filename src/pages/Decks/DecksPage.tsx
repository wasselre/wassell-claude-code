import { useMemo } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { v4 as uuid } from 'uuid';
import { useAppStore } from '@/stores/appStore';
import { Presentation, Plus, FileText, CheckCircle2, AlertCircle, Loader2, Clock } from 'lucide-react';
import type { AppRecord } from '@/types';
import DeckRightPane from './components/DeckRightPane';

/**
 * Two-pane "Decks" layout. Left = list of past decks (records in the
 * `decks` model). Right = the active deck (brief form, progress, ready
 * card, or error). Routes `/model/decks` and `/model/decks/:recordId` both
 * land here via the dispatcher in App.tsx.
 *
 * Each generation is one `decks` record. The brief, status, file metadata,
 * and error messages all live on `record.data`. The `/api/generate-deck`
 * endpoint drives the record through queued → generating → ready / failed.
 */
export default function DecksPage() {
  const { recordId } = useParams();
  const navigate = useNavigate();
  const isAr = useAppStore((s) => s.language === 'ar');
  const models = useAppStore((s) => s.models);
  const recordsByModel = useAppStore((s) => s.records);
  const saveRecord = useAppStore((s) => s.saveRecord);
  const currentUserId = useAppStore((s) => s.currentUserId);

  const decksModel = useMemo(() => models.find((m) => m.name === 'decks'), [models]);
  const decks = useMemo<AppRecord[]>(() => {
    if (!decksModel) return [];
    const all = recordsByModel[decksModel.id] ?? [];
    return [...all].sort((a, b) =>
      (b.created_at ?? '').localeCompare(a.created_at ?? ''),
    );
  }, [decksModel, recordsByModel]);

  function startNewDeck() {
    if (!decksModel) return;
    const now = new Date().toISOString();
    const newId = uuid();
    const record: AppRecord = {
      id: newId,
      model_id: decksModel.id,
      data: {
        title: '',
        brief: '',
        status: 'queued',
        created_by: currentUserId,
      },
      created_at: now,
      updated_at: now,
    };
    saveRecord(record);
    navigate(`/model/decks/${newId}`);
  }

  if (!decksModel) {
    return (
      <div className="p-8 text-center text-charcoal/70">
        {isAr
          ? 'نموذج العروض التقديمية غير مهيأ بعد. أعد تحميل الصفحة.'
          : 'Decks model not initialized. Please reload.'}
      </div>
    );
  }

  return (
    <div className="h-[calc(100vh-8rem)] flex overflow-hidden rounded-2xl border border-sand/20 bg-white">
      {/* Left pane — list + new-deck button */}
      <div
        className={`w-full md:w-[320px] shrink-0 border-e border-sand/20 flex-col ${
          recordId ? 'hidden md:flex' : 'flex'
        }`}
      >
        <div className="p-3 border-b border-sand/20">
          <button
            onClick={startNewDeck}
            className="w-full flex items-center justify-center gap-2 px-3 py-2 rounded-lg bg-copper text-white hover:bg-terracotta transition-colors text-sm font-medium"
          >
            <Plus size={16} />
            {isAr ? 'عرض جديد' : 'New deck'}
          </button>
        </div>
        <div className="flex-1 overflow-y-auto">
          {decks.length === 0 ? (
            <div className="p-6 text-center text-sm text-charcoal/60">
              {isAr ? 'لا توجد عروض بعد.' : 'No decks yet.'}
            </div>
          ) : (
            decks.map((deck) => {
              const title =
                ((deck.data.title as string | undefined) ?? '').trim() ||
                (isAr ? 'بدون عنوان' : 'Untitled');
              const status = (deck.data.status as string | undefined) ?? 'queued';
              const filename = deck.data.filename as string | undefined;
              const active = deck.id === recordId;
              return (
                <button
                  key={deck.id}
                  onClick={() => navigate(`/model/decks/${deck.id}`)}
                  className={`w-full text-start p-3 border-b border-sand/10 hover:bg-cream transition-colors ${
                    active ? 'bg-cream' : ''
                  }`}
                >
                  <div className="flex items-center gap-2">
                    <FileText size={14} className="text-copper shrink-0" />
                    <div className="font-medium text-sm truncate flex-1">{title}</div>
                    <StatusPill status={status} isAr={isAr} />
                  </div>
                  {filename && (
                    <div className="text-xs text-charcoal/50 truncate mt-1 ps-6">
                      {filename}
                    </div>
                  )}
                </button>
              );
            })
          )}
        </div>
      </div>

      {/* Right pane — active deck or welcome */}
      <div className={`flex-1 min-w-0 flex-col ${!recordId ? 'hidden md:flex' : 'flex'}`}>
        {recordId ? (
          <DeckRightPane
            key={recordId}
            recordId={recordId}
            modelId={decksModel.id}
            onNewDeck={startNewDeck}
          />
        ) : (
          <EmptyPane isAr={isAr} onStart={startNewDeck} />
        )}
      </div>
    </div>
  );
}

function StatusPill({ status, isAr }: { status: string; isAr: boolean }) {
  const config: Record<string, { ar: string; en: string; bg: string; fg: string; Icon: typeof Clock }> = {
    queued: { ar: 'بانتظار', en: 'Queued', bg: 'bg-charcoal/10', fg: 'text-charcoal/70', Icon: Clock },
    generating: { ar: 'قيد التوليد', en: 'Generating', bg: 'bg-blue-100', fg: 'text-blue-700', Icon: Loader2 },
    ready: { ar: 'جاهز', en: 'Ready', bg: 'bg-green-100', fg: 'text-green-700', Icon: CheckCircle2 },
    failed: { ar: 'فشل', en: 'Failed', bg: 'bg-red-100', fg: 'text-red-700', Icon: AlertCircle },
  };
  const c = config[status] ?? config.queued!;
  const { Icon } = c;
  return (
    <span className={`inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-medium ${c.bg} ${c.fg}`}>
      <Icon size={10} className={status === 'generating' ? 'animate-spin' : ''} />
      {isAr ? c.ar : c.en}
    </span>
  );
}

function EmptyPane({ isAr, onStart }: { isAr: boolean; onStart: () => void }) {
  return (
    <div className="flex-1 flex flex-col items-center justify-center p-8 text-center">
      <div className="w-16 h-16 rounded-full bg-copper/10 flex items-center justify-center mb-4">
        <Presentation size={32} className="text-copper" />
      </div>
      <h2 className="text-xl font-semibold text-charcoal mb-2">
        {isAr ? 'منشئ العروض التقديمية' : 'Deck Builder'}
      </h2>
      <p className="text-sm text-charcoal/70 max-w-md mb-6">
        {isAr
          ? 'صف العرض الذي تريده — الغرض والجمهور والمحتوى — وسيقوم Claude ببناء عرض PowerPoint متوافق مع هوية وصل، بألوان النحاس والعربي وخط أميري. كل عرض مختلف.'
          : 'Describe the deck you want — purpose, audience, content — and Claude builds a Wassel-branded PowerPoint with the copper palette, Arabic typography, and Amiri font. Every deck looks different.'}
      </p>
      <button
        onClick={onStart}
        className="flex items-center gap-2 px-4 py-2 rounded-lg bg-copper text-white hover:bg-terracotta transition-colors"
      >
        <Plus size={16} />
        {isAr ? 'عرض جديد' : 'New deck'}
      </button>
    </div>
  );
}
