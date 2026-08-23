// Compact client context for the Context step — an AI-written briefing (from the
// client's full history: preferences, follow-ups, calls + transcripts, WhatsApp)
// plus three buttons that open the heavy history in popups (previous follow-ups /
// previous calls / WhatsApp chat), instead of dumping the whole timeline inline.
//
// The briefing comes from /api/client-summary (see src/lib/clientSummary/client.ts).
// The deterministic stage · status line is kept as a fallback until it loads / if
// there is no history to summarize.

import { useCallback, useEffect, useRef, useState } from 'react';
import { History, PhoneCall, MessageCircle, Sparkles, RefreshCw, Loader2 } from 'lucide-react';
import Modal from '@/components/ui/Modal';
import { useAppStore } from '@/stores/appStore';
import TimelinePanel from './TimelinePanel';
import CallHistoryPanel from '@/pages/Records/components/CallHistoryPanel';
import RecordFormModal from '@/pages/Records/components/RecordFormModal';
import { gatherClientFacts, fetchClientSummary, hasSummarizableHistory, clientSummaryCache } from '@/lib/clientSummary/client';

interface ClientContextCardProps {
  clientId: string | null;
  client: Record<string, unknown> | null;
  currentFollowupId: string;
  phones: string[];
  /** Opens the WhatsApp conversation popup (existing thread or the composer). */
  onOpenWhatsApp: () => void;
}

type SummaryState =
  | { status: 'idle' | 'loading' | 'empty' }
  | { status: 'ready'; text: string }
  | { status: 'error'; message: string };

export default function ClientContextCard({ clientId, client, currentFollowupId, phones, onOpenWhatsApp }: ClientContextCardProps) {
  const isAr = useAppStore((s) => s.language === 'ar');
  const models = useAppStore((s) => s.models);
  const [modal, setModal] = useState<'followups' | 'calls' | null>(null);
  // A past record picked from the timeline — opened in a read/edit modal on top
  // of the popup so the rep sees its full details without leaving the workspace.
  const [detail, setDetail] = useState<{ modelId: string; recordId: string } | null>(null);

  const openEntry = (modelName: string, recordId: string) => {
    const m = models.find((mm) => mm.name === modelName);
    if (m) setDetail({ modelId: m.id, recordId });
  };

  // Deterministic fallback line (stage · status), shown until the AI briefing loads.
  const stage = typeof client?.client_stage === 'string' ? client.client_stage : null;
  const status = typeof client?.client_status === 'string' ? client.client_status : null;
  const fallback = [stage, status].filter(Boolean).join(' · ');

  const cached = clientId ? clientSummaryCache.get(clientId) : undefined;
  const [ai, setAi] = useState<SummaryState>(cached ? { status: 'ready', text: cached } : { status: 'idle' });
  const abortRef = useRef<AbortController | null>(null);

  const generate = useCallback(async () => {
    if (!clientId) return;
    abortRef.current?.abort();
    const ctrl = new AbortController();
    abortRef.current = ctrl;
    setAi({ status: 'loading' });
    try {
      const facts = await gatherClientFacts(clientId, phones);
      if (ctrl.signal.aborted) return;
      if (!hasSummarizableHistory(facts)) { setAi({ status: 'empty' }); return; }
      const text = await fetchClientSummary(facts, isAr ? 'ar' : 'en', ctrl.signal);
      if (ctrl.signal.aborted) return;
      clientSummaryCache.set(clientId, text);
      setAi({ status: 'ready', text });
    } catch (err) {
      if (ctrl.signal.aborted) return;
      setAi({ status: 'error', message: err instanceof Error ? err.message : String(err) });
    }
  }, [clientId, phones, isAr]);

  // Auto-generate once per client when there is no cached briefing yet.
  useEffect(() => {
    if (!clientId) return;
    const hit = clientSummaryCache.get(clientId);
    if (hit) { setAi({ status: 'ready', text: hit }); return; }
    void generate();
    return () => abortRef.current?.abort();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [clientId]);

  const refresh = () => { if (clientId) { clientSummaryCache.clear(clientId); void generate(); } };

  const btn = 'inline-flex items-center gap-2 rounded-lg border border-sand px-3 py-2 text-sm font-semibold text-charcoal transition hover:bg-cream';

  return (
    <section className="card p-5">
      <div className="mb-2 flex items-center justify-between gap-2">
        <h2 className="flex items-center gap-1.5 text-sm font-bold text-chocolate">
          <Sparkles size={14} className="text-copper" /> {isAr ? 'ملخص العميل' : 'Client summary'}
        </h2>
        <button
          type="button"
          onClick={refresh}
          disabled={ai.status === 'loading' || !clientId}
          className="inline-flex items-center gap-1 rounded-lg px-2 py-1 text-xs font-semibold text-charcoal/50 transition hover:bg-cream hover:text-copper disabled:opacity-50"
          title={isAr ? 'إعادة توليد الملخص' : 'Regenerate summary'}
        >
          {ai.status === 'loading' ? <Loader2 size={13} className="animate-spin" /> : <RefreshCw size={13} />}
          {isAr ? 'تحديث' : 'Refresh'}
        </button>
      </div>

      {ai.status === 'loading' ? (
        <p className="flex items-center gap-2 text-sm text-charcoal/60">
          <Loader2 size={14} className="animate-spin" />
          {isAr ? 'يقرأ الذكاء الاصطناعي سجل العميل…' : 'AI is reading the client history…'}
        </p>
      ) : ai.status === 'ready' ? (
        <Briefing text={ai.text} />
      ) : ai.status === 'error' ? (
        <div className="text-sm">
          <p className="text-terracotta">
            {isAr ? 'تعذّر توليد الملخص.' : 'Could not generate the summary.'}
            {fallback ? <span className="text-charcoal/70"> — {fallback}</span> : null}
          </p>
          <button type="button" onClick={refresh} className="mt-1 text-xs font-semibold text-copper hover:underline">
            {isAr ? 'إعادة المحاولة' : 'Try again'}
          </button>
        </div>
      ) : ai.status === 'empty' ? (
        <p className="text-sm text-charcoal/70">
          {fallback || (isAr ? 'لا يوجد سجل كافٍ للتلخيص بعد.' : 'Not enough history to summarize yet.')}
        </p>
      ) : (
        <p className="text-sm text-charcoal/70">{fallback || (isAr ? 'لا يوجد ملخص بعد.' : 'No summary yet.')}</p>
      )}

      <div className="mt-3 flex flex-wrap gap-2">
        <button type="button" className={btn} onClick={() => setModal('followups')}>
          <History size={16} /> {isAr ? 'المتابعات السابقة' : 'Previous follow-ups'}
        </button>
        <button type="button" className={btn} onClick={() => setModal('calls')}>
          <PhoneCall size={16} /> {isAr ? 'المكالمات السابقة' : 'Previous calls'}
        </button>
        <button type="button" className={btn} onClick={onOpenWhatsApp}>
          <MessageCircle size={16} /> {isAr ? 'محادثة الواتساب' : 'WhatsApp chat'}
        </button>
      </div>

      {modal === 'followups' ? (
        <Modal open onClose={() => setModal(null)} title={isAr ? 'المتابعات السابقة' : 'Previous follow-ups'} maxWidth="max-w-2xl">
          <TimelinePanel clientId={clientId} currentFollowupId={currentFollowupId} phones={phones} showCalls={false} heading={null} onSelectEntry={openEntry} />
        </Modal>
      ) : null}
      {modal === 'calls' ? (
        <Modal open onClose={() => setModal(null)} title={isAr ? 'المكالمات السابقة' : 'Previous calls'} maxWidth="max-w-2xl">
          <CallHistoryPanel phones={phones} chrome="naked" />
        </Modal>
      ) : null}

      {detail ? (
        <RecordFormModal modelId={detail.modelId} recordId={detail.recordId} onClose={() => setDetail(null)} />
      ) : null}
    </section>
  );
}

/** Split a line into React nodes, turning **bold** spans into <strong>. */
function renderInline(text: string) {
  return text.split(/(\*\*[^*]+\*\*)/g).map((part, i) => {
    const m = /^\*\*([^*]+)\*\*$/.exec(part);
    return m ? <strong key={i} className="font-semibold text-chocolate">{m[1] ?? ''}</strong> : <span key={i}>{part}</span>;
  });
}

/** Minimal markdown renderer for the AI briefing: **bold**, `- ` bullets, a
 *  whole-line **heading**, and plain paragraphs. No external dependency — the
 *  model output is trusted-shape prose, not arbitrary HTML. */
function Briefing({ text }: { text: string }) {
  const blocks: JSX.Element[] = [];
  let bullets: string[] = [];
  const flushBullets = () => {
    if (!bullets.length) return;
    const items = bullets;
    bullets = [];
    blocks.push(
      <ul key={`ul-${blocks.length}`} className="list-disc space-y-1 ps-5 marker:text-copper">
        {items.map((b, i) => <li key={i}>{renderInline(b)}</li>)}
      </ul>,
    );
  };

  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) { flushBullets(); continue; }
    const bullet = /^[-*•]\s+(.*)$/.exec(line);
    if (bullet) { bullets.push(bullet[1] ?? ''); continue; }
    flushBullets();
    const heading = /^\*\*([^*]+)\*\*:?$/.exec(line);
    if (heading) {
      blocks.push(<p key={`h-${blocks.length}`} className="font-bold text-chocolate">{heading[1] ?? ''}</p>);
    } else {
      blocks.push(<p key={`p-${blocks.length}`}>{renderInline(line)}</p>);
    }
  }
  flushBullets();

  return <div className="space-y-2 text-sm leading-relaxed text-charcoal/90">{blocks}</div>;
}
