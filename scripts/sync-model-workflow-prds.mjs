#!/usr/bin/env node
/**
 * sync-model-workflow-prds.mjs
 * ----------------------------------------------------------------------------
 * Snapshots every MODEL and WORKFLOW from the live Supabase DB into one
 * deterministic markdown PRD per artifact, under:
 *   docs/prd/models/<model-name-slug>.md
 *   docs/prd/workflows/<label-slug>-<id8>.md
 * plus an index README in each dir.
 *
 * WHY THIS EXISTS
 *   Frozen models become physical Postgres tables + migrations *in code*, so
 *   Claude sees them in any session. But UNFROZEN models and ALL workflows
 *   live only as JSONB rows in Supabase — created/edited at runtime through the
 *   in-app Model Builder and Workflow editor. They never become code files, so
 *   Claude is blind to them in a fresh session. This script reads the live DB
 *   and writes them down so Claude (and humans) can read them. The git diff
 *   between runs is the record of what changed in the app.
 *
 * IT IS PURE TEMPLATING — no LLM, no network beyond reading Supabase. Re-runs
 * are deterministic (each file's "Last updated" uses that row's own updated_at,
 * never Date.now()), so an unchanged DB produces zero git churn.
 *
 * REQUIRED ENV (read from process.env, or auto-loaded from .env.local / .env
 * at the repo root):
 *   SUPABASE_URL                 (or VITE_SUPABASE_URL)
 *   SUPABASE_SERVICE_ROLE_KEY    preferred — bypasses RLS so no row is hidden
 *     ...or SUPABASE_ANON_KEY / VITE_SUPABASE_ANON_KEY  (only sees what RLS allows)
 *
 * USAGE
 *   node scripts/sync-model-workflow-prds.mjs          # exits 1 if env missing
 *   node scripts/sync-model-workflow-prds.mjs --hook   # quiet skip (exit 0) if
 *                                                       # env missing / DB down,
 *                                                       # so a SessionStart hook
 *                                                       # never breaks a session
 *
 * LABEL PROVENANCE (re-implemented here because this .mjs can't import the TS
 * app code — keep in sync by convention if these ever change):
 *   - Action labels         ← ACTION_STYLE in src/pages/Workflow/components/ActionList.tsx
 *   - Condition operators   ← condition.* keys in src/lib/i18n.ts
 *   - Field-type union      ← FieldType in src/types/index.ts
 *   - Custom-UI model slugs ← App.tsx route dispatchers + FreezeModelModal/ModelEditor
 * ----------------------------------------------------------------------------
 */

import { createClient } from '@supabase/supabase-js';
import { writeFileSync, readFileSync, existsSync, readdirSync, unlinkSync, mkdirSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const ROOT = resolve(dirname(__filename), '..');

const ARGS = new Set(process.argv.slice(2));
const HOOK_MODE = ARGS.has('--hook');

// ── tiny zero-dep .env loader (no `dotenv` in this repo) ───────────────────
// Reads .env.local then .env; fills only keys not already in process.env, so a
// real shell env always wins. CRLF-safe. Avoids Node's single-file --env-file.
function loadEnvFile(p) {
  if (!existsSync(p)) return;
  let txt;
  try {
    txt = readFileSync(p, 'utf8');
  } catch {
    return; // unreadable env file — fall through; the env-presence check below reports it
  }
  for (const line of txt.split(/\r?\n/)) {
    if (!line || line.trimStart().startsWith('#')) continue;
    const m = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/.exec(line);
    if (!m) continue;
    let v = m[2];
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
      v = v.slice(1, -1);
    }
    if (process.env[m[1]] === undefined) process.env[m[1]] = v;
  }
}
loadEnvFile(join(ROOT, '.env.local'));
loadEnvFile(join(ROOT, '.env'));

// In --hook mode, a missing-env / DB-down situation is a quiet skip (exit 0) so
// it never blocks a session. Manual runs fail loudly (exit 1). Either way the
// reason is printed — never a silent swallow (see CLAUDE.md "Silent Failures").
function bail(reason) {
  if (HOOK_MODE) {
    process.stderr.write(`[sync:prds] skipped — ${reason}\n`);
    process.exit(0);
  }
  console.error(`[sync:prds] ERROR — ${reason}`);
  process.exit(1);
}

const SUPABASE_URL = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL;
const SUPABASE_KEY =
  process.env.SUPABASE_SERVICE_ROLE_KEY ||
  process.env.SUPABASE_ANON_KEY ||
  process.env.VITE_SUPABASE_ANON_KEY;
const USING_SERVICE_ROLE = !!process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!SUPABASE_URL || !SUPABASE_KEY) {
  bail('missing SUPABASE_URL or a Supabase key (service-role/anon) in env, .env.local, or .env');
}

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY, { auth: { persistSession: false } });

// ── paginated load (dodges the 1000-row PostgREST truncation; see CLAUDE.md) ─
async function loadAll(table) {
  const PAGE = 1000;
  const rows = [];
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await supabase.from(table).select('*').range(from, from + PAGE - 1);
    if (error) throw new Error(`load "${table}": ${error.message}`);
    if (!data || data.length === 0) break;
    rows.push(...data);
    if (data.length < PAGE) break;
  }
  return rows;
}

// Auxiliary lookup tables: degrade with a VISIBLE warning rather than abort the
// whole snapshot (a missing label is a cosmetic loss, not data loss). Core
// tables (models, workflows) use loadAll and abort loudly on any error.
async function loadAux(table) {
  try {
    return await loadAll(table);
  } catch (e) {
    process.stderr.write(`[sync:prds] WARN — could not load "${table}" (${e.message}); cross-references to it will show raw ids.\n`);
    return [];
  }
}

// ── constants (mirrors of app code — see LABEL PROVENANCE above) ────────────
const CUSTOM_UI_MODELS = new Set([
  'chats', 'ai_chats', 'decks', 'data_migration', 'image_chats',
  'design_templates', 'chat_templates', 'site_settings', 'project_details',
  'marketing_operations',
]);

const FIELD_TYPE_LABEL = {
  text: 'Text', textarea: 'Text area', number: 'Number', email: 'Email',
  phone: 'Phone', date: 'Date', datetime: 'Date & time', currency: 'Currency',
  url: 'URL', multi_link: 'Multi-link', checkbox: 'Checkbox', dropdown: 'Dropdown',
  multiselect: 'Multi-select', lookup: 'Lookup', mirror: 'Mirror',
  section_mirror: 'Section mirror', section_selector: 'Section selector',
  assignee: 'Assignee', notes: 'Notes', range: 'Range', auto_id: 'Auto ID',
  formula: 'Formula', table: 'Table', image: 'Image', multi_image: 'Multi-image',
  file: 'File', multi_file: 'Multi-file', attachment: 'Attachment',
  template_variables: 'Template variables', templates_picker: 'Templates picker',
  generations_gallery: 'Generations gallery', whatsapp_history: 'WhatsApp history',
  call_history: 'Call history',
};

const OPERATOR_WORDS = {
  equals: 'equals', not_equals: 'not equals', contains: 'contains',
  intersects: 'overlaps with', greater_than: 'greater than',
  less_than: 'less than', is_empty: 'is empty', is_not_empty: 'is not empty',
};

const ACTION_LABEL = {
  create_record: 'Create Record', update_record: 'Update Record',
  send_notification: 'Send Notification', assign_user: 'Assign User',
  http_request: 'HTTP Request', outbound_ivr: 'Automated Call',
  send_whatsapp_message: 'Send WhatsApp', paseet_query: 'Paseet Query',
};

const TRIGGER_EVENT_DESC = {
  create: 'When a record is created',
  update: 'When a record is updated',
  delete: 'When a record is deleted',
  webhook: 'When a webhook payload arrives',
  button_click: 'When a custom button is clicked',
  on_due: 'When a due date is reached',
};

// ── primitives ─────────────────────────────────────────────────────────────
const BT = '`';
const FENCE = '```';
function bt(s) { return BT + String(s ?? '') + BT; }
function bool(b) { return b ? 'yes' : 'no'; }
function ymd(iso) {
  if (!iso) return 'unknown';
  const m = /^(\d{4}-\d{2}-\d{2})/.exec(String(iso));
  return m ? m[1] : String(iso).slice(0, 10);
}
function slugify(s) {
  const out = String(s ?? '')
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^-+|-+$/g, '');
  return out || 'untitled';
}
// Table-cell-safe: no raw pipes, no newlines.
function cell(s) {
  return String(s ?? '').replace(/\r?\n/g, ' ').replace(/\|/g, '\\|').trim();
}
function fmtScalar(v) {
  if (v === null || v === undefined || v === '') return '(empty)';
  if (typeof v === 'object') return bt(JSON.stringify(v));
  return String(v);
}
function fmtValue(v) {
  if (Array.isArray(v)) return v.length ? v.map(fmtScalar).join(', ') : '(empty list)';
  return fmtScalar(v);
}
function banner() {
  return [
    '<!-- AUTO-GENERATED by scripts/sync-model-workflow-prds.mjs — DO NOT EDIT BY HAND.',
    '     Regenerate with: npm run sync:prds  (reads the live Supabase DB).',
    '     The git diff of this file is the record of what changed in the app. -->',
  ].join('\n');
}

// ── cross-reference context (populated in main, read by renderers) ──────────
const ctx = {
  modelById: new Map(),
  modelGroupById: new Map(),
  workflowGroupById: new Map(),
  webhookSlugById: new Map(),
  roleById: new Map(),
  profileById: new Map(),
};

function sectionsOf(model) {
  const sch = model && model.schema;
  return sch && Array.isArray(sch.sections) ? sch.sections : [];
}
function allFieldsOf(model) {
  const out = [];
  for (const s of sectionsOf(model)) for (const f of (s.fields || [])) out.push(f);
  return out;
}
function fieldByIdOf(model, id) { return allFieldsOf(model).find((f) => f.id === id) || null; }
function fieldBySlugOf(model, slug) { return allFieldsOf(model).find((f) => f.name === slug) || null; }
function sectionByIdOf(model, id) { return sectionsOf(model).find((s) => s.id === id) || null; }

function modelLabel(id) {
  const m = ctx.modelById.get(id);
  return m ? m.label_en : `${bt(id)} (unknown model)`;
}
function modelLabelFull(m) { return `${m.label_en} / ${m.label_ar}`; }

// Field reference inside a SPECIFIC model, by slug (conditions/mappings store slugs).
function fieldLabelBySlug(model, slug) {
  if (slug === undefined || slug === null || slug === '') return '(none)';
  const f = model ? fieldBySlugOf(model, slug) : null;
  return f ? `${f.label_en} (${bt(slug)})` : `${bt(slug)} (unknown field)`;
}
function fieldLabelById(model, id) {
  if (!id) return '(none)';
  const f = model ? fieldByIdOf(model, id) : null;
  return f ? `${f.label_en} (${bt(f.name)})` : `${bt(id)} (unknown field)`;
}
function sectionLabelById(model, id) {
  if (!id) return '(none)';
  const s = model ? sectionByIdOf(model, id) : null;
  return s ? `${s.label_en} / ${s.label_ar}` : `${bt(id)} (unknown section)`;
}
function roleLabel(id) {
  if (!id) return '(none)';
  const r = ctx.roleById.get(id);
  return r ? (r.label_en || r.name || r.label_ar || id) : `${bt(id)} (role)`;
}
function profileLabel(id) {
  const p = ctx.profileById.get(id);
  return p ? (p.label_en || p.name || p.label_ar || id) : `${bt(id)} (profile)`;
}

// Resolve a stored condition/filter value to option labels when the field has options.
function fmtFieldValue(model, slug, v) {
  const f = model ? fieldBySlugOf(model, slug) : null;
  if (f && Array.isArray(f.options) && f.options.length) {
    const one = (val) => {
      const opt = f.options.find((o) => o.value === val);
      return opt ? `"${opt.label_en}" (${bt(val)})` : fmtScalar(val);
    };
    if (Array.isArray(v)) return v.length ? v.map(one).join(', ') : '(empty list)';
    return one(v);
  }
  return fmtValue(v);
}

// ── per-field rendering ─────────────────────────────────────────────────────
// One short hint for the table's "Details" column.
function fieldDetailHint(field) {
  const t = field.type;
  if (t === 'dropdown') return `${(field.options || []).length} options`;
  if (t === 'multiselect') return `${(field.options || []).length} options · multi`;
  if (t === 'section_selector') return 'controls section visibility';
  if (t === 'lookup') {
    const tgt = field.lookup_model_id ? modelLabel(field.lookup_model_id) : '(unset)';
    return `→ ${tgt}${field.is_multi ? ' · multi' : ''}`;
  }
  if (t === 'formula') return `= ${truncate(field.formula_expression, 40)}`;
  if (t === 'auto_id') return `${field.auto_id_prefix || ''}${'#'.repeat(field.auto_id_padding || 3)}`;
  if (t === 'range') return `${field.range_min ?? '?'}–${field.range_max ?? '?'}`;
  if (t === 'table') return `${(field.table_columns || []).length} columns`;
  if (t === 'mirror') return 'computed mirror';
  if (t === 'section_mirror') return 'embedded section';
  if (t === 'assignee') return field.assignee_user_filter_mode === 'restricted' ? 'restricted' : 'any user';
  if (field.is_computed) return `computed: ${field.computed_kind || '?'}`;
  return '';
}
function truncate(s, n) {
  const str = String(s ?? '');
  return str.length > n ? str.slice(0, n - 1) + '…' : str;
}

// Full expanded detail block for one field (returns [] when nothing to expand).
function fieldDetailBlock(field, model) {
  const t = field.type;
  const lines = [];
  const head = `- **${field.label_en} / ${field.label_ar}** (${bt(field.name)}, type ${bt(t)})`;

  if ((t === 'dropdown' || t === 'multiselect') && (field.options || []).length) {
    lines.push(head + (t === 'multiselect' ? ' — multi-value. Options:' : ' — options:'));
    const groups = field.option_groups || [];
    for (const o of field.options) {
      const grp = o.group_id ? groups.find((g) => g.id === o.group_id) : null;
      const bits = [`API value ${bt(o.value)} → "${o.label_en}" / "${o.label_ar}"`];
      if (o.color) bits.push(`color ${bt(o.color)}`);
      if (grp) bits.push(`group "${grp.label_en}"`);
      if (o.is_section_option) bits.push('section option');
      lines.push(`  - ${bits.join(' · ')}`);
    }
  } else if (t === 'section_selector') {
    lines.push(head + ' — its options are the model\'s non-base sections; selecting them shows those sections (base sections always show).');
    for (const o of (field.options || [])) {
      lines.push(`  - ${bt(o.value)} → "${o.label_en}"${o.is_section_option ? '' : ' (custom, non-section)'}`);
    }
  } else if (t === 'lookup') {
    lines.push(head + ':');
    lines.push(`  - target model: ${field.lookup_model_id ? modelLabel(field.lookup_model_id) : '(unset)'}`);
    lines.push(`  - shows field: ${bt(field.lookup_display_field || '(default)')}`);
    lines.push(`  - multiple: ${bool(field.is_multi)}${field.lookup_max_records ? ` · max in dropdown: ${field.lookup_max_records}` : ''}`);
  } else if (t === 'formula') {
    lines.push(head + ':');
    lines.push(`  - expression: ${bt(field.formula_expression || '(empty)')}`);
    lines.push(`  - output: ${field.formula_output_type || 'number'}${field.formula_decimals != null ? ` · ${field.formula_decimals} decimals` : ''}${field.formula_currency ? ` · ${field.formula_currency}` : ''}`);
  } else if (t === 'auto_id') {
    lines.push(head + ':');
    lines.push(`  - format: ${bt((field.auto_id_prefix || '') + '0'.repeat(field.auto_id_padding || 3))} · starts at ${field.auto_id_start_value ?? 1}`);
    if (field.auto_id_scope_field_id) lines.push(`  - per-value scope: ${fieldLabelById(model, field.auto_id_scope_field_id)}`);
  } else if (t === 'range') {
    lines.push(head + `:`);
    lines.push(`  - ${field.range_min ?? '?'} to ${field.range_max ?? '?'}${field.range_step ? ` step ${field.range_step}` : ''}${field.range_unit_en ? ` ${field.range_unit_en}` : ''}`);
  } else if (t === 'table') {
    lines.push(head + ' — columns:');
    for (const c of (field.table_columns || [])) {
      const extra = c.type === 'dropdown' ? ` · ${(c.options || []).length} options`
        : c.type === 'formula' ? ` · = ${bt(truncate(c.formula_expression, 40))}` : '';
      lines.push(`  - ${bt(c.name)} "${c.label_en}" (${c.type})${c.required ? ' · required' : ''}${extra}`);
    }
  } else if (t === 'assignee') {
    lines.push(head + ':');
    const restricted = field.assignee_user_filter_mode === 'restricted';
    lines.push(`  - eligible users: ${restricted ? 'restricted' : 'any active user'}`);
    if (restricted) {
      if ((field.assignee_role_ids || []).length) lines.push(`  - roles: ${field.assignee_role_ids.map(roleLabel).join(', ')}`);
      if ((field.assignee_profile_ids || []).length) lines.push(`  - profiles: ${field.assignee_profile_ids.map(profileLabel).join(', ')}`);
    }
  } else if (t === 'mirror') {
    lines.push(head + ` — read-only; shows ${bt(field.mirror_target_field_name || '?')} from the record linked via ${fieldLabelById(model, field.mirror_via_lookup_field_id)}.`);
  } else if (t === 'section_mirror') {
    lines.push(head + ':');
    lines.push(`  - via lookup: ${fieldLabelById(model, field.section_mirror_via_lookup_field_id)}`);
    lines.push(`  - source section: ${field.section_mirror_source_section_id ? bt(field.section_mirror_source_section_id) : '(unset)'}`);
    lines.push(`  - fields: ${field.section_mirror_field_mode || 'all'} · editable: ${field.section_mirror_edit_mode || 'none'} · sync-back: ${field.section_mirror_sync_mode || 'all'}`);
  }

  // Cross-cutting extras that apply on top of (or instead of) a type block.
  const extras = [];
  if (field.is_computed && t !== 'mirror') extras.push(`computed rollup (${bt(field.computed_kind || '?')}), read-only`);
  if (field.visible_when && field.visible_when.field_id) {
    extras.push(`shown only when ${fieldLabelById(model, field.visible_when.field_id)} is one of: ${(field.visible_when.values || []).map((v) => bt(v)).join(', ')}`);
  }
  if (field.fallback_source_field_id) extras.push(`falls back to ${fieldLabelById(model, field.fallback_source_field_id)} when empty on save`);
  if (field.auto_link_lookup_field_id) extras.push(`auto-links ${fieldLabelById(model, field.auto_link_lookup_field_id)} by matching ${bt(field.auto_link_target_field_name || '?')}${field.auto_link_create_if_missing ? ' (creates if missing)' : ''}`);
  if (field.auto_fill_from_lookup_field_id) extras.push(`auto-fills from ${fieldLabelById(model, field.auto_fill_from_lookup_field_id)} → ${bt(field.auto_fill_source_field_name || '?')}`);
  if (field.default_country_code) extras.push(`default country code ${bt(field.default_country_code)}`);

  if (extras.length) {
    if (!lines.length) lines.push(head + ':');
    for (const e of extras) lines.push(`  - ${e}`);
  }
  return lines;
}

// ── per-model PRD ────────────────────────────────────────────────────────────
function renderModel(model) {
  const L = [];
  L.push(banner());
  L.push('');
  L.push(`# Model: ${model.label_en} / ${model.label_ar}  ${bt(model.name)}`);
  L.push('');
  L.push('**Status:** Auto-generated (do not hand-edit) — reflects live Supabase');
  L.push(`**Last updated (from DB):** ${ymd(model.updated_at)}`);
  L.push(`**Model id:** ${bt(model.id)}`);
  L.push(`**Storage:** ${model.is_hardcoded ? `frozen table ${bt(model.table_name || model.name)}` : 'unified records (JSONB)'}`);
  const grp = model.group_id ? ctx.modelGroupById.get(model.group_id) : null;
  L.push(`**Group:** ${grp ? grp.label_en : '(ungrouped)'}`);
  const customUi = CUSTOM_UI_MODELS.has(model.name);
  L.push(`**System model:** ${bool(model.is_system)}   ·   **Custom UI:** ${bool(customUi)}${customUi ? ' (bespoke page — the generic record form/table is bypassed)' : ''}`);
  L.push(`**Icon:** ${bt(model.icon || '')}   ·   **Color:** ${bt(model.color || '')}`);
  L.push('');

  const sections = [...sectionsOf(model)].sort((a, b) => (a.order ?? 0) - (b.order ?? 0) || String(a.id).localeCompare(String(b.id)));
  const fieldCount = allFieldsOf(model).length;
  const baseCount = sections.filter((s) => s.is_base).length;
  const sch = model.schema || {};

  L.push('## Overview');
  L.push(`- Sections: **${sections.length}** (${baseCount} base, ${sections.length - baseCount} non-base)`);
  L.push(`- Fields: **${fieldCount}**`);
  L.push(`- Section-selector field: ${sch.section_selector_field_id ? fieldLabelById(model, sch.section_selector_field_id) : 'none'}`);
  L.push(`- Duplicate-check field: ${sch.duplicate_check_field_id ? fieldLabelById(model, sch.duplicate_check_field_id) : 'none'}`);
  L.push(`- Custom buttons: ${(sch.custom_buttons || []).length}`);
  L.push('');

  // Card view
  const cc = model.card_config || {};
  if (cc.title_field_id || (cc.shown_field_ids || []).length) {
    L.push('## Card view');
    if (cc.title_field_id) L.push(`- Title: ${fieldLabelById(model, cc.title_field_id)}`);
    if (cc.subtitle_field_id) L.push(`- Subtitle: ${fieldLabelById(model, cc.subtitle_field_id)}`);
    if (cc.badge_field_id) L.push(`- Badge: ${fieldLabelById(model, cc.badge_field_id)}`);
    if ((cc.shown_field_ids || []).length) L.push(`- Shown: ${cc.shown_field_ids.map((id) => fieldLabelById(model, id)).join(', ')}`);
    L.push('');
  }

  // Maps view
  const mc = model.maps_config || {};
  const mapsHasContent = Object.entries(mc).some(([k, v]) => v !== null && v !== undefined && !(Array.isArray(v) && v.length === 0) && k !== 'click_action');
  if (mapsHasContent) {
    L.push('## Maps view');
    if (mc.location_url_field_id) L.push(`- Location URL field: ${fieldLabelById(model, mc.location_url_field_id)}`);
    if (mc.manual_lat_field_id || mc.manual_lng_field_id) L.push(`- Manual lat/lng: ${fieldLabelById(model, mc.manual_lat_field_id)} / ${fieldLabelById(model, mc.manual_lng_field_id)}`);
    if (mc.pin_color_field_id) L.push(`- Pin color field: ${fieldLabelById(model, mc.pin_color_field_id)}`);
    if (mc.pin_label_field_id) L.push(`- Pin label field: ${fieldLabelById(model, mc.pin_label_field_id)}`);
    L.push(`- Click action: ${mc.click_action || 'popup'}`);
    L.push('');
  }

  // Sections & fields
  L.push('## Sections & fields');
  L.push('');
  sections.forEach((section, idx) => {
    const badges = [];
    if (section.is_base) badges.push('base');
    if (section.is_mirrored) badges.push('mirrored');
    if (section.default_collapsed) badges.push('collapsed by default');
    if (section.color) badges.push(`color ${section.color}`);
    L.push(`### ${idx + 1}. ${section.label_en} / ${section.label_ar}${badges.length ? `  _(${badges.join(', ')})_` : ''}`);
    L.push('');

    if (section.is_mirrored) {
      L.push(`Mirrors section ${sectionLabelById(ctx.modelById.get(lookupTargetModelId(model, section.mirror_via_lookup_field_id)), section.mirror_source_section_id)} via lookup ${fieldLabelById(model, section.mirror_via_lookup_field_id)}. Fields render from the linked record at runtime.`);
      L.push('');
      return;
    }

    const fields = [...(section.fields || [])].sort((a, b) => (a.order ?? 0) - (b.order ?? 0) || String(a.id).localeCompare(String(b.id)));
    if (!fields.length) {
      L.push('_(no fields)_');
      L.push('');
      return;
    }

    L.push('| API name (slug) | Label (EN / AR) | Type | Required | Width | In table | Details |');
    L.push('| --- | --- | --- | --- | --- | --- | --- |');
    for (const f of fields) {
      L.push(`| ${cell(bt(f.name))} | ${cell(`${f.label_en} / ${f.label_ar}`)} | ${cell(FIELD_TYPE_LABEL[f.type] || f.type)} | ${bool(f.required)} | ${cell(f.width || '')} | ${bool(f.show_in_table)} | ${cell(fieldDetailHint(f))} |`);
    }
    L.push('');

    const detailLines = [];
    for (const f of fields) {
      const block = fieldDetailBlock(f, model);
      if (block.length) detailLines.push(...block);
    }
    if (detailLines.length) {
      L.push('**Field details:**');
      L.push('');
      L.push(...detailLines);
      L.push('');
    }
  });

  // Custom buttons
  const buttons = sch.custom_buttons || [];
  if (buttons.length) {
    L.push('## Custom buttons');
    L.push('');
    for (const b of buttons) {
      L.push(`- **${b.label_en} / ${b.label_ar}**${b.enabled === false ? ' _(disabled)_' : ''} — icon ${bt(b.icon || 'sparkles')}, shows in: ${(b.locations || []).join(', ') || '(nowhere)'}`);
      L.push(`  - action: ${describeButtonAction(b.action, model)}`);
    }
    L.push('');
  }

  return L.join('\n');
}

function lookupTargetModelId(model, lookupFieldId) {
  const f = fieldByIdOf(model, lookupFieldId);
  return f ? f.lookup_model_id : null;
}

function describeButtonAction(action, model) {
  if (!action) return '(none)';
  switch (action.type) {
    case 'trigger_workflow':
      return `run workflow ${bt(action.workflow_id)}`;
    case 'generate_design':
      return 'generate marketing design';
    case 'create_record': {
      const tgt = ctx.modelById.get(action.target_model_id);
      const maps = (action.prefill || []).map((p) => `${bt(p.target_field_name)} ← ${bt(p.source_field_name)}`).join(', ');
      return `create a ${tgt ? tgt.label_en : modelLabel(action.target_model_id)}${maps ? ` (prefill: ${maps})` : ''}`;
    }
    case 'find_or_create_record': {
      const tgt = ctx.modelById.get(action.target_model_id);
      const search = (action.search_by || []).map((p) => `${bt(p.target_field_name)} = ${bt(p.source_field_name)}`).join(' AND ');
      return `find or create a ${tgt ? tgt.label_en : modelLabel(action.target_model_id)}${search ? ` (match: ${search})` : ''}`;
    }
    default:
      return bt(action.type);
  }
}

// ── per-workflow PRD ──────────────────────────────────────────────────────────
function mappingSource(m, triggerModel) {
  switch (m.source_type) {
    case 'static': return `static value ${fmtValue(m.static_value)}`;
    case 'trigger_field': return `the trigger record's ${fieldLabelBySlug(triggerModel, m.trigger_field_id)}`;
    case 'current_date': return 'the current date';
    case 'current_user': return 'the current user';
    case 'record_id': return "the trigger record's id";
    case 'role_variable': return `a user chosen by role ${roleLabel(m.role_id)}${(m.role_conditions || []).length ? ` (${m.role_conditions.length} condition(s))` : ''}`;
    case 'date_expression': {
      const base = m.date_base === 'trigger_field' ? `trigger field ${fieldLabelBySlug(triggerModel, m.date_base_field_id)}` : 'the current date';
      return `${base} offset by ${bt(m.date_expression || '')}`;
    }
    case 'formula': return `formula ${bt(m.formula_expression || '')}`;
    default: return bt(m.source_type);
  }
}

function ivrDestination(action, triggerModel) {
  const to = action.to;
  if (to) {
    switch (to.kind) {
      case 'trigger_field': return `trigger record's ${fieldLabelBySlug(triggerModel, to.field_name)}`;
      case 'lookup': return `via lookup ${bt(to.lookup_field_name)} → ${bt(to.target_phone_field_name)}`;
      case 'static': return `static number ${bt(to.phone)}`;
      case 'prev_action_output': return `phone from a prior action's record (${bt(to.phone_field_name)})`;
      default: return bt(JSON.stringify(to));
    }
  }
  if (action.to_field_id) return `trigger record's ${fieldLabelBySlug(triggerModel, action.to_field_id)} (legacy)`;
  return '(unset)';
}

// Returns the action rendered as markdown lines (a bold header + bullets).
function renderAction(action, n, triggerModel) {
  const L = [];
  L.push(`**Action ${n} — ${ACTION_LABEL[action.type] || action.type}**`);
  switch (action.type) {
    case 'create_record': {
      const tgt = ctx.modelById.get(action.target_model_id);
      L.push(`Create a **${tgt ? modelLabelFull(tgt) : modelLabel(action.target_model_id)}** record with:`);
      for (const m of (action.field_mappings || [])) {
        L.push(`- ${fieldLabelBySlug(tgt, m.target_field_id)} ← ${mappingSource(m, triggerModel)}`);
      }
      if (!(action.field_mappings || []).length) L.push('- (no field mappings)');
      if (action.skip_if_exists) L.push(`- _Skipped if a record already exists with matching ${fieldLabelBySlug(tgt, action.dedup_target_field_id)}._`);
      break;
    }
    case 'update_record': {
      const tgt = ctx.modelById.get(action.target_model_id);
      const fv = action.filter_value_source === 'trigger_field'
        ? `the trigger record's ${fieldLabelBySlug(triggerModel, action.filter_trigger_field_id)}`
        : fmtFieldValue(tgt, action.filter_field_id, action.filter_value);
      L.push(`Update **${tgt ? modelLabelFull(tgt) : modelLabel(action.target_model_id)}** records where ${fieldLabelBySlug(tgt, action.filter_field_id)} = ${fv}, setting:`);
      for (const m of (action.field_mappings || [])) {
        L.push(`- ${fieldLabelBySlug(tgt, m.target_field_id)} ← ${mappingSource(m, triggerModel)}`);
      }
      if (!(action.field_mappings || []).length) L.push('- (no field mappings)');
      break;
    }
    case 'send_notification':
      L.push('Show an in-app notification:');
      L.push(`- EN: "${action.message_en || ''}"`);
      L.push(`- AR: "${action.message_ar || ''}"`);
      break;
    case 'assign_user':
      L.push(`Assign ${fieldLabelBySlug(triggerModel, action.assignment_field_id)}:`);
      if (action.mode === 'specific_user') {
        L.push(`- to a specific user (${bt(action.specific_user_id || '?')})`);
      } else {
        L.push(`- by role ${roleLabel(action.role_id)} · strategy: ${action.selection_strategy === 'least_workload' ? 'least workload' : 'first match'}`);
        for (const rc of (action.role_conditions || [])) {
          const val = rc.value_source === 'trigger_field' ? `the trigger record's ${fieldLabelBySlug(triggerModel, rc.trigger_field_id)}` : fmtValue(rc.value);
          L.push(`  - where ${bt(rc.field_name)} ${OPERATOR_WORDS[rc.operator] || rc.operator} ${val}`);
        }
      }
      break;
    case 'http_request':
      L.push('Send an HTTP request:');
      L.push(`- ${bt(`${action.method} ${action.url}`)}`);
      if ((action.headers || []).length) L.push(`- headers: ${action.headers.map((h) => bt(h.name)).join(', ')}`);
      L.push(`- body: ${action.body_mode || 'none'}`);
      if (action.body_mode === 'json_template' && action.body_template) {
        L.push('', FENCE, action.body_template, FENCE);
      } else if (action.body_mode === 'form_mappings') {
        for (const m of (action.body_mappings || [])) L.push(`  - ${bt(m.target_field_id)} ← ${mappingSource(m, triggerModel)}`);
      }
      L.push(`- timeout: ${action.timeout_ms ?? 30000} ms`);
      break;
    case 'outbound_ivr':
      L.push('Place an automated phone call:');
      L.push(`- to: ${ivrDestination(action, triggerModel)}`);
      if (action.audio_mode === 'audio') {
        L.push(`- audio file: ${action.audio_file_label || action.audio_file_url || '(unset)'}`);
      } else {
        L.push(`- speaks (TTS, ${action.tts_voice || 'default voice'}): "${truncate(action.tts_text, 200)}"`);
      }
      if (action.language) L.push(`- language: ${action.language}`);
      if ((action.options || []).length) {
        L.push('- menu:');
        for (const o of action.options) L.push(`  - press ${bt(o.digit)} → ${o.label_en}`);
      }
      break;
    case 'send_whatsapp_message':
      L.push('Send a WhatsApp message:');
      L.push(`- to: ${ivrDestination(action, triggerModel)}`);
      L.push(`- device: ${action.device_id ? bt(action.device_id) : '(default device)'}`);
      L.push('- body:');
      L.push('', FENCE, action.body_template || '', FENCE);
      break;
    case 'paseet_query':
      L.push('Run a Paseet AI query:');
      L.push('- prompt:');
      L.push('', FENCE, action.prompt_template || '', FENCE);
      L.push(`- response shape: ${action.response_shape}`);
      for (const rm of (action.response_mappings || [])) {
        L.push(`  - ${rm.kind} → ${fieldLabelBySlug(triggerModel, rm.target_field_id)}${rm.parse_as ? ` (as ${rm.parse_as})` : ''}`);
      }
      break;
    default:
      L.push(`(unrecognized action type ${bt(action.type)})`);
  }
  return L;
}

function renderConditions(conditions, mode, triggerModel) {
  const L = [];
  const join = mode === 'any' ? 'ANY must pass (OR)' : 'ALL must pass (AND)';
  if (!conditions || !conditions.length) {
    L.push('- _(no conditions — always runs)_');
    return L;
  }
  L.push(`_Match: ${join}_`);
  for (const c of conditions) {
    const onChange = c.only_on_change ? ' · _only when it newly becomes true_' : '';
    if (c.operator === 'is_empty' || c.operator === 'is_not_empty') {
      L.push(`- ${fieldLabelBySlug(triggerModel, c.field_id)} ${OPERATOR_WORDS[c.operator] || c.operator}${onChange}`);
    } else {
      L.push(`- ${fieldLabelBySlug(triggerModel, c.field_id)} ${OPERATOR_WORDS[c.operator] || c.operator} ${fmtFieldValue(triggerModel, c.field_id, c.value)}${onChange}`);
    }
  }
  return L;
}

function renderWorkflow(workflow) {
  const L = [];
  const triggerModel = workflow.trigger_model_id ? ctx.modelById.get(workflow.trigger_model_id) : null;

  L.push(banner());
  L.push('');
  L.push(`# Workflow: ${workflow.label_en} / ${workflow.label_ar}`);
  L.push('');
  L.push('**Status:** Auto-generated (do not hand-edit) — reflects live Supabase');
  L.push(`**Last updated (from DB):** ${ymd(workflow.updated_at)}`);
  L.push(`**Workflow id:** ${bt(workflow.id)}   ·   **Active:** ${bool(workflow.is_active)}`);
  const grp = workflow.group_id ? ctx.workflowGroupById.get(workflow.group_id) : null;
  L.push(`**Group:** ${grp ? grp.label_en : '(ungrouped)'}`);
  L.push(`**Trigger:** ${TRIGGER_EVENT_DESC[workflow.trigger_event] || workflow.trigger_event}`);
  if (workflow.trigger_event !== 'webhook') {
    L.push(`**Trigger model:** ${triggerModel ? `${modelLabelFull(triggerModel)} ${bt(triggerModel.name)}` : (workflow.trigger_model_id ? modelLabel(workflow.trigger_model_id) : '(none)')}`);
  }
  if (workflow.trigger_event === 'webhook' && workflow.trigger_webhook_slug_id) {
    const wh = ctx.webhookSlugById.get(workflow.trigger_webhook_slug_id);
    L.push(`**Webhook:** ${wh ? `${wh.name} (${bt(wh.slug)})` : bt(workflow.trigger_webhook_slug_id)}`);
  }
  L.push('');

  const branches = Array.isArray(workflow.branches) ? workflow.branches : [];

  if (branches.length) {
    L.push('## Logic (branched)');
    L.push('');
    branches.forEach((branch, i) => {
      const nonElse = branches.filter((b) => !b.is_else);
      const pos = branch.is_else ? 'OTHERWISE' : (nonElse.indexOf(branch) === 0 ? 'IF' : 'ELSE IF');
      const label = (branch.label_en || branch.label_ar) ? ` — ${branch.label_en || branch.label_ar}` : '';
      L.push(`### Branch ${i + 1}: ${pos}${label}`);
      L.push('');
      L.push('**Conditions:**');
      L.push(...renderConditions(branch.conditions, branch.condition_mode, triggerModel));
      L.push('');
      L.push('**Actions (run in order):**');
      L.push('');
      const actions = branch.actions || [];
      if (!actions.length) L.push('_(no actions)_');
      actions.forEach((a, ai) => {
        L.push(...renderAction(a, ai + 1, triggerModel));
        L.push('');
      });
    });
  } else {
    L.push('## Logic (flat / legacy shape)');
    L.push('');
    L.push('_This workflow predates the branched editor; it uses the flat conditions + actions shape._');
    L.push('');
    L.push('**Conditions (all must pass):**');
    L.push(...renderConditions(workflow.conditions, 'all', triggerModel));
    L.push('');
    L.push('**Actions (run in order):**');
    L.push('');
    const actions = workflow.actions || [];
    if (!actions.length) L.push('_(no actions)_');
    actions.forEach((a, ai) => {
      L.push(...renderAction(a, ai + 1, triggerModel));
      L.push('');
    });
  }

  return L.join('\n');
}

// ── index files ─────────────────────────────────────────────────────────────
function renderModelsIndex(models) {
  const L = [];
  L.push(banner());
  L.push('');
  L.push('# Models — auto-generated index');
  L.push('');
  L.push(`**${models.length} models.** Auto-generated from Supabase by ${bt('npm run sync:prds')}. Do not hand-edit.`);
  L.push('');
  L.push('| Model | API name | Storage | Group | Sections | Fields | Custom UI | Updated |');
  L.push('| --- | --- | --- | --- | --- | --- | --- | --- |');
  for (const m of models) {
    const grp = m.group_id ? ctx.modelGroupById.get(m.group_id) : null;
    const storage = m.is_hardcoded ? `frozen ${bt(m.table_name || m.name)}` : 'JSONB';
    L.push(`| [${cell(m.label_en)}](${slugify(m.name)}.md) | ${cell(bt(m.name))} | ${storage} | ${cell(grp ? grp.label_en : '—')} | ${sectionsOf(m).length} | ${allFieldsOf(m).length} | ${bool(CUSTOM_UI_MODELS.has(m.name))} | ${ymd(m.updated_at)} |`);
  }
  L.push('');
  return L.join('\n');
}

function renderWorkflowsIndex(workflows) {
  const L = [];
  L.push(banner());
  L.push('');
  L.push('# Workflows — auto-generated index');
  L.push('');
  L.push(`**${workflows.length} workflows.** Auto-generated from Supabase by ${bt('npm run sync:prds')}. Do not hand-edit.`);
  L.push('');
  L.push('| Workflow | Trigger | On model | Active | Branches | Actions | Updated |');
  L.push('| --- | --- | --- | --- | --- | --- | --- |');
  for (const w of workflows) {
    const file = `${slugify(w.label_en || w.label_ar)}-${String(w.id).slice(0, 8)}.md`;
    const tgt = w.trigger_model_id ? ctx.modelById.get(w.trigger_model_id) : null;
    const branches = Array.isArray(w.branches) ? w.branches : [];
    const actionCount = branches.length
      ? branches.reduce((acc, b) => acc + (b.actions || []).length, 0)
      : (w.actions || []).length;
    L.push(`| [${cell(w.label_en)}](${file}) | ${cell(w.trigger_event)} | ${cell(tgt ? tgt.label_en : (w.trigger_event === 'webhook' ? '— (webhook)' : '—'))} | ${bool(w.is_active)} | ${branches.length || 'flat'} | ${actionCount} | ${ymd(w.updated_at)} |`);
  }
  L.push('');
  return L.join('\n');
}

// ── filesystem ─────────────────────────────────────────────────────────────
function ensureDir(d) { if (!existsSync(d)) mkdirSync(d, { recursive: true }); }
function writeFileLF(p, content) {
  let body = String(content).replace(/\r\n/g, '\n');
  if (!body.endsWith('\n')) body += '\n';
  writeFileSync(p, body, 'utf8');
}
// Prune generated .md files no longer backed by a current artifact. HARD-SCOPED
// to the two generated dirs (asserted by path suffix), never recurses, never
// touches README.md or the hand-written PRDs in docs/prd/ root.
function pruneDir(dir, keepSet) {
  const norm = dir.replace(/\\/g, '/');
  if (!(norm.endsWith('docs/prd/models') || norm.endsWith('docs/prd/workflows'))) {
    throw new Error(`refusing to prune unexpected directory: ${dir}`);
  }
  let pruned = 0;
  for (const name of readdirSync(dir)) {
    if (!name.endsWith('.md') || name === 'README.md' || keepSet.has(name)) continue;
    unlinkSync(join(dir, name));
    process.stderr.write(`[sync:prds] pruned stale ${norm.split('/').slice(-1)[0]}/${name}\n`);
    pruned++;
  }
  return pruned;
}

// ── main ────────────────────────────────────────────────────────────────────
async function main() {
  const [models, workflows, modelGroups, workflowGroups, webhookSlugs, roles, profiles] = await Promise.all([
    loadAll('models'),        // core — abort on error
    loadAll('workflows'),     // core — abort on error
    loadAux('model_groups'),
    loadAux('workflow_groups'),
    loadAux('webhook_slugs'),
    loadAux('roles'),
    loadAux('profiles'),
  ]);

  ctx.modelById = new Map(models.map((m) => [m.id, m]));
  ctx.modelGroupById = new Map(modelGroups.map((g) => [g.id, g]));
  ctx.workflowGroupById = new Map(workflowGroups.map((g) => [g.id, g]));
  ctx.webhookSlugById = new Map(webhookSlugs.map((w) => [w.id, w]));
  ctx.roleById = new Map(roles.map((r) => [r.id, r]));
  ctx.profileById = new Map(profiles.map((p) => [p.id, p]));

  const modelsDir = join(ROOT, 'docs', 'prd', 'models');
  const workflowsDir = join(ROOT, 'docs', 'prd', 'workflows');
  ensureDir(modelsDir);
  ensureDir(workflowsDir);

  // Models
  const sortedModels = [...models].sort((a, b) => String(a.name).localeCompare(String(b.name)));
  const modelFiles = new Set(['README.md']);
  for (const m of sortedModels) {
    const fname = `${slugify(m.name)}.md`;
    modelFiles.add(fname);
    writeFileLF(join(modelsDir, fname), renderModel(m));
  }
  writeFileLF(join(modelsDir, 'README.md'), renderModelsIndex(sortedModels));
  const prunedModels = pruneDir(modelsDir, modelFiles);

  // Workflows
  const sortedWf = [...workflows].sort((a, b) => String(a.label_en || '').localeCompare(String(b.label_en || '')) || String(a.id).localeCompare(String(b.id)));
  const wfFiles = new Set(['README.md']);
  for (const w of sortedWf) {
    const fname = `${slugify(w.label_en || w.label_ar)}-${String(w.id).slice(0, 8)}.md`;
    wfFiles.add(fname);
    writeFileLF(join(workflowsDir, fname), renderWorkflow(w));
  }
  writeFileLF(join(workflowsDir, 'README.md'), renderWorkflowsIndex(sortedWf));
  const prunedWf = pruneDir(workflowsDir, wfFiles);

  console.log(`[sync:prds] ${sortedModels.length} models, ${sortedWf.length} workflows written; ${prunedModels + prunedWf} stale pruned (${prunedModels} models, ${prunedWf} workflows).`);
  console.log(`[sync:prds] auth: ${USING_SERVICE_ROLE ? 'service-role' : 'anon'} · output: docs/prd/models, docs/prd/workflows`);
}

main().catch((err) => {
  const reason = (err && err.message) || String(err);
  if (HOOK_MODE) {
    process.stderr.write(`[sync:prds] skipped — ${reason}\n`);
    process.exit(0);
  }
  console.error(`[sync:prds] FAILED — ${reason}`);
  process.exit(1);
});
