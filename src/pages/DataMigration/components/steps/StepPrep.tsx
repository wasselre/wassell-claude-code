import { useEffect, useRef, useState } from 'react';
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
  AlertTriangle,
  Lock,
} from 'lucide-react';
import type { MigrationUpload } from '../../lib/client';
import { useMigrationJobs, startPlanJob } from '../../lib/jobRunner';
import { isProjectProfileTarget } from '../../lib/types';
import type { ChatMessage, ProposedColumn, PrepQuestion, MigrationStatus } from '../../lib/types';
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
  /** The AI's current open questions / contradictions, shown as answer cards. */
  prepQuestions?: PrepQuestion[];
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
 * Review is MANDATORY for AI extraction: "Start extraction" is GATED until the
 * operator has run the "Review files & clarify" pass at least once AND resolved
 * every open question — you can't extract files the AI hasn't read and you
 * haven't confirmed. (Excel "use as source" / blank tables bypass this step
 * entirely — they don't run AI extraction, so the gate doesn't apply to them.)
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
  prepQuestions,
  status,
  errorMessage,
  onStartExtraction,
  onBack,
}: StepPrepProps) {
  const job = useMigrationJobs((s) => s.jobs[recordId]);
  // "Busy" is now the DETACHED plan job, not a local flag — so the spinner +
  // disabled inputs survive navigating away and back mid-clarify (the job keeps
  // running in jobRunner and re-subscribes here). See startPlanJob.
  const aiBusy = job?.kind === 'plan';
  const projectMode = isProjectProfileTarget(model);
  const Next = isAr ? ArrowLeft : ArrowRight;
  const Back = isAr ? ArrowRight : ArrowLeft;

  const [instrDraft, setInstrDraft] = useState(instructions ?? '');
  const instrLatest = useRef(instructions ?? '');
  const instrTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [aiInput, setAiInput] = useState('');
  const [chatOpen, setChatOpen] = useState(true);
  const [structureOpen, setStructureOpen] = useState(true);

  // Hold the conversation + proposed structure in LOCAL state (seeded from the
  // persisted record, then advanced FORWARD-ONLY by the adopt effect below) and
  // RENDER from it — not directly from the props. The wizard remounts per record
  // (key={recordId}), so this seeds correctly on open and after a reload.
  // Rendering from local state makes the on-screen turn immune to a transient
  // stale realtime echo briefly reverting the store's record.data: the records
  // channel only soft-TTL-dedups its own echoes (Audit H1 —
  // markRecentlyWritten('records', id, null)), so a late echo of an EARLIER
  // same-record write (e.g. the debounced instructions save) could otherwise wipe
  // the visible conversation. Every turn still persists (the detached plan job
  // writes prep_chat/structure/questions/ready), so a reload restores it; this
  // only protects the live view from a stale flash.
  const [thread, setThread] = useState<ChatMessage[]>(prepChat ?? []);
  const [structure, setStructure] = useState<ProposedColumn[]>(prepStructure ?? []);
  const [ready, setReady] = useState<boolean>(prepReady ?? false);
  // The AI's CURRENT open questions (cards) + the operator's in-progress answers
  // (keyed by the question's index in the current list — reset every turn since
  // the AI returns a fresh open set each time). Extraction is blocked while any
  // question card remains.
  const [questions, setQuestions] = useState<PrepQuestion[]>(prepQuestions ?? []);
  const [answers, setAnswers] = useState<Record<number, string>>({});

  // Adopt a planning turn that the DETACHED plan job persisted (jobRunner) into
  // the local view. FORWARD-ONLY on the conversation length: only a turn that
  // ADDS messages is taken, so a transient stale realtime echo of an earlier
  // same-record write (e.g. the debounced instructions save, which carries a
  // shorter/older prep_chat) can never blank the on-screen conversation — the
  // reason this step renders from local state in the first place. This is what
  // lets a clarify turn that finished while the operator was on another screen
  // appear when they return: on remount, useState seeds from the persisted
  // props; while still mounted, this effect picks up the job's write.
  const persistedChatLen = prepChat?.length ?? 0;
  useEffect(() => {
    if (persistedChatLen <= thread.length) return;
    setThread(prepChat ?? []);
    setStructure(prepStructure ?? []);
    setQuestions(prepQuestions ?? []);
    setReady(prepReady ?? false);
    setAnswers({}); // the open-question set just changed — drop in-progress answers
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [persistedChatLen]);

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

  /** One planning turn — handed to the DETACHED plan job (jobRunner), which
   * calls the AI and persists the whole turn (chat + structure + questions +
   * ready) in one write. Running it as a job (not inline here) is what makes a
   * clarify turn survive the operator leaving the migration mid-flight: the job
   * keeps running and persists even after this step unmounts.
   *
   * The live `thread` is passed as the base so the turn builds on exactly what's
   * on screen, and `instrLatest.current` carries the freshest (possibly not-yet-
   * debounced) instructions. We flush the instruction draft first so the
   * persisted record matches what the plan used. `aiBusy`/result come back
   * through the job store + the persisted props (see the adopt effect above). */
  const sendTurn = (userText: string) => {
    const text = userText.trim();
    if (!text || aiBusy) return;
    flushInstructions();
    void startPlanJob(recordId, thread, text, instrLatest.current);
    setAiInput('');
  };

  /** Seed message for the first "Review files & clarify" pass. */
  const startReview = () =>
    sendTurn(
      isAr
        ? 'راجع الملفات وتعليماتي، واسألني عن أي تعارض بين المصادر أو أي شيء غير واضح، واقترح هيكل الجدول وكيف ستملأ كل عمود.'
        : 'Review the files and my instructions; ask me about any contradiction between the sources or anything unclear, and propose the table structure and how you will fill each column.',
    );

  /** Bundle the operator's card answers into ONE message and send it as a turn.
   * Sends only the cards that have an answer; the AI resolves those and returns
   * the remaining open questions (the card list shrinks until empty). The chat
   * input is the alternative free-text path — both feed the same turn. */
  const submitAnswers = () => {
    const answered = questions
      .map((q, i) => ({ q, a: (answers[i] ?? '').trim() }))
      .filter((x) => x.a);
    if (answered.length === 0 || aiBusy) return;
    const header = isAr ? 'هذه إجاباتي عن أسئلتك:' : 'Here are my answers to your questions:';
    const body = answered
      .map((x) => `- ${x.q.question}\n  ${isAr ? 'إجابتي' : 'My answer'}: ${x.a}`)
      .join('\n');
    sendTurn(`${header}\n${body}`);
  };

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

  // Extraction is BLOCKED until the operator has (1) run the review/clarify pass
  // at least once AND (2) resolved every open question card. Prep is MANDATORY:
  // you can't extract files the AI hasn't read and you haven't confirmed. A
  // non-empty conversation means the "Review files & clarify" turn ran; the AI
  // returns an empty question set once your answers satisfy it.
  const reviewed = thread.length > 0;
  const blocked = !reviewed || questions.length > 0;
  const answeredCount = questions.filter((_, i) => (answers[i] ?? '').trim() !== '').length;

  return (
    <div className="p-5 flex flex-col h-full">
      <div className="mb-3 shrink-0">
        <h3 className="font-bold text-charcoal">
          {isAr ? 'التعليمات والمراجعة قبل الاستخراج' : 'Instructions & review before extraction'}
        </h3>
        <p className="text-xs text-charcoal/50">
          {isAr
            ? 'اكتب تعليماتك، ثم راجِع الملفات ووضّح: يقرأ الذكاء الملفات ويسألك عن أي تعارض أو غموض ويقترح هيكل الجدول. لازم تكمل المراجعة قبل أن تتمكن من بدء الاستخراج.'
            : 'Write your instructions, then review & clarify: the AI reads the files, asks you about any contradiction or ambiguity, and proposes the table structure. You must complete the review before you can start extraction.'}
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
                      if (e.key === 'Enter' && !aiBusy && aiInput.trim()) sendTurn(aiInput);
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
                    onClick={() => sendTurn(aiInput)}
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

        {/* Questions & contradictions — answerable CARDS (the quiz), shown BELOW
            the chat. Each must be resolved before extraction is allowed. The
            operator answers here OR in the chat — both feed the same turn. */}
        {questions.length > 0 && (
          <div className="rounded-xl border border-gold/40 bg-gold/[0.06] overflow-hidden">
            <div className="flex items-center gap-2 px-3 py-2 text-sm font-bold text-charcoal border-b border-gold/30">
              <HelpCircle size={15} className="text-gold" />
              <span className="flex-1 text-start">
                {isAr ? 'أسئلة بحاجة لإجابتك' : 'Questions to answer'}
              </span>
              <span className="text-[11px] text-charcoal/50 font-normal">
                {isAr
                  ? `${answeredCount}/${questions.length} مُجابة`
                  : `${answeredCount}/${questions.length} answered`}
              </span>
            </div>
            <div className="px-3 py-2.5 space-y-2.5 max-h-[22rem] overflow-y-auto">
              {questions.map((q, i) => {
                const isContradiction = (q.kind ?? '').toLowerCase().includes('contradict');
                const filled = (answers[i] ?? '').trim() !== '';
                return (
                  <div
                    key={i}
                    className={`rounded-lg border bg-white p-2.5 ${
                      filled ? 'border-green-300' : isContradiction ? 'border-gold/50' : 'border-sand/40'
                    }`}
                  >
                    <div className="flex items-start gap-2 mb-1.5">
                      {isContradiction ? (
                        <AlertTriangle size={14} className="text-gold shrink-0 mt-0.5" />
                      ) : (
                        <HelpCircle size={14} className="text-copper shrink-0 mt-0.5" />
                      )}
                      <div className="flex-1 min-w-0">
                        <div className="text-xs font-bold text-charcoal" dir="auto">
                          {q.question}
                        </div>
                        {q.detail && (
                          <div className="text-[11px] text-charcoal/55 mt-0.5 leading-relaxed" dir="auto">
                            {q.detail}
                          </div>
                        )}
                      </div>
                      {filled && <CheckCircle2 size={14} className="text-green-500 shrink-0 mt-0.5" />}
                    </div>
                    <textarea
                      dir="auto"
                      value={answers[i] ?? ''}
                      onChange={(e) => setAnswers((prev) => ({ ...prev, [i]: e.target.value }))}
                      disabled={aiBusy}
                      placeholder={isAr ? 'اكتب إجابتك…' : 'Type your answer…'}
                      className="form-input w-full text-xs leading-relaxed min-h-[44px] max-h-[140px] resize-y"
                    />
                  </div>
                );
              })}
            </div>
            <div className="flex items-center justify-between gap-2 px-3 py-2 border-t border-gold/30">
              <span className="text-[11px] text-charcoal/50">
                {isAr
                  ? 'أجب في البطاقات أو في المحادثة. لا يمكن بدء الاستخراج قبل حلّ كل الأسئلة.'
                  : 'Answer in the cards or the chat. Extraction is blocked until all are resolved.'}
              </span>
              <button
                onClick={submitAnswers}
                disabled={aiBusy || answeredCount === 0}
                className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-copper text-white hover:bg-terracotta disabled:opacity-50 transition-colors text-sm font-medium shrink-0"
              >
                {aiBusy ? <Loader2 size={15} className="animate-spin" /> : <Sparkles size={15} />}
                {isAr ? 'إرسال الإجابات' : 'Submit answers'}
              </button>
            </div>
          </div>
        )}
      </div>

      {/* Footer — Back + Start extraction (gated until every question is answered). */}
      <div className="flex items-center justify-between mt-4 pt-3 border-t border-sand/20 shrink-0">
        <button
          onClick={onBack}
          className="inline-flex items-center gap-1.5 px-3 py-2 rounded-lg text-sm text-charcoal/60 hover:bg-cream transition-colors"
        >
          <Back size={15} />
          {isAr ? 'رجوع' : 'Back'}
        </button>
        <div className="flex items-center gap-2">
          {blocked && (
            <span className="text-[11px] text-gold inline-flex items-center gap-1">
              <Lock size={13} />
              {!reviewed
                ? isAr
                  ? 'راجِع الملفات ووضّح أولاً'
                  : 'Review & clarify the files first'
                : isAr
                  ? `أجب عن ${questions.length} ${questions.length === 1 ? 'سؤال' : 'أسئلة'} أولاً`
                  : `Answer ${questions.length} question${questions.length === 1 ? '' : 's'} first`}
            </span>
          )}
          <button
            onClick={onStartExtraction}
            disabled={blocked || aiBusy}
            title={
              blocked
                ? !reviewed
                  ? isAr
                    ? 'راجِع الملفات ووضّح قبل بدء الاستخراج'
                    : 'Review & clarify the files before starting extraction'
                  : isAr
                    ? 'أجب عن كل الأسئلة قبل بدء الاستخراج'
                    : 'Answer all questions before starting extraction'
                : undefined
            }
            className="inline-flex items-center gap-1.5 px-4 py-2 rounded-lg bg-copper text-white hover:bg-terracotta disabled:opacity-50 disabled:cursor-not-allowed transition-colors font-medium"
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
