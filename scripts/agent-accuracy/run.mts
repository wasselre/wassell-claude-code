/**
 * Sales-agent RETRIEVAL accuracy test (dry run — nothing is sent or saved).
 *
 * Every scenario carries a predicate over the REAL available inventory. The
 * truth set (units → projects) is computed here, straight from the database,
 * independently of the agent's catalog/units code. The agent then runs on the
 * scripted customer messages, and we score what it NAMED, SENT and which UNITS
 * it sent against that truth.
 *
 * Usage (from the repo root; spends real Opus calls, ~$1–2 a run):
 *   npx tsx scripts/agent-accuracy/run.mts <out.json>      — all scenarios
 *   ONLY=S01,U03 npx tsx scripts/agent-accuracy/run.mts …   — a subset
 *   TRUTH_ONLY=1 npx tsx scripts/agent-accuracy/run.mts x   — print the truth sets, no model calls
 *   node scripts/agent-accuracy/report.mjs <out.json> <report.md>
 *
 * Scenarios are written against the LIVE inventory (2026-10-01). When units
 * sell, a truth set shrinks on its own; when a project's last fitting unit
 * sells, rewrite that scenario rather than accepting a "nothing fits" PASS.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
for (const f of ['.env.local', '.env']) {
  try { for (const l of readFileSync(f, 'utf8').split(/\r?\n/)) { const m = l.match(/^([A-Z0-9_]+)=(.*)$/); if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^"|"$/g, ''); } } catch (e) { console.error(`env ${f}:`, (e as Error).message); }
}
const root = process.cwd();
const { getServiceSupabase } = await import(pathToFileURL(`${root}/api/_lib/supabaseServer.ts`).href);
const { runAgentTurn } = await import(pathToFileURL(`${root}/api/_lib/salesAgent/turn.ts`).href);
const svc = getServiceSupabase();

// ── Inventory (ground truth source) ─────────────────────────────────────────
type Unit = { id: string; projectId: string; type: string; bedrooms: number | null; price: number | null; area: number | null; floor: string; code: string | null };
type Proj = { id: string; name: string; district: string | null; city: string | null; zone: string | null; ready: boolean };

const num = (v: unknown) => { const n = typeof v === 'number' ? v : parseFloat(String(v ?? '').replace(/,/g, '')); return Number.isFinite(n) ? n : null; };
const TYPE: Array<[RegExp, string]> = [[/تاون/, 'تاون هاوس'], [/دبلكس|دوبلكس/, 'دبلكس'], [/فيلا|فله|فلة/, 'فيلا'], [/بنتهاوس|بنت هاوس/, 'بنتهاوس'], [/استوديو/, 'استوديو'], [/^دور|أدوار|ادوار/, 'دور'], [/شق/, 'شقة']];
const normType = (t: string) => { for (const [re, v] of TYPE) if (re.test(t)) return v; return t.trim(); };
const normFloor = (f: string) => {
  const t = f.trim().replace(/^ال/, '').replace(/^دور\s+/, '');
  if (/ارضي|أرضي/.test(t)) return 'ارضي';
  if (/روف|سطح/.test(t)) return 'روف';
  if (/^(اول|أول)$/.test(t)) return '1';
  if (/^ثاني$/.test(t)) return '2';
  if (/^ثالث$/.test(t)) return '3';
  return t;
};

async function loadAll<T>(q: (from: number) => PromiseLike<{ data: T[] | null; error: { message: string } | null }>): Promise<T[]> {
  const out: T[] = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await q(from);
    if (error) throw new Error(error.message);
    out.push(...(data ?? []));
    if (!data || data.length < 1000) break;
  }
  return out;
}

const { data: models, error: mErr } = await svc.from('models').select('id, name').in('name', ['our_projects', 'all_projects', 'units']);
if (mErr) throw new Error(mErr.message);
const mid = (n: string) => (models ?? []).find((m: { name: string }) => m.name === n)!.id as string;
const ours = await loadAll<{ data: { project?: string } }>((f) => svc.from('records').select('data').eq('model_id', mid('our_projects')).order('id').range(f, f + 999));
const projIds = [...new Set(ours.map((o) => o.data?.project).filter((x): x is string => typeof x === 'string' && /^[0-9a-f-]{36}$/i.test(x)))];
const projRows = await loadAll<{ id: string; data: Record<string, unknown> }>((f) => svc.from('records').select('id, data').in('id', projIds).order('id').range(f, f + 999));
const distIds = [...new Set(projRows.map((p) => (p.data.location as { district?: string } | undefined)?.district).filter((x): x is string => !!x))];
const { data: dists, error: dErr } = await svc.from('districts').select('id, name_ar').in('id', distIds);
if (dErr) throw new Error(dErr.message);
const distName = new Map((dists ?? []).map((d: { id: string; name_ar: string }) => [d.id, d.name_ar]));
const zoneOf = new Map<string, string>();
for (const z of ['north', 'south', 'east', 'west', 'center']) {
  const { data, error } = await svc.rpc('wassell_city_zone_districts', { p_city: 'الرياض', p_zone: z });
  if (error) throw new Error(error.message);
  for (const r of (data ?? []) as Array<{ district_name: string }>) if (!zoneOf.has(r.district_name)) zoneOf.set(r.district_name, z);
}
const projects = new Map<string, Proj>();
for (const p of projRows) {
  const d = p.data;
  const district = distName.get(String((d.location as { district?: string } | undefined)?.district ?? '')) ?? null;
  const city = typeof d.city_name === 'string' && d.city_name.trim() ? d.city_name.trim() : null;
  const cs = String(d.construction_status ?? '').toLowerCase(); const ps = String(d.project_status ?? '').toLowerCase();
  const inRiyadh = city === 'الرياض' || (city === null && !!district && zoneOf.has(district));
  projects.set(p.id, {
    id: p.id, name: String(d.project_name ?? d.name ?? p.id), district, city: inRiyadh ? 'الرياض' : city,
    zone: inRiyadh && district ? zoneOf.get(district) ?? null : null,
    ready: cs === 'ready' || cs === 'جاهز' || ps === 'available' || ps === 'ready',
  });
}
const unitRows = await loadAll<{ id: string; data: Record<string, unknown> }>((f) => svc.from('records').select('id, data').eq('model_id', mid('units')).in('data->>project_id', projIds).order('id').range(f, f + 999));
const AVAILABLE = new Set(["available", "متاح", "متاحة", "متوفر", "متوفرة"]);
const units: Unit[] = unitRows
  .filter((u) => AVAILABLE.has(String(u.data.unit_status ?? '').trim().toLowerCase()))
  .map((u) => ({
    id: u.id, projectId: String(u.data.project_id), type: normType(String(u.data.unit_type ?? '')),
    bedrooms: num(u.data.bedrooms), price: num(u.data.total_price), area: num(u.data.unit_area) ?? num(u.data.total_area),
    floor: normFloor(String(u.data.floor ?? '')), code: (u.data.unit_code as string) ?? (u.data.unit_number as string) ?? null,
  }));
console.log(`inventory: ${projects.size} projects, ${units.length} available units`);

// ── Scenarios ───────────────────────────────────────────────────────────────
type P = (u: Unit, p: Proj) => boolean;
const inD = (d: string): P => (_u, p) => (p.district ?? '').replace(/^حي\s+/, '') === d;
const zone = (z: string): P => (_u, p) => p.zone === z;
const riyadh: P = (_u, p) => p.city === 'الرياض';
const city = (c: string): P => (_u, p) => p.city === c;
const type = (t: string): P => (u) => u.type === t;
const beds = (b: number): P => (u) => u.bedrooms === b;
const maxP = (x: number): P => (u) => u.price !== null && u.price <= x;
const minA = (x: number): P => (u) => u.area !== null && u.area >= x;
const ready: P = (_u, p) => p.ready;
const proj = (name: string): P => (_u, p) => p.name === name;
const all = (...ps: P[]): P => (u, p) => ps.every((f) => f(u, p));

interface Scenario {
  id: string; title: string; messages: string[]; where: P;
  /** units: the agent should send/quote exactly the matching units of one project; cheapest: only the cheapest one(s). */
  level: 'project' | 'units' | 'cheapest' | 'none';
  /** A unit QUESTION (answer with the right numbers) rather than a request to send. */
  question?: boolean;
}
const S: Scenario[] = [
  { id: 'S01', title: 'Ready villa in Narjis ≤3M', level: 'project', messages: ['السلام عليكم، ابي فيلا جاهزة في حي النرجس، ميزانيتي ما تتعدى ٣ مليون'], where: all(inD('النرجس'), type('فيلا'), ready, maxP(3_000_000)) },
  { id: 'S02', title: 'دور 3BR north ≤1.5M', level: 'project', messages: ['ابغى دور ٣ غرف بشمال الرياض، ما ابي ادفع فوق مليون ونص'], where: all(zone('north'), type('دور'), beds(3), maxP(1_500_000)) },
  { id: 'S03', title: '2BR apartment in Malqa', level: 'project', messages: ['عندكم شقة غرفتين في الملقا؟'], where: all(inD('الملقا'), type('شقة'), beds(2)) },
  { id: 'S04', title: 'Townhouse 4BR Riyadh ≤1.4M', level: 'project', messages: ['ابي تاون هاوس ٤ غرف بالرياض، حدي مليون و٤٠٠'], where: all(riyadh, type('تاون هاوس'), beds(4), maxP(1_400_000)) },
  { id: 'S05', title: 'Ready 3BR apt Riyadh <1M', level: 'project', messages: ['ابي شقة جاهزة ٣ غرف بالرياض بأقل من مليون'], where: all(riyadh, type('شقة'), beds(3), ready, maxP(1_000_000)) },
  { id: 'S06', title: 'Jeddah 3BR apt', level: 'project', messages: ['عندكم مشاريع بجدة؟ ابي شقة ٣ غرف'], where: all(city('جدة'), type('شقة'), beds(3)) },
  { id: 'S07', title: '2BR center ≤700k', level: 'project', messages: ['ابي شقة غرفتين وسط الرياض، ميزانيتي ٧٠٠ ألف'], where: all(zone('center'), type('شقة'), beds(2), maxP(700_000)) },
  { id: 'S08', title: '5BR villa Riyadh', level: 'project', messages: ['ابي فيلا ٥ غرف نوم بالرياض'], where: all(riyadh, type('فيلا'), beds(5)) },
  { id: 'S09', title: 'Apt ≥200m² north', level: 'project', messages: ['ابي شقة واسعة، مساحتها ٢٠٠ متر وفوق، بشمال الرياض'], where: all(zone('north'), type('شقة'), minA(200)) },
  { id: 'S10', title: 'Any duplex', level: 'project', messages: ['عندكم دبلكس بالرياض؟'], where: all(riyadh, type('دبلكس')) },
  { id: 'S11', title: 'TRAP villa ≤800k', level: 'none', messages: ['ابي فيلا بالرياض بـ ٨٠٠ ألف'], where: all(riyadh, type('فيلا'), maxP(800_000)) },
  { id: 'S12', title: 'TRAP 4BR apartment', level: 'none', messages: ['ابي شقة ٤ غرف بالرياض'], where: all(riyadh, type('شقة'), beds(4)) },
  { id: 'U01', title: 'Safa 82 townhouse 3BR', level: 'units', messages: ['مهتم بصفا 82، ابي تاون هاوس ٣ غرف، وش المتاح؟ ارسل لي الوحدات'], where: all(proj('صفا 82'), type('تاون هاوس'), beds(3)) },
  { id: 'U02', title: 'Majdiya 163 cheapest 3BR on 1st floor', level: 'cheapest', question: true, messages: ['الماجدية 163، وش أرخص شقة ٣ غرف بالدور الأول؟'], where: all(proj('الماجدية 163'), beds(3), (u) => u.floor === '1') },
  { id: 'U03', title: 'Aknan 23 3BR <900k', level: 'units', messages: ['أكنان 23، ابي شقة ٣ غرف تحت ٩٠٠ ألف، ارسل لي الوحدات'], where: all(proj('أكنان 23'), type('شقة'), beds(3), maxP(900_000)) },
  { id: 'U04', title: 'Tal Al-Rabwa 2BR roof', level: 'units', question: true, messages: ['تل الربوة، عندكم شقة غرفتين بالروف؟ كم سعرها؟'], where: all(proj('تل الربوة'), beds(2), (u) => u.floor === 'روف') },
  { id: 'U05', title: 'Makana above floor 15', level: 'units', messages: ['مكانة، ابي شقة بدور عالي فوق الدور ١٥، ارسل لي اللي عندك'], where: all(proj('مكانة'), (u) => (num(u.floor) ?? 0) > 15) },
  { id: 'U06', title: 'Safa 83 1BR ≤600k', level: 'units', messages: ['صفا 83، ابي غرفة وحدة بحدود ٦٠٠ ألف، ارسلها لي'], where: all(proj('صفا 83'), beds(1), maxP(600_000)) },
  { id: 'U07', title: 'Majdiya 174 3BR ≥150m² ≤1.8M', level: 'units', question: true, messages: ['الماجدية 174، ابي ٣ غرف مساحتها ١٥٠ متر وفوق، وميزانيتي مليون و٨٠٠'], where: all(proj('الماجدية 174'), beds(3), minA(150), maxP(1_800_000)) },
  { id: 'U08', title: 'Sawari Mujabbab 2BR floor', level: 'units', messages: ['سواري مجبب، عندكم دور غرفتين؟ ارسل لي الخيارات'], where: all(proj('سواري مجبب'), type('دور'), beds(2)) },
  { id: 'X01', title: 'Ready 3BR Narjis ≤1.5M', level: 'project', messages: ['ابي شقة ٣ غرف بالنرجس، جاهزة، تحت مليون ونص'], where: all(inD('النرجس'), type('شقة'), beds(3), ready, maxP(1_500_000)) },
  { id: 'X02', title: 'Multi-turn: 3BR north → ready ≤1.25M', level: 'project', messages: ['ابي شقة ٣ غرف شمال الرياض', 'ابيها جاهزة، وميزانيتي مليون وربع بالكثير'], where: all(zone('north'), type('شقة'), beds(3), ready, maxP(1_250_000)) },
  { id: 'X03', title: 'Multi-turn: townhouse Narjis → 4BR ≤2M', level: 'project', messages: ['ابي تاون هاوس بالنرجس', '٤ غرف، وما ابي ادفع فوق ٢ مليون'], where: all(inD('النرجس'), type('تاون هاوس'), beds(4), maxP(2_000_000)) },
  { id: 'X04', title: 'English: ready 2BR north <1.1M', level: 'project', messages: ['Hi, I am looking for a ready 2-bedroom apartment in north Riyadh under 1.1M'], where: all(zone('north'), type('شقة'), beds(2), ready, maxP(1_100_000)) },
];

// ── Scoring helpers ─────────────────────────────────────────────────────────
const AR_DIGITS = '٠١٢٣٤٥٦٧٨٩';
const norm = (s: string) => s.replace(/[٠-٩]/g, (d) => String(AR_DIGITS.indexOf(d))).replace(/[ًٌٍَُِّْـ]/g, '').replace(/[أإآ]/g, 'ا').replace(/ة/g, 'ه').replace(/\s+/g, ' ').toLowerCase();
const aliasOf = (name: string) => [...new Set([name, name.replace(/\s*\(.*?\)\s*/g, ''), name.split(' - ')[0]].map((x) => norm(x.trim())).filter((x) => x.length >= 3))];
const projList = [...projects.values()];
function namedIn(text: string): Set<string> {
  const t = norm(text);
  const out = new Set<string>();
  // Longest aliases first so «صفا 82» does not also count «صفا 8».
  const pairs = projList.flatMap((p) => aliasOf(p.name).map((a) => ({ a, id: p.id }))).sort((x, y) => y.a.length - x.a.length);
  let rest = t;
  for (const { a, id } of pairs) {
    // Preceded by start / a non-letter / a joined «و» («وزنك 8»).
    const re = new RegExp(String.raw`(^|[^0-9a-z؀-ۿ]|(?:^|\s)و)` + a.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + String.raw`(?![0-9])`, 'u');
    if (re.test(rest)) { out.add(id); rest = rest.replace(re, '$1 '); }
  }
  return out;
}

type Turn = { customer: string; replies: string[]; tools: string[]; sentProject: string | null; sentUnits: { projectId: string; unitIds: string[] } | null; secs: number };
const only = (process.env.ONLY ?? '').split(',').map((s) => s.trim()).filter(Boolean);
const todo = S.filter((s) => !only.length || only.includes(s.id));

async function run(s: Scenario) {
  const truthUnits = units.filter((u) => s.where(u, projects.get(u.projectId)!));
  const truthProjects = new Set(truthUnits.map((u) => u.projectId));
  let truthIds = new Set(truthUnits.map((u) => u.id));
  if (s.level === 'cheapest' && truthUnits.length) {
    const min = Math.min(...truthUnits.map((u) => u.price ?? Infinity));
    truthIds = new Set(truthUnits.filter((u) => u.price === min).map((u) => u.id));
  }
  const msgs: Array<{ who: 'customer' | 'us'; text: string; isNew?: boolean }> = [];
  let conversation: Record<string, unknown> = {};
  const turns: Turn[] = [];
  const wid = `dryrun-acc-${s.id}@c.us`;
  const script = [...s.messages];
  let nudged = false;
  for (let i = 0; i < script.length; i++) {
    for (const m of msgs) m.isNew = false;
    msgs.push({ who: 'customer', text: script[i], isNew: true });
    const t0 = Date.now();
    let r: Record<string, unknown>;
    try {
      r = await runAgentTurn(svc, wid, { dryRun: true, sim: { messages: msgs.map((m) => ({ ...m })), conversation } }) as Record<string, unknown>;
    } catch (e) {
      turns.push({ customer: script[i], replies: [`ERROR ${(e as Error).message}`], tools: [], sentProject: null, sentUnits: null, secs: 0 });
      break;
    }
    const b = (r.brain ?? {}) as { toolTrace?: string[]; projectId?: string | null; units?: { projectId: string; unitIds: string[] } | null };
    const replies = (r.replies as string[] | undefined) ?? [];
    turns.push({ customer: script[i], replies, tools: b.toolTrace ?? [], sentProject: b.projectId ?? null, sentUnits: b.units ?? null, secs: Math.round((Date.now() - t0) / 1000) });
    for (const rep of replies) msgs.push({ who: 'us', text: rep, isNew: false });
    const sent = new Set<string>((conversation.sent_project_ids as string[] | undefined) ?? []);
    if (b.projectId) sent.add(b.projectId);
    conversation = { ...conversation, slots: r.slots ?? conversation.slots, sent_project_ids: [...sent] };
    // One nudge when the scripted messages are used up and the agent only asked.
    const surfaced = turns.some((t) => t.sentProject || t.sentUnits || t.replies.some((x) => namedIn(x).size));
    if (i === script.length - 1 && !surfaced && !nudged && s.level !== 'none') {
      nudged = true;
      script.push(s.level === 'project' ? 'ما عندي تفضيل ثاني، ارسل لي اللي يناسب طلبي' : 'ايه ارسلها لي');
    }
  }

  // Score.
  const named = new Set<string>();
  for (const t of turns) for (const x of t.replies) for (const id of namedIn(x)) named.add(id);
  const sentP = turns.map((t) => t.sentProject).filter((x): x is string => !!x);
  const sentU = turns.flatMap((t) => t.sentUnits?.unitIds ?? []);
  const unitProj = turns.map((t) => t.sentUnits?.projectId).filter((x): x is string => !!x);
  const surfaced = new Set([...named, ...sentP, ...unitProj]);
  const wrongProjects = [...surfaced].filter((id) => !truthProjects.has(id));
  const hitProjects = [...surfaced].filter((id) => truthProjects.has(id));
  const wrongUnits = sentU.filter((id) => !truthIds.has(id));
  const missedUnits = [...truthIds].filter((id) => !sentU.includes(id));
  const nm = (id: string) => projects.get(id)?.name ?? id;
  return {
    id: s.id, title: s.title, level: s.level, question: !!s.question, messages_scripted: s.messages.length, nudged,
    truth: {
      projects: [...truthProjects].map(nm),
      units: truthUnits.length,
      unit_ids: s.level === 'project' ? undefined : [...truthIds],
      price_range: truthUnits.length ? [Math.min(...truthUnits.map((u) => u.price ?? Infinity)), Math.max(...truthUnits.map((u) => u.price ?? 0))] : null,
      cheapest: s.level === 'cheapest' ? truthUnits.filter((u) => truthIds.has(u.id)).map((u) => ({ code: u.code, price: u.price, floor: u.floor, area: u.area })) : undefined,
    },
    got: {
      named: [...named].map(nm), sent_projects: sentP.map(nm), sent_units: sentU.length,
      wrong_projects: wrongProjects.map(nm), hit_projects: hitProjects.map(nm),
      wrong_units: wrongUnits.length, missed_units: missedUnits.length,
    },
    turns,
  };
}

if (process.env.TRUTH_ONLY) {
  for (const s of todo) {
    const tu = units.filter((u) => s.where(u, projects.get(u.projectId)!));
    const by = new Map<string, number>();
    for (const u of tu) by.set(projects.get(u.projectId)!.name, (by.get(projects.get(u.projectId)!.name) ?? 0) + 1);
    console.log(s.id, s.title, '→', tu.length, 'units', JSON.stringify([...by]));
  }
  process.exit(0);
}
const results: unknown[] = [];
const CONC = 3;
let next = 0;
await Promise.all(Array.from({ length: CONC }, async () => {
  while (next < todo.length) {
    const s = todo[next++];
    const r = await run(s);
    results.push(r);
    writeFileSync(process.argv[2]!, JSON.stringify(results, null, 1), 'utf8');
    console.log(`${s.id} done`);
  }
}));
console.log('ALL DONE');
