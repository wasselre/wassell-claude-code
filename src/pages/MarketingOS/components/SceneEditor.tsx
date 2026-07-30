/**
 * Scene table — design screen 7.
 *
 * A real table, not prose, because the shoot list is DERIVED from it: every
 * scene marked `missing` is a shot somebody has to go and film. That is why
 * footage status is a first-class control here rather than a note.
 */
import { useState } from 'react';
import { Plus, Trash2 } from 'lucide-react';
import { useAppStore } from '@/stores/appStore';
import Button from '@/components/ui/Button';
import { deleteScene, saveScene, FOOTAGE_LABELS, MosScene } from '@/lib/marketingOS/client';

interface Props {
  contentId: string;
  scenes: MosScene[];
  canEdit: boolean;
  isAr: boolean;
  onChange: (scenes: MosScene[]) => void;
}

const STATUSES: Array<MosScene['footage_status']> = ['have', 'to_make', 'missing'];

export default function SceneEditor({ contentId, scenes, canEdit, isAr, onChange }: Props) {
  const addToast = useAppStore((s) => s.addToast);
  const [busy, setBusy] = useState(false);

  const run = async (fn: () => Promise<{ scenes: MosScene[] }>) => {
    setBusy(true);
    try {
      const res = await fn();
      onChange(res.scenes);
    } catch (e) {
      addToast(e instanceof Error ? e.message : String(e), 'error');
    } finally {
      setBusy(false);
    }
  };

  const missing = scenes.filter((s) => s.footage_status === 'missing').length;
  const have = scenes.filter((s) => s.footage_status === 'have').length;

  return (
    <div className="space-y-3">
      {scenes.length > 0 && (
        <div className="flex flex-wrap items-center gap-3 rounded-xl border border-sand bg-white px-4 py-3">
          <div className="text-sm">
            <b>{have}</b>
            <span className="text-charcoal/55">
              {isAr ? ` من ${scenes.length} مشهدًا لديها تصوير` : ` of ${scenes.length} scenes have footage`}
            </span>
          </div>
          {missing > 0 && (
            <span className="rounded bg-red-50 px-2 py-1 text-xs font-semibold text-red-800">
              {isAr ? `${missing} ناقصة` : `${missing} missing`}
            </span>
          )}
          {missing > 0 && (
            <span className="ms-auto text-xs text-charcoal/55">
              {isAr
                ? 'المشاهد الناقصة هي ما يتجمّع في طلب التصوير.'
                : 'Missing scenes are what roll up into a shoot request.'}
            </span>
          )}
        </div>
      )}

      <div className="overflow-hidden rounded-xl border border-sand bg-white">
        {scenes.length === 0 ? (
          <p className="p-8 text-center text-sm text-charcoal/55">
            {isAr ? 'لا توجد مشاهد بعد.' : 'No scenes yet.'}
          </p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-sand bg-cream/50 text-xs text-charcoal/60">
                  <th className="w-10 p-3 text-start font-semibold">#</th>
                  <th className="p-3 text-start font-semibold">{isAr ? 'الصورة' : 'Visual'}</th>
                  <th className="p-3 text-start font-semibold">{isAr ? 'التعليق الصوتي' : 'Voice-over'}</th>
                  <th className="p-3 text-start font-semibold">{isAr ? 'نص الشاشة' : 'On-screen'}</th>
                  <th className="w-40 p-3 text-start font-semibold">{isAr ? 'التصوير' : 'Footage'}</th>
                  {canEdit && <th className="w-10 p-3" />}
                </tr>
              </thead>
              <tbody>
                {scenes.map((s) => (
                  <tr key={s.id} className="border-b border-sand/50 last:border-0 align-top">
                    <td className="p-3 text-xs text-charcoal/50">{s.position}</td>
                    {(['visual', 'voiceover', 'on_screen_text'] as const).map((f) => (
                      <td key={f} className="p-2">
                        <textarea
                          defaultValue={(s[f] as string | null) ?? ''}
                          disabled={!canEdit || busy}
                          rows={2}
                          onBlur={(e) => {
                            if (e.target.value !== ((s[f] as string | null) ?? '')) {
                              void run(() =>
                                saveScene(contentId, { id: s.id, [f]: e.target.value || null }),
                              );
                            }
                          }}
                          className="w-full rounded border border-transparent bg-transparent p-1 text-xs hover:border-sand focus:border-copper focus:bg-white focus:outline-none"
                        />
                      </td>
                    ))}
                    <td className="p-2">
                      <div className="flex gap-1">
                        {STATUSES.map((st) => (
                          <button
                            key={st}
                            type="button"
                            disabled={!canEdit || busy}
                            onClick={() => void run(() => saveScene(contentId, { id: s.id, footage_status: st }))}
                            className={`rounded px-1.5 py-1 text-[11px] font-semibold ${
                              s.footage_status === st
                                ? st === 'have'
                                  ? 'bg-green-600 text-white'
                                  : st === 'to_make'
                                    ? 'bg-amber-500 text-white'
                                    : 'bg-red-700 text-white'
                                : 'bg-cream text-charcoal/55'
                            }`}
                          >
                            {isAr ? FOOTAGE_LABELS[st]?.ar : FOOTAGE_LABELS[st]?.en}
                          </button>
                        ))}
                      </div>
                    </td>
                    {canEdit && (
                      <td className="p-2">
                        <button
                          type="button"
                          disabled={busy}
                          onClick={() => void run(() => deleteScene(contentId, s.id))}
                          className="rounded p-1.5 text-charcoal/40 hover:bg-red-50 hover:text-red-700"
                          aria-label={isAr ? 'حذف المشهد' : 'Delete scene'}
                        >
                          <Trash2 className="h-3.5 w-3.5" />
                        </button>
                      </td>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {canEdit && (
        <Button
          variant="secondary"
          disabled={busy}
          onClick={() => void run(() => saveScene(contentId, { footage_status: 'missing' }))}
        >
          <Plus className="h-4 w-4" />
          {isAr ? 'إضافة مشهد' : 'Add scene'}
        </Button>
      )}
    </div>
  );
}
