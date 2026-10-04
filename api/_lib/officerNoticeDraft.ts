/**
 * High interest → a DRAFT message to the project's officer, held in the AI tab
 * until the operator approves it (operator, 2026-10-04: nothing but portal
 * registration goes out on its own yet).
 *
 * The officer is told ONLY about a highly interested client — never because a
 * client was registered. The text is a fixed template, so nothing in it can be
 * invented:
 *   السلام عليكم،
 *   عندنا عميل مهتم كثير بمشروع «X» (على الخارطة)، وهو مسجّل عندكم في البوابة.
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
import { resolveProjectDelivery } from '../../src/lib/projectMessage/delivery.js';

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

  const delivery = resolveProjectDelivery(project.data ?? {});
  const readiness = delivery.kind === 'off_plan' ? ' (على الخارطة)' : delivery.kind === 'ready' ? ' (جاهز)' : '';
  const clientName = str(client.data?.client_name).trim();
  const clientPhone = localPhone(str(client.data?.phone_number));
  const lines = [
    'السلام عليكم،',
    `عندنا عميل مهتم كثير بمشروع «${projectName(project)}»${readiness}${registered ? '، وهو مسجّل عندكم في البوابة' : ''}.`,
    ...(lowNames.length ? [`اهتمامه أقل بـ«${lowNames.join('» و«')}».`] : []),
    `العميل: ${clientName || '—'}${clientPhone ? ` — رقمه: ${clientPhone}` : ''}`,
    'نتمنى تتواصلون معه، ويعطيك العافية.',
  ];
  const body = lines.join('\n');

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
