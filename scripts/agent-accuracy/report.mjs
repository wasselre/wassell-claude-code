/**
 * Score a run of scripts/agent-accuracy/run.mts.
 * Usage: node scripts/agent-accuracy/report.mjs <run.json> <report.md>
 */
import fs from 'node:fs';
const rs = JSON.parse(fs.readFileSync(process.argv[2], 'utf8')).sort((a, b) => a.id.localeCompare(b.id));
const L = [];
const AR = '٠١٢٣٤٥٦٧٨٩';
function prices(text) {
  const t = text.replace(/[٠-٩]/g, (d) => String(AR.indexOf(d))).replace(/,/g, '');
  const out = [];
  // [N] مليون [و (نص|ربع|M)] · 1.04M · N ألف · 1234567
  const re = /(\d+(?:\.\d+)?)?\s*مليون(?:ين)?(?:\s*و\s*(نص|ربع|\d+))?|(\d+(?:\.\d+)?)\s*M\b|(\d+(?:\.\d+)?)\s*(?:ألف|الف|آلاف|الاف|k\b)|(\d{6,})/gi;
  const extra = (x) => (!x ? 0 : x === 'نص' ? 500000 : x === 'ربع' ? 250000 : parseInt(x, 10) < 1000 ? parseInt(x, 10) * 1000 : parseInt(x, 10));
  let m;
  while ((m = re.exec(t))) {
    if (m[0].includes('مليون')) out.push((m[1] ? parseFloat(m[1]) : m[0].includes('مليونين') ? 2 : 1) * 1e6 + extra(m[2]));
    else if (m[3]) out.push(parseFloat(m[3]) * 1e6);
    else if (m[4]) out.push(parseFloat(m[4]) * 1000);
    else if (m[5]) out.push(parseInt(m[5], 10));
  }
  return out;
}
let pass = 0;
for (const r of rs) {
  const g = r.got, t = r.truth;
  let verdict;
  const searched = r.turns[0]?.tools.some((x) => x.startsWith('search')) ?? false;
  // Naming a cheaper/closest project is fine when the agent says plainly that
  // nothing fits; SENDING something as if it fit is the failure.
  const honest = r.turns.some((tu) => tu.replies.some((x) => /ما عندنا|للأسف|مع الأسف|don't have|do not have/i.test(x)));
  if (r.level === 'none') verdict = g.sent_units || g.sent_projects.length || (g.wrong_projects.length && !honest) ? 'FAIL (offered something that does not fit)' : searched ? 'PASS' : 'ASKED BEFORE SEARCHING';
  else if (r.question) {
    const q = r.turns.flatMap((tu) => tu.replies.flatMap(prices));
    verdict = g.wrong_units ? `WRONG units: ${g.wrong_units}` : q.some((p) => Math.abs(p - t.price_range[0]) <= t.price_range[0] * 0.005) ? 'PASS' : `ANSWER — did not quote the right price ${t.price_range[0]}`;
  }
  else if (r.level === 'project') {
    const recallOk = t.projects.length > 3 || t.projects.every((p) => g.hit_projects.includes(p));
    verdict = g.wrong_projects.length ? `WRONG project(s): ${g.wrong_projects.join('، ')}` : !g.hit_projects.length ? 'MISSED — found nothing right' : recallOk ? 'PASS' : `PARTIAL — missed ${t.projects.filter((p) => !g.hit_projects.includes(p)).join('، ')}`;
  } else {
    verdict = g.wrong_units ? `WRONG units: ${g.wrong_units} sent that do not fit` : g.wrong_projects.length ? `WRONG project: ${g.wrong_projects.join('، ')}` : g.sent_units ? (g.missed_units ? `PARTIAL — sent ${g.sent_units}/${t.units === undefined ? '?' : (t.unit_ids ?? []).length}` : 'PASS') : 'NO UNITS SENT — check reply';
  }
  if (r.level !== 'none' && t.price_range) {
    const quoted = r.turns.slice(r.messages_scripted ? r.messages_scripted - 1 : 0).flatMap((tu) => tu.replies.flatMap(prices)).filter((p) => p >= 100000);
    const below = quoted.filter((p) => p < t.price_range[0] * 0.995);
    if (below.length) verdict = (verdict === 'PASS' ? 'PRICE' : verdict + ' + PRICE') + ` — quoted ${below.join(', ')} below the cheapest fitting unit ${t.price_range[0]}`;
  }
  if (verdict === 'PASS') pass++;
  L.push(`## ${r.id} ${r.title} — ${verdict}${r.nudged ? ' (needed a nudge)' : ''}`);
  L.push(`truth: ${t.projects.join('، ') || '(nothing)'} · ${t.units} units${t.price_range ? ` · ${t.price_range[0]}–${t.price_range[1]}` : ''}${t.cheapest ? ` · cheapest ${JSON.stringify(t.cheapest)}` : ''}`);
  L.push(`got: named [${g.named.join('، ')}] · sent [${g.sent_projects.join('، ')}] · units sent ${g.sent_units} (wrong ${g.wrong_units}, missed ${g.missed_units})`);
  for (const tu of r.turns) {
    L.push(`> C: ${tu.customer}`);
    L.push(`> tools: ${tu.tools.join(' ; ')}`);
    L.push(`> A (${tu.secs}s): ${tu.replies.join(' / ')}`);
  }
  L.push('');
}
L.unshift(`# Retrieval accuracy — ${pass}/${rs.length} clean PASS\n`);
fs.writeFileSync(process.argv[3], L.join('\n'), 'utf8');
console.log(`${pass}/${rs.length}`);
