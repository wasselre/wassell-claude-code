import { useMemo, useState, type ReactNode } from 'react';
import { CalendarDays, Check, KeyRound, Loader2, MapPin, Map as MapIcon, SlidersHorizontal, X } from 'lucide-react';
import { useAppStore } from '@/stores/appStore';
import Button from '@/components/ui/Button';
import DynamicField from '@/pages/Records/components/DynamicField';
import DistrictMapPicker from '@/components/DistrictMapPicker';
import { useRecordDraft } from '@/hooks/useRecordDraft';
import { saveClientPreferences } from '@/lib/clients/preferences';
import { usePrefFieldFormat } from '@/pages/Chats/lib/usePrefFieldFormat';
import type { AppModel, AppRecord, ModelField } from '@/types';
import type { LocationItem } from '@/lib/geo/locationItems';
import { messagesBefore, messagesMatching, quoteFragments, type ReviewMessage } from '../lib/reviewHighlight';
import type {
  ReviewBooking, ReviewCardKey, ReviewCardVerdict, ReviewDetail, ReviewPortal,
} from '../lib/useAiChatReviewDetail';

/**
 * The AI chat review's cards — what the AI agent DID in the chat (operator,
 * 2026-10-05): places saved, other preferences saved, portal registrations,
 * visits booked / recorded. Clicking a card lights up the messages it rests on.
 * Each card is accepted, or rejected: the reviewer corrects the values right
 * here (an ordinary client / appointment / visit save) and writes what the
 * mistake was — a rejection without a reason is refused by the database too.
 */

const BTN = '!px-3 !py-1.5 !text-xs !rounded-lg !gap-1';

const fieldsOf = (m: AppModel | undefined): ModelField[] => (m?.schema?.sections ?? []).flatMap((s) => s.fields ?? []);

function asItems(v: unknown): LocationItem[] {
  return Array.isArray(v) ? (v as LocationItem[]) : [];
}

function cityIdOf(location: unknown): string | null {
  const c = location && typeof location === 'object' ? (location as Record<string, unknown>).city : null;
  return Array.isArray(c) ? (typeof c[0] === 'string' ? c[0] : null) : typeof c === 'string' ? c : null;
}

/** before/after of the keys that changed — kept with a rejection. */
function diff(before: Record<string, unknown>, after: Record<string, unknown>, keys: readonly string[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const k of keys) {
    if (JSON.stringify(before[k] ?? null) !== JSON.stringify(after[k] ?? null)) out[k] = { before: before[k] ?? null, after: after[k] ?? null };
  }
  return out;
}

const PORTAL_STATUS: Record<string, { ar: string; en: string }> = {
  covered: { ar: 'مسجّل مسبقاً — مغطى', en: 'Already covered' },
  already_registered: { ar: 'مسجّل مسبقاً', en: 'Already registered' },
  done: { ar: 'تم التسجيل', en: 'Registered' },
  queued: { ar: 'في الانتظار', en: 'Queued' },
  running: { ar: 'جارٍ التسجيل', en: 'Running' },
  in_progress: { ar: 'جارٍ التسجيل', en: 'In progress' },
  awaiting_input: { ar: 'بانتظار رمز التحقق', en: 'Waiting for the code' },
  failed: { ar: 'فشل', en: 'Failed' },
  cancelled: { ar: 'أُلغي', en: 'Cancelled' },
  no_portal: { ar: 'لا توجد بوابة لهذا المشروع', en: 'No portal for this project' },
  interest_attempt_used: { ar: 'استُخدمت المحاولة', en: 'Attempt already used' },
};

const APPT_STATUS: Record<string, { ar: string; en: string }> = {
  scheduled: { ar: 'مجدول', en: 'Scheduled' }, confirmed: { ar: 'مؤكد', en: 'Confirmed' },
  rescheduled: { ar: 'أُعيدت جدولته', en: 'Rescheduled' }, completed: { ar: 'تم', en: 'Done' },
  no_show: { ar: 'لم يحضر', en: 'No-show' }, cancelled: { ar: 'ملغي', en: 'Cancelled' },
};

function fmtWhen(iso: unknown, isAr: boolean): string {
  if (typeof iso !== 'string' || !iso) return '—';
  const d = new Date(iso.length === 16 ? `${iso}:00+03:00` : iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleString(isAr ? 'ar-SA-u-nu-latn' : 'en-GB', {
    timeZone: 'Asia/Riyadh', weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit',
  });
}

/** The newest item per key (input is oldest-first, as the API returns it). */
function latestBy<T extends { created_at: string }>(items: readonly T[], key: (t: T) => string): T[] {
  const out = new Map<string, T>();
  for (const it of items) {
    const k = key(it);
    const prev = out.get(k);
    if (!prev || prev.created_at <= it.created_at) out.set(k, it);
  }
  return [...out.values()];
}

// ── One card's frame: summary, highlight, accept / reject + correction ─────────

function CardShell({
  title, icon, isAr, empty, verdict, active, onHighlight, children, editor, onAccept, onReject, rejecting, setRejecting,
}: {
  title: string; icon: ReactNode; isAr: boolean; empty: boolean;
  verdict: ReviewCardVerdict | undefined; active: boolean; onHighlight: () => void;
  children: ReactNode; editor: ReactNode | null;
  onAccept: () => Promise<void>; onReject: (reason: string) => Promise<void>;
  rejecting: boolean; setRejecting: (v: boolean) => void;
}) {
  const L = (ar: string, en: string) => (isAr ? ar : en);
  const addToast = useAppStore((s) => s.addToast);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState<'accept' | 'reject' | null>(null);

  const run = async (kind: 'accept' | 'reject', fn: () => Promise<void>) => {
    setBusy(kind);
    try {
      await fn();
      if (kind === 'reject') { setRejecting(false); setReason(''); }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      console.error('[AiReviewCards] save failed:', msg);
      addToast(L(`تعذّر الحفظ: ${msg}`, `Could not save: ${msg}`), 'error');
    } finally {
      setBusy(null);
    }
  };

  return (
    <section className={`rounded-2xl border bg-white p-3 ${active ? 'border-gold ring-2 ring-gold/40' : 'border-sand'}`}>
      <button type="button" onClick={onHighlight} disabled={empty} className="block w-full text-start disabled:cursor-default">
        <div className="flex items-center gap-2">
          <span className="text-copper">{icon}</span>
          <h4 className="flex-1 text-sm font-bold text-chocolate">{title}</h4>
          {verdict?.verdict === 'accepted' && (
            <span className="inline-flex items-center gap-1 rounded-full bg-[#10B981]/15 px-2 py-0.5 text-[11px] font-bold text-[#0F7A55]"><Check size={11} /> {L('مقبول', 'Accepted')}</span>
          )}
          {verdict?.verdict === 'rejected' && (
            <span className="inline-flex items-center gap-1 rounded-full bg-terracotta/15 px-2 py-0.5 text-[11px] font-bold text-terracotta"><X size={11} /> {L('مرفوض', 'Rejected')}</span>
          )}
        </div>
        <div className="mt-2 text-xs text-charcoal">{children}</div>
        {!empty && <p className="mt-1.5 text-[10.5px] text-charcoal/45">{L('اضغط لتمييز الرسائل التي بنى عليها المساعد', 'Click to highlight the messages the AI based this on')}</p>}
      </button>

      {verdict?.verdict === 'rejected' && verdict.reason && !rejecting && (
        <p className="mt-2 rounded-lg bg-terracotta/5 px-2 py-1.5 text-xs text-terracotta" dir="auto">{verdict.reason}</p>
      )}

      {!empty && !rejecting && (
        <div className="mt-2 flex flex-wrap gap-2">
          <Button className={BTN} variant={verdict?.verdict === 'accepted' ? 'secondary' : 'primary'} disabled={busy !== null} onClick={() => void run('accept', onAccept)}>
            {busy === 'accept' ? <Loader2 size={12} className="animate-spin" /> : <Check size={12} />} {L('قبول', 'Accept')}
          </Button>
          <Button className={BTN} variant="secondary" disabled={busy !== null} onClick={() => setRejecting(true)}>
            <X size={12} /> {L('رفض وتصحيح', 'Reject & correct')}
          </Button>
        </div>
      )}

      {rejecting && (
        <div className="mt-3 space-y-3 rounded-xl border border-terracotta/30 bg-terracotta/5 p-3">
          {editor && (
            <div className="space-y-3">
              <p className="text-xs font-bold text-chocolate">{L('صحّح القيم:', 'Correct the values:')}</p>
              {editor}
            </div>
          )}
          <div>
            <label className="mb-1 block text-xs font-bold text-chocolate">
              {L('ما الخطأ ولماذا؟ (مطلوب)', 'What was wrong, and why? (required)')}
            </label>
            <textarea value={reason} onChange={(e) => setReason(e.target.value)} rows={2} dir="auto" maxLength={2000}
              className="form-input w-full resize-y text-sm" />
          </div>
          <div className="flex flex-wrap gap-2">
            <Button className={BTN} variant="danger" disabled={busy !== null || !reason.trim()} onClick={() => void run('reject', () => onReject(reason.trim()))}>
              {busy === 'reject' ? <Loader2 size={12} className="animate-spin" /> : <X size={12} />}
              {editor ? L('حفظ التصحيح والرفض', 'Save correction & reject') : L('تأكيد الرفض', 'Confirm reject')}
            </Button>
            <Button className={BTN} variant="ghost" disabled={busy !== null} onClick={() => setRejecting(false)}>{L('إلغاء', 'Cancel')}</Button>
          </div>
        </div>
      )}
    </section>
  );
}

// ── The four cards ───────────────────────────────────────────────────────────

export default function AiReviewCards({
  detail, client, messages, isAr, activeCard, onHighlight, setCard,
}: {
  detail: ReviewDetail;
  client: AppRecord | undefined;
  messages: readonly ReviewMessage[];
  isAr: boolean;
  activeCard: ReviewCardKey | null;
  onHighlight: (card: ReviewCardKey | null, ids: Set<string>) => void;
  setCard: (card: ReviewCardKey, verdict: 'accepted' | 'rejected', reason: string | null, corrections: Record<string, unknown> | null) => Promise<void>;
}) {
  const L = (ar: string, en: string) => (isAr ? ar : en);
  const models = useAppStore((s) => s.models);
  const records = useAppStore((s) => s.records);
  const saveRecord = useAppStore((s) => s.saveRecord);
  const { fieldLabel, formatValue } = usePrefFieldFormat();
  const clientsModel = models.find((m) => m.name === 'clients');
  const clientFields = fieldsOf(clientsModel);
  const { draft, patchDraft } = useRecordDraft(client);
  const [rejecting, setRejecting] = useState<Partial<Record<ReviewCardKey, boolean>>>({});
  const [mapOpen, setMapOpen] = useState(false);
  const verdictOf = (k: ReviewCardKey) => detail.cards.find((c) => c.card === k);

  // Each AI reading re-saves what it heard, so one field / one district can
  // appear many times in a window (measured: bedrooms saved 11× in one chat).
  // Show the LATEST per field and per district; highlight on ALL their quotes.
  const allPlaces = detail.changes.filter((c) => c.kind === 'place');
  const allPrefs = detail.changes.filter((c) => c.kind === 'pref' && c.field);
  const places = useMemo(() => latestBy(allPlaces, (c) => `${c.label ?? ''}|${c.applied ? 1 : 0}`)
    // A district that was saved at some point is not also listed as "doubted".
    .filter((c, _i, arr) => c.applied || !arr.some((o) => o.applied && o.label === c.label)), [allPlaces]);
  const prefs = useMemo(() => latestBy(allPrefs, (c) => c.field as string), [allPrefs]);
  const prefSlugs = useMemo(() => [...new Set(prefs.map((c) => c.field as string))], [prefs]);
  const locationField = clientFields.find((f) => f.name === 'location');

  const toggle = (k: ReviewCardKey, ids: Set<string>) => onHighlight(activeCard === k ? null : k, ids);

  // A card's correction saves the client's preference fields, then the verdict.
  const rejectClientCard = async (card: ReviewCardKey, slugs: string[], reason: string) => {
    if (!client) throw new Error(L('العميل غير محمّل', 'Client not loaded'));
    const keys = [...slugs, ...(slugs.includes('location') ? ['location_items'] : [])];
    const corrections = diff(client.data, draft, keys);
    if (Object.keys(corrections).length > 0) {
      const res = await saveClientPreferences({ client, draft, slugs, saveRecord, isAr });
      if (!res.ok) throw new Error(res.message);
    }
    await setCard(card, 'rejected', reason, Object.keys(corrections).length ? corrections : null);
  };

  // ── Places ──
  const placeLabels = places.map((c) => c.label).filter((x): x is string => !!x);
  const placesCard = (
    <CardShell
      key="places"
      title={L('التفضيلات الجغرافية', 'Places saved')}
      icon={<MapPin size={16} />}
      isAr={isAr}
      empty={places.length === 0}
      verdict={verdictOf('places')}
      active={activeCard === 'places'}
      onHighlight={() => toggle('places', messagesMatching(messages, [...placeLabels, ...allPlaces.flatMap((c) => (c.applied ? quoteFragments(c.quote) : []))], true))}
      rejecting={!!rejecting.places}
      setRejecting={(v) => setRejecting((r) => ({ ...r, places: v }))}
      onAccept={() => setCard('places', 'accepted', null, null)}
      onReject={(reason) => rejectClientCard('places', ['location'], reason)}
      editor={client && locationField ? (
        <DynamicField field={locationField} value={draft.location} onChange={(v) => patchDraft({ location: v })}
          recordData={draft} modelId={clientsModel?.id} recordId={client.id} onPatch={patchDraft} />
      ) : null}
    >
      {places.length === 0 ? (
        <span className="text-charcoal/50">{L('لم يحفظ المساعد أي موقع في هذه المحادثة.', 'The AI saved no place in this chat.')}</span>
      ) : (
        <div className="space-y-1.5">
          <div className="flex flex-wrap gap-1.5">
            {places.filter((c) => c.applied && !c.undone_at).map((c) => {
              const excl = asItems(c.added).some((i) => (i as { polarity?: string }).polarity === 'exclude');
              return (
                <span key={c.id} className={`rounded-full px-2 py-0.5 font-bold ${excl ? 'bg-terracotta/10 text-terracotta' : 'bg-copper/10 text-copper'}`}>
                  {excl ? L('استبعاد: ', 'Not: ') : ''}{c.label ?? '—'}
                  {c.profile_name ? <span className="font-normal text-charcoal/50"> · {c.profile_name}</span> : null}
                </span>
              );
            })}
          </div>
          {places.some((c) => !c.applied) && (
            <p className="text-amber-700">
              {L('سمعه ولم يحفظه (مشكوك): ', 'Heard but not saved (doubted): ')}
              {places.filter((c) => !c.applied).map((c) => c.label).filter(Boolean).join(isAr ? '، ' : ', ')}
            </p>
          )}
          {places.some((c) => c.undone_at) && (
            <p className="text-charcoal/45">{L('تراجع عنه شخص: ', 'Undone by a person: ')}{places.filter((c) => c.undone_at).map((c) => c.label).join(isAr ? '، ' : ', ')}</p>
          )}
        </div>
      )}
      {places.length > 0 && client && cityIdOf(client.data.location) && (
        <span
          role="button"
          tabIndex={0}
          onClick={(e) => { e.stopPropagation(); setMapOpen(true); }}
          onKeyDown={(e) => { if (e.key === 'Enter') { e.stopPropagation(); setMapOpen(true); } }}
          className="mt-2 inline-flex items-center gap-1 rounded-lg bg-cream px-2 py-1 font-bold text-copper hover:bg-sand/40"
        >
          <MapIcon size={12} /> {L('عرض على الخريطة', 'Show on the map')}
        </span>
      )}
    </CardShell>
  );

  // ── Other preferences ──
  const prefFields = prefSlugs.map((s) => clientFields.find((f) => f.name === s)).filter((f): f is ModelField => !!f);
  const prefsCard = (
    <CardShell
      key="preferences"
      title={L('التفضيلات الأخرى', 'Other preferences saved')}
      icon={<SlidersHorizontal size={16} />}
      isAr={isAr}
      empty={prefs.length === 0}
      verdict={verdictOf('preferences')}
      active={activeCard === 'preferences'}
      onHighlight={() => toggle('preferences', messagesMatching(messages, allPrefs.flatMap((c) => quoteFragments(c.quote))))}
      rejecting={!!rejecting.preferences}
      setRejecting={(v) => setRejecting((r) => ({ ...r, preferences: v }))}
      onAccept={() => setCard('preferences', 'accepted', null, null)}
      onReject={(reason) => rejectClientCard('preferences', prefFields.map((f) => f.name), reason)}
      editor={client && prefFields.length ? (
        <div className="space-y-3">
          {prefFields.map((f) => (
            <div key={f.id}>
              <label className="mb-1 block text-xs font-semibold text-charcoal/60">{isAr ? f.label_ar : f.label_en}</label>
              <DynamicField field={f} value={draft[f.name]} onChange={(v) => patchDraft({ [f.name]: v })}
                recordData={draft} modelId={clientsModel?.id} recordId={client.id} onPatch={patchDraft} />
            </div>
          ))}
        </div>
      ) : null}
    >
      {prefs.length === 0 ? (
        <span className="text-charcoal/50">{L('لم يحفظ المساعد تفضيلات أخرى في هذه المحادثة.', 'The AI saved no other preference in this chat.')}</span>
      ) : (
        <ul className="space-y-1.5">
          {prefs.map((c) => (
            <li key={c.id} className={c.undone_at ? 'text-charcoal/40 line-through' : ''}>
              <span className="font-bold text-chocolate">{fieldLabel(c.field as string)}: </span>
              <span className={c.applied ? '' : 'text-amber-700'}>
                {formatValue(c.field as string, c.after_value) || '—'}
                {!c.applied && L(' (لم يُحفظ — بقيت قيمة المندوب)', ' (not saved — the rep’s value kept)')}
              </span>
              {c.profile_name && <span className="text-charcoal/50"> · {c.profile_name}</span>}
              {c.quote && <span className="block text-[11px] text-charcoal/55" dir="auto">«{c.quote}»</span>}
            </li>
          ))}
        </ul>
      )}
    </CardShell>
  );

  // ── Portal ──
  const portalNeedles = detail.portals.map((p) => p.project).filter((x): x is string => !!x);
  const portalLine = (p: ReviewPortal): ReactNode => {
    if (p.kind === 'interest') {
      const res = (p.result && typeof p.result === 'object' ? p.result : {}) as { status?: string; portals?: Array<{ portal?: string; status?: string }> };
      const rows = res.portals ?? [];
      return (
        <li key={p.id}>
          <span className="font-bold text-chocolate">{p.project ?? '—'}</span>
          {rows.length === 0 ? (
            <span> — {L(PORTAL_STATUS[res.status ?? '']?.ar ?? res.status ?? '—', PORTAL_STATUS[res.status ?? '']?.en ?? res.status ?? '—')}</span>
          ) : rows.map((r, i) => (
            <span key={`${p.id}-${i}`} className="block ps-3">
              {r.portal ?? '—'}: {L(PORTAL_STATUS[r.status ?? '']?.ar ?? r.status ?? '—', PORTAL_STATUS[r.status ?? '']?.en ?? r.status ?? '—')}
            </span>
          ))}
        </li>
      );
    }
    const st = PORTAL_STATUS[p.status ?? ''];
    return (
      <li key={p.id}>
        <span className="font-bold text-chocolate">{p.portal ?? L('بوابة', 'Portal')}</span>
        {p.project ? ` · ${p.project}` : ''} — {st ? L(st.ar, st.en) : p.status}
        {p.error && <span className="block text-[11px] text-terracotta" dir="auto">{p.error}</span>}
      </li>
    );
  };
  const portalCard = (
    <CardShell
      key="portal"
      title={L('التسجيل في البوابات', 'Portal registration')}
      icon={<KeyRound size={16} />}
      isAr={isAr}
      empty={detail.portals.length === 0}
      verdict={verdictOf('portal')}
      active={activeCard === 'portal'}
      onHighlight={() => toggle('portal', messagesMatching(messages, portalNeedles))}
      rejecting={!!rejecting.portal}
      setRejecting={(v) => setRejecting((r) => ({ ...r, portal: v }))}
      onAccept={() => setCard('portal', 'accepted', null, null)}
      onReject={(reason) => setCard('portal', 'rejected', reason, null)}
      editor={null}
    >
      {detail.portals.length === 0 ? (
        <span className="text-charcoal/50">{L('لم يُسجَّل العميل في أي بوابة من هذه المحادثة.', 'No portal registration from this chat.')}</span>
      ) : <ul className="space-y-1.5">{detail.portals.map(portalLine)}</ul>}
    </CardShell>
  );

  // ── Visits ──
  const appModel = models.find((m) => m.name === 'appointments');
  const visitModel = models.find((m) => m.name === 'visits');
  const [bookingDrafts, setBookingDrafts] = useState<Record<string, Record<string, unknown>>>({});
  const bookingFields = (b: ReviewBooking): ModelField[] => {
    const names = b.kind === 'appointment' ? ['appointment_date', 'appointment_status', 'project_id'] : ['scheduled_datetime', 'project_id'];
    const fs = fieldsOf(b.kind === 'appointment' ? appModel : visitModel);
    return names.map((n) => fs.find((f) => f.name === n)).filter((f): f is ModelField => !!f);
  };
  const recordOf = (b: ReviewBooking): AppRecord | undefined => {
    const m = b.kind === 'appointment' ? appModel : visitModel;
    return m ? (records[m.id] ?? []).find((r) => r.id === b.id) : undefined;
  };
  const rejectVisits = async (reason: string) => {
    const corrections: Record<string, unknown> = {};
    for (const b of detail.bookings) {
      const patch = bookingDrafts[b.id];
      const rec = recordOf(b);
      if (!patch || !rec) continue;
      const changed = diff(rec.data, { ...rec.data, ...patch }, Object.keys(patch));
      if (Object.keys(changed).length === 0) continue;
      const res = await saveRecord({ ...rec, data: { ...rec.data, ...patch }, updated_at: new Date().toISOString() }, { expectedVersion: rec.version ?? null });
      if (res.status !== 'saved') throw new Error(L('تعذّر حفظ الموعد — أعد التحميل وحاول', 'Could not save the booking — reload and try again'));
      corrections[`${b.kind}:${b.id}`] = changed;
    }
    await setCard('visits', 'rejected', reason, Object.keys(corrections).length ? corrections : null);
  };
  const visitsCard = (
    <CardShell
      key="visits"
      title={L('المواعيد والزيارات', 'Appointments & visits')}
      icon={<CalendarDays size={16} />}
      isAr={isAr}
      empty={detail.bookings.length === 0}
      verdict={verdictOf('visits')}
      active={activeCard === 'visits'}
      onHighlight={() => toggle('visits', new Set(detail.bookings.flatMap((b) => [...messagesBefore(messages, b.at)])))}
      rejecting={!!rejecting.visits}
      setRejecting={(v) => setRejecting((r) => ({ ...r, visits: v }))}
      onAccept={() => setCard('visits', 'accepted', null, null)}
      onReject={rejectVisits}
      editor={detail.bookings.length ? (
        <div className="space-y-3">
          {detail.bookings.map((b) => {
            const rec = recordOf(b);
            if (!rec) return <p key={b.id} className="text-xs text-charcoal/50">{L('السجل غير محمّل — عدّله من صفحته.', 'Record not loaded — edit it on its page.')}</p>;
            const cur = { ...rec.data, ...(bookingDrafts[b.id] ?? {}) };
            return (
              <div key={b.id} className="space-y-2 rounded-lg bg-white p-2">
                <p className="text-xs font-bold text-chocolate">{b.kind === 'appointment' ? L('موعد', 'Appointment') : L('زيارة', 'Visit')}{b.project ? ` · ${b.project}` : ''}</p>
                {bookingFields(b).map((f) => (
                  <div key={f.id}>
                    <label className="mb-1 block text-xs font-semibold text-charcoal/60">{isAr ? f.label_ar : f.label_en}</label>
                    <DynamicField field={f} value={cur[f.name]} recordData={cur} recordId={rec.id}
                      modelId={b.kind === 'appointment' ? appModel?.id : visitModel?.id}
                      onChange={(v) => setBookingDrafts((d) => ({ ...d, [b.id]: { ...(d[b.id] ?? {}), [f.name]: v } }))} />
                  </div>
                ))}
              </div>
            );
          })}
        </div>
      ) : null}
    >
      {detail.bookings.length === 0 ? (
        <span className="text-charcoal/50">{L('لم يحجز المساعد موعداً ولم يسجّل زيارة.', 'The AI booked no appointment and recorded no visit.')}</span>
      ) : (
        <ul className="space-y-1.5">
          {detail.bookings.map((b) => (
            <li key={b.id}>
              <span className="font-bold text-chocolate">{b.kind === 'appointment' ? L('حجز موعد', 'Booked a visit') : L('سجّل زيارة تمت', 'Recorded a visit')}</span>
              {b.project ? ` · ${b.project}` : ''} — {fmtWhen(b.kind === 'appointment' ? b.data.appointment_date : b.data.scheduled_datetime, isAr)}
              {b.kind === 'appointment' && typeof b.data.appointment_status === 'string' && (
                <span className="text-charcoal/55"> · {L(APPT_STATUS[b.data.appointment_status]?.ar ?? b.data.appointment_status, APPT_STATUS[b.data.appointment_status]?.en ?? b.data.appointment_status)}</span>
              )}
            </li>
          ))}
        </ul>
      )}
    </CardShell>
  );

  const cityId = client ? cityIdOf(client.data.location) : null;
  return (
    <div className="space-y-3">
      {placesCard}
      {prefsCard}
      {portalCard}
      {visitsCard}
      {mapOpen && cityId && (
        <DistrictMapPicker
          cityId={cityId}
          items={asItems(draft.location_items)}
          // Changing the map IS a correction: stage it and open the reject form.
          onApply={(items) => {
            patchDraft({ location_items: items });
            setRejecting((r) => ({ ...r, places: true }));
            setMapOpen(false);
          }}
          onClose={() => setMapOpen(false)}
          isAr={isAr}
        />
      )}
    </div>
  );
}
