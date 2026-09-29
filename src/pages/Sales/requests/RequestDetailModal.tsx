/**
 * One unanswered request, worked end to end:
 *   1. the ask (the rep's words + the client's preferences) and the search task;
 *   2. the real-estate offices of the requested districts — pick, preview, send
 *      (paced by the database: see 2026-09-28_office_outreach.sql);
 *   3. what each office answered;
 *   4. the offerings saved from those answers (OfficeOfferModal);
 *   5. the request's history.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Building2, Send, Loader2, ExternalLink, MessageCircle, Plus, XCircle, AlertTriangle, ClipboardList } from 'lucide-react';
import Modal from '@/components/ui/Modal';
import Button from '@/components/ui/Button';
import { useAppStore } from '@/stores/appStore';
import { usePermission } from '@/hooks/usePermission';
import type { AppRecord } from '@/types';
import {
  cancelOutreach, enqueueOutreach, fetchCandidates, fetchOutreach, outreachErrorText, skipReasonText,
  type LineStatus, type OutreachCandidate, type OutreachRow,
} from '@/lib/officeOutreach/client';
import { buildOfficeMessage, containsLink, describeAsk } from '@/lib/officeOutreach/message';
import { clientOf, firstId, isOpenRequest, offeringsFor, requestFacts } from './requestData';
import OfficeOfferModal from './OfficeOfferModal';

const PAGE = 100;

interface Props {
  requestId: string;
  line: LineStatus | null;
  onClose: () => void;
  onOutreachChanged: () => void;
}

export default function RequestDetailModal({ requestId, line, onClose, onOutreachChanged }: Props) {
  const navigate = useNavigate();
  // Every record opened from here carries state.backTo, so the record form's
  // back / save / delete exits return to THIS request instead of dropping the
  // rep on the raw model list (RecordFormPage exitTarget).
  const openRecord = (path: string) => navigate(path, { state: { backTo: `/sales-workspace/requests?request=${requestId}` } });
  const models = useAppStore((s) => s.models);
  const records = useAppStore((s) => s.records);
  const users = useAppStore((s) => s.users);
  const addToast = useAppStore((s) => s.addToast);
  const isAr = useAppStore((s) => s.language) === 'ar';
  const t = (ar: string, en: string) => (isAr ? ar : en);

  const requestsModel = models.find((m) => m.name === 'unanswered_requests') ?? null;
  const clientsModel = models.find((m) => m.name === 'clients') ?? null;
  const tasksModel = models.find((m) => m.name === 'sales_tasks') ?? null;
  const unitsModel = models.find((m) => m.name === 'units') ?? null;
  const projectsModel = models.find((m) => m.name === 'all_projects') ?? null;
  const canCreateUnit = usePermission(unitsModel?.id ?? '', 'create');
  const canCreateProject = usePermission(projectsModel?.id ?? '', 'create');

  const request = useMemo<AppRecord | null>(
    () => (requestsModel ? (records[requestsModel.id] ?? []).find((r) => r.id === requestId) ?? null : null),
    [requestsModel, records, requestId],
  );
  const clientsById = useMemo(
    () => new Map((clientsModel ? records[clientsModel.id] ?? [] : []).map((r) => [r.id, r])),
    [clientsModel, records],
  );
  const client = request ? clientOf(request, clientsById) : null;
  const store = useMemo(() => ({ models, records }), [models, records]);
  const facts = useMemo(() => (request ? requestFacts(request, client, store) : null), [request, client, store]);
  const offerings = useMemo(() => offeringsFor(requestId, store), [requestId, store]);

  const openTask = useMemo(() => {
    const rows = (tasksModel ? records[tasksModel.id] ?? [] : []).filter((task) => {
      const d = task.data as Record<string, unknown>;
      const st = typeof d.task_status === 'string' && d.task_status ? d.task_status : 'open';
      return firstId(d.request_id) === requestId && (st === 'open' || st === 'in_progress');
    });
    return rows[0] ?? null;
  }, [tasksModel, records, requestId]);

  // ── Offices ──
  const [includeCity, setIncludeCity] = useState(false);
  const [candidates, setCandidates] = useState<OutreachCandidate[] | null>(null);
  const [candError, setCandError] = useState<string | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [limit, setLimit] = useState(PAGE);
  const [confirming, setConfirming] = useState(false);
  const [sending, setSending] = useState(false);
  const [outreach, setOutreach] = useState<OutreachRow[]>([]);
  const [offerFor, setOfferFor] = useState<{ officeId: string | null; officeName: string | null } | null>(null);

  const eligible = (c: OutreachCandidate) => !c.do_not_contact && !c.in_this_request && (!c.recently_contacted || c.replied_before);

  const loadCandidates = useCallback(async () => {
    setCandidates(null);
    const res = await fetchCandidates(requestId, includeCity);
    if (res.error !== null) {
      console.error('[request] candidates failed:', res.error);
      setCandError(outreachErrorText(res.error, isAr));
      setCandidates([]);
      return;
    }
    setCandError(null);
    setCandidates(res.data);
    // District matches are pre-selected; city-wide matches are opt-in (thousands).
    setSelected(new Set(res.data.filter((c) => eligible(c) && c.match_kind === 'district').map((c) => c.office_id)));
    setLimit(PAGE);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [requestId, includeCity, isAr]);

  const loadOutreach = useCallback(async () => {
    const res = await fetchOutreach([requestId]);
    if (res.error !== null) { console.error('[request] outreach failed:', res.error); addToast(outreachErrorText(res.error, isAr), 'error'); return; }
    setOutreach(res.data);
  }, [requestId, addToast, isAr]);

  useEffect(() => { void loadCandidates(); }, [loadCandidates]);
  useEffect(() => { void loadOutreach(); }, [loadOutreach]);

  const selectedList = useMemo(() => (candidates ?? []).filter((c) => selected.has(c.office_id)), [candidates, selected]);
  const preview = facts && selectedList[0] ? buildOfficeMessage(facts, selectedList[0].office_name, selectedList[0].office_id) : null;
  const noteHasLink = !!facts?.notes && containsLink(facts.notes);

  const perDay = line?.per_day ?? 0;
  const estDays = perDay > 0 ? Math.ceil((selectedList.length + (line?.today_scheduled ?? 0)) / perDay) : null;
  const sendBlocked = !line?.can_send;

  const send = async () => {
    if (!facts || selectedList.length === 0) return;
    setSending(true);
    const messages = selectedList.map((c) => ({ office_id: c.office_id, body: buildOfficeMessage(facts, c.office_name, c.office_id) }));
    const res = await enqueueOutreach(requestId, messages);
    setSending(false);
    setConfirming(false);
    if (res.error !== null) {
      console.error('[request] enqueue failed:', res.error);
      addToast(outreachErrorText(res.error, isAr), 'error');
      return;
    }
    const r = res.data;
    const when = r.last_at ? new Date(r.last_at).toLocaleString(isAr ? 'ar-SA-u-nu-latn' : 'en-GB', { dateStyle: 'medium', timeStyle: 'short' }) : '';
    addToast(t(`جُدول إرسال الطلب إلى ${r.queued} مكتب — آخر رسالة ${when}`, `Request scheduled to ${r.queued} offices — last message ${when}`), 'success');
    if (r.skipped.length > 0) {
      const byReason = new Map<string, number>();
      for (const s of r.skipped) byReason.set(s.reason, (byReason.get(s.reason) ?? 0) + 1);
      addToast(t('تم تخطي: ', 'Skipped: ') + [...byReason].map(([k, n]) => `${skipReasonText(k, isAr)} (${n})`).join('، '), 'info');
    }
    await loadOutreach();
    await loadCandidates();
    onOutreachChanged();
  };

  const cancelPending = async () => {
    const res = await cancelOutreach(requestId);
    if (res.error !== null) { addToast(outreachErrorText(res.error, isAr), 'error'); return; }
    addToast(t(`أُلغي ${res.data} إرسال لم يتم بعد`, `Cancelled ${res.data} pending messages`), 'success');
    await loadOutreach();
    onOutreachChanged();
  };

  if (!request || !facts) {
    return (
      <Modal open onClose={onClose} title={t('الطلب', 'Request')} maxWidth="max-w-lg">
        <p className="text-sm text-charcoal/60">{t('لم يعد هذا الطلب متاحاً.', 'This request is no longer available.')}</p>
      </Modal>
    );
  }

  const d = request.data as Record<string, unknown>;
  const cd = (client?.data ?? {}) as Record<string, unknown>;
  const queuedCount = outreach.filter((o) => o.status === 'queued').length;
  const updates = Array.isArray(d.request_updates) ? (d.request_updates as { id?: string; text?: string; author_id?: string; created_at?: string }[]) : [];
  const userName = (id?: string) => {
    const u = id ? users.find((x) => x.id === id) : undefined;
    return u ? ((isAr ? u.name_ar : u.name_en) || u.email || '') : '';
  };
  const statusText = (o: OutreachRow) => {
    const at = (iso: string | null) => (iso ? new Date(iso).toLocaleString(isAr ? 'ar-SA-u-nu-latn' : 'en-GB', { dateStyle: 'short', timeStyle: 'short' }) : '');
    if (o.replied_at) return { text: t(`ردّ ${at(o.replied_at)}`, `Replied ${at(o.replied_at)}`), cls: 'bg-emerald-50 text-emerald-700' };
    switch (o.status) {
      case 'queued': return { text: t(`مجدول ${at(o.deliver_at)}`, `Scheduled ${at(o.deliver_at)}`), cls: 'bg-sky-50 text-sky-700' };
      case 'sent': return { text: t(`أُرسل ${at(o.sent_at)} · بانتظار الرد`, `Sent ${at(o.sent_at)} · awaiting reply`), cls: 'bg-cream text-charcoal/70' };
      case 'failed': return { text: t('فشل الإرسال', 'Failed'), cls: 'bg-red-50 text-red-700' };
      default: return { text: t('أُلغي', 'Cancelled'), cls: 'bg-sand/30 text-charcoal/50' };
    }
  };

  return (
    <>
      <Modal open onClose={onClose} title={t('طلب غير مجاب', 'Unanswered request')} maxWidth="max-w-3xl">
        <div className="space-y-5">
          {/* 1 — the ask */}
          <section className="space-y-2">
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-lg font-bold text-chocolate">{typeof cd.client_name === 'string' ? cd.client_name : t('عميل', 'Client')}</span>
              {client && (
                <button type="button" onClick={() => openRecord(`/model/clients/${client.id}`)} className="inline-flex items-center gap-1 text-xs font-semibold text-copper hover:underline">
                  <ExternalLink size={12} /> {t('ملف العميل', 'Client profile')}
                </button>
              )}
              {openTask && (
                <button type="button" onClick={() => openRecord(`/model/sales_tasks/${openTask.id}`)} className="inline-flex items-center gap-1 text-xs font-semibold text-copper hover:underline">
                  <ClipboardList size={12} /> {t('مهمة البحث — سجّل النتيجة', 'Search task — record the result')}
                </button>
              )}
            </div>
            <div className="rounded-xl border border-sand/60 bg-cream-light p-3 text-sm">
              <div className="font-semibold text-charcoal">{describeAsk(facts)}</div>
              {facts.notes && <div className="mt-1 text-charcoal/70">«{facts.notes}»</div>}
            </div>
          </section>

          {/* 2 — offices */}
          {isOpenRequest(request) && (
            <section className="space-y-2">
              <div className="flex flex-wrap items-center gap-2">
                <h3 className="flex items-center gap-1.5 text-sm font-bold text-chocolate"><Building2 size={15} className="text-copper" />{t('إرسال الطلب للمكاتب العقارية', 'Send the request to real-estate offices')}</h3>
                <label className="ms-auto flex items-center gap-1.5 text-xs text-charcoal/70">
                  <input type="checkbox" checked={includeCity} onChange={(e) => setIncludeCity(e.target.checked)} className="rounded border-sand text-copper" />
                  {t('أضف مكاتب نفس المدينة', 'Include offices in the same city')}
                </label>
              </div>

              {sendBlocked && (
                <div className="flex items-start gap-2 rounded-lg bg-amber-50 p-2.5 text-xs text-amber-800">
                  <AlertTriangle size={14} className="mt-0.5 shrink-0" />
                  <span>
                    {!line || !line.device_id || !line.line_active || !line.line_started_on
                      ? t('لم يُضبط رقم واتساب مخصص للمكاتب بعد، لذلك الإرسال متوقف. يمكنك تجهيز القائمة الآن.', 'No dedicated WhatsApp line is set for offices yet, so sending is off. You can prepare the list now.')
                      : line.paused_until && Date.parse(line.paused_until) > Date.now()
                        ? t('الإرسال موقوف مؤقتاً لأن واتساب قيّد الرقم. يُستأنف تلقائياً بعد انتهاء المهلة.', 'Sending is paused because WhatsApp restricted the line. It resumes when the pause ends.')
                        : t('الرقم في فترة التهيئة ولا يرسل للمكاتب بعد.', 'The line is still warming up and cannot message offices yet.')}
                  </span>
                </div>
              )}

              {candidates === null ? (
                <div className="flex items-center gap-2 text-xs text-charcoal/50"><Loader2 size={14} className="animate-spin" />{t('جارٍ البحث عن المكاتب…', 'Finding offices…')}</div>
              ) : candError ? (
                <div className="text-xs text-red-600">{candError}</div>
              ) : candidates.length === 0 ? (
                <div className="rounded-lg bg-cream p-3 text-xs text-charcoal/60">
                  {facts.places.length === 0
                    ? t('لا توجد أحياء محددة في تفضيلات العميل — أضف الأحياء المطلوبة في ملف العميل أولاً.', 'The client has no requested districts — add them on the client profile first.')
                    : t('لا توجد مكاتب مسجلة في هذه الأحياء. جرّب «أضف مكاتب نفس المدينة».', 'No offices are registered in these districts. Try «Include offices in the same city».')}
                </div>
              ) : (
                <>
                  <div className="flex flex-wrap items-center gap-2 text-xs text-charcoal/60">
                    <span>{t(`${candidates.length} مكتب مطابق · محدد ${selected.size}`, `${candidates.length} matching offices · ${selected.size} selected`)}</span>
                    <button type="button" className="font-semibold text-copper hover:underline"
                      onClick={() => setSelected(new Set(candidates.filter(eligible).map((c) => c.office_id)))}>{t('تحديد كل المتاح', 'Select all eligible')}</button>
                    <button type="button" className="font-semibold text-charcoal/60 hover:underline" onClick={() => setSelected(new Set())}>{t('إلغاء التحديد', 'Clear')}</button>
                  </div>
                  <div className="max-h-64 divide-y divide-sand/40 overflow-y-auto rounded-lg border border-sand/60 bg-white">
                    {candidates.slice(0, limit).map((c) => {
                      const ok = eligible(c);
                      return (
                        <label key={c.office_id} className={`flex items-center gap-2 px-3 py-2 text-sm ${ok ? 'cursor-pointer hover:bg-cream' : 'opacity-50'}`}>
                          <input type="checkbox" disabled={!ok} checked={selected.has(c.office_id)} className="rounded border-sand text-copper"
                            onChange={() => setSelected((prev) => { const n = new Set(prev); if (n.has(c.office_id)) n.delete(c.office_id); else n.add(c.office_id); return n; })} />
                          <span className="flex min-w-0 flex-1 items-center gap-2">
                            <span className="truncate font-semibold text-charcoal">{c.office_name ?? t('مكتب بلا اسم', 'Unnamed office')}</span>
                            <span className="shrink-0 text-xs text-charcoal/50" dir="ltr">+{c.phone}</span>
                          </span>
                          <span className="shrink-0 text-xs text-charcoal/50">{c.district_name ?? ''}{c.match_kind === 'city' ? t(' · المدينة', ' · city') : ''}</span>
                          {c.replied_before && <span className="shrink-0 rounded bg-emerald-50 px-1.5 text-[10px] font-semibold text-emerald-700">{t('ردّ سابقاً', 'replied before')}</span>}
                          {c.do_not_contact && <span className="shrink-0 rounded bg-red-50 px-1.5 text-[10px] font-semibold text-red-700">{t('لا يراسَل', 'do not contact')}</span>}
                          {c.in_this_request && <span className="shrink-0 rounded bg-sky-50 px-1.5 text-[10px] font-semibold text-sky-700">{t('أُرسل له', 'already sent')}</span>}
                          {!c.in_this_request && c.recently_contacted && !c.replied_before && <span className="shrink-0 rounded bg-amber-50 px-1.5 text-[10px] font-semibold text-amber-700">{t('رُوسل مؤخراً', 'messaged recently')}</span>}
                        </label>
                      );
                    })}
                  </div>
                  {candidates.length > limit && (
                    <button type="button" onClick={() => setLimit((l) => l + PAGE)} className="text-xs font-semibold text-copper hover:underline">
                      {t(`يُعرض ${limit} من ${candidates.length} — عرض المزيد`, `Showing ${limit} of ${candidates.length} — show more`)}
                    </button>
                  )}

                  {preview && (
                    <div>
                      <div className="mb-1 text-xs font-semibold text-charcoal/60">{t('نص الرسالة (مثال لأول مكتب — تختلف الصياغة قليلاً بين المكاتب)', 'Message (first office — wording varies slightly between offices)')}</div>
                      <pre className="whitespace-pre-wrap rounded-lg border border-sand/60 bg-cream-light p-3 font-[inherit] text-sm text-charcoal">{preview}</pre>
                    </div>
                  )}
                  {noteHasLink && (
                    <div className="rounded-lg bg-red-50 p-2.5 text-xs text-red-700">
                      {t('ملاحظة الطلب تحتوي رابطاً. الروابط من رقم جديد تؤدي للحظر — احذف الرابط من «ملاحظات الطلب» أولاً.', 'The request note contains a link. Links from a new number get it banned — remove it from the request note first.')}
                    </div>
                  )}

                  {!confirming ? (
                    <div className="flex flex-wrap items-center gap-2">
                      <Button onClick={() => setConfirming(true)} disabled={selected.size === 0 || sendBlocked || noteHasLink} className="px-4 py-2 text-sm">
                        <Send size={15} /> {t(`إرسال الطلب إلى ${selected.size} مكتب`, `Send to ${selected.size} offices`)}
                      </Button>
                      {queuedCount > 0 && (
                        <Button variant="secondary" onClick={() => void cancelPending()} className="px-3 py-2 text-xs">
                          <XCircle size={14} /> {t(`إلغاء ${queuedCount} لم تُرسل بعد`, `Cancel ${queuedCount} not yet sent`)}
                        </Button>
                      )}
                    </div>
                  ) : (
                    <div className="space-y-2 rounded-xl border border-copper/30 bg-copper/5 p-3 text-sm">
                      <div className="font-semibold text-charcoal">{t(`سيُرسل الطلب إلى ${selected.size} مكتب، رسالة كل بضع دقائق وبين الساعة ${line?.send_start_hour ?? 9} و${line?.send_end_hour ?? 21} فقط.`, `The request goes to ${selected.size} offices, one message every few minutes, only between ${line?.send_start_hour ?? 9}:00 and ${line?.send_end_hour ?? 21}:00.`)}</div>
                      {estDays !== null && (
                        <div className="text-xs text-charcoal/70">{t(`الحد اليومي الحالي ${perDay} مكتب، لذلك يكتمل الإرسال خلال ${estDays} يوم تقريباً.`, `Today's limit is ${perDay} offices, so sending finishes in about ${estDays} day(s).`)}</div>
                      )}
                      <div className="text-xs text-charcoal/60">{t('إذا قيّد واتساب الرقم يتوقف الإرسال تلقائياً ويُلغى الباقي.', 'If WhatsApp restricts the line, sending stops automatically and the rest is cancelled.')}</div>
                      <div className="flex gap-2">
                        <Button onClick={() => void send()} disabled={sending} className="px-4 py-1.5 text-sm">
                          {sending ? <Loader2 size={15} className="animate-spin" /> : <Send size={15} />} {t('تأكيد الإرسال', 'Confirm')}
                        </Button>
                        <Button variant="secondary" onClick={() => setConfirming(false)} disabled={sending} className="px-3 py-1.5 text-sm">{t('رجوع', 'Back')}</Button>
                      </div>
                    </div>
                  )}
                </>
              )}
            </section>
          )}

          {/* 3 — outreach timeline */}
          {outreach.length > 0 && (
            <section className="space-y-2">
              <h3 className="flex items-center gap-1.5 text-sm font-bold text-chocolate"><MessageCircle size={15} className="text-copper" />{t('المكاتب التي أُرسل لها', 'Offices messaged')}</h3>
              <div className="max-h-72 divide-y divide-sand/40 overflow-y-auto rounded-lg border border-sand/60 bg-white">
                {outreach.map((o) => {
                  const st = statusText(o);
                  return (
                    <div key={o.id} className="space-y-1 px-3 py-2 text-sm">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="font-semibold text-charcoal">{o.office_name ?? t('مكتب بلا اسم', 'Unnamed office')}</span>
                        <span className="text-xs text-charcoal/50" dir="ltr">+{o.office_phone}</span>
                        <span className={`rounded-full px-2 py-0.5 text-[11px] font-semibold ${st.cls}`}>{st.text}</span>
                        {o.replied_at && (canCreateUnit || canCreateProject) && (
                          <button type="button" onClick={() => setOfferFor({ officeId: o.office_id, officeName: o.office_name })}
                            className="ms-auto inline-flex items-center gap-1 text-xs font-semibold text-copper hover:underline">
                            <Plus size={12} /> {t('إضافة عرض', 'Add offering')}
                          </button>
                        )}
                      </div>
                      {o.reply_preview && <div className="rounded bg-emerald-50/60 px-2 py-1 text-xs text-charcoal/80">«{o.reply_preview}»</div>}
                      {o.status === 'failed' && o.error && <div className="text-xs text-red-600">{o.error.slice(0, 160)}</div>}
                    </div>
                  );
                })}
              </div>
              <p className="text-xs text-charcoal/50">{t('الرد يظهر هنا تلقائياً، والمحادثة مع المكتب تكمل في واتساب ضمن «أخرى».', 'Replies appear here automatically; the conversation continues in WhatsApp under «Other».')}</p>
            </section>
          )}

          {/* 4 — offerings */}
          <section className="space-y-2">
            <div className="flex items-center gap-2">
              <h3 className="text-sm font-bold text-chocolate">{t('العروض من المكاتب', 'Offerings from offices')}</h3>
              {(canCreateUnit || canCreateProject) && (
                <button type="button" onClick={() => setOfferFor({ officeId: null, officeName: null })}
                  className="ms-auto inline-flex items-center gap-1 text-xs font-semibold text-copper hover:underline">
                  <Plus size={12} /> {t('إضافة عرض من مكتب', 'Add an office offering')}
                </button>
              )}
            </div>
            {offerings.length === 0 ? (
              <div className="text-xs text-charcoal/50">{t('لم يُضف أي عرض بعد.', 'No offerings yet.')}</div>
            ) : (
              <div className="divide-y divide-sand/40 rounded-lg border border-sand/60 bg-white">
                {offerings.map((o) => {
                  const od = o.record.data as Record<string, unknown>;
                  const title = o.kind === 'project'
                    ? String(od.project_name ?? t('مشروع', 'Project'))
                    : [od.unit_code, od.unit_type].filter((x) => typeof x === 'string' && x).join(' · ') || t('وحدة', 'Unit');
                  return (
                    <button key={o.record.id} type="button" onClick={() => openRecord(`/model/${o.kind === 'project' ? 'all_projects' : 'units'}/${o.record.id}`)}
                      className="flex w-full items-center gap-2 px-3 py-2 text-start text-sm hover:bg-cream">
                      <span className="rounded bg-cream px-1.5 text-[11px] font-semibold text-charcoal/70">
                        {o.kind === 'project' ? t('مشروع', 'Project') : od.unit_source === 'office' ? t('وحدة مكتب', 'Office unit') : t('وحدة', 'Unit')}
                      </span>
                      <span className="flex-1 truncate font-semibold text-charcoal">{title}</span>
                      {typeof od.total_price === 'number' && <span className="text-xs text-charcoal/60">{od.total_price.toLocaleString('en-US')} {t('ر.س', 'SAR')}</span>}
                    </button>
                  );
                })}
              </div>
            )}
          </section>

          {/* 5 — history */}
          {updates.length > 0 && (
            <section className="space-y-1.5">
              <h3 className="text-sm font-bold text-chocolate">{t('سجل الطلب', 'Request history')}</h3>
              {updates.slice().reverse().map((u, i) => (
                <div key={u.id ?? i} className="text-xs text-charcoal/70">
                  <span className="text-charcoal/45">{u.created_at ? new Date(u.created_at).toLocaleString(isAr ? 'ar-SA-u-nu-latn' : 'en-GB', { dateStyle: 'short', timeStyle: 'short' }) : ''} {userName(u.author_id)}</span>
                  {' — '}{u.text}
                </div>
              ))}
            </section>
          )}
        </div>
      </Modal>

      {offerFor && client && (
        <OfficeOfferModal
          request={request}
          clientId={client.id}
          outreach={outreach}
          initialOfficeId={offerFor.officeId}
          onClose={() => setOfferFor(null)}
        />
      )}
    </>
  );
}
