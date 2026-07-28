/**
 * Run the EXACT PostgREST selects that api/marketing-mgmt.ts sends, against the
 * live database, and report the status of each.
 *
 * Reading a select string and believing it is valid is how the last round of
 * bugs survived review: an ambiguous embed (two foreign keys from the same child
 * table) and a column that does not exist both look completely fine on the page.
 * Only PostgREST can settle it.
 *
 *   node scripts/check-mkt-portfolio-embeds.mjs
 */
import { readFileSync } from 'node:fs';
import { createClient } from '@supabase/supabase-js';

function env(name, ...alts) {
  for (const k of [name, ...alts]) if (process.env[k]) return process.env[k];
  for (const f of ['.env.local', '.env']) {
    try {
      const line = readFileSync(f, 'utf8').split(/\r?\n/)
        .find((l) => [name, ...alts].some((k) => l.startsWith(`${k}=`)));
      // Values in this repo's env files are quoted; an unstripped quote turns
      // into "Invalid supabaseUrl", which reads like a wrong URL rather than a
      // parsing bug in this script.
      if (line) return line.slice(line.indexOf('=') + 1).trim().replace(/^["']|["']$/g, '');
    } catch { /* the file simply is not there; try the next one */ }
  }
  return null;
}

const url = env('SUPABASE_URL', 'VITE_SUPABASE_URL');
const key = env('SUPABASE_SERVICE_ROLE_KEY', 'VITE_SUPABASE_ANON_KEY');
if (!url || !key) { console.error('missing SUPABASE_URL / key'); process.exit(1); }
const sb = createClient(url, key, { auth: { persistSession: false } });

/** [label, table, select] — copied verbatim from the endpoint. */
const SELECTS = [
  ['portfolio_map.plans', 'mkt_plans',
    'id,name_ar,name_en,plan_type,status,period_start,period_end,strategy_version_id,owner_user_id,needs_classification'],
  ['portfolio_map.strategies', 'mkt_strategy_versions',
    'id,version_number,name_ar,name_en,status,effective_date,approved_at'],
  ['portfolio_map.goals', 'mkt_goals',
    'id,plan_id,goal_class,goal_category,name_ar,name_en,metric,unit,target_value,actual_value,status,owner_user_id,parent_goal_id'],
  ['portfolio_map.initiatives', 'mkt_initiatives', '*'],
  ['portfolio_map.programs', 'mkt_programs', '*'],
  ['portfolio_map.campaigns', 'mkt_internal_campaigns',
    '*, mkt_internal_campaign_projects(project_id), mkt_content_items!campaign_id(id,status)'],
  ['portfolio_map.program_output', 'mkt_content_items',
    'id,status,origin_program_id,created_at,planned_publish_at'],
  ['portfolio_list.initiatives', 'mkt_initiatives',
    '*, mkt_programs(id,name_ar,status), mkt_internal_campaigns(id,code,name_ar,campaign_class,status)'],
  ['detail.initiative.secondary', 'mkt_activity_goals', '*'],
  ['detail.initiative.projects', 'mkt_initiative_projects', 'project_id'],
  ['detail.campaign.projects', 'mkt_internal_campaign_projects', 'project_id'],
  ['detail.campaign.content', 'mkt_content_items',
    'id,content_number,title,content_type,status,due_date'],
  ['detail.campaign.perf', 'mkt_performance_snapshots', '*'],
  ['detail.decisions', 'mkt_review_decisions', '*'],
  ['planning_overview.plans', 'mkt_plans',
    '*, mkt_goals(id,plan_id,goal_class,goal_category,name_ar,unit,target_value,actual_value,result,status,needs_classification)'],
];

/** [label, fn, args] — RPCs the endpoint calls. */
const RPCS = [
  ['mkt_campaign_missing_requirements', { p_campaign_id: null }],
  ['mkt_program_missing_requirements', { p_program_id: null }],
  ['mkt_initiative_missing_requirements', { p_initiative_id: null }],
  ['mkt_next_campaign_code', {}],
];

let failed = 0;

for (const [label, table, select] of SELECTS) {
  const { error } = await sb.from(table).select(select).limit(1);
  if (error) {
    failed++;
    console.log(`FAIL  ${label}\n      ${error.code ?? ''} ${error.message}`);
  } else {
    console.log(`ok    ${label}`);
  }
}

for (const [fn, args] of RPCS) {
  const { error } = await sb.rpc(fn, args);
  // A null argument is a legitimate call that returns nothing; only a missing
  // function or a wrong signature is a failure here.
  if (error && (error.code === 'PGRST202' || /does not exist/i.test(error.message))) {
    failed++;
    console.log(`FAIL  rpc ${fn}\n      ${error.code ?? ''} ${error.message}`);
  } else {
    console.log(`ok    rpc ${fn}${error ? ` (returned ${error.code})` : ''}`);
  }
}

console.log(failed === 0 ? '\nALL SELECTS AND RPCS RESOLVE' : `\n${failed} FAILED`);
process.exit(failed === 0 ? 0 : 1);
