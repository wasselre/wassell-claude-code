import { useEffect, useRef, useState } from 'react';
import { useAppStore } from '@/stores/appStore';
import {
  Sparkles,
  Loader2,
  MessageSquareText,
  ChevronDown,
  ChevronRight,
  AlertCircle,
  RotateCcw,
  ArrowRight,
  ArrowLeft,
  FileText,
  Image as ImageIcon,
  FileSpreadsheet,
  ListChecks,
  CheckCircle2,
  HelpCircle,
} from 'lucide-react';
import { planExtraction, type MigrationUpload } from '../../lib/client';
import { targetFieldLites } from '../../lib/targetFields';
import { useMigrationJobs } from '../../lib/jobRunner';
import { isProjectProfileTarget } from '../../lib/types';
import type { ChatMessage, ProposedColumn, MigrationStatus } from '../../lib/types';
import type { AppModel } from '@/types';

interface StepPrepProps {
  isAr: boolean;
  recordId: string;
  /** Target model — its fields seed the planning hunt-list (never coerce values). */
  model: AppModel;
  /** Uploaded source files — the AI reads them (incl. floor plans) while planning. */
  sourceFiles?: MigrationUpload[];
  /** Free-text instructions for how to extract (persisted, debounced here). */
  instructions?: string;
  onInstructions: (v: string) => void;
  /** The planning conversation (persisted on the record). */
  prepChat?: ChatMessage[];
  /** The latest proposed table structure + its "ready" signal. */
  prepStructure?: ProposedColumn[];
  prepReady?: boolean;
  /** Persist a completed planning turn in ONE write (chat + structure + ready).
   * A SINGLE patch is deliberate: saving the chat and the structure as two
   * rapid back-to-back writes to the same record could briefly desync the
   * store/realtime copy from the saved one (the user would see the turn vanish
   * back to the empty state even though the server still had it). */
  onPlanResult: (chat: ChatMessage[], structure: ProposedColumn[], ready: boolean) => void;
  status: MigrationStatus | undefined;
  errorMessage: string | null | undefined;
  /** Trigger the real extraction (discover/fuse or project extract). */
  onStartExtraction: () => void;
  onBack: () => void;
}

/**
 * Step "prep" — the PRE-extraction planning conversation. The operator writes
 * free-text instructions, then the AI reads the files and replies with any
 * QUESTIONS (contradictions between sources, anything unclear) plus a PROPOSED
 * table structure (columns + how each is derived). They converse until happy,
 * then click "Start extraction" — which threads the instructions + resolved
 * clarifications + confirmed structure into the extraction (jobRunner builds the
 * guidance). The extraction trigger + its spinner live here (moved from upload).
 *
 * Default-for-all but skippable: "Start extraction" is always available, so a
 * simple import is one click away. Excel "use as source" / blank tables bypass
 * this step entirely (no AI extraction).
 */
export default function StepPrep({
  isAr,
  recordId,
  model,
  sourceFiles,
  instructions,
  onInstructions,
  prepChat,
  prepStructure,
  prepReady,
  onPlanResult,
  status,
  errorMessage,
  onStartExtraction,
  onBack,
}: StepPrepProps) {
  const addToast = useAppStore((s) => s.addToast);
  const job = useMigrationJobs((s) => s.jobs[recordId]);
  const projectMode = isProjectProfileTarget(model);
  const Next = isAr ? ArrowLeft : ArrowRight;
  const Back = isAr ? ArrowRight : ArrowLeft;

  const [instrDraft, setInstrDraft] = useState(instructions ?? '');
  const instrLatest = useRef(instructions ?? '');
  const instrTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [aiInput, setAiInput] = useState('');
  const [aiBusy, setAiBusy] = useState(false);
  const [chatOpen, setChatOpen] = useState(true);
  const [structureOpen, setStructureOpen] = useState(true);

  // Hold the conversation + proposed structure in LOCAL state (seeded once from
  // the persisted record) and RENDER from it — not directly from the props. The
  // wizard remounts per record (key={recordId}), so this seeds correctly on open
  // and after a reload. Rendering from local state makes the on-screen turn
  // immune to a transient stale realtime echo briefly reverting the store's
  // record.data: the records channel only soft-TTL-dedups its own echoes (Audit
  // H1 — markRecentlyWritten('records', id, null)), so a late echo of an EARLIER
  // same-record write (e.g. the debounced instructions save) could otherwise wipe
  // the visible conversation. Every turn still persists via onPlanResult, so a
  // reload restores it; this only protects the live view from a stale flash.
  const [thread, setThread] = useState<ChatMessage[]>(prepChat ?? []);
  const [structure, setStructure] = useState<ProposedColumn[]>(prepStructure ?? []);
  const [ready, setReady] = useState<boolean>(prepReady ?? false);

  const flushInstructions = () => {
    if (instrTimer.current) {
      clearTimeout(instrTimer.current);
      instrTimer.current = null;
      onInstructions(instrLatest.current);
    }
  };
  // Flush the pending instructions save when leaving the step.
  useEffect(() => () => flushInstructions(), []); // eslint-disable-line react-hooks/exhaustive-deps

  const handleInstr = (v: string) => {
    setInstrDraft(v);
    instrLatest.current = v;
    if (instrTimer.current) clearTimeout(instrTimer.current);
    instrTimer.current = setTimeout(() => {
      instrTimer.current = null;
      onInstructions(v);
    }, 600);
  };

  /** One planning turn: send the thread + new user message + freshest
   * instructions to the AI, append both turns, and refresh the proposed
   * structure / ready flag. */
  const runPlanTurn = async (userText: string) => {
    const text = userText.trim();
    if (!text || aiBusy) return;
    setAiBusy(true);
    try {
      const apiMessages = [
        ...thread.map((m) => ({ role: m.role, content: m.content })),
        { role: 'user' as const, content: text },
      ];
      const { reply, questions, proposedColumns, ready: nextReady } = await planExtraction({
        messages: apiMessages,
        instructions: instrLatest.current,
        uploads: sourceFiles,
        fields: targetFieldLites(model),
        language: isAr ? 'ar' : 'en',
      });
      const now = new Date().toISOString();
      // Fold the structured questions into the assistant bubble as a bullet list
      // (kept as plain chat text so the thread persists as ChatMessage[]).
      const assistantContent =
        (reply || (isAr ? 'تم.' : 'Done.')) +
        (questions.length > 0
          ? '\n\n' +
            (isAr ? 'أسئلة بحاجة لإجابتك:' : 'Questions for you:') +
            '\n' +
            questions.map((q) => `• ${q}`).join('\n')
          : '');
      const nextThread: ChatMessage[] = [
        ...thread,
        { role: 'user', content: text, ts: now },
        { role: 'assistant', content: assistantContent, ts: now },
      ];
      // Update the LOCAL view first (immune to a stale store echo), then persist
      // the whole turn in ONE write (chat + structure + ready) — see onPlanResult.
      setThread(nextThread);
      setStructure(proposedColumns);
      setReady(nextReady);
      onPlanResult(nextThread, proposedColumns, nextReady);
      setAiInput('');
    } catch (err) {
      addToast(err instanceof Error ? err.message : String(err), 'error');
    } finally {
      setAiBusy(false);
    }
  };

  /** Seed message for the first "Review files & clarify" pass. */
  const startReview = () =>
    void runPlanTurn(
      isAr
        ? 'راجع الملفات وتعليماتي، واسألني عن أي تعارض بين المصادر أو أي شيء غير واضح، واقترح هيكل الجدول وكيف ستملأ كل عمود.'
        : 'Review the files and my instructions; ask me about any contradiction between the sources or anything unclear, and propose the table structure and how you will fill each column.',
    );

  const fileIcon = (mime: string) =>
    mime.includes('pdf') ? (
      <FileText size={15} className="text-copper shrink-0" />
    ) : mime.includes('csv') || mime.includes('sheet') ? (
      <FileSpreadsheet size={15} className="text-copper shrink-0" />
    ) : (
      <ImageIcon size={15} className="text-copper shrink-0" />
    );

  // ── Extraction running in this tab → progress spinner ──
  if (job?.kind === 'extract') {
    return (
      <div className="flex flex-col items-center justify-center text-center p-12 gap-3 h-full">
        <Loader2 size={32} className="text-copper animate-spin" />
        <div className="font-semibold text-charcoal">
          {isAr ? 'جارٍ استخراج البيانات…' : 'Extracting data…'}
        </div>
        <p className="text-sm text-charcoal/50 max-w-sm">
          {projectMode
            ? isAr
              ? 'يقرأ Claude ملفات المشروع بالكامل، يستخرج معلوماته العامة، ويكتب الوثيقة التسويقية. قد يستغرق هذا بضع دقائق.'
              : 'Claude is reading the whole project, extracting its general information, and writing the marketing document. This can take a few minutes.'
            : job && job.phase === 'fuse'
              ? isAr
                ? `يدمج Claude حقائق كل وحدة من جميع المصادر (الجدول، البروشور، المخططات…)${
                    job.total > 0 ? ` — ${job.done}/${job.total}` : ''
                  }. قد يستغرق هذا عدة دقائق.`
                : `Claude is fusing each unit's facts across all sources (table, brochure, floor plans…)${
                    job.total > 0 ? ` — ${job.done}/${job.total}` : ''
                  }. This can take a few minutes.`
              : isAr
                ? 'يفحص Claude الملفات، يصنّف المصادر، ويكتشف كل الوحدات…'
                : 'Claude is scanning the files, classifying the sources, and discovering every unit…'}
        </p>
        <p className="text-xs text-charcoal/40 max-w-sm">
          {isAr
            ? 'يستمر الاستخراج في الخلفية — يمكنك فتح ترحيل آخر أو بدء واحد جديد الآن.'
            : 'Extraction keeps running in the background — you can open or start another migration now.'}
        </p>
      </div>
    );
  }

  // ── Record says extracting but no job runs here — a reload interrupted it ──
  if (status === 'extracting') {
    return (
      <div className="flex flex-col items-center justify-center text-center p-12 gap-3 h-full">
        <div className="w-14 h-14 rounded-full bg-gold/15 flex items-center justify-center">
          <AlertCircle size={28} className="text-gold" />
        </div>
        <div className="font-semibold text-charcoal">
          {isAr ? 'توقّف الاستخراج' : 'Extraction was interrupted'}
        </div>
        <p className="text-sm text-charcoal/60 max-w-md">
          {isAr
            ? 'انقطع الاستخراج (غالبًا بسبب إعادة تحميل الصفحة). ملفاتك وتعليماتك محفوظة — أعد تشغيله.'
            : 'The run was interrupted (usually a page reload). Your files and instructions are saved — run it again.'}
        </p>
        <button
          onClick={onStartExtraction}
          className="inline-flex items-center gap-1.5 px-3 py-2 rounded-lg text-sm bg-copper text-white hover:bg-terracotta transition-colors"
        >
          <RotateCcw size={15} />
          {isAr ? 'إعادة الاستخراج' : 'Retry extraction'}
        </button>
      </div>
    );
  }

  const openQuestions = thread.length > 0 && !ready;

  return (
    <div className="p-5 flex flex-col h-full">
      <div className="mb-3 shrink-0">
        <h3 className="font-bold text-charcoal">
          {isAr ? 'التعليمات والمراجعة قبل الاستخراج' : 'Instructions & review before extraction'}
        </h3>
        <p className="text-xs text-charcoal/50">
          {isAr
            ? 'اكتب تعليماتك، ثم دع الذكاء يقرأ الملفات ويسألك عن أي تعارض أو غموض ويقترح هيكل الجدول — قبل إنتاجه. أو ابدأ الاستخراج مباشرة.'
            : 'Write your instructions, then let the AI read the files and ask you about any contradiction or ambiguity and propose the table structure — before producing it. Or start extraction directly.'}
        </p>
      </div>

      {status === 'failed' && errorMessage && (
        <div className="mb-3 shrink-0 flex items-start gap-2.5 px-3.5 py-3 rounded-xl bg-red-50 border border-red-200 text-sm text-charcoal/80">
          <AlertCircle size={18} className="text-red-500 shrink-0 mt-0.5" />
          <div>
            <span className="font-bold text-charcoal">
              {isAr ? 'فشل الاستخراج: ' : 'Extraction failed: '}
            </span>
            {errorMessage}
          </div>
        </div>
      )}

      <div className="flex-1 min-h-0 overflow-y-auto pe-1 space-y-3">
        {/* Instructions */}
        <div>
          <label className="block text-xs font-bold text-charcoal/70 uppercase tracking-wide mb-1.5">
            {isAr ? 'تعليمات للذكاء (اختياري)' : 'Instructions for the AI (optional)'}
          </label>
          <textarea
            dir="auto"
            value={instrDraft}
            onChange={(e) => handleInstr(e.target.value)}
            placeholder={
              isAr
                ? 'مثال: اعتمد أسعار قائمة الأسعار وليس البروشور. اجعل المساحة بالمتر المربع. تجاهل الوحدات المباعة. لو تعارضت المخططات مع الجدول اسألني.'
                : 'e.g. Use the price list, not the brochure, for prices. Areas in m². Skip sold units. If the plans contradict the sheet, ask me.'
            }
            className="form-input w-full text-sm leading-relaxed min-h-[90px] max-h-[200px] resize-y"
          />
        </div>

        {/* Source files (read-only summary) */}
        {sourceFiles && sourceFiles.length > 0 && (
          <div>
            <div className="text-xs font-bold text-charcoal/70 uppercase tracking-wide mb-1.5">
              {isAr ? `الملفات (${sourceFiles.length})` : `Files (${sourceFiles.length})`}
            </div>
            <div className="space-y-1.5">
              {sourceFiles.map((u) => (
                <div
                  key={u.path}
                  className="flex items-center gap-2 p-2 rounded-lg border border-sand/30 bg-white"
                >
                  {fileIcon(u.mimeType)}
                  <span className="text-sm text-charcoal truncate flex-1">{u.name}</span>
                  <span className="text-xs text-charcoal/40">{(u.size / 1024).toFixed(0)} KB</span>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Proposed structure */}
        {structure.length > 0 && (
          <div className="rounded-xl border border-copper/30 bg-copper/[0.04] overflow-hidden">
            <button
              onClick={() => setStructureOpen((v) => !v)}
              className="w-full flex items-center gap-2 px-3 py-2 text-sm font-bold text-charcoal hover:bg-copper/[0.08] transition-colors"
            >
              {structureOpen ? (
                <ChevronDown size={15} />
              ) : (
                <ChevronRight size={15} className={isAr ? 'rotate-180' : ''} />
              )}
              <ListChecks size={15} className="text-copper" />
              <span className="flex-1 text-start">
                {isAr ? 'هيكل الجدول المقترح' : 'Proposed table structure'}
              </span>
              <span
                className={`inline-flex items-center gap-1 text-[11px] font-normal ${
                  ready ? 'text-green-600' : 'text-gold'
                }`}
              >
                {ready ? <CheckCircle2 size={13} /> : <HelpCircle size={13} />}
                {ready
                  ? isAr ? 'جاهز' : 'ready'
                  : isAr ? 'أسئلة مفتوحة' : 'open questions'}
              </span>
            </button>
            {structureOpen && (
              <div className="px-3 pb-3 max-h-72 overflow-y-auto space-y-1.5">
                {structure.map((c, i) => (
                  <div key={i} className="bg-white/70 rounded-lg p-2.5 border border-sand/30 text-xs">
                    <div className="font-bold text-charcoal mb-0.5" dir="auto">
                      {c.header}
                    </div>
                    <div className="text-charcoal/70 leading-relaxed" dir="auto">
                      {c.description}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

        {/* Planning chat */}
        <div className="rounded-xl border border-copper/20 bg-copper/[0.03] overflow-hidden">
          <button
            onClick={() => setChatOpen((v) => !v)}
            className="w-full flex items-center gap-2 px-3 py-2 text-sm font-bold text-charcoal hover:bg-copper/[0.06] transition-colors"
          >
            {chatOpen ? (
              <ChevronDown size={15} />
            ) : (
              <ChevronRight size={15} className={isAr ? 'rotate-180' : ''} />
            )}
            <MessageSquareText size={15} className="text-copper" />
            <span className="flex-1 text-start">
              {isAr ? 'المحادثة التوضيحية' : 'Clarification chat'}
            </span>
          </button>

          {chatOpen && (
            <div className="px-3 pb-3">
              {thread.length === 0 ? (
                <div className="text-center py-3">
                  <p className="text-xs text-charcoal/55 mb-2.5 max-w-md mx-auto">
                    {isAr
                      ? 'اطلب من الذكاء قراءة الملفات وتعليماتك ليسألك عن أي تعارض أو غموض ويقترح هيكل الجدول قبل إنتاجه.'
                      : 'Have the AI read the files and your instructions, ask you about any contradiction or ambiguity, and propose the table structure before producing it.'}
                  </p>
                  <button
                    onClick={startReview}
                    disabled={aiBusy}
                    className="inline-flex items-center gap-1.5 px-3.5 py-2 rounded-lg bg-copper text-white hover:bg-terracotta disabled:opacity-50 transition-colors text-sm font-medium"
                  >
                    {aiBusy ? <Loader2 size={15} className="animate-spin" /> : <Sparkles size={15} />}
                    {isAr ? 'راجع الملفات ووضّح' : 'Review files & clarify'}
                  </button>
                </div>
              ) : (
                <div className="max-h-72 overflow-y-auto space-y-2 pe-1">
                  {thread.map((m, i) => (
                    <div key={i} className={`flex ${m.role === 'user' ? 'justify-end' : 'justify-start'}`}>
                      <div
                        dir="auto"
                        className={`max-w-[85%] text-xs whitespace-pre-wrap leading-relaxed rounded-lg px-2.5 py-1.5 ${
                          m.role === 'user'
                            ? 'bg-copper text-white'
                            : 'bg-white text-charcoal border border-sand/30'
                        }`}
                      >
                        {m.content}
                      </div>
                    </div>
                  ))}
                  {aiBusy && (
                    <div className="flex justify-start">
                      <div className="inline-flex items-center gap-1.5 text-xs text-charcoal/50 bg-white border border-sand/30 rounded-lg px-2.5 py-1.5">
                        <Loader2 size={13} className="animate-spin" />
                        {isAr ? 'يقرأ الذكاء الملفات…' : 'Reading the files…'}
                      </div>
                    </div>
                  )}
                </div>
              )}

              {thread.length > 0 && (
                <div className="flex items-center gap-2 mt-2">
                  <input
                    value={aiInput}
                    onChange={(e) => setAiInput(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' && !aiBusy && aiInput.trim()) void runPlanTurn(aiInput);
                    }}
                    placeholder={
                      isAr
                        ? 'أجب عن سؤاله، أو وضّح المطلوب، أو اطلب تعديل الهيكل…'
                        : 'Answer its question, clarify, or ask it to adjust the structure…'
                    }
                    disabled={aiBusy}
                    className="form-input flex-1 text-sm py-1.5"
                  />
                  <button
                    onClick={() => void runPlanTurn(aiInput)}
                    disabled={aiBusy || !aiInput.trim()}
                    className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-copper/10 text-copper font-medium text-sm hover:bg-copper/20 disabled:opacity-50 transition-colors shrink-0"
                  >
                    {aiBusy ? <Loader2 size={15} className="animate-spin" /> : <Sparkles size={15} />}
                    {isAr ? 'إرسال' : 'Send'}
                  </button>
                </div>
              )}
            </div>
          )}
        </div>
      </div>

      {/* Footer — Back + Start extraction (always available = the "skip"). */}
      <div className="flex items-center justify-between mt-4 pt-3 border-t border-sand/20 shrink-0">
        <button
          onClick={onBack}
          className="inline-flex items-center gap-1.5 px-3 py-2 rounded-lg text-sm text-charcoal/60 hover:bg-cream transition-colors"
        >
          <Back size={15} />
          {isAr ? 'رجوع' : 'Back'}
        </button>
        <div className="flex items-center gap-2">
          {openQuestions && (
            <span className="text-[11px] text-gold inline-flex items-center gap-1">
              <HelpCircle size={13} />
              {isAr ? 'هناك أسئلة مفتوحة' : 'open questions'}
            </span>
          )}
          <button
            onClick={onStartExtraction}
            className="inline-flex items-center gap-1.5 px-4 py-2 rounded-lg bg-copper text-white hover:bg-terracotta transition-colors font-medium"
          >
            <Sparkles size={15} />
            {isAr ? 'ابدأ الاستخراج' : 'Start extraction'}
            <Next size={15} />
          </button>
        </div>
      </div>
    </div>
  );
}
