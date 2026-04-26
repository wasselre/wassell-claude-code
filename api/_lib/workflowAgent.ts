/**
 * Wassel workflow-builder AI agent — server-side logic.
 *
 * A separate Claude agent dedicated to translating natural-language
 * descriptions into actual `Workflow` records. Lives next to the sales
 * agent (api/_lib/aiAgent.ts) but knows nothing about projects or leads —
 * its world is models, fields, conditions, and actions.
 *
 * Tools it exposes:
 *   get_app_context        — inventory of models (with fields), users,
 *                            roles, existing workflows (with their on/off
 *                            state and folder), workflow folders, and
 *                            webhook endpoints, so the agent can resolve
 *                            names → IDs without guessing.
 *   create_workflow        — saves a fully-specified workflow to Supabase.
 *   set_workflow_active    — toggles an existing workflow's is_active flag.
 *   create_workflow_folder — adds a new folder for organizing workflows.
 *   rename_workflow_folder — updates a folder's bilingual labels.
 *   delete_workflow_folder — deletes a folder; its workflows become
 *                            ungrouped via the schema's ON DELETE SET NULL.
 *   set_workflow_folder    — moves an existing workflow into / out of a
 *                            folder.
 *
 * Conversation history lives on the client (no persistence yet — the
 * value is the workflow that gets created, not the chat).
 */

import type Anthropic from '@anthropic-ai/sdk';
import type { SupabaseClient } from '@supabase/supabase-js';

// Vercel Edge functions don't ship the Node 'crypto' module — they expose
// the Web Crypto API as a global instead. `crypto.randomUUID()` is part
// of that surface and works identically to Node's version.
const newId = (): string => crypto.randomUUID();

export const WORKFLOW_AGENT_MODEL = 'claude-opus-4-7';
export const WORKFLOW_AGENT_MAX_TOKENS = 16_000;

// Frozen string so prompt-caching stays warm. Update CAREFULLY — every
// edit invalidates the cache for the next several hours of traffic.
export const WORKFLOW_AGENT_SYSTEM_PROMPT = `You are the Wassel Workflow Builder — an AI assistant inside the Wassel CRM (وصل العقارية, a Saudi Arabian real-estate marketing CRM) whose ONLY job is to help users create automation rules ("workflows") by talking to them in natural language.

# Your job
A user describes an automation in plain English or Arabic. You ask a few clarifying questions if needed, then call \`create_workflow\` with a fully-specified workflow object. You can also:
 - Turn workflows on/off (\`set_workflow_active\`).
 - Manage **folders** that organize workflows: \`create_workflow_folder\`, \`rename_workflow_folder\`, \`delete_workflow_folder\`, \`set_workflow_folder\` (moves a workflow into / out of a folder, or assigns one when creating).

You don't run workflows; you build, toggle, organize them.

# How workflows work in this app

A workflow has:
 - **trigger** — an event on a model: \`create\`, \`update\`, \`delete\`, or \`webhook\`. Pick a model the user actually has (call \`get_app_context\` to see them).
 - **branches** — an ordered list of if/else-if/else arms. The engine walks them top-to-bottom and runs the first one whose conditions all pass. \`is_else: true\` marks the catch-all, which must be the LAST branch.
 - Each branch has **conditions** (AND-joined boolean checks on the trigger record's fields) and **actions** (run sequentially when the branch wins).

## Condition shape
\`{ id, field_id, operator, value, only_on_change? }\`
 - \`field_id\` is the field's slug (the \`name\` property in the model schema), NOT its UUID.
 - \`operator\` is one of: \`equals\`, \`not_equals\`, \`contains\`, \`intersects\`, \`greater_than\`, \`less_than\`, \`is_empty\`, \`is_not_empty\`.
 - \`only_on_change\` (optional, update-event only) — fires only on the false→true transition, prevents re-firing on every save.

## Action types and their shapes
Use one of these seven \`type\` values (full config for each below):

1. \`create_record\` — { id, type, target_model_id, field_mappings: FieldMapping[], skip_if_exists?, dedup_target_field_id? }
2. \`update_record\` — { id, type, target_model_id, filter_field_id, filter_value_source: 'static'|'trigger_field', filter_value, filter_trigger_field_id?, field_mappings: FieldMapping[] }
3. \`send_notification\` — { id, type, message_ar, message_en }
4. \`assign_user\` — { id, type, assignment_field_id, mode: 'specific_user'|'role_based', specific_user_id?, role_id?, role_conditions?, selection_strategy?: 'least_workload'|'random'|'round_robin' }
5. \`http_request\` — { id, type, method: 'GET'|'POST'|'PUT'|'PATCH'|'DELETE', url, headers: HttpHeaderPair[], body_mode: 'none'|'json_template'|'form_mappings', body_template?, timeout_ms? }
6. \`outbound_ivr\` — { id, type, to: { kind: 'static'|'trigger_field', value? | field_name? }, audio_mode: 'tts'|'audio_file', tts_text?, tts_voice?, audio_file_url?, options: WorkflowIvrOption[], language: 'ar'|'en' }
7. \`send_whatsapp_message\` — { id, type, to_field_id, body_template }

## FieldMapping shape (used inside create_record / update_record)
\`{ id, target_field_id, source_type, ...source-specific fields }\`
 - source_type: 'static' | 'trigger_field' | 'current_date' | 'current_user' | 'record_id' | 'role_variable' | 'date_expression' | 'formula'
 - For 'static': { static_value }
 - For 'trigger_field': { trigger_field_id }
 - For 'date_expression': { date_base: 'current_date'|'trigger_field', date_base_field_id?, date_expression: e.g. '+5d -2w' }
 - For 'formula': { formula_expression: e.g. '{price} * 0.05' }
 - For 'role_variable': { role_id, role_conditions, selection_strategy }

# Operating procedure

1. **First call \`get_app_context\`** before doing ANYTHING else. This tells you which models exist, what fields they have, who the users are, what roles exist, what webhook endpoints are registered, and what workflows the user already has. NEVER guess at field slugs or model IDs.

2. **Ask ONE clarifying question at a time** if the user's request is ambiguous. Examples of when to ask:
   - "When a hot lead comes in, notify the sales team" — ask: which model? Which field marks a lead as 'hot'?
   - "Create a follow-up after 3 days" — ask: linked to which trigger record? Which user should it be assigned to?
   - Unique value handling — ask: should we dedup, and on which field?

3. **Confirm before creating** for non-trivial workflows. Show a short summary in plain language: "I'll create a workflow that fires when a Client is created with status='hot', sends a notification, and assigns it to a sales user. Should I save it?"

4. **Match the user's language.** Arabic in → Arabic out. English in → English out. Both label_ar AND label_en should be set — when the user gives one, derive the other.

5. **Always set both \`label_ar\` and \`label_en\`** on the workflow. Same for any branch labels. If the user only gave you one language, write a sensible translation for the other.

6. **Don't invent IDs.** Field slugs (the \`name\` property) come from the model schema returned by \`get_app_context\`. Model IDs, user IDs, role IDs, webhook slug IDs all come from the context dump too. The server fills in branch / condition / action / field_mapping IDs automatically — leave them empty/missing in your call and they'll be added.

7. **Honesty rules.** If the user asks for something the data model can't express (e.g. "send an email" — there's no email action), say so plainly. Don't fabricate features. If a field they mention doesn't exist, list what's actually on the model and ask them to pick.

8. **Keep responses short.** This is a workflow builder, not a chatbot. Aim for 2-4 sentence replies — ask the next thing you need, or confirm what you're about to build, or report what was created.

9. **After \`create_workflow\` succeeds**, tell the user the workflow was created, name it, and explain in one sentence what they can do next (e.g. "Open it in the editor to fine-tune actions or activate it.").

# Activating / deactivating an existing workflow

When the user says something like "activate the one I just created", "turn on the welcome workflow", "disable the lead notifier", call \`set_workflow_active\` with the workflow id and the desired \`is_active\` value. To find the id:
 - If you just created it in this conversation, you already know the id from the \`create_workflow\` tool result.
 - Otherwise call \`get_app_context\` and match the user's description against the existing workflows list (each entry has \`id\`, \`label_ar\`, \`label_en\`, \`is_active\`, and \`group_id\`).

If the user's description is ambiguous (multiple workflows match), list the candidates with their on/off state and ask them to pick.

# Managing folders

Folders are organizational only — they don't affect what a workflow does. Each workflow has a nullable \`group_id\` referencing a folder; null means "ungrouped" (the default).

When to use:
 - "Create a folder called Onboarding" → \`create_workflow_folder\`. Always set BOTH label_ar and label_en (write a sensible translation if the user only gave one).
 - "Rename the Onboarding folder to Welcome" → \`rename_workflow_folder\`. Pass only the languages the user wants changed.
 - "Delete the Welcome folder" → \`delete_workflow_folder\`. WARN the user first if the folder still has workflows in it (they'll become ungrouped, not deleted) and confirm before calling.
 - "Move the welcome workflow into the Onboarding folder" → \`set_workflow_folder\` with the workflow_id and target folder_id. Pass \`folder_id: null\` to move a workflow OUT of any folder back to ungrouped.
 - When creating a new workflow into an existing folder, you can either pass \`group_id\` directly to \`create_workflow\` or call \`set_workflow_folder\` after.

Folder discovery: \`get_app_context\` returns a \`workflow_folders\` array (id + bilingual labels + order) and each workflow's \`group_id\`. If the user mentions a folder by name, match against that list; if no folder matches, offer to create it.

# What NOT to do
- Don't write workflow JSON in your assistant text — always emit it via the \`create_workflow\` tool.
- Don't say "I created..." or "I activated..." until the tool actually returns success.
- Don't use \`assign_user\` action without confirming which assignee field on the model — it requires \`assignment_field_id\`.
- Don't set \`is_active: true\` on the first save unless the user explicitly says "activate" / "turn on" — leaving it false lets them review first.

Begin.`;

type ToolUnion = Anthropic.Messages.Tool;

export const WORKFLOW_AGENT_TOOLS: ToolUnion[] = [
  {
    name: 'get_app_context',
    description:
      'Get a complete inventory of the app: every model with its fields (id, slug name, label_ar/label_en, type, options for dropdowns), every user (id + name + email), every role (id + name + members), every existing workflow (id, name, trigger summary), and every declared webhook endpoint (id + slug + payload schema). Call this FIRST before anything else so you have correct IDs and field slugs to reference. The agent should not invent IDs — they all come from this dump.',
    input_schema: {
      type: 'object',
      properties: {},
    },
  },
  {
    name: 'set_workflow_active',
    description:
      "Turn an existing workflow on or off by flipping its `is_active` flag. Pass the workflow id (from get_app_context's `workflows` list, or from a create_workflow result earlier in this conversation) and the desired boolean. Returns the updated workflow row. Use this when the user asks to activate, enable, turn on, deactivate, disable, or turn off an existing workflow.",
    input_schema: {
      type: 'object',
      properties: {
        workflow_id: { type: 'string', description: 'The workflow id to update.' },
        is_active: { type: 'boolean', description: 'true to activate, false to deactivate.' },
      },
      required: ['workflow_id', 'is_active'],
    },
  },
  {
    name: 'create_workflow',
    description:
      'Save a new workflow record. The server will assign IDs to any branch / condition / action / field_mapping that lacks one, mirror the first non-else branch into the legacy `conditions` / `actions` fields for engine compatibility, and persist to Supabase. Returns the created workflow id and a URL the user can navigate to in order to inspect / edit it. Do NOT call until you have asked any clarifying questions and confirmed the design with the user.',
    input_schema: {
      type: 'object',
      properties: {
        label_ar: { type: 'string', description: 'Workflow name in Arabic.' },
        label_en: { type: 'string', description: 'Workflow name in English.' },
        trigger_model_id: { type: 'string', description: 'Model id from get_app_context (omit when trigger_event is "webhook").' },
        trigger_event: {
          type: 'string',
          enum: ['create', 'update', 'delete', 'webhook'],
          description: 'Which kind of event fires this workflow.',
        },
        trigger_webhook_slug_id: { type: 'string', description: 'Webhook slug id when trigger_event is "webhook".' },
        is_active: { type: 'boolean', description: 'Whether the workflow runs on save. Default false unless the user says to activate.' },
        group_id: { type: 'string', description: 'Optional folder (workflow_groups.id) to drop the new workflow into. Omit for ungrouped.' },
        branches: {
          type: 'array',
          description: 'Ordered list of if/else-if/else arms. The first arm whose conditions all pass runs.',
          items: {
            type: 'object',
            properties: {
              label_ar: { type: 'string' },
              label_en: { type: 'string' },
              is_else: { type: 'boolean' },
              conditions: {
                type: 'array',
                items: {
                  type: 'object',
                  properties: {
                    field_id: { type: 'string', description: 'Field SLUG (name), not UUID.' },
                    operator: { type: 'string' },
                    value: {},
                    only_on_change: { type: 'boolean' },
                  },
                  required: ['field_id', 'operator'],
                },
              },
              actions: {
                type: 'array',
                items: {
                  type: 'object',
                  description: 'A workflow action. Shape varies by `type` — see the system prompt for each variant.',
                  properties: {
                    type: { type: 'string' },
                  },
                  required: ['type'],
                },
              },
            },
            required: ['conditions', 'actions'],
          },
        },
      },
      required: ['label_ar', 'label_en', 'trigger_event', 'branches'],
    },
  },
  {
    name: 'create_workflow_folder',
    description:
      'Create a new folder for organizing workflows in the workflows list. Folders are organizational only — they do not change what a workflow does. Always provide BOTH `label_ar` and `label_en`; if the user only gave one, write a sensible translation for the other. Returns the folder id you can pass into `set_workflow_folder` or `create_workflow`.',
    input_schema: {
      type: 'object',
      properties: {
        label_ar: { type: 'string', description: 'Folder name in Arabic.' },
        label_en: { type: 'string', description: 'Folder name in English.' },
      },
      required: ['label_ar', 'label_en'],
    },
  },
  {
    name: 'rename_workflow_folder',
    description:
      "Update one or both labels of an existing folder. Pass only the languages you want changed — omitted ones stay as they were. Use this when the user says things like 'rename the Welcome folder to Onboarding'.",
    input_schema: {
      type: 'object',
      properties: {
        folder_id: { type: 'string', description: 'Folder id from get_app_context.' },
        label_ar: { type: 'string', description: 'New Arabic label (omit to keep current).' },
        label_en: { type: 'string', description: 'New English label (omit to keep current).' },
      },
      required: ['folder_id'],
    },
  },
  {
    name: 'delete_workflow_folder',
    description:
      "Delete a folder. Workflows inside it become ungrouped (their group_id is set to null) — they are NOT deleted. ALWAYS warn the user first if the folder still has workflows in it (look at workflows.group_id in get_app_context to count them) and confirm before calling.",
    input_schema: {
      type: 'object',
      properties: {
        folder_id: { type: 'string', description: 'Folder id to delete.' },
      },
      required: ['folder_id'],
    },
  },
  {
    name: 'set_workflow_folder',
    description:
      "Move a workflow into a folder, between folders, or out of any folder back to ungrouped. Pass the workflow id and a target folder_id. To move OUT of a folder, omit folder_id (or pass an empty string) — the workflow becomes ungrouped. Use when the user says things like 'put the welcome workflow in Onboarding' or 'remove the lead notifier from any folder'.",
    input_schema: {
      type: 'object',
      properties: {
        workflow_id: { type: 'string', description: 'Workflow id to move.' },
        folder_id: { type: 'string', description: 'Target folder id. Omit or pass an empty string to ungroup.' },
      },
      required: ['workflow_id'],
    },
  },
];

// ─── Tool execution ───────────────────────────────────────────────────────

interface ModelRow {
  id: string;
  label_ar: string;
  label_en: string;
  schema: { sections?: Array<{ fields?: Array<{ id: string; name: string; label_ar: string; label_en: string; type: string; options?: Array<{ value: string; label_ar: string; label_en: string }> }> }> };
}

interface UserRow {
  id: string;
  name?: string;
  email?: string;
}

interface RoleRow {
  id: string;
  name: string;
}

interface WebhookSlugRow {
  id: string;
  slug: string;
  name: string;
  payload_schema?: Record<string, unknown>;
}

interface WorkflowRow {
  id: string;
  label_ar: string;
  label_en: string;
  trigger_event: string;
  trigger_model_id: string | null;
  is_active: boolean;
  group_id: string | null;
}

interface WorkflowFolderRow {
  id: string;
  label_ar: string;
  label_en: string;
  order: number;
}

async function buildAppContext(supabase: SupabaseClient, baseUrl: string): Promise<string> {
  // Models with their fields (flattened from schema.sections[].fields[]).
  const { data: rawModels } = await supabase.from('models').select('id, label_ar, label_en, schema');
  const models = (rawModels ?? []) as ModelRow[];
  const modelsForAgent = models.map((m) => {
    const fields = (m.schema?.sections ?? []).flatMap((s) => s.fields ?? []).map((f) => ({
      id: f.id,
      name: f.name,
      label_ar: f.label_ar,
      label_en: f.label_en,
      type: f.type,
      ...(f.options ? { options: f.options.map((o) => ({ value: o.value, label_ar: o.label_ar, label_en: o.label_en })) } : {}),
    }));
    return { id: m.id, label_ar: m.label_ar, label_en: m.label_en, fields };
  });

  // Users & roles.
  const { data: rawUsers } = await supabase.from('users').select('id, name, email');
  const users = (rawUsers ?? []) as UserRow[];
  const { data: rawRoles } = await supabase.from('roles').select('id, name');
  const roles = (rawRoles ?? []) as RoleRow[];

  // Existing workflows (id + name + trigger + on/off state + folder).
  // The agent uses `is_active` to phrase replies correctly ("already
  // active") and `group_id` to know which folder a workflow lives in
  // when the user says things like "the welcome workflow in Onboarding".
  const { data: rawWorkflows } = await supabase.from('workflows').select('id, label_ar, label_en, trigger_event, trigger_model_id, is_active, group_id');
  const workflows = (rawWorkflows ?? []) as WorkflowRow[];

  // Workflow folders. Tolerate the table not existing on installs that
  // haven't run the latest migration yet.
  let workflowFolders: WorkflowFolderRow[] = [];
  try {
    const { data: rawFolders } = await supabase.from('workflow_groups').select('id, label_ar, label_en, "order"');
    workflowFolders = (rawFolders ?? []) as WorkflowFolderRow[];
  } catch { /* table missing on older installs */ }

  // Webhook slugs.
  const { data: rawSlugs } = await supabase.from('webhook_slugs').select('id, slug, name, payload_schema');
  const webhookSlugs = (rawSlugs ?? []) as WebhookSlugRow[];

  // Bundle as a single JSON string so Claude sees the whole world in one
  // tool result. baseUrl is included so the agent can mention links in its
  // replies (the canvas-editor URL for the workflow it just created).
  return JSON.stringify({
    base_url: baseUrl,
    models: modelsForAgent,
    users,
    roles,
    workflows,
    workflow_folders: workflowFolders,
    webhook_slugs: webhookSlugs,
    available_action_types: [
      'create_record',
      'update_record',
      'send_notification',
      'assign_user',
      'http_request',
      'outbound_ivr',
      'send_whatsapp_message',
    ],
    available_condition_operators: [
      'equals',
      'not_equals',
      'contains',
      'intersects',
      'greater_than',
      'less_than',
      'is_empty',
      'is_not_empty',
    ],
  });
}

interface CreateWorkflowInput {
  label_ar: string;
  label_en: string;
  trigger_model_id?: string;
  trigger_event: 'create' | 'update' | 'delete' | 'webhook';
  trigger_webhook_slug_id?: string;
  is_active?: boolean;
  group_id?: string;
  branches: Array<{
    label_ar?: string;
    label_en?: string;
    is_else?: boolean;
    conditions: Array<{ field_id: string; operator: string; value?: unknown; only_on_change?: boolean }>;
    actions: Array<Record<string, unknown>>;
  }>;
}

// Walk an action object and assign UUIDs to its id + any nested
// field_mappings / role_conditions / options that are missing one. Keeps the
// agent's input clean (it doesn't have to invent UUIDs) while ensuring the
// saved row has stable identifiers throughout.
function fillActionIds(action: Record<string, unknown>): Record<string, unknown> {
  const next: Record<string, unknown> = { ...action, id: (action.id as string | undefined) || newId() };

  const mapMappings = (arr: unknown): unknown => {
    if (!Array.isArray(arr)) return arr;
    return arr.map((m) => {
      if (typeof m !== 'object' || m === null) return m;
      const cast = m as Record<string, unknown>;
      const filled: Record<string, unknown> = { ...cast, id: (cast.id as string | undefined) || newId() };
      if (Array.isArray(cast.role_conditions)) {
        filled.role_conditions = (cast.role_conditions as Array<Record<string, unknown>>).map((rc) => ({
          ...rc,
          id: (rc.id as string | undefined) || newId(),
        }));
      }
      return filled;
    });
  };

  if (Array.isArray(next.field_mappings)) next.field_mappings = mapMappings(next.field_mappings);
  if (Array.isArray(next.role_conditions)) {
    next.role_conditions = (next.role_conditions as Array<Record<string, unknown>>).map((rc) => ({
      ...rc,
      id: (rc.id as string | undefined) || newId(),
    }));
  }
  if (Array.isArray(next.options)) {
    next.options = (next.options as Array<Record<string, unknown>>).map((o) => ({
      ...o,
      id: (o.id as string | undefined) || newId(),
    }));
  }
  if (Array.isArray(next.headers)) {
    next.headers = (next.headers as Array<Record<string, unknown>>).map((h) => ({
      ...h,
      id: (h.id as string | undefined) || newId(),
    }));
  }
  return next;
}

async function createWorkflow(
  supabase: SupabaseClient,
  baseUrl: string,
  input: CreateWorkflowInput,
): Promise<string> {
  const now = new Date().toISOString();
  const id = newId();

  const branches = input.branches.map((b) => ({
    id: newId(),
    label_ar: b.label_ar,
    label_en: b.label_en,
    is_else: !!b.is_else,
    conditions: (b.conditions ?? []).map((c) => ({
      id: newId(),
      field_id: c.field_id,
      operator: c.operator,
      value: c.value ?? '',
      ...(c.only_on_change ? { only_on_change: true } : {}),
    })),
    actions: (b.actions ?? []).map(fillActionIds),
  }));

  // Mirror the first non-else branch into the legacy `conditions` / `actions`
  // fields, matching what the editor's `handleSave` does, so engine
  // back-compat consumers don't see an empty rule.
  const primary = branches.find((b) => !b.is_else) ?? branches[0];

  const row = {
    id,
    label_ar: input.label_ar,
    label_en: input.label_en,
    trigger_model_id: input.trigger_model_id ?? null,
    trigger_event: input.trigger_event,
    trigger_webhook_slug_id: input.trigger_webhook_slug_id ?? null,
    // Empty string → null (Postgres rejects '' on UUID columns).
    group_id: input.group_id || null,
    branches,
    conditions: primary?.conditions ?? [],
    actions: primary?.actions ?? [],
    is_active: !!input.is_active,
    created_at: now,
    updated_at: now,
  };

  const { error } = await supabase.from('workflows').insert(row);
  if (error) {
    return JSON.stringify({ ok: false, error: error.message });
  }

  return JSON.stringify({
    ok: true,
    workflow_id: id,
    name: input.label_en || input.label_ar,
    is_active: row.is_active,
    editor_url: `${baseUrl}/workflow/${id}`,
    branch_count: branches.length,
    action_count: branches.reduce((sum, b) => sum + b.actions.length, 0),
    // Full row so the browser can drop it straight into its local store —
    // avoids a round-trip reload before the Open-in-editor link works.
    workflow: row,
  });
}

// ─── Folder management ────────────────────────────────────────────────────

interface CreateFolderInput {
  label_ar: string;
  label_en: string;
}

async function createWorkflowFolder(
  supabase: SupabaseClient,
  input: CreateFolderInput,
): Promise<string> {
  if (!input?.label_ar || !input?.label_en) {
    return JSON.stringify({ ok: false, error: 'label_ar and label_en are required' });
  }
  const id = newId();
  // Order: append to the end. Read current max so the new folder doesn't
  // jump above existing ones.
  const { data: existing } = await supabase
    .from('workflow_groups')
    .select('"order"')
    .order('"order"', { ascending: false })
    .limit(1);
  const nextOrder = ((existing as Array<{ order?: number }> | null)?.[0]?.order ?? -1) + 1;

  const row = {
    id,
    label_ar: input.label_ar,
    label_en: input.label_en,
    order: nextOrder,
  };
  const { error } = await supabase.from('workflow_groups').insert(row);
  if (error) return JSON.stringify({ ok: false, error: error.message });
  return JSON.stringify({ ok: true, folder_id: id, folder: row });
}

interface RenameFolderInput {
  folder_id: string;
  label_ar?: string;
  label_en?: string;
}

async function renameWorkflowFolder(
  supabase: SupabaseClient,
  input: RenameFolderInput,
): Promise<string> {
  if (!input?.folder_id) {
    return JSON.stringify({ ok: false, error: 'folder_id is required' });
  }
  const patch: Record<string, unknown> = {};
  if (input.label_ar) patch.label_ar = input.label_ar;
  if (input.label_en) patch.label_en = input.label_en;
  if (Object.keys(patch).length === 0) {
    return JSON.stringify({ ok: false, error: 'pass at least one of label_ar or label_en' });
  }
  const { data, error } = await supabase
    .from('workflow_groups')
    .update(patch)
    .eq('id', input.folder_id)
    .select('*')
    .single();
  if (error) return JSON.stringify({ ok: false, error: error.message });
  if (!data) return JSON.stringify({ ok: false, error: 'folder not found' });
  return JSON.stringify({ ok: true, folder_id: input.folder_id, folder: data });
}

interface DeleteFolderInput {
  folder_id: string;
}

async function deleteWorkflowFolder(
  supabase: SupabaseClient,
  input: DeleteFolderInput,
): Promise<string> {
  if (!input?.folder_id) {
    return JSON.stringify({ ok: false, error: 'folder_id is required' });
  }
  // Count the workflows that will get un-grouped so the agent can phrase
  // its confirmation message correctly. The schema's ON DELETE SET NULL
  // does the actual orphaning automatically.
  const { data: orphans } = await supabase
    .from('workflows')
    .select('id')
    .eq('group_id', input.folder_id);
  const orphanCount = (orphans as Array<{ id: string }> | null)?.length ?? 0;

  const { error } = await supabase.from('workflow_groups').delete().eq('id', input.folder_id);
  if (error) return JSON.stringify({ ok: false, error: error.message });
  return JSON.stringify({
    ok: true,
    folder_id: input.folder_id,
    workflows_unfiled: orphanCount,
  });
}

interface SetWorkflowFolderInput {
  workflow_id: string;
  folder_id?: string;
}

async function setWorkflowFolder(
  supabase: SupabaseClient,
  baseUrl: string,
  input: SetWorkflowFolderInput,
): Promise<string> {
  if (!input?.workflow_id) {
    return JSON.stringify({ ok: false, error: 'workflow_id is required' });
  }
  // Empty string or missing → ungroup. Anything else → folder id.
  const target = input.folder_id ? input.folder_id : null;
  const now = new Date().toISOString();
  const { data, error } = await supabase
    .from('workflows')
    .update({ group_id: target, updated_at: now })
    .eq('id', input.workflow_id)
    .select('*')
    .single();
  if (error) return JSON.stringify({ ok: false, error: error.message });
  if (!data) return JSON.stringify({ ok: false, error: 'workflow not found' });
  return JSON.stringify({
    ok: true,
    workflow_id: input.workflow_id,
    group_id: target,
    editor_url: `${baseUrl}/workflow/${input.workflow_id}`,
    workflow: data,
  });
}

// ─── Activation ───────────────────────────────────────────────────────────

interface SetActiveInput {
  workflow_id: string;
  is_active: boolean;
}

async function setWorkflowActive(
  supabase: SupabaseClient,
  baseUrl: string,
  input: SetActiveInput,
): Promise<string> {
  if (!input?.workflow_id || typeof input.is_active !== 'boolean') {
    return JSON.stringify({ ok: false, error: 'workflow_id and is_active are required' });
  }
  const now = new Date().toISOString();
  // Round-trip the row so the browser can sync the updated workflow into
  // its local store without re-fetching the full list.
  const { data, error } = await supabase
    .from('workflows')
    .update({ is_active: input.is_active, updated_at: now })
    .eq('id', input.workflow_id)
    .select('*')
    .single();

  if (error) {
    return JSON.stringify({ ok: false, error: error.message });
  }
  if (!data) {
    return JSON.stringify({ ok: false, error: 'workflow not found' });
  }

  return JSON.stringify({
    ok: true,
    workflow_id: input.workflow_id,
    is_active: input.is_active,
    name: (data as { label_en?: string; label_ar?: string }).label_en
      || (data as { label_en?: string; label_ar?: string }).label_ar
      || input.workflow_id,
    editor_url: `${baseUrl}/workflow/${input.workflow_id}`,
    workflow: data,
  });
}

export async function executeWorkflowAgentTool(
  name: string,
  input: unknown,
  supabase: SupabaseClient,
  baseUrl: string,
): Promise<string> {
  switch (name) {
    case 'get_app_context':
      return await buildAppContext(supabase, baseUrl);
    case 'create_workflow':
      return await createWorkflow(supabase, baseUrl, input as CreateWorkflowInput);
    case 'set_workflow_active':
      return await setWorkflowActive(supabase, baseUrl, input as SetActiveInput);
    case 'create_workflow_folder':
      return await createWorkflowFolder(supabase, input as CreateFolderInput);
    case 'rename_workflow_folder':
      return await renameWorkflowFolder(supabase, input as RenameFolderInput);
    case 'delete_workflow_folder':
      return await deleteWorkflowFolder(supabase, input as DeleteFolderInput);
    case 'set_workflow_folder':
      return await setWorkflowFolder(supabase, baseUrl, input as SetWorkflowFolderInput);
    default:
      return JSON.stringify({ ok: false, error: `unknown tool: ${name}` });
  }
}
