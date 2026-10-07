/**
 * Registered in a portal → tell the project's officer, AUTOMATICALLY — no
 * approval (operator, 2026-10-07: "once a client is registered in the Al Ramz
 * portal, a message should go to the officer"). This is the one officer
 * message that does not wait in the AI tab; the high-interest notice
 * (officerNoticeDraft.ts) still does.
 *
 * Switched on per portal by its `notify_officer_on_register` checkbox, from
 * `notify_officer_since` on (set when it was switched on, so turning it on
 * never messages the officer about an old backlog), and never further back
 * than LOOKBACK_MS.
 *
 * One message per successful registration run (status 'done', kind
 * 'register'): the ai_actions row's reference «officer_notice:portal_job:<job>»
 * is UNIQUE, so two overlapping ticks queue it once. It goes out from the
 * OPERATIONS line only (never the sales line — same rule as an approved
 * notice), inside 09:00–21:00 Riyadh (a registration at 3 a.m. is delivered at
 * 9). Delivery is tracked by tg_ai_actions_job_sync like any officer notice.
 *
 * A registration we cannot announce (no officer covers the project, the
 * officer's phone is unusable, the run has no project) leaves a FAILED
 * ai_actions row saying why — visible in the AI tab, and the reference stops
 * the next tick from trying again. A missing operations line is left undone
 * (reported) so the next tick retries once the line is back.
 *
 * The text is a fixed formal template from facts only (the same blocks as the
 * interest notice — officerNoticeDraft.ts factLines / clientLines):
 *   السلام عليكم ورحمة الله وبركاته،
 *   نفيدكم بأننا سجّلنا لديكم في البوابة عميلاً جديداً مهتماً بمشروع «X».
 *   • سبب اهتمامه … / • تفاعله مع المشروع … / • موعد الزيارة …   (when known)
 *   بيانات العميل: الاسم / الجوال
 *   نأمل منكم التواصل معه، ولكم جزيل الشكر.
 */
import { type Rec, type Svc, LEAD_PORTALS_MODEL_ID, str, loadRecord } from './leadPortals.js';
import { resolveProjectOfficers } from './projectOfficers.js';
import { type InterestWhy, clientLines, factLines, interestWhy, localPhone, officerChatWid, projectName } from './officerNoticeDraft.js';

/** Never announce a registration older than this, whatever `notify_officer_since` says. */
export const LOOKBACK_MS = 48 * 3600_000;
const PER_TICK = 20;

export type RegistrationNoticeOutcome =
  | { job_id: string; status: 'queued'; action_id: string; officer_id: string; deliver_at: string }
  | { job_id: string; status: 'not_sent'; reason: string }
  | { job_id: string; status: 'would_send' };

/** The officer message for a registration. PURE. */
export function registrationNoticeBody(a: {
  projectName: string; why: InterestWhy; clientName: string; clientPhone: string;
}): string {
  const facts = factLines(a.why);
  return [
    'السلام عليكم ورحمة الله وبركاته،',
    '',
    `نفيدكم بأننا سجّلنا لديكم في البوابة عميلاً جديداً مهتماً بمشروع «${a.projectName}».`,
    ...(facts.length ? ['', ...facts] : []),
    '',
    ...clientLines(a.clientName, a.clientPhone),
    '',
    'نأمل منكم التواصل معه، ولكم جزيل الشكر.',
  ].join('\n');
}

/**
 * When the officer may get it: now inside 09:00–21:00 Riyadh, else the next
 * 09:00. Saudi Arabia is UTC+3 with no daylight saving. PURE.
 */
export function officerDeliverAt(now: Date): string {
  const local = new Date(now.getTime() + 3 * 3600_000);
  const h = local.getUTCHours();
  if (h >= 9 && h < 21) return now.toISOString();
  const nine = new Date(local);
  nine.setUTCHours(9, 0, 0, 0);
  if (h >= 21) nine.setUTCDate(nine.getUTCDate() + 1);
  return new Date(nine.getTime() - 3 * 3600_000).toISOString();
}

interface JobRow {
  id: string; portal_record_id: string; client_record_id: string | null; project_record_id: string | null;
  user_id: string | null; finished_at: string;
}

export async function sendRegistrationNotices(
  svc: Svc,
  opts: { dryRun: boolean; operationsDeviceId: () => Promise<string | null>; now?: Date },
): Promise<RegistrationNoticeOutcome[]> {
  const now = opts.now ?? new Date();
  const { data: portalRows, error: pErr } = await svc.from('unified_records').select('id, data').eq('model_id', LEAD_PORTALS_MODEL_ID);
  if (pErr) throw new Error(`portals load failed: ${pErr.message}`);
  const portals = ((portalRows ?? []) as Rec[]).filter((p) => p.data?.notify_officer_on_register === true && p.data?.is_active !== false);
  if (portals.length === 0) return [];

  const jobs: JobRow[] = [];
  for (const p of portals) {
    const floor = now.getTime() - LOOKBACK_MS;
    const since = Date.parse(str(p.data?.notify_officer_since));
    const from = new Date(Number.isFinite(since) ? Math.max(since, floor) : floor).toISOString();
    const { data, error } = await svc.from('portal_registration_jobs')
      .select('id, portal_record_id, client_record_id, project_record_id, user_id, finished_at')
      .eq('portal_record_id', p.id).eq('kind', 'register').eq('status', 'done')
      .gte('finished_at', from).order('finished_at', { ascending: true }).limit(PER_TICK);
    if (error) throw new Error(`registered jobs read failed: ${error.message}`);
    jobs.push(...((data ?? []) as JobRow[]));
  }
  if (jobs.length === 0) return [];

  const refOf = (jobId: string) => `officer_notice:portal_job:${jobId}`;
  const { data: seen, error: sErr } = await svc.from('ai_actions').select('reference').in('reference', jobs.map((j) => refOf(j.id)));
  if (sErr) throw new Error(`existing notices read failed: ${sErr.message}`);
  const done = new Set(((seen ?? []) as { reference: string }[]).map((r) => r.reference));

  const out: RegistrationNoticeOutcome[] = [];
  let ops: string | null | undefined;
  for (const job of jobs) {
    const reference = refOf(job.id);
    if (done.has(reference)) continue;
    if (opts.dryRun) { out.push({ job_id: job.id, status: 'would_send' }); continue; }

    // A registration we cannot announce → a FAILED row that says why (once).
    const notSent = async (clientId: string, reason: string, extra: Record<string, unknown> = {}): Promise<void> => {
      const { error } = await svc.from('ai_actions').insert({
        kind: 'officer_notice', status: 'failed', client_id: clientId, project_id: job.project_record_id,
        body: '', original_body: '', reference, error: reason,
        context: { trigger: 'portal_registered', portal_job_id: job.id, ...extra },
      });
      if (error && error.code !== '23505') throw new Error(`recording the unsent notice failed: ${error.message}`);
      out.push({ job_id: job.id, status: 'not_sent', reason });
    };

    // ai_actions needs a client; a run without one cannot even be recorded.
    if (!job.client_record_id) {
      console.error(`[officer-registration-notice] job ${job.id} has no client — nothing to announce`);
      out.push({ job_id: job.id, status: 'not_sent', reason: 'the registration has no client' });
      continue;
    }
    const clientId = job.client_record_id;
    if (!job.project_record_id) { await notSent(clientId, 'the registration has no project'); continue; }
    const [client, project] = await Promise.all([loadRecord(svc, clientId), loadRecord(svc, job.project_record_id)]);
    if (!client || !project) { await notSent(clientId, 'the client or the project record is gone'); continue; }
    const officer = (await resolveProjectOfficers(svc, project.id))[0];
    if (!officer) { await notSent(clientId, `no active officer covers «${projectName(project)}»`); continue; }
    const wid = officerChatWid(officer.phone);
    if (!wid) { await notSent(clientId, `officer ${officer.name} has an unusable phone (${officer.phone})`, { officer_id: officer.id }); continue; }

    // The line is checked once per tick; without it nothing is recorded, so
    // the next tick tries again.
    if (ops === undefined) ops = await opts.operationsDeviceId();
    if (!ops) throw new Error('no operations WhatsApp line is configured — registration notices wait for it');

    const chatWid = await clientChatWid(svc, client);
    const clientName = str(client.data?.client_name).trim();
    const clientPhone = localPhone(str(client.data?.phone_number));
    const why = await interestWhy(svc, client.id, project.id, chatWid);
    const body = registrationNoticeBody({ projectName: projectName(project), why, clientName, clientPhone });
    const deliverAt = officerDeliverAt(now);
    const stamp = new Date().toISOString();

    const { data: ins, error: insErr } = await svc.from('ai_actions').insert({
      kind: 'officer_notice', status: 'sending', client_id: client.id, chat_wid: wid, project_id: project.id,
      officer_id: officer.id, phone: `+${wid.split('@')[0]}`, device_id: ops, body, original_body: body,
      reference, decided_at: stamp,
      context: {
        trigger: 'portal_registered', auto_sent: true, portal_job_id: job.id, portal_id: job.portal_record_id,
        client_name: clientName || null, client_chat_wid: chatWid, project_name: projectName(project),
        officer_name: officer.name, officer_coverage: officer.coverage, registered: true, deliver_at: deliverAt,
      },
    }).select('id').single();
    if (insErr) {
      if (insErr.code === '23505') continue; // another tick took this registration first
      throw new Error(`registration notice insert failed: ${insErr.message}`);
    }
    const actionId = (ins as { id: string }).id;

    const { data: jobId, error: qErr } = await svc.rpc('scheduled_whatsapp_enqueue', {
      p_device_id: ops, p_chat_wid: wid, p_phone: `+${wid.split('@')[0]}`, p_body: body, p_media: null,
      p_reference: reference, p_deliver_at: deliverAt, p_user_id: null,
    });
    if (qErr && qErr.code !== '23505') {
      const { error: fErr } = await svc.from('ai_actions')
        .update({ status: 'failed', error: `could not queue: ${qErr.message}`, updated_at: new Date().toISOString() })
        .eq('id', actionId).eq('status', 'sending');
      if (fErr) console.error(`[officer-registration-notice] could not mark ${actionId} failed: ${fErr.message}`);
      throw new Error(`queueing the registration notice failed: ${qErr.message}`);
    }
    if (jobId) {
      const { error: uErr } = await svc.from('ai_actions').update({ scheduled_job_id: jobId as string, updated_at: new Date().toISOString() }).eq('id', actionId);
      if (uErr) console.error(`[officer-registration-notice] queued ${actionId} but could not store its job id: ${uErr.message}`);
    }
    out.push({ job_id: job.id, status: 'queued', action_id: actionId, officer_id: officer.id, deliver_at: deliverAt });
  }
  return out;
}

/** The client's WhatsApp chat (for the link-activity facts), if one is linked. */
async function clientChatWid(svc: Svc, client: Rec): Promise<string | null> {
  const { data, error } = await svc.from('models').select('id').eq('name', 'chats').maybeSingle();
  if (error) throw new Error(`chats model lookup failed: ${error.message}`);
  const chatsModel = (data as { id: string } | null)?.id;
  if (!chatsModel) return null;
  const { data: chat, error: cErr } = await svc.from('records').select('data')
    .eq('model_id', chatsModel)
    .or(`data->>client_link.eq.${client.id},data->client_link->>0.eq.${client.id}`)
    .order('updated_at', { ascending: false }).limit(1).maybeSingle();
  if (cErr) throw new Error(`client chat lookup failed: ${cErr.message}`);
  const wid = str((chat as { data?: Record<string, unknown> } | null)?.data?.wid);
  return wid || null;
}
