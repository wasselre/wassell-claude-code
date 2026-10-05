/**
 * High interest → a DRAFT message to the project's officer, held in the AI tab
 * until the operator approves it (operator, 2026-10-04: nothing but portal
 * registration goes out on its own yet).
 *
 * The officer is told ONLY about a highly interested client — never because a
 * client was registered. The text is a fixed template, so nothing in it can be
 * invented:
 *   السلام عليكم،
 *   عندنا عميل مهتم كثير بمشروع «X»، وهو مسجّل عندكم في البوابة.
 *   سبب الاهتمام: سأل عن الأسعار والمخططات.
 *   ما قام به العميل: فتح صفحة المشروع 3 مرات، تصفّح البروشور (5 صفحات).
 *   حجز العميل موعد زيارة لمشروع «X» يوم الاثنين 5 أكتوبر الساعة 7:00 مساءً.
 *   اهتمامه أقل بـ«Y».
 *   العميل: محمد — رقمه: 05…
 *   نتمنى تتواصلون معه، ويعطيك العافية.
 * The portal line appears only when the client really is registered with that
 * company; the «less interest» line only for other projects of the SAME company
 * we sent the client (telling a developer about a competitor's project would be
 * a leak), ranked by their link score.
 *
 * One officer per event (explicit first, developer-officer-wins — the same pick
 * as the «إشعار المسؤول» button), and a cooldown: no new draft for the same
 * client × officer while one is pending or was sent in the last N days.
 */
import { type Rec, type Svc, idList, str, loadRecord, resolvePortals } from './leadPortals.js';
import { resolveProjectOfficers } from './projectOfficers.js';

export type OfficerDraftResult =
  | { status: 'drafted'; action_id: string; officer_id: string }
  | { status: 'wait_portal' }
  | { status: 'no_officer' | 'cooldown' | 'missing_record' | 'no_phone'; reason?: string };

/** A KSA mobile in E.164 (+9665XXXXXXXX) → the local 05XXXXXXXX a person writes. */
function localPhone(v: string): string {
  const digits = v.replace(/\D/g, '');
  const m = /^(?:00)?966(5\d{8})$/.exec(digits);
  return m ? `0${m[1]}` : v.trim();
}

function officerChatWid(phone: string): string | null {
  let d = phone.replace(/\D/g, '');
  if (d.startsWith('00')) d = d.slice(2);
  if (d.startsWith('0')) d = `966${d.slice(1)}`;
  else if (d.length === 9 && d.startsWith('5')) d = `966${d}`;
  return /^\d{10,15}$/.test(d) ? `${d}@c.us` : null;
}

function projectName(p: Rec): string {
  return str(p.data?.project_name) || str(p.data?.name) || '—';
}

export async function draftOfficerNotice(
  svc: Svc,
  args: { interestId: string; clientId: string; projectId: string; chatWid: string | null; detectedAt: string; cooldownDays: number; source: string; score: number | null },
): Promise<OfficerDraftResult> {
  // Let the portal step settle first, so the message says truthfully whether
  // the client is registered — but never wait more than 2 hours.
  const waitedMs = Date.now() - Date.parse(args.detectedAt);
  if (waitedMs < 2 * 3600_000) {
    const { data: live, error: liveErr } = await svc
      .from('portal_registration_jobs').select('id')
      .eq('client_record_id', args.clientId).in('status', ['queued', 'running', 'awaiting_input']).limit(1);
    if (liveErr) throw new Error(`live portal job check failed: ${liveErr.message}`);
    if ((live ?? []).length > 0) return { status: 'wait_portal' };
  }

  const [client, project] = await Promise.all([loadRecord(svc, args.clientId), loadRecord(svc, args.projectId)]);
  if (!client || !project) return { status: 'missing_record' };

  const officers = await resolveProjectOfficers(svc, args.projectId);
  const officer = officers[0];
  if (!officer) return { status: 'no_officer' };
  const wid = officerChatWid(officer.phone);
  if (!wid) return { status: 'no_phone', reason: `officer ${officer.id} has an unusable phone` };

  if (args.cooldownDays > 0) {
    const since = new Date(Date.now() - args.cooldownDays * 86_400_000).toISOString();
    const { data: recent, error: rErr } = await svc
      .from('ai_actions').select('id')
      .eq('kind', 'officer_notice').eq('officer_id', officer.id).eq('client_id', args.clientId)
      .in('status', ['pending', 'sending', 'sent']).gte('created_at', since).limit(1);
    if (rErr) throw new Error(`cooldown check failed: ${rErr.message}`);
    if ((recent ?? []).length > 0) return { status: 'cooldown' };
  }

  // Registered with this project's company? (any portal covering the project)
  const portals = await resolvePortals(svc, client, project, { email: '', name: '', phone: '' });
  let registered = false;
  if (portals.length > 0) {
    const { data: regs, error: regErr } = await svc
      .from('client_portal_registrations').select('portal_record_id, our_status')
      .eq('client_record_id', args.clientId).in('portal_record_id', portals.map((p) => p.id));
    if (regErr) throw new Error(`registration lookup failed: ${regErr.message}`);
    registered = ((regs ?? []) as { our_status: string | null }[])
      .some((r) => r.our_status === 'registered' || r.our_status === 'already_registered');
  }

  // Other projects of the SAME company sent to this client, least interest first.
  const lowNames: string[] = [];
  if (args.chatWid) {
    const devId = idList(project.data?.developer)[0] ?? null;
    const mktIds = idList(project.data?.marketer);
    const { data: sent, error: sErr } = await svc
      .from('chat_message_projects').select('project_id').eq('chat_wid', args.chatWid).limit(60);
    if (sErr) throw new Error(`sent projects read failed: ${sErr.message}`);
    const otherIds = [...new Set(((sent ?? []) as { project_id: string | null }[]).map((r) => r.project_id).filter((id): id is string => !!id && id !== args.projectId))];
    if (otherIds.length) {
      const [{ data: prows, error: pErr }, { data: scores, error: scErr }] = await Promise.all([
        svc.from('unified_records').select('id, data').in('id', otherIds),
        svc.from('v_project_interest').select('project_id, score').eq('chat_wid', args.chatWid).in('project_id', otherIds),
      ]);
      if (pErr) throw new Error(`sent project records read failed: ${pErr.message}`);
      if (scErr) throw new Error(`interest scores read failed: ${scErr.message}`);
      const scoreOf = new Map(((scores ?? []) as { project_id: string; score: number | null }[]).map((s) => [s.project_id, s.score ?? 0]));
      const same = ((prows ?? []) as Rec[]).filter((p) => {
        const d = idList(p.data?.developer)[0] ?? null;
        const m = idList(p.data?.marketer);
        return (devId && d === devId) || m.some((x) => mktIds.includes(x));
      });
      same.sort((a, b) => (scoreOf.get(a.id) ?? 0) - (scoreOf.get(b.id) ?? 0));
      for (const p of same.slice(0, 2)) lowNames.push(projectName(p));
    }
  }

  const clientName = str(client.data?.client_name).trim();
  const clientPhone = localPhone(str(client.data?.phone_number));
  const why = await interestWhy(svc, args.clientId, args.projectId, args.chatWid);
  const body = noticeBody({ projectName: projectName(project), registered, why, lowNames, clientName, clientPhone, questions: [] });

  const { data: ins, error: insErr } = await svc.from('ai_actions').insert({
    kind: 'officer_notice',
    client_id: args.clientId,
    chat_wid: wid,
    project_id: args.projectId,
    officer_id: officer.id,
    interest_id: args.interestId,
    phone: `+${wid.split('@')[0]}`,
    body,
    original_body: body,
    context: {
      client_name: clientName || null,
      client_chat_wid: args.chatWid,
      project_name: projectName(project),
      officer_name: officer.name,
      officer_coverage: officer.coverage,
      registered,
      less_interest: lowNames,
      interest_source: args.source,
      interest_score: args.score,
    },
  }).select('id').single();
  if (insErr) {
    // Another tick drafted this exact notice first (unique interest × officer).
    if (insErr.code === '23505') return { status: 'cooldown', reason: 'already drafted' };
    throw new Error(`officer notice insert failed: ${insErr.message}`);
  }
  const actionId = (ins as { id: string }).id;
  const { error: refErr } = await svc.from('ai_actions').update({ reference: `officer_notice:${actionId}` }).eq('id', actionId);
  if (refErr) throw new Error(`officer notice reference failed: ${refErr.message}`);
  return { status: 'drafted', action_id: actionId, officer_id: officer.id };
}

/** The officer message, from facts only. PURE. */
export function noticeBody(a: {
  projectName: string; registered: boolean; why: InterestWhy; lowNames: string[];
  clientName: string; clientPhone: string; questions: string[];
}): string {
  const asking = a.questions.length > 0;
  return [
    'السلام عليكم،',
    `عندنا عميل مهتم${asking ? '' : ' كثير'} بمشروع «${a.projectName}»${a.registered ? '، وهو مسجّل عندكم في البوابة' : ''}.`,
    ...(a.why.reason ? [`سبب الاهتمام: ${a.why.reason}.`] : []),
    ...(a.why.actions.length ? [`ما قام به العميل: ${a.why.actions.join('، ')}.`] : []),
    ...(a.why.booking ? [bookingLine(a.why.booking, a.projectName)] : []),
    ...(a.lowNames.length ? [`اهتمامه أقل بـ«${a.lowNames.join('» و«')}».`] : []),
    ...a.questions.map((q) => `سؤال العميل: «${q}»`),
    `العميل: ${a.clientName || '—'}${a.clientPhone ? ` — رقمه: ${a.clientPhone}` : ''}`,
    asking ? 'نتمنى تتواصلون معه وتردون على سؤاله، ويعطيك العافية.' : 'نتمنى تتواصلون معه، ويعطيك العافية.',
  ].join('\n');
}

export interface InterestWhy {
  /** A general reason («سأل عن الأسعار والمخططات») — never the customer's literal words. */
  reason: string | null;
  /** What the client actually did («فتح صفحة المشروع 3 مرات»، «تصفّح البروشور»). */
  actions: string[];
  /** The visit booked (or made) for this project, with its date and time — its own line. */
  booking?: Booking | null;
}

/** An appointment or visit for the project. `at` = Riyadh wall-clock «YYYY-MM-DDTHH:mm». */
export interface Booking { at: string; done: boolean }

const AR_DAYS = ['الأحد', 'الاثنين', 'الثلاثاء', 'الأربعاء', 'الخميس', 'الجمعة', 'السبت'];
const AR_MONTHS = ['يناير', 'فبراير', 'مارس', 'أبريل', 'مايو', 'يونيو', 'يوليو', 'أغسطس', 'سبتمبر', 'أكتوبر', 'نوفمبر', 'ديسمبر'];

/**
 * PURE — «حجز العميل موعد زيارة لمشروع «X» يوم الاثنين 5 أكتوبر الساعة 7:00 مساءً.»
 * (operator, 2026-10-05: when a visit is saved the officer must see, below the
 * interest and what the client did, that the client booked a visit at this time
 * for this project). The stored time is Riyadh wall-clock — no conversion.
 */
export function bookingLine(b: Booking, projectName: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2}))?/.exec(b.at);
  if (!m) return b.done ? `زار العميل مشروع «${projectName}».` : `حجز العميل موعد زيارة لمشروع «${projectName}».`;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const day = `يوم ${AR_DAYS[new Date(Date.UTC(y, mo - 1, d)).getUTCDay()]} ${d} ${AR_MONTHS[mo - 1]}`;
  let time = '';
  if (m[4] !== undefined) {
    const h = Number(m[4]);
    const h12 = h % 12 === 0 ? 12 : h % 12;
    const part = h < 12 ? 'صباحاً' : h === 12 ? 'ظهراً' : 'مساءً';
    time = ` الساعة ${h12}:${m[5]} ${part}`;
  }
  return b.done
    ? `زار العميل مشروع «${projectName}» ${day}${time}.`
    : `حجز العميل موعد زيارة لمشروع «${projectName}» ${day}${time}.`;
}

/** Riyadh wall-clock now, «YYYY-MM-DDTHH:mm» (Saudi Arabia has no daylight saving). */
const riyadhNow = (): string => new Date(Date.now() + 3 * 3600_000).toISOString().slice(0, 16);

/**
 * The visit to show for this client × project: the next upcoming booking
 * (appointment not cancelled / no-show / completed, or a visit still ahead),
 * else the most recent visit made. Appointments and visits point at the
 * our_projects record, whose `project` is the master all_projects id.
 */
async function findBooking(svc: Svc, clientId: string, projectId: string): Promise<Booking | null> {
  const { data: models, error: mErr } = await svc.from('models').select('id, name').in('name', ['our_projects', 'appointments', 'visits']);
  if (mErr) throw new Error(`models read failed: ${mErr.message}`);
  const idOf = (n: string) => ((models ?? []) as { id: string; name: string }[]).find((x) => x.name === n)?.id ?? null;
  const ourModel = idOf('our_projects');
  if (!ourModel) return null;
  const { data: ours, error: oErr } = await svc.from('records').select('id').eq('model_id', ourModel).eq('data->>project', projectId);
  if (oErr) throw new Error(`our project read failed: ${oErr.message}`);
  const projectIds = new Set([projectId, ...((ours ?? []) as { id: string }[]).map((r) => r.id)]);
  const read = async (model: string | null) => {
    if (!model) return [] as Array<{ data: Record<string, unknown> | null }>;
    const { data, error } = await svc.from('records').select('data').eq('model_id', model).eq('data->>client_id', clientId);
    if (error) throw new Error(`booking read failed: ${error.message}`);
    return ((data ?? []) as Array<{ data: Record<string, unknown> | null }>).filter((r) => projectIds.has(str(r.data?.project_id)));
  };
  const [appts, visits] = await Promise.all([read(idOf('appointments')), read(idOf('visits'))]);
  const now = riyadhNow();
  const upcoming: string[] = [];
  const done: string[] = [];
  for (const r of appts) {
    const at = str(r.data?.appointment_date);
    const st = str(r.data?.appointment_status);
    if (!at || st === 'cancelled' || st === 'no_show') continue;
    if (st === 'completed') done.push(at);
    else if (at >= now) upcoming.push(at);
  }
  for (const r of visits) {
    const at = str(r.data?.scheduled_datetime);
    if (!at) continue;
    (at >= now ? upcoming : done).push(at);
  }
  if (upcoming.length) return { at: upcoming.sort()[0]!, done: false };
  if (done.length) return { at: done.sort().reverse()[0]!, done: true };
  return null;
}

/** What the customer asked about, as general topics (fixed order). */
const TOPICS: Array<{ label: string; re: RegExp }> = [
  { label: 'الأسعار', re: /سعر|اسعار|بكم|كم\s+(?:السعر|الشقه|الفيلا|الوحده)/ },
  { label: 'المخططات', re: /مخطط|بلان|plan/i },
  { label: 'البروشور', re: /بروشور|بروشر|كتيب|brochure/i },
  { label: 'المساحات', re: /مساح|متر/ },
  { label: 'الأدوار', re: /الدور(?:\s|$|[؟?،,])|ادوار|طابق/ },
  { label: 'عدد الغرف', re: /(\d|[٠-٩]|ثلاث|اربع|خمس|غرفتين)\s*غرف|غرف\s*نوم|كم\s*غرفه/ },
  { label: 'غرف السائق والخادمة', re: /سائق|سواق|خادم|شغاله/ },
  { label: 'الوحدات المتاحة', re: /متاح|متوفر|الوحدات/ },
  { label: 'طريقة الدفع', re: /دفع|تقسيط|قسط|اقساط|تمويل|بنك/ },
  { label: 'الموقع', re: /موقع|لوكيشن|وين\s+(?:المشروع|مكانه)/ },
  { label: 'موعد التسليم', re: /تسليم|استلام/ },
  { label: 'زيارة المشروع', re: /زياره|ازور|نزور|اشوف\s+المشروع/ },
];

const fold = (t: string): string => t.replace(/[أإآ]/g, 'ا').replace(/ة/g, 'ه').replace(/ى/g, 'ي');

/**
 * PURE — the officer's «why» from what the client did (exact) and what they
 * asked about (general). Operator, 2026-10-05: «give them the exact actions
 * executed by the client with a general reason — not the literal client words,
 * that is weird» (the draft quoted «البروشور و المخطط و الأسعار» and a 43/100 score).
 */
export function describeInterest(r: {
  message_level: string | null; message_quote: string | null; appointments: number; visits: number;
}, l: {
  sessions: number; open_days: number; brochure_pages: number; brochure_seconds: number; videos_played: number;
  max_video_pct: number; photos_opened: number; units_opened: number; opened_map: boolean;
} | null, booking: Booking | null = null): InterestWhy {
  let reason: string | null = null;
  if (r.message_level && r.message_level !== 'rejected') {
    const q = fold(r.message_quote ?? '');
    const topics = TOPICS.filter((t) => t.re.test(q)).map((t) => t.label);
    reason = topics.length
      ? `سأل عن ${topics.join(' و')}`
      : r.message_level === 'wants' ? 'أبدى رغبة واضحة في المشروع' : 'سأل عن تفاصيل المشروع';
  }
  const actions: string[] = [];
  if (l && l.sessions > 0) {
    actions.push(l.sessions === 1 ? 'فتح صفحة المشروع' : `فتح صفحة المشروع ${l.sessions === 2 ? 'مرتين' : `${l.sessions} مرات`}${l.open_days === 2 ? ' في يومين' : l.open_days > 2 ? ` في ${l.open_days} أيام` : ''}`);
  }
  if (l && (l.brochure_pages > 0 || l.brochure_seconds > 0)) actions.push(l.brochure_pages > 1 ? `تصفّح البروشور (${l.brochure_pages} صفحات)` : 'تصفّح البروشور');
  if (l && l.videos_played > 0) actions.push(l.max_video_pct >= 90 ? 'شاهد فيديو المشروع كاملاً' : l.max_video_pct > 0 ? `شاهد فيديو المشروع (${Math.round(l.max_video_pct)}٪ منه)` : 'شغّل فيديو المشروع');
  if (l && l.photos_opened > 0) actions.push(l.photos_opened === 1 ? 'فتح صورة من صور المشروع' : `فتح ${l.photos_opened} صور`);
  if (l && l.units_opened > 0) actions.push(l.units_opened === 1 ? 'فتح تفاصيل وحدة' : `فتح تفاصيل ${l.units_opened} وحدات`);
  if (l?.opened_map) actions.push('فتح موقع المشروع على الخريطة');
  if (booking) return { reason, actions, booking };
  if (r.visits > 0) actions.push('زار المشروع');
  else if (r.appointments > 0) actions.push('حجز موعد زيارة');
  return { reason, actions };
}

/**
 * Why we say the client is interested — FACTS only: what the client did with
 * the project's links (v_project_interest, every chat of this client), a visit
 * or booked appointment, and the topics they asked about.
 */
async function interestWhy(svc: Svc, clientId: string, projectId: string, chatWid: string | null): Promise<InterestWhy> {
  const [{ data, error }, { data: links, error: lErr }, booking] = await Promise.all([
    svc.from('v_client_project_interest')
      .select('appointments, visits, message_level, message_quote')
      .eq('client_id', clientId).eq('project_id', projectId).maybeSingle(),
    svc.from('v_project_interest')
      .select('sessions, open_days, brochure_pages, brochure_seconds, videos_played, max_video_pct, photos_opened, units_opened, opened_map')
      .eq('project_id', projectId)
      .or(chatWid ? `client_id.eq.${clientId},chat_wid.eq.${chatWid}` : `client_id.eq.${clientId}`),
    findBooking(svc, clientId, projectId),
  ]);
  if (error) throw new Error(`interest read failed: ${error.message}`);
  if (lErr) throw new Error(`link activity read failed: ${lErr.message}`);
  const r = (data ?? { message_level: null, message_quote: null, appointments: 0, visits: 0 }) as {
    message_level: string | null; message_quote: string | null; appointments: number; visits: number;
  };
  type L = { sessions: number; open_days: number; brochure_pages: number; brochure_seconds: number; videos_played: number; max_video_pct: number; photos_opened: number; units_opened: number; opened_map: boolean };
  const rows = (links ?? []) as Array<Partial<Record<keyof L, unknown>>>;
  const num = (v: unknown) => (typeof v === 'number' ? v : Number(v ?? 0) || 0);
  const l: L | null = rows.length ? rows.reduce<L>((acc, x) => ({
    sessions: acc.sessions + num(x.sessions), open_days: acc.open_days + num(x.open_days),
    brochure_pages: Math.max(acc.brochure_pages, num(x.brochure_pages)), brochure_seconds: acc.brochure_seconds + num(x.brochure_seconds),
    videos_played: Math.max(acc.videos_played, num(x.videos_played)), max_video_pct: Math.max(acc.max_video_pct, num(x.max_video_pct)),
    photos_opened: Math.max(acc.photos_opened, num(x.photos_opened)), units_opened: Math.max(acc.units_opened, num(x.units_opened)),
    opened_map: acc.opened_map || x.opened_map === true,
  }), { sessions: 0, open_days: 0, brochure_pages: 0, brochure_seconds: 0, videos_played: 0, max_video_pct: 0, photos_opened: 0, units_opened: 0, opened_map: false }) : null;
  return describeInterest({ ...r, appointments: num(r.appointments), visits: num(r.visits) }, l, booking);
}

/**
 * Rebuild a PENDING officer notice nobody edited yet with the current wording
 * (no readiness tag; actions + a general reason). Returns false when it was
 * edited or already decided — those are left exactly as they are.
 */
export async function refreshPendingNotice(svc: Svc, actionId: string): Promise<boolean> {
  const { data, error } = await svc.from('ai_actions')
    .select('id, status, body, original_body, client_id, project_id, context').eq('id', actionId).maybeSingle();
  if (error) throw new Error(`notice read failed: ${error.message}`);
  const a = data as { id: string; status: string; body: string; original_body: string | null; client_id: string; project_id: string; context: Record<string, unknown> | null } | null;
  if (!a || a.status !== 'pending' || a.body !== a.original_body) return false;
  const [client, project] = await Promise.all([loadRecord(svc, a.client_id), loadRecord(svc, a.project_id)]);
  if (!client || !project) return false;
  const ctx = a.context ?? {};
  const strings = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []);
  const why = await interestWhy(svc, a.client_id, a.project_id, typeof ctx.client_chat_wid === 'string' ? ctx.client_chat_wid : null);
  const body = noticeBody({
    projectName: projectName(project), registered: ctx.registered === true, why, lowNames: strings(ctx.less_interest),
    clientName: str(client.data?.client_name).trim(), clientPhone: localPhone(str(client.data?.phone_number)), questions: strings(ctx.questions),
  });
  if (body === a.body) return false;
  const { error: uErr } = await svc.from('ai_actions').update({ body, original_body: body }).eq('id', a.id).eq('status', 'pending').eq('body', a.body);
  if (uErr) throw new Error(`notice refresh failed: ${uErr.message}`);
  return true;
}

export type OfficerQuestionResult =
  | { status: 'drafted' | 'appended'; action_id: string; officer_id: string }
  | { status: 'no_officer' | 'no_phone' | 'missing_record' | 'duplicate' };

/**
 * The customer asked something only the developer can answer — a discount, the
 * final price for cash, a payment arrangement — and the agent handed it off
 * (reason «negotiation»). The project's officer gets it as a DRAFT in the AI
 * tab (operator, 2026-10-04: "the questions regarding discounts … should be
 * notified to the officer with clarification of interest and the question").
 * The question is the customer's own words. A notice already waiting for this
 * client × officer gets the question added instead of a second message.
 */
export async function draftOfficerQuestion(
  svc: Svc,
  args: { clientId: string; projectId: string; clientChatWid: string; question: string; trigger?: 'negotiation_handoff' | 'visit_question' },
): Promise<OfficerQuestionResult> {
  const question = args.question.replace(/\s+/g, ' ').trim().slice(0, 300);
  if (!question) return { status: 'duplicate' };
  const [client, project] = await Promise.all([loadRecord(svc, args.clientId), loadRecord(svc, args.projectId)]);
  if (!client || !project) return { status: 'missing_record' };
  const officer = (await resolveProjectOfficers(svc, args.projectId))[0];
  if (!officer) return { status: 'no_officer' };
  const wid = officerChatWid(officer.phone);
  if (!wid) return { status: 'no_phone' };
  const qLine = `سؤال العميل: «${question}»`;

  const { data: open, error: oErr } = await svc.from('ai_actions')
    .select('id, body, context, status, created_at')
    .eq('kind', 'officer_notice').eq('officer_id', officer.id).eq('client_id', args.clientId)
    .in('status', ['pending', 'sent']).gte('created_at', new Date(Date.now() - 86_400_000).toISOString())
    .order('created_at', { ascending: false });
  if (oErr) throw new Error(`open officer notice read failed: ${oErr.message}`);
  const rows = (open ?? []) as Array<{ id: string; body: string; context: Record<string, unknown> | null; status: string }>;
  if (rows.some((r) => r.body.includes(question))) return { status: 'duplicate' };
  const pending = rows.find((r) => r.status === 'pending');
  if (pending) {
    const lines = pending.body.split('\n');
    const at = lines.findIndex((l) => l.startsWith('العميل:'));
    lines.splice(at >= 0 ? at : lines.length - 1, 0, qLine);
    const body = lines.join('\n');
    const questions = [...(Array.isArray(pending.context?.questions) ? pending.context!.questions as unknown[] : []), question];
    const { error: uErr } = await svc.from('ai_actions')
      .update({ body, original_body: body, context: { ...(pending.context ?? {}), questions } })
      .eq('id', pending.id).eq('status', 'pending');
    if (uErr) throw new Error(`officer notice update failed: ${uErr.message}`);
    return { status: 'appended', action_id: pending.id, officer_id: officer.id };
  }

  const registered = await isRegistered(svc, client, project);
  const clientName = str(client.data?.client_name).trim();
  const clientPhone = localPhone(str(client.data?.phone_number));
  const why = await interestWhy(svc, args.clientId, args.projectId, args.clientChatWid);
  const body = noticeBody({ projectName: projectName(project), registered, why, lowNames: [], clientName, clientPhone, questions: [question] });
  const { data: ins, error: insErr } = await svc.from('ai_actions').insert({
    kind: 'officer_notice', client_id: args.clientId, chat_wid: wid, project_id: args.projectId,
    officer_id: officer.id, phone: `+${wid.split('@')[0]}`, body, original_body: body,
    context: {
      client_name: clientName || null, client_chat_wid: args.clientChatWid, project_name: projectName(project),
      officer_name: officer.name, officer_coverage: officer.coverage, registered, questions: [question], trigger: args.trigger ?? 'negotiation_handoff',
    },
  }).select('id').single();
  if (insErr) throw new Error(`officer question insert failed: ${insErr.message}`);
  const actionId = (ins as { id: string }).id;
  const { error: refErr } = await svc.from('ai_actions').update({ reference: `officer_notice:${actionId}` }).eq('id', actionId);
  if (refErr) throw new Error(`officer question reference failed: ${refErr.message}`);
  return { status: 'drafted', action_id: actionId, officer_id: officer.id };
}

async function isRegistered(svc: Svc, client: Rec, project: Rec): Promise<boolean> {
  const portals = await resolvePortals(svc, client, project, { email: '', name: '', phone: '' });
  if (portals.length === 0) return false;
  const { data: regs, error } = await svc
    .from('client_portal_registrations').select('our_status')
    .eq('client_record_id', client.id).in('portal_record_id', portals.map((p) => p.id));
  if (error) throw new Error(`registration lookup failed: ${error.message}`);
  return ((regs ?? []) as { our_status: string | null }[]).some((r) => r.our_status === 'registered' || r.our_status === 'already_registered');
}
