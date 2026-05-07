/**
 * Wassel model-builder AI agent — server-side logic.
 *
 * A separate Claude agent dedicated to translating natural-language
 * descriptions into actual model schema mutations. Sibling of the
 * workflow-builder agent (api/_lib/workflowAgent.ts) — same SSE
 * pattern, same tool-loop discipline, different surface.
 *
 * Tools it exposes:
 *   get_app_context         — full inventory: models with their schemas,
 *                             groups, field-type catalog, icon catalog.
 *   create_model            — create a new model with optional initial
 *                             sections + fields. Server assigns UUIDs.
 *   update_model_metadata   — change a model's labels, icon, color,
 *                             group. Does NOT touch the schema.
 *   delete_model            — delete a non-system model (and cascade).
 *   add_section             — append a section to a model.
 *   update_section          — modify a section's labels / color / order
 *                             / is_base / default_collapsed flags.
 *   delete_section          — remove a section and all its fields.
 *   add_field               — append a field to a section. Handles all
 *                             21 field types via a permissive input
 *                             schema; type-specific knobs (options,
 *                             lookup_model_id, formula_expression, etc.)
 *                             are passed through verbatim.
 *   update_field            — modify a field's properties. Does NOT
 *                             support slug renames — those need the
 *                             Builder's confirmation modal because they
 *                             cascade across records / formulas /
 *                             workflows / views.
 *   delete_field            — remove a field from its section.
 *   create_model_group      — add a sidebar folder.
 *   rename_model_group      — update a folder's labels.
 *   delete_model_group      — delete a folder. Models inside become
 *                             ungrouped via ON DELETE SET NULL.
 *   set_model_group         — move a model into / out of a folder.
 *
 * Conversation history lives on the client (no persistence — the value
 * is the model that gets created / mutated, not the chat).
 */

import type Anthropic from '@anthropic-ai/sdk';
import type { SupabaseClient } from '@supabase/supabase-js';

// Vercel Edge functions don't ship the Node 'crypto' module — they expose
// the Web Crypto API as a global instead. `crypto.randomUUID()` is part
// of that surface and works identically to Node's version.
const newId = (): string => crypto.randomUUID();

export const BUILDER_AGENT_MODEL = 'claude-opus-4-7';
export const BUILDER_AGENT_MAX_TOKENS = 16_000;

// Frozen string so prompt-caching stays warm. Update CAREFULLY — every
// edit invalidates the cache for the next several hours of traffic.
export const BUILDER_AGENT_SYSTEM_PROMPT = `You are the Wassel Model Builder — an AI assistant inside the Wassel CRM (وصل العقارية, a Saudi Arabian real-estate marketing CRM) whose ONLY job is to help users design their data models — the CRM's tables, sections, and fields — by talking to them in natural language.

# Your job
A user describes a data model in plain English or Arabic ("a Properties model with photos and price", "add a phone field to Clients", "delete the inventory table"). You ask a few clarifying questions if needed, then call the right tool to make the change. You can also organize models into sidebar folders.

You don't enter records into models; you build, edit, delete the models themselves.

# How models work in this app

A **model** is a custom table the user designs. It has:
 - A snake_case \`name\` (slug, unique across the app) — used in URLs and as a stable identifier.
 - Bilingual display labels: \`label_ar\` (Arabic) and \`label_en\` (English).
 - An \`icon\` (Lucide icon name, kebab-case, see the catalog) and \`color\` (hex).
 - A \`group_id\` (sidebar folder, optional) and \`order\` (sidebar position, server-assigned).
 - An \`is_system\` flag — TRUE for the 7 pre-built system models; you CANNOT delete those.
 - A \`schema\` containing \`sections[]\` and an optional \`section_selector_field_id\`.

A **section** is a grouping inside a model. It has:
 - \`id\` (UUID, server-assigned), \`label_ar\`, \`label_en\`, \`order\`, \`color\`.
 - \`is_base\` — base sections always show on the record form regardless of the section_selector value.
 - \`fields[]\` — the inputs.
 - Optional \`default_collapsed\` to start the section collapsed in the form.

A **field** is one input. It has:
 - \`id\` (UUID, server-assigned), \`name\` (snake_case slug, unique within the model), \`label_ar\`, \`label_en\`.
 - \`type\` (one of 21 types — see catalog below).
 - \`required\` (boolean), \`width\` ('full' | 'half' | 'third'), \`show_in_table\` (boolean).
 - \`order\` (within section), \`section_id\` (parent section UUID).
 - Type-specific config (only the keys that apply to the chosen type — see field-type catalog).

# Field-type catalog — what each type needs

Pick the type that best fits the data. Pass ONLY the type-specific config that the chosen type accepts:

 - \`text\` — short string. No extra config.
 - \`textarea\` — long string. No extra config.
 - \`number\` — numeric input. No extra config.
 - \`email\` — email validation. No extra config.
 - \`phone\` — phone with country code. Optional \`default_country_code\` (e.g. "+966").
 - \`date\` — date only.
 - \`datetime\` — date + time.
 - \`currency\` — money (always SAR for this app). No extra config.
 - \`url\` — URL.
 - \`checkbox\` — boolean.
 - \`dropdown\` — single-select from a list. REQUIRES \`options\`: array of \`{ label_ar, label_en, value (slug, unique within field), color? }\`. Optional \`option_groups\` for collapsible headers.
 - \`multiselect\` — multi-select. Same \`options\` shape as dropdown.
 - \`lookup\` — picks a record from another model. REQUIRES \`lookup_model_id\` (target model id) and \`lookup_display_field\` (slug of a scalar field on the target). Optional \`is_multi\` (true → array of ids), \`lookup_max_records\` (default 20, range 1–500).
 - \`mirror\` — read-only copy of a field on a related record. REQUIRES \`mirror_via_lookup_field_id\` (UUID of a sibling \`lookup\` field on this same model) and \`mirror_target_field_name\` (slug on the lookup's target model). Cannot be required. Cannot chain (mirror → mirror).
 - \`section_mirror\` — pulls a SUBSET of another record's section inline. Container field, no width / show_in_table. REQUIRES \`section_mirror_via_lookup_field_id\` and \`section_mirror_source_section_id\`. Optional: \`section_mirror_field_mode\` ('all' | 'custom'), \`section_mirror_field_names\` (when custom), \`section_mirror_edit_mode\` ('all' | 'none' | 'custom', default 'none'), \`section_mirror_editable_field_names\`, \`section_mirror_sync_mode\`, \`section_mirror_sync_field_names\`. Most users want the simpler \`mirror\` field — only suggest \`section_mirror\` when the user asks for editing a related record's data inline.
 - \`section_selector\` — controls which non-base sections appear in this record's form. The model can have at most ONE section_selector field. Its options auto-populate from non-base section names — leave \`options\` empty when adding it; the Builder fills them. Custom non-section options can be added afterwards.
 - \`assignee\` — picks a user. Optional \`assignee_role_ids\` to limit the picker to specific roles.
 - \`notes\` — append-only journal of timestamped entries. No extra config.
 - \`range\` — pair of min/max numbers. Optional \`range_min\`, \`range_max\`, \`range_step\`, \`range_unit_ar\`, \`range_unit_en\` (e.g. "م²" / "m²").
 - \`auto_id\` — auto-incrementing identifier. Optional \`auto_id_prefix\` (e.g. "CLT-"), \`auto_id_padding\` (default 3), \`auto_id_start_value\` (default 1), \`auto_id_scope_field_id\` (sibling field whose value scopes the counter). Forced \`required: false\`.
 - \`formula\` — computed read-only value via Excel-like template. REQUIRES \`formula_expression\` (e.g. "{price} * {qty}", "CONCAT({first_name}, \\" \\", {last_name})", "IF({is_paid}, \\"PAID\\", \\"UNPAID\\")"). Optional \`formula_output_type\` ('number' | 'currency' | 'percentage' | 'text', default 'number'), \`formula_decimals\` (0–6, default 2), \`formula_currency\` (default 'SAR'), \`formula_thousands_separator\` (default true). Forced \`required: false\`.
 - \`table\` — inline editable table stored as an array of rows. REQUIRES \`table_columns\` (array of \`{ name (slug), label_ar, label_en, type ('text' | 'textarea' | 'number' | 'currency' | 'date' | 'url' | 'dropdown'), required?, options? for dropdown columns }\`). Optional \`table_min_rows\`, \`table_max_rows\`.

# Icon catalog
The icon must be one of the supported Lucide names (kebab-case): \`users\`, \`phone-call\`, \`building-2\`, \`target\`, \`star\`, \`file-search\`, \`database\`, \`globe\`, \`folder\`, \`briefcase\`, \`calendar\`, \`mail\`, \`truck\`, \`home\`, \`map-pin\`, \`clipboard\`, \`tag\`, \`layers\`, \`grid\`, \`box\`, \`package\`, \`activity\`, \`zap\`, \`bell\`, \`flag\`, \`heart\`, \`award\`, \`shield\`. Default to \`database\` if unsure.

# Color guidance
Default to the brand palette: \`#B8734F\` (copper, the primary), \`#8E4E3A\` (terracotta), \`#C09B5F\` (gold), \`#4A2C2A\` (chocolate), \`#4A4E54\` (charcoal), \`#D4B896\` (sand). Pick something distinct from neighboring models. Outside-palette colors are allowed but stay tasteful.

# Operating procedure

1. **First call \`get_app_context\`** before doing ANYTHING else. This tells you which models, groups, sections, fields, and slugs already exist. NEVER guess at IDs or assume a slug exists — they all come from this dump.

2. **Match labels to slugs.** The user usually says English or Arabic names ("Clients" / "العملاء") — you must look up the actual model id from the context. If multiple models match, list them and ask.

3. **Ask ONE clarifying question at a time** when ambiguous. Examples:
   - "Add a model for properties" — ask: which fields? (or offer a sensible default set: name, type, location, price, status, agent.)
   - "Add a status field to Clients" — ask: dropdown with which options? Required or optional?
   - "Connect this to clients" — ask: do you want a lookup field (single picker), or to mirror a clients field?

4. **Confirm destructive actions** before calling. Deleting a model loses all its records (cascade). Deleting a field loses that column's data on every record. Deleting a section loses all its fields. SHOW the user what will be lost and require explicit confirmation ("yes, delete it") before issuing the tool call.

5. **Match the user's language.** Arabic in → Arabic out. English in → English out. Always set BOTH \`label_ar\` AND \`label_en\` on every model / section / field / option — when the user gives only one, derive a sensible translation for the other (don't leave fields untranslated).

6. **Don't invent IDs.** Field slugs and existing ids come from \`get_app_context\`. The server fills in section / field / option UUIDs and the model id automatically — leave those empty/missing in your tool calls and they'll be added.

7. **Use snake_case for slugs.** Field \`name\` and option \`value\` are slugs: lowercase ASCII, words separated by underscores, no spaces or hyphens. The model \`name\` is also a snake_case slug and must be unique across all models.

8. **System models can be edited but NOT deleted.** \`get_app_context\` marks each model with \`is_system\`. Refuse delete_model on system models — say so plainly and offer to edit instead.

9. **Slug renames are not supported in this agent.** Field \`name\` slugs cascade across records, formulas, lookups, mirrors, workflows, and views — that needs the Builder UI's confirmation modal. If the user asks to rename a slug, explain that and direct them to "API name / اسم API" in the Field Properties panel of the Builder. Label changes (label_ar / label_en) are fine through update_field — those are display-only.

10. **Honesty rules.** If the user asks for something the data model can't express (e.g. "make this field encrypted" — no such config), say so plainly. If a field they reference doesn't exist, list the actual fields and ask them to pick.

11. **Keep responses short.** This is a model builder, not a chatbot. Aim for 2–4 sentence replies — ask the next thing you need, confirm what you're about to build, or report what was created.

12. **After a tool call succeeds**, tell the user what changed in one sentence and offer the next logical step (e.g. "Created the Properties model. Want to add fields, or open it in the Builder to fine-tune visuals?").

# Managing folders

Folders organize models in the sidebar. Each model has a nullable \`group_id\`; null means "ungrouped" (the default).

When to use:
 - "Create a folder called Sales" → \`create_model_group\`. Always set BOTH label_ar and label_en.
 - "Rename the Sales folder to Pipeline" → \`rename_model_group\`.
 - "Delete the Sales folder" → \`delete_model_group\`. WARN the user first if the folder still has models in it (they'll become ungrouped, not deleted).
 - "Move the Properties model into Sales" → \`set_model_group\` with model_id + group_id. Pass empty group_id to ungroup.

# What NOT to do
 - Don't say "I created..." or "I deleted..." until the tool actually returns success.
 - Don't suggest creating a model that already exists — point at the existing one and ask what to add.
 - Don't try to delete a system model. Refuse and offer to edit instead.
 - Don't invent field types beyond the 21 listed above.
 - Don't add \`is_system: true\` on user-created models. The server forces it to false anyway.
 - Don't write JSON blobs in your assistant text — emit changes via tool calls.

Begin.`;

type ToolUnion = Anthropic.Messages.Tool;

export const BUILDER_AGENT_TOOLS: ToolUnion[] = [
  {
    name: 'get_app_context',
    description:
      "Get a complete inventory of the app's models: every model with its full schema (sections, fields, field types, options for dropdowns, lookup targets, formula expressions, etc.), every group/folder, and the catalog of supported field types and icons. Call this FIRST before any other tool so you have correct IDs and slugs to reference. The agent should not invent IDs — they all come from this dump.",
    input_schema: { type: 'object', properties: {} },
  },
  {
    name: 'create_model',
    description:
      "Create a new model. The server assigns UUIDs to the model itself, every section, and every field — leave those empty/missing in your call. Use snake_case for the model `name` slug; it must be unique across all models. Bilingual labels are required. Initial sections + fields are optional — you can pass an empty schema and add via add_section / add_field. Always include at least one base section (`is_base: true`) so the form has somewhere to render fields. Returns the full saved model row.",
    input_schema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'snake_case slug, unique across all models (e.g. "properties", "leads").' },
        label_ar: { type: 'string', description: 'Arabic display label.' },
        label_en: { type: 'string', description: 'English display label.' },
        icon: { type: 'string', description: 'Lucide icon name (kebab-case). See the icon catalog. Defaults to "database".' },
        color: { type: 'string', description: 'Hex color for the sidebar dot and accents (e.g. "#B8734F"). Defaults to copper.' },
        group_id: { type: 'string', description: 'Optional folder id (model_groups.id). Omit for ungrouped.' },
        sections: {
          type: 'array',
          description: 'Optional initial sections. At least one is recommended (mark it is_base: true). Each section may include initial fields.',
          items: {
            type: 'object',
            properties: {
              label_ar: { type: 'string' },
              label_en: { type: 'string' },
              color: { type: 'string', description: 'Hex color. Defaults to the model color.' },
              is_base: { type: 'boolean', description: 'Base sections always show on the record form.' },
              default_collapsed: { type: 'boolean', description: 'Start collapsed in the form.' },
              fields: {
                type: 'array',
                description: 'Optional initial fields for this section. Each field shape varies by `type` — see the field-type catalog in the system prompt.',
                items: {
                  type: 'object',
                  description: 'A field. Required: name, label_ar, label_en, type. Type-specific config keys passed through (options, lookup_model_id, formula_expression, etc.).',
                  properties: {
                    name: { type: 'string' },
                    label_ar: { type: 'string' },
                    label_en: { type: 'string' },
                    type: { type: 'string' },
                  },
                  required: ['name', 'label_ar', 'label_en', 'type'],
                },
              },
            },
            required: ['label_ar', 'label_en'],
          },
        },
      },
      required: ['name', 'label_ar', 'label_en'],
    },
  },
  {
    name: 'update_model_metadata',
    description:
      "Update a model's display labels, icon, color, or sidebar group. Pass only the keys you want changed — omitted keys stay as they were. Does NOT touch the schema (use add/update/delete_section + _field for those). Does NOT support changing the slug `name` (use the Builder UI). Returns the full updated model.",
    input_schema: {
      type: 'object',
      properties: {
        model_id: { type: 'string', description: 'Model id from get_app_context.' },
        label_ar: { type: 'string' },
        label_en: { type: 'string' },
        icon: { type: 'string', description: 'Lucide icon name (kebab-case).' },
        color: { type: 'string', description: 'Hex color.' },
        group_id: { type: 'string', description: 'Folder id, or empty string to ungroup.' },
      },
      required: ['model_id'],
    },
  },
  {
    name: 'delete_model',
    description:
      "Delete a model and ALL its records (server-side CASCADE). REFUSES to delete system models (is_system: true) — those are protected. Confirm with the user before calling — this is destructive. Returns ok + deleted_model_id on success.",
    input_schema: {
      type: 'object',
      properties: {
        model_id: { type: 'string', description: 'Model id to delete.' },
      },
      required: ['model_id'],
    },
  },
  {
    name: 'add_section',
    description:
      "Append a section to a model's schema. Section UUID is server-assigned. Order is appended (last). Returns the full updated model row.",
    input_schema: {
      type: 'object',
      properties: {
        model_id: { type: 'string' },
        label_ar: { type: 'string' },
        label_en: { type: 'string' },
        color: { type: 'string', description: 'Hex color. Defaults to the model color.' },
        is_base: { type: 'boolean', description: 'Base sections always show. Defaults to false (the section_selector controls visibility for non-base sections).' },
        default_collapsed: { type: 'boolean' },
        fields: {
          type: 'array',
          description: 'Optional initial fields. Same shape as create_model.sections[].fields.',
          items: {
            type: 'object',
            properties: {
              name: { type: 'string' },
              label_ar: { type: 'string' },
              label_en: { type: 'string' },
              type: { type: 'string' },
            },
            required: ['name', 'label_ar', 'label_en', 'type'],
          },
        },
      },
      required: ['model_id', 'label_ar', 'label_en'],
    },
  },
  {
    name: 'update_section',
    description:
      "Update a section's labels, color, base flag, default-collapsed flag, or order. Pass only the keys you want changed. Returns the full updated model row.",
    input_schema: {
      type: 'object',
      properties: {
        model_id: { type: 'string' },
        section_id: { type: 'string' },
        label_ar: { type: 'string' },
        label_en: { type: 'string' },
        color: { type: 'string' },
        is_base: { type: 'boolean' },
        default_collapsed: { type: 'boolean' },
        order: { type: 'number', description: 'New order index. Sections with lower numbers render first.' },
      },
      required: ['model_id', 'section_id'],
    },
  },
  {
    name: 'delete_section',
    description:
      "Delete a section AND all its fields. The deleted fields' data on every record stays in JSONB but becomes orphaned (not visible anywhere). CONFIRM with the user before calling. Returns the full updated model row.",
    input_schema: {
      type: 'object',
      properties: {
        model_id: { type: 'string' },
        section_id: { type: 'string' },
      },
      required: ['model_id', 'section_id'],
    },
  },
  {
    name: 'add_field',
    description:
      "Append a field to a section. Field UUID is server-assigned; you supply the slug `name` (snake_case, unique within the model), `type`, bilingual labels, and any type-specific config keys. Order is appended (last). The auto_id, formula, mirror, section_mirror, and table types are all supported — pass their type-specific keys verbatim. Returns the full updated model row.",
    input_schema: {
      type: 'object',
      properties: {
        model_id: { type: 'string' },
        section_id: { type: 'string', description: 'Parent section id. Must already exist on the model.' },
        name: { type: 'string', description: 'snake_case slug, unique within the model.' },
        label_ar: { type: 'string' },
        label_en: { type: 'string' },
        type: { type: 'string', description: 'One of the 21 supported types — see catalog.' },
        required: { type: 'boolean', description: 'Defaults to false. Forced false for auto_id, formula, mirror.' },
        width: { type: 'string', enum: ['full', 'half', 'third'], description: 'Layout width. Defaults to "half".' },
        show_in_table: { type: 'boolean', description: 'Show as a column in the records table. Defaults to false.' },
        // Type-specific config — all optional, pass only the ones the chosen type uses.
        options: {
          type: 'array',
          description: 'Dropdown / multiselect options.',
          items: {
            type: 'object',
            properties: {
              label_ar: { type: 'string' },
              label_en: { type: 'string' },
              value: { type: 'string', description: 'Slug, unique within the field. Stored on records.' },
              color: { type: 'string', description: 'Optional hex color for the chip.' },
            },
            required: ['label_ar', 'label_en', 'value'],
          },
        },
        lookup_model_id: { type: 'string', description: 'For type=lookup: target model id.' },
        lookup_display_field: { type: 'string', description: 'For type=lookup: slug of a scalar field on the target model.' },
        is_multi: { type: 'boolean', description: 'For type=lookup: allow multiple selections.' },
        lookup_max_records: { type: 'number', description: 'For type=lookup: cap on records shown in the picker (1–500, default 20).' },
        default_country_code: { type: 'string', description: 'For type=phone: country code prefix (default "+966").' },
        mirror_via_lookup_field_id: { type: 'string', description: 'For type=mirror: UUID of a sibling lookup field on this same model.' },
        mirror_target_field_name: { type: 'string', description: 'For type=mirror: slug of a field on the lookup target model.' },
        section_mirror_via_lookup_field_id: { type: 'string' },
        section_mirror_source_section_id: { type: 'string' },
        section_mirror_field_mode: { type: 'string', enum: ['all', 'custom'] },
        section_mirror_field_names: { type: 'array', items: { type: 'string' } },
        section_mirror_edit_mode: { type: 'string', enum: ['all', 'none', 'custom'] },
        section_mirror_editable_field_names: { type: 'array', items: { type: 'string' } },
        section_mirror_sync_mode: { type: 'string', enum: ['all', 'none', 'custom'] },
        section_mirror_sync_field_names: { type: 'array', items: { type: 'string' } },
        range_min: { type: 'number' },
        range_max: { type: 'number' },
        range_step: { type: 'number' },
        range_unit_ar: { type: 'string' },
        range_unit_en: { type: 'string' },
        auto_id_prefix: { type: 'string' },
        auto_id_padding: { type: 'number' },
        auto_id_start_value: { type: 'number' },
        auto_id_scope_field_id: { type: 'string' },
        formula_expression: { type: 'string' },
        formula_output_type: { type: 'string', enum: ['number', 'currency', 'percentage', 'text'] },
        formula_decimals: { type: 'number' },
        formula_currency: { type: 'string' },
        formula_thousands_separator: { type: 'boolean' },
        assignee_role_ids: { type: 'array', items: { type: 'string' } },
        table_columns: {
          type: 'array',
          description: 'For type=table: column definitions.',
          items: {
            type: 'object',
            properties: {
              name: { type: 'string' },
              label_ar: { type: 'string' },
              label_en: { type: 'string' },
              type: { type: 'string', enum: ['text', 'textarea', 'number', 'currency', 'date', 'url', 'dropdown'] },
              required: { type: 'boolean' },
            },
            required: ['name', 'label_ar', 'label_en', 'type'],
          },
        },
        table_min_rows: { type: 'number' },
        table_max_rows: { type: 'number' },
      },
      required: ['model_id', 'section_id', 'name', 'label_ar', 'label_en', 'type'],
    },
  },
  {
    name: 'update_field',
    description:
      "Update a field's properties. Does NOT support changing the slug `name` — that requires the Builder UI's confirmation modal because it cascades across records, formulas, workflows, and views. To rename a field's display labels, pass label_ar / label_en. To change the field's type, pass `type` (the user is responsible for any data interpretation issues). Pass only the keys you want changed — omitted keys stay as they were. Returns the full updated model row.",
    input_schema: {
      type: 'object',
      properties: {
        model_id: { type: 'string' },
        field_id: { type: 'string' },
        label_ar: { type: 'string' },
        label_en: { type: 'string' },
        type: { type: 'string' },
        required: { type: 'boolean' },
        width: { type: 'string', enum: ['full', 'half', 'third'] },
        show_in_table: { type: 'boolean' },
        section_id: { type: 'string', description: 'Move the field to a different section.' },
        order: { type: 'number' },
        options: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              label_ar: { type: 'string' },
              label_en: { type: 'string' },
              value: { type: 'string' },
              color: { type: 'string' },
            },
            required: ['label_ar', 'label_en', 'value'],
          },
        },
        lookup_model_id: { type: 'string' },
        lookup_display_field: { type: 'string' },
        is_multi: { type: 'boolean' },
        lookup_max_records: { type: 'number' },
        default_country_code: { type: 'string' },
        mirror_via_lookup_field_id: { type: 'string' },
        mirror_target_field_name: { type: 'string' },
        formula_expression: { type: 'string' },
        formula_output_type: { type: 'string', enum: ['number', 'currency', 'percentage', 'text'] },
        formula_decimals: { type: 'number' },
        formula_currency: { type: 'string' },
        formula_thousands_separator: { type: 'boolean' },
        range_min: { type: 'number' },
        range_max: { type: 'number' },
        range_step: { type: 'number' },
        range_unit_ar: { type: 'string' },
        range_unit_en: { type: 'string' },
        auto_id_prefix: { type: 'string' },
        auto_id_padding: { type: 'number' },
        auto_id_start_value: { type: 'number' },
        auto_id_scope_field_id: { type: 'string' },
      },
      required: ['model_id', 'field_id'],
    },
  },
  {
    name: 'delete_field',
    description:
      "Remove a field from its section. The field's data on every record stays in JSONB but becomes orphaned. CONFIRM with the user before calling. Returns the full updated model row.",
    input_schema: {
      type: 'object',
      properties: {
        model_id: { type: 'string' },
        field_id: { type: 'string' },
      },
      required: ['model_id', 'field_id'],
    },
  },
  {
    name: 'create_model_group',
    description:
      "Create a new sidebar folder for organizing models. Always provide BOTH label_ar and label_en. Returns the folder id.",
    input_schema: {
      type: 'object',
      properties: {
        label_ar: { type: 'string' },
        label_en: { type: 'string' },
      },
      required: ['label_ar', 'label_en'],
    },
  },
  {
    name: 'rename_model_group',
    description:
      "Update one or both labels of an existing folder. Pass only the languages you want changed.",
    input_schema: {
      type: 'object',
      properties: {
        group_id: { type: 'string' },
        label_ar: { type: 'string' },
        label_en: { type: 'string' },
      },
      required: ['group_id'],
    },
  },
  {
    name: 'delete_model_group',
    description:
      "Delete a folder. Models inside become ungrouped (their group_id is set to null) — they are NOT deleted. WARN the user first if the folder still has models in it.",
    input_schema: {
      type: 'object',
      properties: {
        group_id: { type: 'string' },
      },
      required: ['group_id'],
    },
  },
  {
    name: 'set_model_group',
    description:
      "Move a model into a folder, between folders, or out of any folder back to ungrouped. Pass empty group_id to ungroup.",
    input_schema: {
      type: 'object',
      properties: {
        model_id: { type: 'string' },
        group_id: { type: 'string', description: 'Target folder id. Pass empty string to ungroup.' },
      },
      required: ['model_id'],
    },
  },
];

// ─── Tool execution ───────────────────────────────────────────────────────

const FIELD_TYPES = [
  'text', 'textarea', 'number', 'email', 'phone', 'date', 'datetime',
  'currency', 'url', 'checkbox', 'dropdown', 'multiselect', 'lookup',
  'mirror', 'section_mirror', 'section_selector', 'assignee', 'notes',
  'range', 'auto_id', 'formula', 'table',
] as const;

const ICON_NAMES = [
  'users', 'phone-call', 'building-2', 'target', 'star', 'file-search',
  'database', 'globe', 'folder', 'briefcase', 'calendar', 'mail',
  'truck', 'home', 'map-pin', 'clipboard', 'tag', 'layers',
  'grid', 'box', 'package', 'activity', 'zap', 'bell',
  'flag', 'heart', 'award', 'shield',
];

const MAPS_CONFIG_DEFAULT = {
  location_url_field_id: null,
  manual_lat_field_id: null,
  manual_lng_field_id: null,
  pin_color_field_id: null,
  pin_label_field_id: null,
  click_action: 'popup',
  popup_title_field_id: null,
  popup_subtitle_field_id: null,
  popup_badge_field_id: null,
  popup_shown_field_ids: [],
  map_style_json: null,
  default_center_lat: null,
  default_center_lng: null,
  default_zoom: null,
};

interface FieldShape {
  id: string;
  name: string;
  label_ar: string;
  label_en: string;
  type: string;
  required: boolean;
  order: number;
  section_id: string;
  width: string;
  show_in_table: boolean;
  [key: string]: unknown;
}

interface SectionShape {
  id: string;
  label_ar: string;
  label_en: string;
  order: number;
  is_base: boolean;
  color?: string;
  fields: FieldShape[];
  default_collapsed?: boolean;
  [key: string]: unknown;
}

interface ModelRow {
  id: string;
  name: string;
  label_ar: string;
  label_en: string;
  icon: string;
  color: string;
  schema: { sections: SectionShape[]; section_selector_field_id?: string | null; duplicate_check_field_id?: string | null };
  card_config: Record<string, unknown>;
  maps_config: Record<string, unknown>;
  group_id: string | null;
  order: number;
  is_system: boolean;
  /** True when the model has been promoted to a dedicated Postgres table.
   *  Schema mutations through this agent are refused — the user is sent
   *  to a regular Claude Code chat to write a migration. */
  is_hardcoded?: boolean;
  table_name?: string | null;
  created_at: string;
  updated_at: string;
}

interface GroupRow {
  id: string;
  label_ar: string;
  label_en: string;
  order: number;
}

// Build the JSON dump of the world that get_app_context returns.
async function buildAppContext(supabase: SupabaseClient, baseUrl: string): Promise<string> {
  const { data: rawModels } = await supabase.from('models').select('*');
  const models = (rawModels ?? []) as ModelRow[];

  // Trim each model down to the fields the agent needs to reason — we keep
  // the full schema but strip card_config / maps_config and counter state
  // (auto_id_counters) which are operational, not structural.
  const modelsForAgent = models.map((m) => ({
    id: m.id,
    name: m.name,
    label_ar: m.label_ar,
    label_en: m.label_en,
    icon: m.icon,
    color: m.color,
    group_id: m.group_id,
    order: m.order,
    is_system: m.is_system,
    schema: {
      section_selector_field_id: m.schema?.section_selector_field_id ?? null,
      duplicate_check_field_id: m.schema?.duplicate_check_field_id ?? null,
      sections: (m.schema?.sections ?? []).map((s) => ({
        id: s.id,
        label_ar: s.label_ar,
        label_en: s.label_en,
        order: s.order,
        is_base: s.is_base,
        color: s.color,
        default_collapsed: s.default_collapsed,
        fields: (s.fields ?? []).map((f) => {
          const out: Record<string, unknown> = { ...f };
          delete out.auto_id_counters;
          return out;
        }),
      })),
    },
  }));

  const { data: rawGroups } = await supabase.from('model_groups').select('id, label_ar, label_en, "order"');
  const groups = (rawGroups ?? []) as GroupRow[];

  return JSON.stringify({
    base_url: baseUrl,
    models: modelsForAgent,
    groups,
    available_field_types: FIELD_TYPES,
    available_icons: ICON_NAMES,
  });
}

// Read one model row by id. Returns null if not found.
async function readModel(supabase: SupabaseClient, modelId: string): Promise<ModelRow | null> {
  const { data, error } = await supabase.from('models').select('*').eq('id', modelId).single();
  if (error || !data) return null;
  return data as ModelRow;
}

/**
 * Frozen models can't have their schema mutated through the Builder Agent —
 * doing so would leave the JSONB schema and the dedicated Postgres table out
 * of sync. The user is supposed to ask Claude (in a regular Claude Code
 * session) to write a migration that ALTERs the table AND updates the JSONB
 * schema in one transaction.
 *
 * Returns null when the model is editable; returns an error JSON string ready
 * to short-circuit out of the calling tool when frozen.
 */
function refuseIfFrozen(model: ModelRow): string | null {
  if (!model.is_hardcoded) return null;
  return JSON.stringify({
    ok: false,
    error: `Model "${model.label_en || model.name}" is frozen — its schema lives in a dedicated Postgres table and cannot be mutated via the Builder Agent. To add/modify/remove fields or sections, ask Claude (in a regular Claude Code chat, not this Builder Agent) to write a migration that ALTERs the table and updates the model's schema JSONB atomically.`,
  });
}

// Persist an updated model row. Updates `updated_at`. Returns a plain
// object whose `error` field is null on success — avoids discriminated-
// union narrowing (which doesn't always cooperate when the api files are
// type-checked outside the project tsconfig).
async function writeModel(supabase: SupabaseClient, model: ModelRow): Promise<{ model: ModelRow; error: string | null }> {
  const now = new Date().toISOString();
  const next = { ...model, updated_at: now };
  const { error } = await supabase.from('models').update(next).eq('id', model.id);
  if (error) return { model: next, error: error.message };
  return { model: next, error: null };
}

// Slug validation: lowercase ASCII, starts with a letter, alphanumeric + underscore.
function isValidSlug(s: string): boolean {
  return /^[a-z][a-z0-9_]*$/.test(s);
}

// Take a partial field shape from the agent and return a fully-populated
// FieldShape with id, order, section_id filled in. Pass-through for any
// type-specific config keys the agent provided.
function buildField(
  partial: Record<string, unknown>,
  sectionId: string,
  order: number,
): FieldShape {
  const type = (partial.type as string) || 'text';
  // Forced flags per type — keeps invariants from the Builder UI.
  let required = !!partial.required;
  if (type === 'auto_id' || type === 'formula' || type === 'mirror' || type === 'section_mirror') {
    required = false;
  }
  const width = (partial.width as string) || 'half';
  // section_mirror containers are invisible — no width / show_in_table.
  const show_in_table = type === 'section_mirror' ? false : !!partial.show_in_table;

  const out: FieldShape = {
    id: newId(),
    name: String(partial.name ?? ''),
    label_ar: String(partial.label_ar ?? ''),
    label_en: String(partial.label_en ?? ''),
    type,
    required,
    order,
    section_id: sectionId,
    width,
    show_in_table,
  };

  // Pass through type-specific config keys verbatim — the Builder's runtime
  // resolver picks up only the keys the type uses, and ignores the rest.
  const passThrough = [
    'options', 'option_groups', 'lookup_model_id', 'lookup_display_field',
    'is_multi', 'lookup_max_records', 'assignee_role_ids', 'default_country_code',
    'mirror_via_lookup_field_id', 'mirror_target_field_name',
    'section_mirror_via_lookup_field_id', 'section_mirror_source_section_id',
    'section_mirror_field_mode', 'section_mirror_field_names',
    'section_mirror_edit_mode', 'section_mirror_editable_field_names',
    'section_mirror_sync_mode', 'section_mirror_sync_field_names',
    'range_min', 'range_max', 'range_step', 'range_unit_ar', 'range_unit_en',
    'auto_id_prefix', 'auto_id_padding', 'auto_id_start_value', 'auto_id_scope_field_id',
    'formula_expression', 'formula_output_type', 'formula_decimals',
    'formula_currency', 'formula_thousands_separator',
    'fallback_source_field_id', 'field_group_id',
    'table_columns', 'table_min_rows', 'table_max_rows',
  ];
  for (const key of passThrough) {
    if (partial[key] !== undefined) out[key] = partial[key];
  }

  // Options + option_groups need stable UUIDs.
  if (Array.isArray(out.options)) {
    out.options = (out.options as Array<Record<string, unknown>>).map((o) => ({
      ...o,
      id: (o.id as string | undefined) || newId(),
    }));
  }
  if (Array.isArray(out.option_groups)) {
    out.option_groups = (out.option_groups as Array<Record<string, unknown>>).map((g) => ({
      ...g,
      id: (g.id as string | undefined) || newId(),
    }));
  }
  if (Array.isArray(out.table_columns)) {
    out.table_columns = (out.table_columns as Array<Record<string, unknown>>).map((c) => {
      const next: Record<string, unknown> = { ...c, id: (c.id as string | undefined) || newId() };
      if (Array.isArray(next.options)) {
        next.options = (next.options as Array<Record<string, unknown>>).map((o) => ({
          ...o,
          id: (o.id as string | undefined) || newId(),
        }));
      }
      return next;
    });
  }
  // auto_id needs an empty counters map at field-create time.
  if (type === 'auto_id' && !out.auto_id_counters) out.auto_id_counters = {};
  return out;
}

// ─── create_model ─────────────────────────────────────────────────────────

interface CreateModelInput {
  name: string;
  label_ar: string;
  label_en: string;
  icon?: string;
  color?: string;
  group_id?: string;
  sections?: Array<{
    label_ar: string;
    label_en: string;
    color?: string;
    is_base?: boolean;
    default_collapsed?: boolean;
    fields?: Array<Record<string, unknown>>;
  }>;
}

async function createModel(
  supabase: SupabaseClient,
  baseUrl: string,
  input: CreateModelInput,
): Promise<string> {
  if (!input?.name || !input?.label_ar || !input?.label_en) {
    return JSON.stringify({ ok: false, error: 'name, label_ar, label_en are required' });
  }
  if (!isValidSlug(input.name)) {
    return JSON.stringify({ ok: false, error: 'name must be snake_case (lowercase ASCII letter + alnum/underscore)' });
  }
  // Reject duplicate slugs up-front so the agent can recover gracefully.
  const { data: existing } = await supabase.from('models').select('id').eq('name', input.name).maybeSingle();
  if (existing) {
    return JSON.stringify({ ok: false, error: `a model named "${input.name}" already exists — pick a different slug or update the existing one` });
  }

  const id = newId();
  const now = new Date().toISOString();
  const color = input.color || '#B8734F';
  const sectionsInput = input.sections ?? [];
  // If the caller didn't pass any sections, seed one empty base section so
  // the form has somewhere to render.
  if (sectionsInput.length === 0) {
    sectionsInput.push({
      label_ar: 'معلومات عامة',
      label_en: 'General Information',
      is_base: true,
    });
  }

  const sections: SectionShape[] = sectionsInput.map((s, i) => {
    const sectionId = newId();
    const fields: FieldShape[] = (s.fields ?? []).map((f, j) => buildField(f, sectionId, j));
    return {
      id: sectionId,
      label_ar: s.label_ar,
      label_en: s.label_en,
      order: i,
      is_base: !!s.is_base,
      color: s.color || color,
      default_collapsed: s.default_collapsed,
      fields,
    };
  });

  // Pick the next sidebar order: append to the end of the model's group bucket.
  const { data: peers } = await supabase
    .from('models')
    .select('"order"')
    .eq(input.group_id ? 'group_id' : 'group_id', input.group_id || null);
  const nextOrder = ((peers as Array<{ order?: number }> | null) ?? []).reduce(
    (max, m) => Math.max(max, m.order ?? 0),
    -1,
  ) + 1;

  const row: ModelRow = {
    id,
    name: input.name,
    label_ar: input.label_ar,
    label_en: input.label_en,
    icon: input.icon || 'database',
    color,
    schema: {
      sections,
      section_selector_field_id: null,
      duplicate_check_field_id: null,
    },
    card_config: { title_field_id: null, subtitle_field_id: null, badge_field_id: null, shown_field_ids: [] },
    maps_config: { ...MAPS_CONFIG_DEFAULT },
    group_id: input.group_id || null,
    order: nextOrder,
    is_system: false,
    created_at: now,
    updated_at: now,
  };

  const { error } = await supabase.from('models').insert(row);
  if (error) return JSON.stringify({ ok: false, error: error.message });

  return JSON.stringify({
    ok: true,
    model_id: id,
    name: row.name,
    builder_url: `${baseUrl}/builder/${id}`,
    section_count: sections.length,
    field_count: sections.reduce((n, s) => n + s.fields.length, 0),
    model: row,
  });
}

// ─── update_model_metadata ────────────────────────────────────────────────

interface UpdateModelMetadataInput {
  model_id: string;
  label_ar?: string;
  label_en?: string;
  icon?: string;
  color?: string;
  group_id?: string;
}

async function updateModelMetadata(supabase: SupabaseClient, input: UpdateModelMetadataInput): Promise<string> {
  if (!input?.model_id) return JSON.stringify({ ok: false, error: 'model_id is required' });
  const m = await readModel(supabase, input.model_id);
  if (!m) return JSON.stringify({ ok: false, error: 'model not found' });

  const next: ModelRow = { ...m };
  if (input.label_ar !== undefined) next.label_ar = input.label_ar;
  if (input.label_en !== undefined) next.label_en = input.label_en;
  if (input.icon !== undefined) next.icon = input.icon;
  if (input.color !== undefined) next.color = input.color;
  if (input.group_id !== undefined) next.group_id = input.group_id || null;

  const result = await writeModel(supabase, next);
  if (result.error) return JSON.stringify({ ok: false, error: result.error });
  return JSON.stringify({ ok: true, model_id: input.model_id, model: result.model });
}

// ─── delete_model ─────────────────────────────────────────────────────────

interface DeleteModelInput { model_id: string }

async function deleteModel(supabase: SupabaseClient, input: DeleteModelInput): Promise<string> {
  if (!input?.model_id) return JSON.stringify({ ok: false, error: 'model_id is required' });
  const m = await readModel(supabase, input.model_id);
  if (!m) return JSON.stringify({ ok: false, error: 'model not found' });
  if (m.is_system) {
    return JSON.stringify({ ok: false, error: `"${m.label_en || m.name}" is a system model and cannot be deleted. You can edit its sections / fields, but the model itself is protected.` });
  }
  const frozen = refuseIfFrozen(m);
  if (frozen) return frozen;
  const { error } = await supabase.from('models').delete().eq('id', input.model_id);
  if (error) return JSON.stringify({ ok: false, error: error.message });
  return JSON.stringify({ ok: true, deleted_model_id: input.model_id, name: m.label_en || m.name });
}

// ─── add_section ──────────────────────────────────────────────────────────

interface AddSectionInput {
  model_id: string;
  label_ar: string;
  label_en: string;
  color?: string;
  is_base?: boolean;
  default_collapsed?: boolean;
  fields?: Array<Record<string, unknown>>;
}

async function addSection(supabase: SupabaseClient, input: AddSectionInput): Promise<string> {
  if (!input?.model_id || !input?.label_ar || !input?.label_en) {
    return JSON.stringify({ ok: false, error: 'model_id, label_ar, label_en are required' });
  }
  const m = await readModel(supabase, input.model_id);
  if (!m) return JSON.stringify({ ok: false, error: 'model not found' });
  const frozen = refuseIfFrozen(m);
  if (frozen) return frozen;

  const sectionId = newId();
  const order = (m.schema?.sections ?? []).length;
  const fields: FieldShape[] = (input.fields ?? []).map((f, j) => buildField(f, sectionId, j));
  const section: SectionShape = {
    id: sectionId,
    label_ar: input.label_ar,
    label_en: input.label_en,
    order,
    is_base: !!input.is_base,
    color: input.color || m.color,
    default_collapsed: input.default_collapsed,
    fields,
  };
  const next: ModelRow = {
    ...m,
    schema: {
      ...m.schema,
      sections: [...(m.schema.sections ?? []), section],
    },
  };
  const result = await writeModel(supabase, next);
  if (result.error) return JSON.stringify({ ok: false, error: result.error });
  return JSON.stringify({ ok: true, model_id: input.model_id, section_id: sectionId, model: result.model });
}

// ─── update_section ───────────────────────────────────────────────────────

interface UpdateSectionInput {
  model_id: string;
  section_id: string;
  label_ar?: string;
  label_en?: string;
  color?: string;
  is_base?: boolean;
  default_collapsed?: boolean;
  order?: number;
}

async function updateSection(supabase: SupabaseClient, input: UpdateSectionInput): Promise<string> {
  if (!input?.model_id || !input?.section_id) return JSON.stringify({ ok: false, error: 'model_id and section_id are required' });
  const m = await readModel(supabase, input.model_id);
  if (!m) return JSON.stringify({ ok: false, error: 'model not found' });
  const frozen = refuseIfFrozen(m);
  if (frozen) return frozen;
  const sections = m.schema?.sections ?? [];
  const idx = sections.findIndex((s) => s.id === input.section_id);
  if (idx < 0) return JSON.stringify({ ok: false, error: 'section not found' });

  const updated: SectionShape = { ...sections[idx] };
  if (input.label_ar !== undefined) updated.label_ar = input.label_ar;
  if (input.label_en !== undefined) updated.label_en = input.label_en;
  if (input.color !== undefined) updated.color = input.color;
  if (input.is_base !== undefined) updated.is_base = input.is_base;
  if (input.default_collapsed !== undefined) updated.default_collapsed = input.default_collapsed;
  if (input.order !== undefined) updated.order = input.order;

  const nextSections = sections.map((s) => (s.id === input.section_id ? updated : s));
  // Re-sort by `order` so explicit reorders take effect on the next read.
  nextSections.sort((a, b) => (a.order ?? 0) - (b.order ?? 0));

  const next: ModelRow = { ...m, schema: { ...m.schema, sections: nextSections } };
  const result = await writeModel(supabase, next);
  if (result.error) return JSON.stringify({ ok: false, error: result.error });
  return JSON.stringify({ ok: true, model_id: input.model_id, section_id: input.section_id, model: result.model });
}

// ─── delete_section ───────────────────────────────────────────────────────

interface DeleteSectionInput { model_id: string; section_id: string }

async function deleteSection(supabase: SupabaseClient, input: DeleteSectionInput): Promise<string> {
  if (!input?.model_id || !input?.section_id) return JSON.stringify({ ok: false, error: 'model_id and section_id are required' });
  const m = await readModel(supabase, input.model_id);
  if (!m) return JSON.stringify({ ok: false, error: 'model not found' });
  const frozen = refuseIfFrozen(m);
  if (frozen) return frozen;
  const sections = m.schema?.sections ?? [];
  const target = sections.find((s) => s.id === input.section_id);
  if (!target) return JSON.stringify({ ok: false, error: 'section not found' });

  // If the model's section_selector field lives inside this section, we'd
  // be deleting it too — clear the model-level pointer.
  const ssId = m.schema?.section_selector_field_id ?? null;
  const ssLivesHere = ssId && (target.fields ?? []).some((f) => f.id === ssId);

  const filteredSections = sections.filter((s) => s.id !== input.section_id);
  // Renumber remaining sections so order stays gap-free.
  filteredSections.forEach((s, i) => { s.order = i; });

  // Same for duplicate_check_field — clear if it lived in the deleted section.
  const dcId = m.schema?.duplicate_check_field_id ?? null;
  const dcLivesHere = dcId && (target.fields ?? []).some((f) => f.id === dcId);

  const next: ModelRow = {
    ...m,
    schema: {
      ...m.schema,
      sections: filteredSections,
      section_selector_field_id: ssLivesHere ? null : ssId,
      duplicate_check_field_id: dcLivesHere ? null : dcId,
    },
  };
  const result = await writeModel(supabase, next);
  if (result.error) return JSON.stringify({ ok: false, error: result.error });
  return JSON.stringify({
    ok: true,
    model_id: input.model_id,
    deleted_section_id: input.section_id,
    deleted_field_count: (target.fields ?? []).length,
    model: result.model,
  });
}

// ─── add_field ────────────────────────────────────────────────────────────

interface AddFieldInput {
  model_id: string;
  section_id: string;
  name: string;
  label_ar: string;
  label_en: string;
  type: string;
  [key: string]: unknown;
}

async function addField(supabase: SupabaseClient, input: AddFieldInput): Promise<string> {
  if (!input?.model_id || !input?.section_id || !input?.name || !input?.label_ar || !input?.label_en || !input?.type) {
    return JSON.stringify({ ok: false, error: 'model_id, section_id, name, label_ar, label_en, type are required' });
  }
  if (!FIELD_TYPES.includes(input.type as typeof FIELD_TYPES[number])) {
    return JSON.stringify({ ok: false, error: `unknown field type "${input.type}"; pick one of: ${FIELD_TYPES.join(', ')}` });
  }
  if (!isValidSlug(input.name)) {
    return JSON.stringify({ ok: false, error: `field name "${input.name}" must be snake_case (lowercase ASCII letter + alnum/underscore)` });
  }

  const m = await readModel(supabase, input.model_id);
  if (!m) return JSON.stringify({ ok: false, error: 'model not found' });
  const frozen = refuseIfFrozen(m);
  if (frozen) return frozen;
  const sections = m.schema?.sections ?? [];
  const sectionIdx = sections.findIndex((s) => s.id === input.section_id);
  if (sectionIdx < 0) return JSON.stringify({ ok: false, error: 'section not found' });

  // Slug must be unique within the model.
  const allFields = sections.flatMap((s) => s.fields ?? []);
  if (allFields.some((f) => f.name === input.name)) {
    return JSON.stringify({ ok: false, error: `field name "${input.name}" already exists on this model` });
  }
  // Only ONE section_selector per model.
  if (input.type === 'section_selector' && allFields.some((f) => f.type === 'section_selector')) {
    return JSON.stringify({ ok: false, error: 'this model already has a section_selector field; only one is allowed' });
  }

  const targetSection = sections[sectionIdx];
  const order = (targetSection.fields ?? []).length;
  const newField = buildField(input as Record<string, unknown>, input.section_id, order);

  const nextSections = sections.map((s) =>
    s.id === input.section_id ? { ...s, fields: [...(s.fields ?? []), newField] } : s,
  );

  const next: ModelRow = {
    ...m,
    schema: {
      ...m.schema,
      sections: nextSections,
      // section_selector field — register on the model for the runtime renderer.
      section_selector_field_id:
        input.type === 'section_selector' ? newField.id : (m.schema?.section_selector_field_id ?? null),
    },
  };
  const result = await writeModel(supabase, next);
  if (result.error) return JSON.stringify({ ok: false, error: result.error });
  return JSON.stringify({ ok: true, model_id: input.model_id, field_id: newField.id, model: result.model });
}

// ─── update_field ─────────────────────────────────────────────────────────

interface UpdateFieldInput {
  model_id: string;
  field_id: string;
  [key: string]: unknown;
}

async function updateField(supabase: SupabaseClient, input: UpdateFieldInput): Promise<string> {
  if (!input?.model_id || !input?.field_id) return JSON.stringify({ ok: false, error: 'model_id and field_id are required' });
  if (input.name !== undefined) {
    return JSON.stringify({
      ok: false,
      error: "this agent doesn't rename field slugs (the `name` property) — slug renames cascade across records, formulas, lookups, mirrors, workflows, and views, and need the Builder UI's confirmation modal. Use the 'API name' input in the Field Properties panel.",
    });
  }
  const m = await readModel(supabase, input.model_id);
  if (!m) return JSON.stringify({ ok: false, error: 'model not found' });
  const frozen = refuseIfFrozen(m);
  if (frozen) return frozen;
  const sections = m.schema?.sections ?? [];

  // Locate the field and its current section.
  let currentSectionIdx = -1;
  let currentField: FieldShape | null = null;
  for (let i = 0; i < sections.length; i++) {
    const found = (sections[i].fields ?? []).find((f) => f.id === input.field_id);
    if (found) { currentSectionIdx = i; currentField = found; break; }
  }
  if (!currentField) return JSON.stringify({ ok: false, error: 'field not found' });

  // Section move — pull from old, push to new.
  const movingTo = (input.section_id as string | undefined) && input.section_id !== currentField.section_id ? (input.section_id as string) : null;
  if (movingTo) {
    const targetExists = sections.some((s) => s.id === movingTo);
    if (!targetExists) return JSON.stringify({ ok: false, error: 'target section_id not found' });
  }

  // Validate type if it's changing.
  if (input.type !== undefined && !FIELD_TYPES.includes(input.type as typeof FIELD_TYPES[number])) {
    return JSON.stringify({ ok: false, error: `unknown field type "${input.type}"` });
  }

  // Apply patch — type-specific config keys pass through.
  const patch: Record<string, unknown> = { ...input };
  delete patch.model_id;
  delete patch.field_id;
  // section_id move handled separately below; but updates of order also accepted.
  const updatedField: FieldShape = { ...currentField, ...patch } as FieldShape;
  // Re-stamp ids on options if they came in fresh.
  if (Array.isArray(updatedField.options)) {
    updatedField.options = (updatedField.options as Array<Record<string, unknown>>).map((o) => ({
      ...o,
      id: (o.id as string | undefined) || newId(),
    }));
  }
  if (Array.isArray(updatedField.option_groups)) {
    updatedField.option_groups = (updatedField.option_groups as Array<Record<string, unknown>>).map((g) => ({
      ...g,
      id: (g.id as string | undefined) || newId(),
    }));
  }
  // Forced-required rules per type stay enforced after a type change.
  if (updatedField.type === 'auto_id' || updatedField.type === 'formula' || updatedField.type === 'mirror' || updatedField.type === 'section_mirror') {
    updatedField.required = false;
  }

  // Build the next sections array.
  const nextSections = sections.map((s, i) => {
    // Source section: drop the field if we're moving it out.
    let fields = (s.fields ?? []).filter((f) => f.id !== input.field_id);
    // If THIS section is the destination (either same-section update, or a move), append.
    const isDestination = movingTo
      ? s.id === movingTo
      : i === currentSectionIdx;
    if (isDestination) {
      // Re-pin section_id to wherever it lives now.
      updatedField.section_id = s.id;
      fields = [...fields, updatedField];
    }
    return { ...s, fields };
  });

  // section_selector pointer — if the field's type is now / still is
  // section_selector, point the model at it; if it WAS section_selector and
  // the type changed, clear the pointer.
  const wasSelector = currentField.type === 'section_selector';
  const isSelector = updatedField.type === 'section_selector';
  let sectionSelectorId = m.schema?.section_selector_field_id ?? null;
  if (isSelector) sectionSelectorId = updatedField.id;
  else if (wasSelector && !isSelector && sectionSelectorId === updatedField.id) sectionSelectorId = null;

  const next: ModelRow = {
    ...m,
    schema: {
      ...m.schema,
      sections: nextSections,
      section_selector_field_id: sectionSelectorId,
    },
  };
  const result = await writeModel(supabase, next);
  if (result.error) return JSON.stringify({ ok: false, error: result.error });
  return JSON.stringify({ ok: true, model_id: input.model_id, field_id: input.field_id, model: result.model });
}

// ─── delete_field ─────────────────────────────────────────────────────────

interface DeleteFieldInput { model_id: string; field_id: string }

async function deleteFieldOp(supabase: SupabaseClient, input: DeleteFieldInput): Promise<string> {
  if (!input?.model_id || !input?.field_id) return JSON.stringify({ ok: false, error: 'model_id and field_id are required' });
  const m = await readModel(supabase, input.model_id);
  if (!m) return JSON.stringify({ ok: false, error: 'model not found' });
  const frozen = refuseIfFrozen(m);
  if (frozen) return frozen;
  const sections = m.schema?.sections ?? [];

  let foundField: FieldShape | null = null;
  const nextSections = sections.map((s) => {
    const field = (s.fields ?? []).find((f) => f.id === input.field_id);
    if (field) foundField = field;
    return { ...s, fields: (s.fields ?? []).filter((f) => f.id !== input.field_id) };
  });
  if (!foundField) return JSON.stringify({ ok: false, error: 'field not found' });

  // Reorder remaining fields in the host section to stay gap-free.
  for (const s of nextSections) {
    s.fields = (s.fields ?? []).map((f, i) => ({ ...f, order: i }));
  }

  const ssId = m.schema?.section_selector_field_id ?? null;
  const dcId = m.schema?.duplicate_check_field_id ?? null;
  const next: ModelRow = {
    ...m,
    schema: {
      ...m.schema,
      sections: nextSections,
      section_selector_field_id: ssId === input.field_id ? null : ssId,
      duplicate_check_field_id: dcId === input.field_id ? null : dcId,
    },
  };
  const result = await writeModel(supabase, next);
  if (result.error) return JSON.stringify({ ok: false, error: result.error });
  return JSON.stringify({ ok: true, model_id: input.model_id, deleted_field_id: input.field_id, model: result.model });
}

// ─── Group management ────────────────────────────────────────────────────

interface CreateGroupInput { label_ar: string; label_en: string }

async function createGroup(supabase: SupabaseClient, input: CreateGroupInput): Promise<string> {
  if (!input?.label_ar || !input?.label_en) {
    return JSON.stringify({ ok: false, error: 'label_ar and label_en are required' });
  }
  const id = newId();
  const { data: existing } = await supabase
    .from('model_groups')
    .select('"order"')
    .order('"order"', { ascending: false })
    .limit(1);
  const nextOrder = ((existing as Array<{ order?: number }> | null)?.[0]?.order ?? -1) + 1;
  const row = { id, label_ar: input.label_ar, label_en: input.label_en, order: nextOrder };
  const { error } = await supabase.from('model_groups').insert(row);
  if (error) return JSON.stringify({ ok: false, error: error.message });
  return JSON.stringify({ ok: true, group_id: id, group: row });
}

interface RenameGroupInput { group_id: string; label_ar?: string; label_en?: string }

async function renameGroup(supabase: SupabaseClient, input: RenameGroupInput): Promise<string> {
  if (!input?.group_id) return JSON.stringify({ ok: false, error: 'group_id is required' });
  const patch: Record<string, unknown> = {};
  if (input.label_ar) patch.label_ar = input.label_ar;
  if (input.label_en) patch.label_en = input.label_en;
  if (Object.keys(patch).length === 0) {
    return JSON.stringify({ ok: false, error: 'pass at least one of label_ar or label_en' });
  }
  const { data, error } = await supabase
    .from('model_groups')
    .update(patch)
    .eq('id', input.group_id)
    .select('*')
    .single();
  if (error) return JSON.stringify({ ok: false, error: error.message });
  if (!data) return JSON.stringify({ ok: false, error: 'group not found' });
  return JSON.stringify({ ok: true, group_id: input.group_id, group: data });
}

interface DeleteGroupInput { group_id: string }

async function deleteGroup(supabase: SupabaseClient, input: DeleteGroupInput): Promise<string> {
  if (!input?.group_id) return JSON.stringify({ ok: false, error: 'group_id is required' });
  const { data: orphans } = await supabase
    .from('models')
    .select('id')
    .eq('group_id', input.group_id);
  const orphanCount = (orphans as Array<{ id: string }> | null)?.length ?? 0;

  const { error } = await supabase.from('model_groups').delete().eq('id', input.group_id);
  if (error) return JSON.stringify({ ok: false, error: error.message });
  return JSON.stringify({
    ok: true,
    group_id: input.group_id,
    models_unfiled: orphanCount,
  });
}

interface SetModelGroupInput { model_id: string; group_id?: string }

async function setModelGroup(supabase: SupabaseClient, input: SetModelGroupInput): Promise<string> {
  if (!input?.model_id) return JSON.stringify({ ok: false, error: 'model_id is required' });
  const target = input.group_id ? input.group_id : null;
  const now = new Date().toISOString();
  const { data, error } = await supabase
    .from('models')
    .update({ group_id: target, updated_at: now })
    .eq('id', input.model_id)
    .select('*')
    .single();
  if (error) return JSON.stringify({ ok: false, error: error.message });
  if (!data) return JSON.stringify({ ok: false, error: 'model not found' });
  return JSON.stringify({
    ok: true,
    model_id: input.model_id,
    group_id: target,
    model: data,
  });
}

// ─── Dispatcher ──────────────────────────────────────────────────────────

// Audit fix H7: centralized schema-mutation guard.
//
// Every tool that mutates a model's `schema` (sections, fields, options,
// or anything else that maps to the dedicated table's DDL) is listed
// here. The dispatcher does an early refuseIfFrozen check using the
// input's `model_id` BEFORE calling into the per-tool implementation.
// Per-tool guards remain as defense-in-depth.
//
// Tools deliberately NOT in this set:
//   - get_app_context — read-only.
//   - create_model — INSERT, no existing frozen state to protect.
//   - update_model_metadata — labels / icon / color / group only; the
//     dedicated table doesn't care about these and the JSONB sidecar
//     can absorb the change without a migration.
//   - create_model_group / rename_model_group / delete_model_group /
//     set_model_group — group-level metadata, never touches schema.
const SCHEMA_MUTATING_TOOLS = new Set<string>([
  'delete_model',
  'add_section',
  'update_section',
  'delete_section',
  'add_field',
  'update_field',
  'delete_field',
]);

export async function executeBuilderAgentTool(
  name: string,
  input: unknown,
  supabase: SupabaseClient,
  baseUrl: string,
): Promise<string> {
  try {
    if (SCHEMA_MUTATING_TOOLS.has(name)) {
      const modelId =
        typeof input === 'object' && input !== null && 'model_id' in input
          ? String((input as { model_id: unknown }).model_id ?? '')
          : '';
      if (modelId) {
        const m = await readModel(supabase, modelId);
        if (m) {
          const refusal = refuseIfFrozen(m);
          if (refusal) return refusal;
        }
      }
    }

    switch (name) {
      case 'get_app_context':
        return await buildAppContext(supabase, baseUrl);
      case 'create_model':
        return await createModel(supabase, baseUrl, input as CreateModelInput);
      case 'update_model_metadata':
        return await updateModelMetadata(supabase, input as UpdateModelMetadataInput);
      case 'delete_model':
        return await deleteModel(supabase, input as DeleteModelInput);
      case 'add_section':
        return await addSection(supabase, input as AddSectionInput);
      case 'update_section':
        return await updateSection(supabase, input as UpdateSectionInput);
      case 'delete_section':
        return await deleteSection(supabase, input as DeleteSectionInput);
      case 'add_field':
        return await addField(supabase, input as AddFieldInput);
      case 'update_field':
        return await updateField(supabase, input as UpdateFieldInput);
      case 'delete_field':
        return await deleteFieldOp(supabase, input as DeleteFieldInput);
      case 'create_model_group':
        return await createGroup(supabase, input as CreateGroupInput);
      case 'rename_model_group':
        return await renameGroup(supabase, input as RenameGroupInput);
      case 'delete_model_group':
        return await deleteGroup(supabase, input as DeleteGroupInput);
      case 'set_model_group':
        return await setModelGroup(supabase, input as SetModelGroupInput);
      default:
        return JSON.stringify({ ok: false, error: `unknown tool: ${name}` });
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return JSON.stringify({ ok: false, error: message });
  }
}
