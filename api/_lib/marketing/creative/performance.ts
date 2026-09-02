/**
 * creative_performance — the content's live numbers (mos_content_performance_v:
 * publication count + latest-snapshot metric sums) plus the applied package
 * summary, so the creative tab can answer "did this package perform?".
 */
import { jsonOk, jsonError } from '../../auth.js';
import { cStr, requireSvc, type CreativeCtx } from './wake.js';

export async function creativePerformance(ctx: CreativeCtx): Promise<Response> {
  const svc = requireSvc(ctx);
  if (svc instanceof Response) return svc;
  const contentId = cStr(ctx.body.content_id);
  if (!contentId) return jsonError(400, 'content_id is required');

  // The view is granted to authenticated — read as the caller (RLS posture).
  const perf = await ctx.sb.from('mos_content_performance_v').select('*')
    .eq('content_id', contentId).maybeSingle();
  if (perf.error) {
    console.error('[creative] performance read failed', perf.error.code, perf.error.message);
    return jsonError(500, perf.error.message);
  }

  const applied = await svc.from('mos_creative_packages')
    .select('id, version, intended_use, applied_at, cost_usd, created_at')
    .eq('content_id', contentId).eq('stage', 'package').eq('status', 'applied')
    .order('version', { ascending: false }).limit(1).maybeSingle();
  if (applied.error) {
    console.error('[creative] applied package read failed', applied.error.code, applied.error.message);
    return jsonError(500, applied.error.message);
  }

  let derivative_count = 0;
  const pkg = applied.data as { id: string } | null;
  if (pkg) {
    const d = await svc.from('mos_creative_derivatives')
      .select('id', { count: 'exact', head: true }).eq('package_id', pkg.id);
    if (d.error) {
      console.error('[creative] derivative count failed', d.error.code, d.error.message);
    } else {
      derivative_count = d.count ?? 0;
    }
  }

  return jsonOk({
    performance: perf.data ?? null,
    package: applied.data ? { ...(applied.data as Record<string, unknown>), derivative_count } : null,
  });
}
