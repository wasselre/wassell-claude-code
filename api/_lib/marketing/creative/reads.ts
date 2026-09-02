/**
 * Design-read + creative-backfill intelligence actions — served from
 * api/marketing.ts (the Marketing Intelligence endpoint), same posture as its
 * siblings: reads go through the service client (the route is the gate, like
 * content_library); creative_backfill_control is admin-gated by the dispatch
 * block (like run_*).
 *
 * NOTE on the control payload: the op travels as `op`, not `action` — `action`
 * is the endpoint's own dispatch envelope key, so the contract's literal
 * `{kind, action:'start'|'pause'|'resume'}` would collide with it (deviation
 * recorded in the A-API report).
 */
import { jsonOk, jsonError } from '../../auth.js';
import { cStr, requireSvc, type CreativeCtx } from './wake.js';

const READ_SUBJECT_KINDS = new Set(['competitor_media', 'competitor_post', 'wassel_file', 'wassel_content']);
const BACKFILL_KINDS = new Set(['design_reads', 'asset_meta', 'asset_enrich']);

export async function designReadGet(ctx: CreativeCtx): Promise<Response> {
  const svc = requireSvc(ctx);
  if (svc instanceof Response) return svc;
  const subjectKind = cStr(ctx.body.subject_kind);
  const subjectId = cStr(ctx.body.subject_id);
  if (!subjectKind || !READ_SUBJECT_KINDS.has(subjectKind)) {
    return jsonError(400, 'subject_kind must be competitor_media | competitor_post | wassel_file | wassel_content');
  }
  if (!subjectId) return jsonError(400, 'subject_id is required');
  const res = await svc.from('visual_design_reads').select('*')
    .eq('subject_kind', subjectKind).eq('subject_id', subjectId)
    .order('created_at', { ascending: false }).limit(50);
  if (res.error) {
    console.error('[creative] design_read_get failed', res.error.code, res.error.message);
    return jsonError(500, res.error.message);
  }
  return jsonOk({ reads: res.data ?? [] });
}

export async function designReadsStatus(ctx: CreativeCtx): Promise<Response> {
  const svc = requireSvc(ctx);
  if (svc instanceof Response) return svc;
  const count = async (level: string, status: string): Promise<number> => {
    const r = await svc.from('visual_design_reads')
      .select('id', { count: 'exact', head: true }).eq('level', level).eq('status', status);
    if (r.error) {
      console.error('[creative] design_reads_status count failed', r.error.code, r.error.message);
      return 0;
    }
    return r.count ?? 0;
  };
  const [slideDone, postDone, failed] = await Promise.all([
    count('slide', 'done'), count('post', 'done'), count('slide', 'failed').then(async (s) => s + (await count('post', 'failed'))),
  ]);
  const last = await svc.from('visual_design_reads').select('created_at')
    .order('created_at', { ascending: false }).limit(1).maybeSingle();
  if (last.error) {
    console.error('[creative] design_reads_status last-read failed', last.error.code, last.error.message);
  }
  const cfg = await svc.from('mos_settings').select('value').eq('key', 'creative_backfill').maybeSingle();
  if (cfg.error) {
    console.error('[creative] design_reads_status config read failed', cfg.error.code, cfg.error.message);
  }
  const config = ((cfg.data as { value?: Record<string, unknown> } | null)?.value ?? {}) as Record<string, unknown>;
  return jsonOk({
    status: {
      slide_done: slideDone,
      post_done: postDone,
      failed,
      last_read_at: (last.data as { created_at: string } | null)?.created_at ?? null,
      design_reads_config: config.design_reads ?? null,
    },
  });
}

export async function creativeBackfillStatus(ctx: CreativeCtx): Promise<Response> {
  const svc = requireSvc(ctx);
  if (svc instanceof Response) return svc;
  const [cfg, runs] = await Promise.all([
    svc.from('mos_settings').select('value').eq('key', 'creative_backfill').maybeSingle(),
    svc.from('creative_backfill_runs').select('*')
      .order('started_at', { ascending: false }).limit(20),
  ]);
  if (cfg.error || runs.error) {
    const e = cfg.error ?? runs.error;
    console.error('[creative] backfill status read failed', e?.code, e?.message);
    return jsonError(500, e?.message ?? 'read failed');
  }
  return jsonOk({
    backfill: {
      config: (cfg.data as { value?: Record<string, unknown> } | null)?.value ?? {},
      runs: runs.data ?? [],
    },
  });
}

export async function creativeBackfillControl(ctx: CreativeCtx): Promise<Response> {
  const svc = requireSvc(ctx);
  if (svc instanceof Response) return svc;
  const kind = cStr(ctx.body.kind);
  const op = cStr(ctx.body.op);
  if (!kind || !BACKFILL_KINDS.has(kind)) {
    return jsonError(400, 'kind must be design_reads | asset_meta | asset_enrich');
  }
  if (op !== 'start' && op !== 'pause' && op !== 'resume') {
    return jsonError(400, "op must be 'start' | 'pause' | 'resume'");
  }

  const cfgRes = await svc.from('mos_settings').select('value').eq('key', 'creative_backfill').maybeSingle();
  if (cfgRes.error) {
    console.error('[creative] backfill config read failed', cfgRes.error.code, cfgRes.error.message);
    return jsonError(500, cfgRes.error.message);
  }
  const config = (((cfgRes.data as { value?: Record<string, unknown> } | null)?.value ?? {}) as Record<string, unknown>);
  const lane = { ...((config[kind] as Record<string, unknown> | undefined) ?? {}) };

  if (op === 'pause') {
    lane.enabled = false;
    lane.paused_at = new Date().toISOString();
  } else {
    lane.enabled = true;
    lane.paused_at = null;
    if (op === 'start' && typeof ctx.body.tier === 'number' && Number.isInteger(ctx.body.tier)) {
      lane.tiers = [ctx.body.tier];
    }
  }
  const next = { ...config, [kind]: lane };
  const upd = await svc.from('mos_settings').upsert({
    key: 'creative_backfill', value: next, updated_at: new Date().toISOString(),
  });
  if (upd.error) {
    console.error('[creative] backfill config write failed', upd.error.code, upd.error.message);
    return jsonError(500, upd.error.message);
  }
  return jsonOk({ backfill: { config: next } });
}

export async function wasselInternalStatus(ctx: CreativeCtx): Promise<Response> {
  const svc = requireSvc(ctx);
  if (svc instanceof Response) return svc;
  const org = await svc.from('mkt_organizations')
    .select('id, org_type, name_ar, name_en, website, status')
    .eq('name_en', 'Wassel Real Estate').eq('org_type', 'internal').maybeSingle();
  if (org.error) {
    console.error('[creative] wassel org read failed', org.error.code, org.error.message);
    return jsonError(500, org.error.message);
  }
  if (!org.data) return jsonOk({ wassel: { registered: false, org: null, accounts: [], posts: 0, media_stored: 0 } });

  const orgId = (org.data as { id: string }).id;
  const [accounts, posts, media] = await Promise.all([
    svc.from('mkt_social_accounts')
      .select('id, platform, handle, profile_url, is_active, collection_enabled, scrape_status, followers, last_synced_at')
      .eq('organization_id', orgId),
    svc.from('mkt_content_posts').select('id', { count: 'exact', head: true }).eq('organization_id', orgId),
    svc.from('mkt_content_media')
      .select('id, mkt_content_posts!inner(organization_id)', { count: 'exact', head: true })
      .eq('mkt_content_posts.organization_id', orgId).eq('download_status', 'stored'),
  ]);
  if (accounts.error || posts.error || media.error) {
    const e = accounts.error ?? posts.error ?? media.error;
    console.error('[creative] wassel status reads failed', e?.code, e?.message);
    return jsonError(500, e?.message ?? 'read failed');
  }
  return jsonOk({
    wassel: {
      registered: true,
      org: org.data,
      accounts: accounts.data ?? [],
      posts: posts.count ?? 0,
      media_stored: media.count ?? 0,
    },
  });
}
