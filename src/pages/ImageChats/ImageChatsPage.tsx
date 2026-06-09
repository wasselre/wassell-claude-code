import { useEffect, useMemo, useRef } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { v4 as uuid } from 'uuid';
import { useAppStore } from '@/stores/appStore';
import { Sparkles, Plus, ImageIcon, Pencil, Copy, Trash2 } from 'lucide-react';
import type { AppRecord } from '@/types';
import StudioWorkspace from './components/StudioWorkspace';
import { seedDefaultLibrariesIfEmpty } from './lib/seedDefaults';

/**
 * Image Chats v3 — Creative Studio. Two-pane layout:
 *   - Left: list of Creative Sessions (records in `image_chats`) with thumbnail,
 *     generation count, and rename / duplicate / delete actions.
 *   - Right: the workspace (StudioWorkspace) — canvas + timeline + composer +
 *     selected-asset panel — or an empty-state welcome.
 *
 * Each session's generations live in `record.data.generations[]`; the Composer
 * fires `POST /api/image-chat/generate` which appends a queued Generation and a
 * background job. Results stream in via Supabase Realtime; every output becomes
 * a first-class `media_assets` row.
 */
export default function ImageChatsPage() {
  const { recordId } = useParams();
  const navigate = useNavigate();
  const isAr = useAppStore((s) => s.language === 'ar');
  const models = useAppStore((s) => s.models);
  const recordsByModel = useAppStore((s) => s.records);
  const saveRecord = useAppStore((s) => s.saveRecord);
  const deleteRecord = useAppStore((s) => s.deleteRecord);
  const currentUserId = useAppStore((s) => s.currentUserId);

  const imageChatsModel = useMemo(() => models.find((m) => m.name === 'image_chats'), [models]);

  // One-shot seed of "Wassel default" preset + starter prompt snippets.
  const seedAttemptedRef = useRef(false);
  useEffect(() => {
    if (seedAttemptedRef.current) return;
    const presetsModel = models.find((m) => m.name === 'image_presets');
    const snippetsModel = models.find((m) => m.name === 'prompt_snippets');
    if (!presetsModel || !snippetsModel) return;
    seedAttemptedRef.current = true;
    void seedDefaultLibrariesIfEmpty({
      presetsModelId: presetsModel.id,
      snippetsModelId: snippetsModel.id,
      userId: currentUserId,
      saveRecord,
      isAr,
    });
  }, [models, saveRecord, isAr, currentUserId]);

  const sessions = useMemo<AppRecord[]>(() => {
    if (!imageChatsModel) return [];
    const all = recordsByModel[imageChatsModel.id] ?? [];
    return [...all].sort((a, b) => {
      const aT =
        (a.data.last_generation_at as string | undefined) ??
        (a.data.last_message_at as string | undefined) ??
        a.updated_at;
      const bT =
        (b.data.last_generation_at as string | undefined) ??
        (b.data.last_message_at as string | undefined) ??
        b.updated_at;
      return (bT ?? '').localeCompare(aT ?? '');
    });
  }, [imageChatsModel, recordsByModel]);

  function startNewSession() {
    if (!imageChatsModel) return;
    const now = new Date().toISOString();
    const newId = uuid();
    const record: AppRecord = {
      id: newId,
      model_id: imageChatsModel.id,
      data: {
        title: isAr ? 'جلسة جديدة' : 'New session',
        generations: [],
        generation_count: 0,
        last_aspect_ratio: '1:1',
        last_preset_id: null,
        created_by: currentUserId,
      },
      created_at: now,
      updated_at: now,
    };
    void saveRecord(record);
    navigate(`/model/image_chats/${newId}`);
  }

  function duplicateSession(session: AppRecord, e: React.MouseEvent) {
    e.stopPropagation();
    if (!imageChatsModel) return;
    const now = new Date().toISOString();
    const newId = uuid();
    const record: AppRecord = {
      id: newId,
      model_id: imageChatsModel.id,
      data: {
        ...session.data,
        title: `${(session.data.title as string | undefined) ?? 'Session'} ${isAr ? '(نسخة)' : '(copy)'}`,
        created_by: currentUserId,
      },
      created_at: now,
      updated_at: now,
    };
    void saveRecord(record);
    navigate(`/model/image_chats/${newId}`);
  }

  function renameSession(session: AppRecord, e: React.MouseEvent) {
    e.stopPropagation();
    const next = window.prompt(
      isAr ? 'اسم الجلسة' : 'Session name',
      String((session.data.title as string | undefined) ?? ''),
    );
    if (next === null) return;
    void saveRecord({
      ...session,
      data: { ...session.data, title: next.trim() || (isAr ? 'جلسة' : 'Session') },
      updated_at: new Date().toISOString(),
    });
  }

  function deleteSession(session: AppRecord, e: React.MouseEvent) {
    e.stopPropagation();
    if (!window.confirm(isAr ? 'حذف هذه الجلسة؟' : 'Delete this session?')) return;
    if (imageChatsModel) deleteRecord(imageChatsModel.id, session.id);
    if (recordId === session.id) navigate('/model/image_chats');
  }

  if (!imageChatsModel) {
    return (
      <div className="p-8 text-center text-charcoal/70">
        {isAr ? 'مساحة العمل غير مهيأة بعد. أعد تحميل الصفحة.' : 'Studio not initialized. Please reload.'}
      </div>
    );
  }

  return (
    <div className="h-[calc(100vh-8rem)] flex overflow-hidden rounded-2xl border border-sand/20 bg-white">
      {/* Left pane — sessions */}
      <div
        className={`w-full md:w-[300px] shrink-0 border-e border-sand/20 flex-col ${
          recordId ? 'hidden md:flex' : 'flex'
        }`}
      >
        <div className="p-3 border-b border-sand/20">
          <button
            onClick={startNewSession}
            className="w-full flex items-center justify-center gap-2 px-3 py-2 rounded-lg bg-copper text-white hover:bg-terracotta transition-colors text-sm font-medium"
          >
            <Plus size={16} />
            {isAr ? 'جلسة جديدة' : 'New session'}
          </button>
        </div>
        <div className="flex-1 overflow-y-auto">
          {sessions.length === 0 ? (
            <div className="p-6 text-center text-sm text-charcoal/60">
              {isAr ? 'لا توجد جلسات بعد.' : 'No sessions yet.'}
            </div>
          ) : (
            sessions.map((session) => {
              const title = (session.data.title as string | undefined) ?? (isAr ? 'جلسة' : 'Session');
              const gens = Array.isArray(session.data.generations)
                ? (session.data.generations as Array<{ status?: string }>)
                : [];
              const genCount = Number(session.data.generation_count ?? gens.length);
              const anyGenerating = gens.some((g) => g.status === 'queued' || g.status === 'generating');
              const thumbUrl = session.data.thumbnail_url as string | undefined;
              const active = session.id === recordId;
              return (
                <div
                  key={session.id}
                  onClick={() => navigate(`/model/image_chats/${session.id}`)}
                  className={`group w-full text-start p-2.5 border-b border-sand/10 hover:bg-cream transition-colors cursor-pointer flex items-center gap-2.5 ${
                    active ? 'bg-cream' : ''
                  }`}
                >
                  {/* Thumbnail */}
                  <div className="w-11 h-11 shrink-0 rounded-lg overflow-hidden border border-sand/30 bg-cream/50 flex items-center justify-center">
                    {thumbUrl ? (
                      <img src={thumbUrl} alt="" className="w-full h-full object-cover" loading="lazy" />
                    ) : (
                      <ImageIcon size={16} className="text-charcoal/30" />
                    )}
                  </div>
                  {/* Title + count */}
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-1.5">
                      <div className="font-medium text-sm truncate flex-1">{title}</div>
                      {anyGenerating && <span className="text-[10px] text-copper animate-pulse">●</span>}
                    </div>
                    <div className="text-xs text-charcoal/60 truncate mt-0.5">
                      {genCount > 0
                        ? isAr
                          ? `${genCount} إنشاء`
                          : `${genCount} generation${genCount === 1 ? '' : 's'}`
                        : isAr
                          ? 'جديدة'
                          : 'New'}
                    </div>
                  </div>
                  {/* Hover actions */}
                  <div className="hidden group-hover:flex items-center gap-0.5 shrink-0">
                    <IconBtn label={isAr ? 'إعادة تسمية' : 'Rename'} onClick={(e) => renameSession(session, e)}>
                      <Pencil size={13} />
                    </IconBtn>
                    <IconBtn label={isAr ? 'تكرار' : 'Duplicate'} onClick={(e) => duplicateSession(session, e)}>
                      <Copy size={13} />
                    </IconBtn>
                    <IconBtn label={isAr ? 'حذف' : 'Delete'} onClick={(e) => deleteSession(session, e)} danger>
                      <Trash2 size={13} />
                    </IconBtn>
                  </div>
                </div>
              );
            })
          )}
        </div>
      </div>

      {/* Right pane — workspace or welcome */}
      <div className={`flex-1 min-w-0 flex-col ${!recordId ? 'hidden md:flex' : 'flex'}`}>
        {recordId ? (
          <StudioWorkspace
            key={recordId}
            recordId={recordId}
            modelId={imageChatsModel.id}
            onNewChat={startNewSession}
          />
        ) : (
          <EmptyPane isAr={isAr} onStart={startNewSession} />
        )}
      </div>
    </div>
  );
}

function IconBtn({
  children,
  label,
  onClick,
  danger,
}: {
  children: React.ReactNode;
  label: string;
  onClick: (e: React.MouseEvent) => void;
  danger?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={label}
      aria-label={label}
      className={`p-1.5 rounded-md hover:bg-white transition-colors ${
        danger ? 'text-red-500 hover:text-red-600' : 'text-charcoal/50 hover:text-charcoal/80'
      }`}
    >
      {children}
    </button>
  );
}

function EmptyPane({ isAr, onStart }: { isAr: boolean; onStart: () => void }) {
  return (
    <div className="flex-1 flex flex-col items-center justify-center p-8 text-center">
      <div className="w-16 h-16 rounded-full bg-copper/10 flex items-center justify-center mb-4">
        <Sparkles size={32} className="text-copper" />
      </div>
      <h2 className="text-xl font-semibold text-charcoal mb-2">
        {isAr ? 'الاستوديو الإبداعي' : 'Creative Studio'}
      </h2>
      <p className="text-sm text-charcoal/70 max-w-md mb-6">
        {isAr
          ? 'صمم منشورات ولافتات وصور ترويجية على لوحة عمل واحدة. كل صورة تنشئها تصبح أصلاً قابلاً لإعادة الاستخدام في الملفات والسجلات والإعدادات التجارية.'
          : 'Design posts, banners, and promo imagery on one canvas. Every image you create becomes a reusable asset you can drop into Files, records, and brand presets.'}
      </p>
      <button
        onClick={onStart}
        className="flex items-center gap-2 px-4 py-2 rounded-lg bg-copper text-white hover:bg-terracotta transition-colors"
      >
        <Plus size={16} />
        {isAr ? 'جلسة جديدة' : 'New session'}
      </button>
    </div>
  );
}
