/**
 * WhatsApp group reader — developers' broker groups → project updates.
 *
 * The operations line sits in the broker groups of Al-Ramz, Safa and Riva
 * (project_update_groups). Developers post bookings («ريا النخيل مبنى 6 | شقة 2»),
 * available-unit price files (PDF / image), "only these are left" notes,
 * commission and handover terms, and new projects. This reads every new message
 * in a group (plus its PDFs and images), asks Claude to turn the update-bearing
 * ones into STRUCTURED items, checks each item against the messages, and pushes
 * them through the same reconciler + safety brake as the portal lane.
 *
 * Grounding, enforced in code (not just asked of the model):
 *  - every item cites the messages it came from; an item quoting text must
 *    quote it VERBATIM from those messages (normalised) or it is dropped;
 *  - a project must be one of the group's own developer/marketer's projects
 *    (the model only ever sees those ids; anything else is dropped);
 *  - units are matched deterministically by the reconciler — the model never
 *    picks a CRM unit, it only transcribes the identifiers the post states;
 *  - status from a chat moves only FORWARD (a booking cannot un-sell a unit);
 *  - a headline «تبدأ من 669,000» is never written as a unit price; only a
 *    per-unit price list sets prices.
 */

import Anthropic from '@anthropic-ai/sdk';
import type { SupabaseClient } from '@supabase/supabase-js';
import { trackedAnthropic } from '../lib/aiUsage.js';
import { applyResult, patchRecord, PROJECTS_MODEL_ID, UNIT_UPDATES_MODEL_ID, UNITS_MODEL_ID } from './apply.js';
import { createProjectFromSource } from './newProject.js';
import { brakeReason, mapFloor, normUnitKey, num, reconcile, toAsciiDigits } from './reconcile.js';
import type { CrmUnit, ReconcilePolicy, SourceUnit, UnitStatus } from './types.js';

const MODEL = 'claude-opus-5-5';
const MAX_MESSAGES = 80;
const MAX_DOCS = 4;
const MAX_IMAGES = 6;
const MAX_DOC_BYTES = 12 * 1024 * 1024;
const MAX_IMAGE_BYTES = 4 * 1024 * 1024;
/** A file still being saved by the inbound-media lane is waited for this long. */
const MEDIA_WAIT_MS = 10 * 60_000;

export interface ChatMessage {
  id: string;
  date: string;
  kind: string | null;
  body: string | null;
  media_caption: string | null;
  media_file_id: string | null;
  media_mime: string | null;
  from_phone: string | null;
}

interface CandidateProject {
  id: string;
  name: string;
  units: number;
  sample: string;
  developerId: string | null;
  data: Record<string, unknown>;
}

// ── extraction contract ──────────────────────────────────────────────────

export interface ExtractedUnit {
  block?: string | null;
  building?: string | null;
  floor?: string | null;
  unit_number?: number | string | null;
  unit_code?: string | null;
  unit_type?: string | null;
  bedrooms?: number | string | null;
  area?: number | string | null;
  price?: number | string | null;
  status?: 'available' | 'reserved' | 'sold' | null;
}

export interface ExtractedItem {
  message_ids: string[];
  kind: 'units_status' | 'available_list' | 'project_terms' | 'new_project';
  project_id?: string | null;
  project_name_as_written?: string | null;
  evidence?: string | null;
  units?: ExtractedUnit[];
  list_scope?: 'complete' | 'partial' | null;
  buildings_covered?: string[] | null;
  terms?: {
    commission_percent?: number | null;
    commission_until?: string | null;
    handover?: string | null;
    payment_plan?: string | null;
    offer?: string | null;
  } | null;
  new_project?: {
    name?: string | null;
    city?: string | null;
    district?: string | null;
    description?: string | null;
  } | null;
}

const TOOL: Anthropic.Tool = {
  name: 'record_project_updates',
  description: 'Record the project/unit updates contained in the WhatsApp messages.',
  input_schema: {
    type: 'object',
    properties: {
      items: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            message_ids: { type: 'array', items: { type: 'string' }, description: 'The [mN] labels this item comes from.' },
            kind: { type: 'string', enum: ['units_status', 'available_list', 'project_terms', 'new_project'] },
            project_id: { type: ['string', 'null'], description: 'Id from the PROJECTS list, or null when the project is not in it.' },
            project_name_as_written: { type: ['string', 'null'] },
            evidence: { type: ['string', 'null'], description: 'Verbatim quote from the message TEXT supporting the item; null when it comes only from an attached file or image.' },
            units: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  block: { type: ['string', 'null'] },
                  building: { type: ['string', 'null'] },
                  floor: { type: ['string', 'null'] },
                  unit_number: { type: ['string', 'number', 'null'] },
                  unit_code: { type: ['string', 'null'] },
                  unit_type: { type: ['string', 'null'] },
                  bedrooms: { type: ['number', 'string', 'null'], description: 'Bedrooms of THIS unit as the source states it (0 = studio); null when not stated — never inferred from the area.' },
                  area: { type: ['number', 'string', 'null'] },
                  price: { type: ['number', 'string', 'null'], description: 'Price of THIS unit (after discount when both are shown). Never a "starting from" figure.' },
                  status: { type: ['string', 'null'], enum: ['available', 'reserved', 'sold', null] },
                },
              },
            },
            list_scope: { type: ['string', 'null'], enum: ['complete', 'partial', null], description: 'available_list only: complete = the source says these are ALL the units still available (in the buildings it covers).' },
            buildings_covered: { type: ['array', 'null'], items: { type: 'string' } },
            terms: {
              type: ['object', 'null'],
              properties: {
                commission_percent: { type: ['number', 'null'] },
                commission_until: { type: ['string', 'null'], description: 'YYYY-MM-DD' },
                handover: { type: ['string', 'null'], description: 'YYYY-MM' },
                payment_plan: { type: ['string', 'null'] },
                offer: { type: ['string', 'null'] },
              },
            },
            new_project: {
              type: ['object', 'null'],
              properties: {
                name: { type: ['string', 'null'] },
                city: { type: ['string', 'null'] },
                district: { type: ['string', 'null'] },
                description: { type: ['string', 'null'] },
              },
            },
          },
          required: ['message_ids', 'kind'],
        },
      },
    },
    required: ['items'],
  },
};

function instructions(group: string, today: string): string {
  return [
    `You read a real-estate developer's WhatsApp broker group («${group}») for Wassel, a Saudi real-estate marketer. Today is ${today}.`,
    'Turn ONLY the messages that change facts about a project or its units into items. Ignore greetings, motivation, religious posts, meeting links, events and tours, marketing templates, broker-of-the-week congratulations EXCEPT for the booked unit they name, weekly booking COUNTS without unit identifiers, and app/registration announcements.',
    'Item kinds:',
    '- units_status: specific units that were booked/reserved or sold («تفاصيل الحجز: ريا النخيل مبنى 6 | شقة 2»). A booking = reserved. Transcribe each unit\'s identifiers exactly as written (block «بلك», building «مبنى/عمارة», floor, unit number «شقة/فيلا/وحدة», code).',
    '- available_list: a list of units with prices or availability (usually an attached PDF/image price list, or a text like «المتاح حالياً فقط دور اول - 1.199.000»). One unit per row: identifiers, type, area, the price the customer pays now. list_scope=complete only when the source presents it as the units still available («الوحدات المتاحة», «المتاح حالياً فقط»); then buildings_covered = the buildings the list covers (empty if it covers the whole project).',
    '- project_terms: broker commission («عمولتكم 3% حتى 15 اكتوبر»), handover date, payment plan, a time-limited offer or discount. Skip an offer or commission whose period ended before today.',
    '- new_project: a project announced in the group that is NOT in the PROJECTS list.',
    'Rules: project_id must come from the PROJECTS list (match the name as the group writes it, e.g. «ربى النخيل» = «ريا النخيل», «جديل» = the جديل project); null when it is not there. Never invent a unit, price or identifier. A "starting from" price is NOT a unit price. Numbers like 1.199.000 mean 1199000. evidence must be copied exactly from the message text.',
    'Call record_project_updates once with all items (an empty list is a normal answer).',
  ].join('\n');
}

// ── helpers ──────────────────────────────────────────────────────────────

/** Normalise Arabic text for the verbatim-evidence check. */
export function normText(s: string): string {
  return toAsciiDigits(s)
    .replace(/[ً-ٰٟـ]/g, '')
    .replace(/[إأآ]/g, 'ا').replace(/ى/g, 'ي').replace(/ة/g, 'ه')
    .replace(/[*_~|•\-–—:،,.\s‏‎]+/g, ' ')
    .trim()
    .toLowerCase();
}

/** True when `evidence` appears (normalised) in one of the cited messages. */
export function evidenceHolds(evidence: string | null | undefined, texts: string[]): boolean {
  if (!evidence) return false;
  const e = normText(evidence);
  if (e.length < 4) return false;
  return texts.some((t) => normText(t).includes(e));
}

function msgText(m: ChatMessage): string {
  return [m.body, m.media_caption].filter(Boolean).join('\n');
}

function storagePathFor(m: ChatMessage): string | null {
  if (!m.media_file_id) return null;
  const i = m.media_file_id.indexOf('/');
  if (i < 0) return null;
  const session = m.media_file_id.slice(0, i).replace(/^wf_/, '');
  return `whatsapp-media/${session}/${m.media_file_id.slice(i + 1)}`;
}

function toSourceUnits(units: ExtractedUnit[] | undefined, statusOverride?: UnitStatus): SourceUnit[] {
  return (units ?? []).map((u) => {
    const price = num(u.price);
    const area = num(u.area);
    const beds = num(u.bedrooms);
    return {
      sourceId: null,
      unitModel: null,
      unitCode: u.unit_code ? String(u.unit_code) : null,
      block: u.block ? String(u.block) : null,
      buildingNumber: u.building ? String(u.building) : null,
      floor: u.floor ? String(u.floor) : null,
      unitNumber: num(u.unit_number),
      unitType: u.unit_type ?? null,
      status: statusOverride ?? u.status ?? null,
      price: price != null && price > 0 ? price : null,
      area: area != null && area > 0 ? area : null,
      bedrooms: beds != null && beds >= 0 ? beds : null,
    };
  });
}

const PORTAL_SOURCES = new Set(['riva_broker', 'safa_broker', 'menaco', 'developer_api']);

/** The buildings / blocks a list's own rows name, at the most specific level
 *  each row gives: `bg:<block>#<building>`, else `g:<building>`, else `b:<block>`. */
export function listCoverage(src: SourceUnit[]): Set<string> {
  const out = new Set<string>();
  for (const u of src) {
    const b = u.block ? normUnitKey(u.block) : '';
    const g = u.buildingNumber ? normUnitKey(u.buildingNumber) : '';
    if (b && g) out.add(`bg:${b}#${g}`);
    else if (g) out.add(`g:${g}`);
    else if (b) out.add(`b:${b}`);
  }
  return out;
}

/** Is a CRM unit inside a list's coverage? */
export function inCoverage(scope: Set<string>, d: Record<string, unknown>): boolean {
  const b = normUnitKey(d.block);
  const g = normUnitKey(d.building_number);
  return (!!b && !!g && scope.has(`bg:${b}#${g}`)) || (!!g && scope.has(`g:${g}`)) || (!!b && scope.has(`b:${b}`));
}

function unitSample(units: Array<{ data: Record<string, unknown> }>): string {
  const pick = units.slice(0, 4).map((u) => {
    const d = u.data;
    return [d.block ? `بلك ${d.block}` : '', d.building_number ? `مبنى ${d.building_number}` : '',
      d.floor ? `دور ${d.floor}` : '', d.unit_number != null ? `رقم ${d.unit_number}` : '',
      d.unit_model ? `نموذج ${d.unit_model}` : ''].filter(Boolean).join(' ');
  });
  return pick.join(' / ');
}

async function loadCandidates(supabase: SupabaseClient, companyIds: string[]): Promise<CandidateProject[]> {
  const out = new Map<string, CandidateProject>();
  for (const cid of companyIds) {
    for (const q of [
      supabase.from('records').select('id, data').eq('model_id', PROJECTS_MODEL_ID).filter('data->>developer', 'eq', cid),
      supabase.from('records').select('id, data').eq('model_id', PROJECTS_MODEL_ID).filter('data->marketer', 'cs', JSON.stringify([cid])),
    ]) {
      const { data, error } = await q.limit(1000);
      if (error) throw new Error(`candidate projects: ${error.message}`);
      for (const r of (data ?? []) as Array<{ id: string; data: Record<string, unknown> }>) {
        out.set(r.id, {
          id: r.id, name: String(r.data.project_name ?? ''), units: 0, sample: '',
          developerId: typeof r.data.developer === 'string' ? r.data.developer : null, data: r.data,
        });
      }
    }
  }
  return [...out.values()];
}

async function loadUnits(supabase: SupabaseClient, projectId: string): Promise<CrmUnit[]> {
  const out: CrmUnit[] = [];
  for (let from = 0; ; from += 500) {
    const { data, error } = await supabase.from('records').select('id, data')
      .eq('model_id', UNITS_MODEL_ID).filter('data->>project_id', 'eq', projectId)
      .order('id').range(from, from + 499);
    if (error) throw new Error(`units of ${projectId}: ${error.message}`);
    const rows = (data ?? []) as CrmUnit[];
    out.push(...rows);
    if (rows.length < 500) break;
  }
  return out;
}

async function registryFor(supabase: SupabaseClient, projectId: string): Promise<{ id: string; data: Record<string, unknown> } | null> {
  const { data, error } = await supabase.from('records').select('id, data')
    .eq('model_id', UNIT_UPDATES_MODEL_ID).filter('data->>project', 'eq', projectId).limit(1);
  if (error) throw new Error(`registry lookup: ${error.message}`);
  return ((data ?? [])[0] as { id: string; data: Record<string, unknown> } | undefined) ?? null;
}

async function appendLog(supabase: SupabaseClient, projectId: string, line: string, today: string): Promise<void> {
  const reg = await registryFor(supabase, projectId);
  if (reg) {
    const prev = typeof reg.data.migration_log === 'string' ? reg.data.migration_log : '';
    await patchRecord(supabase, reg.id, { migration_log: prev ? `${prev}\n${line}` : line, last_migrated_at: today });
  }
  await patchRecord(supabase, projectId, { last_source_update: today });
}

// ── the run ──────────────────────────────────────────────────────────────

export interface WhatsAppRunArgs {
  supabase: SupabaseClient;
  runId: string;
  dryRun: boolean;
  params: Record<string, unknown>;
  brake: { share: number; minUnits: number };
  heartbeat: () => Promise<void>;
  defer: (seconds: number, note: string) => Promise<void>;
}

export type WhatsAppRunResult =
  | { deferred: true; note: string }
  | { deferred: false; outcome: 'applied' | 'no_change' | 'held' | 'partial' | 'dry_run'; summary: Record<string, unknown> };

export async function runWhatsAppGroup(a: WhatsAppRunArgs): Promise<WhatsAppRunResult> {
  const { supabase } = a;
  const chatWid = String(a.params.chat_wid ?? '');
  if (!chatWid) throw new Error('whatsapp run without params.chat_wid');
  const today = new Date(Date.now() + 3 * 3600_000).toISOString().slice(0, 10);

  const { data: g, error: gErr } = await supabase.from('project_update_groups').select('*').eq('chat_wid', chatWid).maybeSingle();
  if (gErr || !g) throw new Error(`group ${chatWid}: ${gErr?.message ?? 'not registered'}`);
  const group = g as { chat_wid: string; label: string; company_ids: string[]; read_through: string | null };
  const backfill = typeof a.params.since === 'string';
  const since = (a.params.since as string | undefined) ?? group.read_through ?? '1970-01-01T00:00:00Z';
  const until = (a.params.until as string | undefined) ?? new Date().toISOString();

  const { data: msgs, error: mErr } = await supabase.from('chat_messages')
    .select('id, date, kind, body, media_caption, media_file_id, media_mime, from_phone')
    .eq('chat_wid', chatWid).eq('flow', 'in').gt('date', since).lte('date', until)
    .order('date', { ascending: true }).limit(MAX_MESSAGES);
  if (mErr) throw new Error(`messages: ${mErr.message}`);
  const messages = (msgs ?? []) as ChatMessage[];
  if (messages.length === 0) {
    return { deferred: false, outcome: a.dryRun ? 'dry_run' : 'no_change', summary: { group: group.label, messages: 0 } };
  }
  const readThrough = messages[messages.length - 1]!.date;

  // ── attachments: PDFs + images, waited for while the media lane saves them
  const labels = new Map<string, string>(); // message id → mN
  messages.forEach((m, i) => labels.set(m.id, `m${i + 1}`));
  const content: Anthropic.ContentBlockParam[] = [];
  const missing: string[] = [];
  let docs = 0, images = 0;
  const skippedMedia: string[] = [];
  for (const m of messages) {
    const label = labels.get(m.id)!;
    const text = msgText(m);
    const mime = m.media_mime ?? '';
    const isDoc = mime === 'application/pdf';
    const isImg = mime.startsWith('image/');
    const head = `[${label}] ${m.date.slice(0, 16).replace('T', ' ')}${m.kind && m.kind !== 'text' ? ` (${m.kind}${mime ? ` ${mime}` : ''})` : ''}`;
    content.push({ type: 'text', text: `${head}\n${text || '(no text)'}` });
    if (!isDoc && !isImg) continue;
    if ((isDoc && docs >= MAX_DOCS) || (isImg && images >= MAX_IMAGES)) { skippedMedia.push(label); continue; }
    const path = storagePathFor(m);
    if (!path) { missing.push(label); continue; }
    const dl = await supabase.storage.from('wassel-files').download(path);
    if (dl.error || !dl.data) {
      const { data: job } = await supabase.from('inbound_media_jobs').select('status, created_at').eq('message_id', m.id).maybeSingle();
      const j = job as { status?: string; created_at?: string } | null;
      const young = j?.created_at && Date.now() - new Date(j.created_at).getTime() < MEDIA_WAIT_MS;
      if (!a.dryRun && j && (j.status === 'queued' || j.status === 'running') && young) {
        await a.defer(120, `waiting for ${label} to be saved`);
        return { deferred: true, note: `waiting for ${label}` };
      }
      missing.push(label);
      continue;
    }
    const bytes = Buffer.from(await dl.data.arrayBuffer());
    if (isDoc) {
      if (bytes.length > MAX_DOC_BYTES) { skippedMedia.push(label); continue; }
      content.push({ type: 'text', text: `Attached file of ${label}:` });
      content.push({ type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: bytes.toString('base64') } });
      docs++;
    } else {
      if (bytes.length > MAX_IMAGE_BYTES) { skippedMedia.push(label); continue; }
      const mt = (['image/jpeg', 'image/png', 'image/webp', 'image/gif'].includes(mime) ? mime : 'image/jpeg') as 'image/jpeg';
      content.push({ type: 'text', text: `Image of ${label}:` });
      content.push({ type: 'image', source: { type: 'base64', media_type: mt, data: bytes.toString('base64') } });
      images++;
    }
  }
  await a.heartbeat();

  // ── the group's projects (the ONLY ids the model may pick)
  const candidates = await loadCandidates(supabase, group.company_ids);
  for (const c of candidates) {
    const units = await loadUnits(supabase, c.id);
    c.units = units.length;
    c.sample = unitSample(units);
  }
  const projectList = candidates.map((c) => `- ${c.id} | ${c.name} | ${c.units} units${c.sample ? ` | e.g. ${c.sample}` : ''}`).join('\n');
  content.unshift({ type: 'text', text: `PROJECTS of this group:\n${projectList || '(none)'}\n\nMESSAGES (oldest first):` });

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error('ANTHROPIC_API_KEY is not set on the worker');
  const client = trackedAnthropic(new Anthropic({ apiKey }), {
    area: 'sales', callSite: 'worker/projectUpdates/whatsapp', operation: 'extract_updates',
  });
  const res = await client.messages.create({
    model: MODEL,
    max_tokens: 16000,
    system: instructions(group.label, today),
    // Opus 5.5 refuses a FORCED tool_choice ("tool"/"any"); 'auto' plus the
    // system prompt's "call record_project_updates once" is what it accepts.
    tools: [TOOL],
    tool_choice: { type: 'auto' },
    messages: [{ role: 'user', content }],
  });
  if (res.stop_reason === 'max_tokens') throw new Error('extraction hit max_tokens — batch too large');
  const block = res.content.find((b): b is Anthropic.ToolUseBlock => b.type === 'tool_use' && b.name === TOOL.name);
  // No tool call is NOT "no updates" — it is a failed read. Fail loudly so the
  // watermark stays put and the batch is read again.
  if (!block) {
    const said = res.content.filter((b): b is Anthropic.TextBlock => b.type === 'text').map((b) => b.text).join(' ').slice(0, 300);
    throw new Error(`model did not call ${TOOL.name} (stop=${res.stop_reason}): ${said}`);
  }
  const items = (((block.input ?? {}) as { items?: ExtractedItem[] }).items ?? []);
  await a.heartbeat();

  // ── validate + apply
  const byLabel = new Map<string, ChatMessage>();
  messages.forEach((m) => byLabel.set(labels.get(m.id)!, m));
  const candidateIds = new Map(candidates.map((c) => [c.id, c]));
  const results: Array<Record<string, unknown>> = [];
  let applied = 0, held = 0, written = 0;

  const policyFor = (it: ExtractedItem): ReconcilePolicy =>
    it.kind === 'units_status'
      ? { absentAvailable: 'leave', createMissing: false, updatePrices: false, forwardOnly: true }
      : { absentAvailable: it.list_scope === 'complete' ? 'sold' : 'leave', createMissing: true, updatePrices: true, forwardOnly: false };

  // new projects first, so a price list for the same new project lands on it
  const ordered = [...items].sort((x, y) => (x.kind === 'new_project' ? -1 : 0) - (y.kind === 'new_project' ? -1 : 0));
  const createdByName = new Map<string, string>();

  // A catch-up run can be limited to some kinds (e.g. only the bookings).
  const onlyKinds = Array.isArray(a.params.only_kinds) ? new Set(a.params.only_kinds as string[]) : null;

  for (const it of ordered) {
    if (onlyKinds && !onlyKinds.has(it.kind)) { results.push({ kind: it.kind, messages: it.message_ids, skipped: 'not in only_kinds' }); continue; }
    const cited = (it.message_ids ?? []).map((l) => byLabel.get(l)).filter(Boolean) as ChatMessage[];
    const r: Record<string, unknown> = { kind: it.kind, messages: it.message_ids, project: it.project_name_as_written ?? null };
    results.push(r);
    if (cited.length === 0) { r.dropped = 'cites no message of this batch'; continue; }
    const citedTexts = cited.map(msgText);
    const fromFile = cited.some((m) => (m.media_mime ?? '').startsWith('image/') || m.media_mime === 'application/pdf');
    if (!fromFile || it.evidence) {
      if (!evidenceHolds(it.evidence, citedTexts)) { r.dropped = 'evidence is not in the cited messages'; continue; }
    }

    try {
      if (it.kind === 'new_project') {
        const name = (it.new_project?.name ?? it.project_name_as_written ?? '').trim();
        if (!name) { r.dropped = 'no name'; continue; }
        const { data: all, error } = await supabase.from('records').select('id, data').eq('model_id', PROJECTS_MODEL_ID).limit(5000);
        if (error) throw new Error(error.message);
        const key = normUnitKey(name);
        const existing = ((all ?? []) as Array<{ id: string; data: Record<string, unknown> }>).filter((p) => {
          const k = normUnitKey(p.data.project_name);
          return k && (k === key || k.includes(key) || key.includes(k));
        });
        if (existing.length) { r.result = `already in the CRM: ${existing.map((p) => p.data.project_name).join('، ')}`; continue; }
        if (a.dryRun) { r.result = 'would create'; continue; }
        const sibling = candidates[0]?.data ?? null;
        const developerId = candidates.find((c) => c.developerId)?.developerId ?? null;
        const ownDev = group.company_ids.includes(developerId ?? '') ? developerId : null;
        const created = await createProjectFromSource(supabase, {
          runId: a.runId,
          src: {
            sourceId: '', name, url: '', units: [], declaredTotal: null,
            meta: { city: it.new_project?.city ?? undefined, district: it.new_project?.district ?? undefined, description: it.new_project?.description ?? it.evidence ?? undefined },
          },
          sourceType: 'whatsapp_group', sourceLabel: `مجموعة واتساب ${group.label}`, sourceUrl: null,
          sibling, today, updateFrequency: 'on_file', developerId: ownDev, dataSources: ['whatsapp'],
          instructions: `أُضيف تلقائياً (${today}) من مجموعة واتساب «${group.label}». يُحدَّث آلياً من رسائل المجموعة (الحجوزات وقوائم الأسعار) عبر project_update_runs.`,
        });
        createdByName.set(key, created.projectId);
        candidateIds.set(created.projectId, { id: created.projectId, name, units: 0, sample: '', developerId: ownDev, data: {} });
        r.result = `created ${created.code}`;
        written++; applied++;
        continue;
      }

      let projectId = it.project_id && candidateIds.has(it.project_id) ? it.project_id : null;
      if (!projectId && it.project_name_as_written) projectId = createdByName.get(normUnitKey(it.project_name_as_written)) ?? null;
      if (!projectId) { r.dropped = it.project_id ? 'project is not one of this group\'s projects' : 'project not identified'; continue; }
      const project = candidateIds.get(projectId)!;
      r.project = project.name;
      const reg = await registryFor(supabase, projectId);
      if (reg?.data.auto_scope === 'off') { r.dropped = 'automatic updates are off for this project'; continue; }
      // A project kept current by a PORTAL run gets bookings and terms from the
      // chat, but not its price lists: the portal is the source of truth and a
      // chat file would fight it (found 2026-10-04: Riva's Aknan 23 PDF vs the
      // portal applied minutes earlier). auto_scope=status_only flips that —
      // the portal is secondary there (ستون الندى: Al-Ramz's own files lead).
      const portalLed = reg && PORTAL_SOURCES.has(String(reg.data.source_type)) && reg.data.auto_scope !== 'status_only';
      if (it.kind === 'available_list' && portalLed) {
        r.dropped = `price list skipped: ${project.name} is updated from its portal (${String(reg!.data.source_type)})`;
        continue;
      }

      if (it.kind === 'project_terms') {
        const t = it.terms ?? {};
        // Terms that already ended are history, not an update.
        if (t.commission_until && /^d{4}-d{2}-d{2}$/.test(t.commission_until) && t.commission_until < today) {
          r.dropped = `expired on ${t.commission_until}`;
          continue;
        }
        const bits: string[] = [];
        if (t.commission_percent != null) bits.push(`عمولة الوسيط ${t.commission_percent}%${t.commission_until ? ` حتى ${t.commission_until}` : ''}`);
        if (t.offer) bits.push(`عرض: ${t.offer}`);
        if (t.payment_plan) bits.push(`خطة الدفع: ${t.payment_plan}`);
        if (t.handover) bits.push(`التسليم: ${t.handover}`);
        if (!bits.length) { r.dropped = 'no terms'; continue; }
        const line = `${today} (واتساب ${group.label}): ${bits.join(' — ')}`;
        r.result = line;
        if (a.dryRun) continue;
        const patch: Record<string, unknown> = {};
        const prev = typeof project.data.internal_sales_notes === 'string' ? project.data.internal_sales_notes : '';
        if (!normText(prev).includes(normText(bits.join(' — ')))) patch.internal_sales_notes = prev ? `${prev}\n${line}` : line;
        const ho = t.handover?.match(/^(\d{4})-(\d{2})/);
        if (ho) {
          const d = `${ho[1]}-${ho[2]}-01`;
          if (String(project.data.handover_date ?? '').slice(0, 7) !== d.slice(0, 7)) patch.handover_date = d;
        }
        if (Object.keys(patch).length) {
          const before = await patchRecord(supabase, projectId, patch);
          if (before) {
            const { error } = await supabase.from('project_update_changes').insert({
              run_id: a.runId, project_id: projectId, record_id: projectId, model: 'all_projects',
              action: 'update', before, after: patch, reason: `WhatsApp terms: ${bits.join('; ')}`,
            });
            if (error) throw new Error(`change log: ${error.message}`);
            written++; applied++;
          }
        }
        continue;
      }

      // units_status / available_list
      const src = toSourceUnits(it.units, it.kind === 'units_status' ? 'reserved' : undefined)
        .map((u, i) => ({ ...u, status: it.kind === 'units_status' ? (it.units?.[i]?.status === 'sold' ? 'sold' : 'reserved') as UnitStatus : (u.status ?? 'available') as UnitStatus }));
      if (src.length === 0) { r.dropped = 'no units'; continue; }
      let crm = await loadUnits(supabase, projectId);
      if (it.kind === 'available_list' && it.list_scope === 'complete') {
        // "Not on the list → sold" applies ONLY to the buildings the list itself
        // covers — derived from its own rows, never from the model's claim. A
        // list for buildings 1+2 must not sell buildings 3 and 4 (the 2026-09-21
        // ستون الندى file would have marked ~66 units sold without this).
        const scope = listCoverage(src);
        if (scope.size === 0) { r.dropped = 'complete list without building/block numbers — cannot tell which units it covers'; continue; }
        crm = crm.filter((u) => inCoverage(scope, u.data));
        r.buildings_covered = [...scope];
      }
      // A list row becomes a NEW unit only with all four essentials (area,
      // price, bedrooms, type) — reconcile skips the rest into result.incomplete.
      const policy = policyFor(it);
      const result = reconcile(crm, src, policy, {
        projectId, developerId: project.developerId, projectName: project.name,
        sourceLabel: `واتساب ${group.label}`, today,
      });
      const brake = brakeReason(result, a.brake);
      Object.assign(r, {
        matched: result.stats.matched, unmatched: src.length - result.stats.matched - result.ambiguous.length,
        ambiguous: result.ambiguous, changes: result.updates.map((u) => ({ unit: u.label, why: u.reasons })),
        creates: result.creates.map((c) => c.label),
        incomplete: result.incomplete,
      });
      if (brake) { r.held = brake; held++; if (!a.dryRun) await appendLog(supabase, projectId, `${today} — ⛔ تحديث واتساب موقوف: ${brake}`, today); continue; }
      if (a.dryRun) continue;
      const out = await applyResult(supabase, { runId: a.runId, projectId, projectName: project.name, result, heartbeat: a.heartbeat, sourceLabel: `واتساب ${group.label}` });
      r.written = out;
      written += out.updated + out.created;
      if (out.updated + out.created > 0) applied++;
      const unm = Number(r.unmatched ?? 0);
      await appendLog(supabase, projectId,
        `${today} — تحديث تلقائي (واتساب ${group.label}): ${out.updated} تعديل، ${out.created} جديد${unm ? `؛ ${unm} وحدة لم تُطابَق` : ''}${result.ambiguous.length ? `؛ ${result.ambiguous.length} غير محسومة` : ''}${result.incomplete.length ? `؛ ⚠ ${result.incomplete.length} وحدة لم تُضَف لنقص معلومة أساسية (أُبلغ المشغّل)` : ''}`,
        today);
    } catch (err) {
      r.error = (err as Error).message;
    }
    await a.heartbeat();
  }

  if (!a.dryRun && !backfill) {
    const { error } = await supabase.rpc('project_update_group_advance', { p_chat_wid: chatWid, p_through: readThrough });
    if (error) throw new Error(`advance watermark: ${error.message}`);
  }

  const summary = {
    group: group.label, messages: messages.length, read_through: readThrough,
    pdfs: docs, images, missing_media: missing, skipped_media: skippedMedia,
    tokens: { input: res.usage.input_tokens, output: res.usage.output_tokens },
    items: results,
  };
  const outcome = a.dryRun ? 'dry_run' : held && !applied ? 'held' : held ? 'partial' : written ? 'applied' : 'no_change';
  return { deferred: false, outcome, summary };
}

export { mapFloor };
