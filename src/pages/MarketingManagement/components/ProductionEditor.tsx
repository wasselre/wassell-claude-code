/**
 * Production editors — video scenes and carousel slides.
 *
 * Slides are a dynamic table, never fixed "Text 1..4" fields: a carousel can
 * have any number of slides and each is its own record with its own status,
 * assignee and linked asset.
 *
 * Reordering sends the full id order to the server, which parks rows in a
 * negative range before writing the final numbers — so ordering never collides
 * mid-move. Moves are optimistic locally and reconciled from the server reply.
 */
import { useState } from 'react';
import { ChevronUp, ChevronDown, Copy, Plus, Clock } from 'lucide-react';
import Button from '@/components/ui/Button';
import { Section, EmptyHint, Stat } from '@/pages/MarketingIntelligence/components/shared';
import { saveScene, saveSlide, reorderScenes, reorderSlides } from '@/lib/marketingMgmt/client';
import { SCENE_TYPE_LABEL, SLIDE_TYPE_LABEL, lbl } from '@/lib/marketingMgmt/labels';

const SCENE_TYPES = ['presenter','b_roll','drone','ai_visual','animation','screen_recording',
  'property_shot','floor_plan','text_only','testimonial','custom'] as const;
const SLIDE_TYPES = ['cover','content','comparison','feature','offer','testimonial','cta','custom'] as const;

type Row = Record<string, unknown>;
const s = (r: Row, k: string) => (r[k] == null ? '' : String(r[k]));
const n = (r: Row, k: string) => (r[k] == null ? null : Number(r[k]));

export function SceneEditor({ contentItemId, scenes, isAr, onChanged, onError }: {
  contentItemId: string; scenes: Row[]; isAr: boolean;
  onChanged: () => void; onError: (m: string) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [rows, setRows] = useState<Row[]>(scenes);
  const [open, setOpen] = useState<string | null>(null);

  const persist = async (patch: Row, id?: string) => {
    setBusy(true);
    try { await saveScene(patch, id); onChanged(); }
    catch (e) { onError(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(false); }
  };

  const move = async (idx: number, dir: -1 | 1) => {
    const next = [...rows]; const to = idx + dir;
    if (to < 0 || to >= next.length) return;
    [next[idx], next[to]] = [next[to]!, next[idx]!];
    setRows(next);                                   // optimistic
    setBusy(true);
    try { await reorderScenes(next.map((r) => String(r.id))); onChanged(); }
    catch (e) { setRows(rows); onError(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(false); }
  };

  const add = () => persist({
    content_item_id: contentItemId, scene_number: rows.length + 1,
    scene_type: 'b_roll', planned_seconds: 10,
  });

  const duplicate = (r: Row) => persist({
    content_item_id: contentItemId, scene_number: rows.length + 1,
    scene_type: r.scene_type, planned_seconds: r.planned_seconds,
    visual_description: r.visual_description, on_screen_text: r.on_screen_text,
    voice_over: r.voice_over, shot_instructions: r.shot_instructions,
  });

  const totalPlanned = rows.reduce((a, r) => a + (n(r, 'planned_seconds') ?? 0), 0);
  const missing = rows.filter((r) => !s(r, 'visual_description').trim()).length;

  return (
    <Section title={isAr ? 'المشاهد' : 'Scenes'}
      subtitle={isAr ? 'سيناريو منظم — كل مشهد سجل مستقل' : 'Structured script — one record per scene'}
      right={<Button onClick={add} disabled={busy}><Plus className="h-4 w-4" />{isAr ? 'مشهد' : 'Scene'}</Button>}>
      <div className="mb-3 grid grid-cols-2 gap-2.5 sm:grid-cols-4">
        <Stat label={isAr ? 'المشاهد' : 'Scenes'} value={rows.length} />
        <Stat label={isAr ? 'المدة المخططة' : 'Planned length'} value={rows.length ? `${totalPlanned}s` : null} />
        <Stat label={isAr ? 'بلا وصف بصري' : 'Missing visual'} value={missing} tone={missing > 0 ? 'warn' : 'default'} />
        <Stat label={isAr ? 'مكتملة' : 'Completed'} value={rows.filter((r) => r.status === 'completed').length} />
      </div>

      {rows.length === 0 ? <EmptyHint>{isAr ? 'لا مشاهد بعد' : 'No scenes yet'}</EmptyHint> : (
        <ul className="space-y-2">
          {rows.map((r, i) => {
            const id = String(r.id); const isOpen = open === id;
            return (
              <li key={id} className="rounded-xl border border-sand/50 bg-white">
                <div className="flex items-center gap-2 px-3 py-2">
                  <span className="grid h-6 w-6 shrink-0 place-items-center rounded-lg bg-cream text-[11px] font-semibold text-charcoal/60">{i + 1}</span>
                  <button type="button" onClick={() => setOpen(isOpen ? null : id)}
                    className="min-w-0 flex-1 truncate text-start text-[12.5px] text-charcoal">
                    {s(r, 'visual_description') || <span className="text-charcoal/35">{isAr ? '(بلا وصف)' : '(no description)'}</span>}
                  </button>
                  <span className="hidden shrink-0 items-center gap-1 text-[11px] text-charcoal/45 sm:inline-flex">
                    <Clock className="h-3 w-3" />{n(r, 'planned_seconds') ?? '—'}s
                  </span>
                  <div className="flex shrink-0 items-center gap-0.5">
                    <button type="button" disabled={busy || i === 0} onClick={() => move(i, -1)}
                      className="rounded p-1 text-charcoal/40 hover:text-copper disabled:opacity-25"><ChevronUp className="h-3.5 w-3.5" /></button>
                    <button type="button" disabled={busy || i === rows.length - 1} onClick={() => move(i, 1)}
                      className="rounded p-1 text-charcoal/40 hover:text-copper disabled:opacity-25"><ChevronDown className="h-3.5 w-3.5" /></button>
                    <button type="button" disabled={busy} onClick={() => duplicate(r)}
                      className="rounded p-1 text-charcoal/40 hover:text-copper disabled:opacity-25"><Copy className="h-3.5 w-3.5" /></button>
                  </div>
                </div>
                {isOpen && (
                  <div className="grid gap-2 border-t border-sand/40 p-3 sm:grid-cols-2">
                    <select defaultValue={s(r, 'scene_type')} onBlur={(e) => persist({ scene_type: e.target.value }, id)}
                      className="rounded-lg border border-sand/60 bg-white px-2.5 py-1.5 text-[12.5px]">
                      {SCENE_TYPES.map((t) => <option key={t} value={t}>{lbl(SCENE_TYPE_LABEL, t, isAr)}</option>)}
                    </select>
                    <input type="number" defaultValue={s(r, 'planned_seconds')} placeholder={isAr ? 'ثوانٍ' : 'seconds'}
                      onBlur={(e) => persist({ planned_seconds: Number(e.target.value) || null }, id)}
                      className="rounded-lg border border-sand/60 bg-white px-2.5 py-1.5 text-[12.5px]" />
                    <textarea defaultValue={s(r, 'visual_description')} rows={2}
                      placeholder={isAr ? 'الوصف البصري' : 'Visual description'}
                      onBlur={(e) => persist({ visual_description: e.target.value }, id)}
                      className="rounded-lg border border-sand/60 bg-white px-2.5 py-1.5 text-[12.5px] sm:col-span-2" />
                    <textarea defaultValue={s(r, 'voice_over')} rows={2}
                      placeholder={isAr ? 'التعليق الصوتي' : 'Voice-over'}
                      onBlur={(e) => persist({ voice_over: e.target.value }, id)}
                      className="rounded-lg border border-sand/60 bg-white px-2.5 py-1.5 text-[12.5px]" />
                    <textarea defaultValue={s(r, 'on_screen_text')} rows={2}
                      placeholder={isAr ? 'النص على الشاشة' : 'On-screen text'}
                      onBlur={(e) => persist({ on_screen_text: e.target.value }, id)}
                      className="rounded-lg border border-sand/60 bg-white px-2.5 py-1.5 text-[12.5px]" />
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </Section>
  );
}

export function SlideEditor({ contentItemId, slides, isAr, onChanged, onError }: {
  contentItemId: string; slides: Row[]; isAr: boolean;
  onChanged: () => void; onError: (m: string) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [rows, setRows] = useState<Row[]>(slides);
  const [open, setOpen] = useState<string | null>(null);

  const persist = async (patch: Row, id?: string) => {
    setBusy(true);
    try { await saveSlide(patch, id); onChanged(); }
    catch (e) { onError(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(false); }
  };

  const move = async (idx: number, dir: -1 | 1) => {
    const next = [...rows]; const to = idx + dir;
    if (to < 0 || to >= next.length) return;
    [next[idx], next[to]] = [next[to]!, next[idx]!];
    setRows(next);
    setBusy(true);
    try { await reorderSlides(next.map((r) => String(r.id))); onChanged(); }
    catch (e) { setRows(rows); onError(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(false); }
  };

  const add = () => persist({
    content_item_id: contentItemId, slide_number: rows.length + 1,
    slide_type: rows.length === 0 ? 'cover' : 'content',
  });

  const missingCopy = rows.filter((r) => !s(r, 'headline').trim() && !s(r, 'body_text').trim()).length;

  return (
    <Section title={isAr ? 'الشرائح' : 'Slides'}
      subtitle={isAr ? 'أي عدد من الشرائح — كل شريحة سجل مستقل' : 'Any number of slides — one record each'}
      right={<Button onClick={add} disabled={busy}><Plus className="h-4 w-4" />{isAr ? 'شريحة' : 'Slide'}</Button>}>
      <div className="mb-3 grid grid-cols-2 gap-2.5 sm:grid-cols-3">
        <Stat label={isAr ? 'الشرائح' : 'Slides'} value={rows.length} />
        <Stat label={isAr ? 'بلا نص' : 'Missing copy'} value={missingCopy} tone={missingCopy > 0 ? 'warn' : 'default'} />
        <Stat label={isAr ? 'مكتملة' : 'Completed'} value={rows.filter((r) => r.status === 'completed').length} />
      </div>

      {rows.length === 0 ? <EmptyHint>{isAr ? 'لا شرائح بعد' : 'No slides yet'}</EmptyHint> : (
        <ul className="space-y-2">
          {rows.map((r, i) => {
            const id = String(r.id); const isOpen = open === id;
            return (
              <li key={id} className="rounded-xl border border-sand/50 bg-white">
                <div className="flex items-center gap-2 px-3 py-2">
                  <span className="grid h-6 w-6 shrink-0 place-items-center rounded-lg bg-cream text-[11px] font-semibold text-charcoal/60">{i + 1}</span>
                  <button type="button" onClick={() => setOpen(isOpen ? null : id)}
                    className="min-w-0 flex-1 truncate text-start text-[12.5px] text-charcoal">
                    {s(r, 'headline') || <span className="text-charcoal/35">{isAr ? '(بلا عنوان)' : '(no headline)'}</span>}
                  </button>
                  <span className="hidden shrink-0 text-[11px] text-charcoal/45 sm:inline">{s(r, 'slide_type')}</span>
                  <div className="flex shrink-0 items-center gap-0.5">
                    <button type="button" disabled={busy || i === 0} onClick={() => move(i, -1)}
                      className="rounded p-1 text-charcoal/40 hover:text-copper disabled:opacity-25"><ChevronUp className="h-3.5 w-3.5" /></button>
                    <button type="button" disabled={busy || i === rows.length - 1} onClick={() => move(i, 1)}
                      className="rounded p-1 text-charcoal/40 hover:text-copper disabled:opacity-25"><ChevronDown className="h-3.5 w-3.5" /></button>
                  </div>
                </div>
                {isOpen && (
                  <div className="grid gap-2 border-t border-sand/40 p-3 sm:grid-cols-2">
                    <select defaultValue={s(r, 'slide_type')} onBlur={(e) => persist({ slide_type: e.target.value }, id)}
                      className="rounded-lg border border-sand/60 bg-white px-2.5 py-1.5 text-[12.5px]">
                      {SLIDE_TYPES.map((t) => <option key={t} value={t}>{lbl(SLIDE_TYPE_LABEL, t, isAr)}</option>)}
                    </select>
                    <input defaultValue={s(r, 'cta')} placeholder={isAr ? 'دعوة الإجراء' : 'CTA'}
                      onBlur={(e) => persist({ cta: e.target.value }, id)}
                      className="rounded-lg border border-sand/60 bg-white px-2.5 py-1.5 text-[12.5px]" />
                    <input defaultValue={s(r, 'headline')} placeholder={isAr ? 'العنوان' : 'Headline'}
                      onBlur={(e) => persist({ headline: e.target.value }, id)}
                      className="rounded-lg border border-sand/60 bg-white px-2.5 py-1.5 text-[12.5px] sm:col-span-2" />
                    <textarea defaultValue={s(r, 'body_text')} rows={2} placeholder={isAr ? 'النص' : 'Body text'}
                      onBlur={(e) => persist({ body_text: e.target.value }, id)}
                      className="rounded-lg border border-sand/60 bg-white px-2.5 py-1.5 text-[12.5px] sm:col-span-2" />
                    <textarea defaultValue={s(r, 'design_instructions')} rows={2}
                      placeholder={isAr ? 'تعليمات التصميم' : 'Design instructions'}
                      onBlur={(e) => persist({ design_instructions: e.target.value }, id)}
                      className="rounded-lg border border-sand/60 bg-white px-2.5 py-1.5 text-[12.5px] sm:col-span-2" />
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </Section>
  );
}
