export type FieldType =
  | 'text'
  | 'textarea'
  | 'number'
  | 'email'
  | 'phone'
  | 'date'
  | 'datetime'
  | 'currency'
  | 'url'
  | 'checkbox'
  | 'dropdown'
  | 'multiselect'
  | 'lookup'
  | 'mirror'
  | 'section_mirror'
  | 'section_selector'
  | 'assignee'
  | 'notes'
  | 'range'
  | 'auto_id'
  | 'formula';

// Tri-state control used by `section_mirror` for edit permissions and sync-back.
// - 'all': every mirrored child field follows the rule
// - 'none': no child field follows the rule (read-only, or local-only)
// - 'custom': only the field slugs listed in the companion array follow the rule
export type SectionMirrorControlMode = 'all' | 'none' | 'custom';

// How to pick which child fields to mirror from the source section.
export type SectionMirrorFieldMode = 'all' | 'custom';

export type FieldWidth = 'full' | 'half' | 'third';

export interface FieldOption {
  id: string;
  label_ar: string;
  label_en: string;
  value: string;
  color?: string;
  // Optional group id this option belongs to. Options with a matching group_id
  // render under the same collapsible header in DropdownSelect / MultiSelect;
  // ungrouped options (no group_id, or a stale id) render at the top.
  group_id?: string;
  // Marks options on a `section_selector` field that were auto-generated from
  // the model's non-base sections (id + value = section id). Section options
  // are managed by the Builder and render as read-only in the options editor.
  // Options without this flag are "custom" values the user added manually —
  // they show up in the dropdown but don't control section visibility.
  is_section_option?: boolean;
}

// Grouping for dropdown/multiselect options. Defined per-field to let a single
// dropdown organize many options under collapsible headers (e.g. "Appointment
// Status" → Confirmed / Not Confirmed; "Visit Status" → Attended / No Show).
// Groups carry no semantic meaning for records — they affect display only.
export interface FieldOptionGroup {
  id: string;
  label_ar: string;
  label_en: string;
}

export interface ModelField {
  id: string;
  name: string; // snake_case slug
  label_ar: string;
  label_en: string;
  type: FieldType;
  required: boolean;
  order: number;
  section_id: string;
  width: FieldWidth;
  show_in_table: boolean;
  options?: FieldOption[];
  option_groups?: FieldOptionGroup[]; // dropdown/multiselect only; groups options into collapsible sections
  lookup_model_id?: string | null;
  lookup_display_field?: string | null;
  is_multi?: boolean; // When type: 'lookup', allows picking multiple records (value becomes string[]).
  lookup_max_records?: number; // When type: 'lookup', caps how many records show in the combobox dropdown (default 20).
  assignee_role_ids?: string[];
  default_country_code?: string; // e.g. "+966". Used for type: 'phone'.
  mirror_via_lookup_field_id?: string | null; // UUID of the sibling lookup field to hop through (type: 'mirror').
  mirror_target_field_name?: string | null; // Slug of the field on the sibling's target model to display (type: 'mirror').
  // Section mirror config (type: 'section_mirror'). Renders a picked subset of
  // another record's section inline, with per-field edit + sync-back controls.
  // Stored value shape is Record<string, unknown> — a map of local overrides per
  // child field slug. Children whose sync is on write back to the linked record
  // on save; children whose sync is off store edits in this map (local overrides).
  section_mirror_via_lookup_field_id?: string | null; // UUID of the sibling lookup field used to find the source record.
  section_mirror_source_section_id?: string | null; // Section ID on the sibling lookup's target model.
  section_mirror_field_mode?: SectionMirrorFieldMode; // 'all' or 'custom'. Defaults to 'all'.
  section_mirror_field_names?: string[]; // Child field slugs to include when mode is 'custom'.
  section_mirror_edit_mode?: SectionMirrorControlMode; // 'all' | 'none' | 'custom'. Defaults to 'none' (read-only).
  section_mirror_editable_field_names?: string[]; // Child field slugs that are editable when edit_mode is 'custom'.
  section_mirror_sync_mode?: SectionMirrorControlMode; // 'all' | 'none' | 'custom'. Defaults to 'all' when editing is allowed.
  section_mirror_sync_field_names?: string[]; // Child field slugs that sync back when sync_mode is 'custom'.
  // Range config (type: 'range'). Stored value shape is { min?: number; max?: number }.
  range_min?: number; // inclusive lower bound for min/max inputs
  range_max?: number; // inclusive upper bound for min/max inputs
  range_step?: number; // step between allowed values
  range_unit_ar?: string; // optional Arabic unit label (e.g. "م²", "ر.س")
  range_unit_en?: string; // optional English unit label
  // Auto ID config (type: 'auto_id'). The value stored on each record is the
  // formatted string (e.g. "CLT-001"). Assigned once at record creation and
  // immutable thereafter. Counters live here on the field definition so the
  // model's schema JSONB is the single source of truth.
  auto_id_prefix?: string; // e.g. "CLT-". Empty = number only.
  auto_id_padding?: number; // zero-pad width (default 3).
  auto_id_start_value?: number; // first number to assign (default 1).
  auto_id_scope_field_id?: string | null; // sibling field id; counter is kept per-value-of-that-field.
  auto_id_counters?: Record<string, number>; // next number to assign, keyed by scope-value-slug or "__global__".
  // Formula config (type: 'formula'). Raw template with {field_slug} tokens.
  // The computed value is stored on each record at save time (snapshot) so
  // reads, filters, and exports don't need to re-evaluate. Formula references
  // other fields in the same record only.
  formula_expression?: string;
  // Output formatting for formula fields. Applied uniformly to form preview,
  // table cells, exports. Text output is unformatted; numeric output is
  // rounded to `formula_decimals` (default 2) and localized with thousands
  // separators when `formula_thousands_separator` is true (default true).
  // Currency appends a currency code/symbol; percentage multiplies by 100 and
  // appends `%`.
  formula_output_type?: 'number' | 'currency' | 'percentage' | 'text';
  formula_decimals?: number; // 0..6; applied when output_type is number|currency|percentage
  formula_currency?: string; // e.g. 'SAR', 'USD'. Defaults to 'SAR' when output_type is 'currency'.
  formula_thousands_separator?: boolean; // default true
  // Optional in-section group id (see ModelSection.field_groups). Lets fields
  // inside the same section render under a collapsible sub-header. Display
  // only — doesn't change storage or field behavior.
  field_group_id?: string | null;
  // Fallback source field. When set and this field's value is empty at save
  // time, `saveRecord` copies the referenced field's current value into this
  // field. User-editable afterward (not a derived/computed snapshot). Disallowed
  // as *target* for types where "empty" isn't meaningful or the value is already
  // computed: formula, mirror, section_mirror, section_selector, auto_id, notes,
  // checkbox, assignee. Cannot self-reference; source may not be formula / mirror
  // / section_mirror (those resolve in a different phase). Lookup sources resolve
  // to the linked record's `lookup_display_field` — never a raw UUID.
  fallback_source_field_id?: string | null;
}

// Notes field (type: 'notes'). Stored value is a chronological list of entries.
// Each entry is append-only — edits write a new entry rather than mutate history.
export interface NoteEntry {
  id: string;
  text: string;
  author_id: string | null; // UserId of the entry's author (null only if no current user at creation)
  created_at: string; // ISO
}

export interface ModelSection {
  id: string;
  label_ar: string;
  label_en: string;
  order: number;
  is_base: boolean;
  color?: string;
  fields: ModelField[];
  // Mirrored-section config. When is_mirrored=true, fields[] is empty and the
  // section renders using the linked record's source section at runtime.
  // Edits inside a mirrored section write back to the linked record on save.
  is_mirrored?: boolean;
  mirror_via_lookup_field_id?: string | null; // Sibling lookup field on this model used to find the source record.
  mirror_source_section_id?: string | null; // Section ID on the lookup's target model whose fields we mirror.
  // When true, the section renders collapsed by default in the record form.
  // User-facing — can be toggled at runtime by clicking the section header.
  // Does not affect validation or data visibility — only the initial UI state.
  default_collapsed?: boolean;
  // Optional in-section field groups. Each group is a collapsible sub-header
  // shown inside this section's body; fields reference a group via
  // `ModelField.field_group_id`. Fields without a group_id render ungrouped
  // at the top. Groups are display-only — they don't nest sections, change
  // how records are stored, or affect the section_selector.
  field_groups?: SectionFieldGroup[];
}

/**
 * In-section collapsible grouping of fields. Lives on `ModelSection.field_groups`.
 * Fields belong to a group by setting `ModelField.field_group_id`; fields without
 * one render above the groups as ungrouped. Groups affect presentation only —
 * the section's `fields` array is unchanged, so records, imports, formulas,
 * and workflows keep working without migration.
 */
export interface SectionFieldGroup {
  id: string;
  label_ar: string;
  label_en: string;
  order: number;
  /** When true, the group renders collapsed by default in the record form. */
  default_collapsed?: boolean;
}

export interface CardConfig {
  title_field_id: string | null;
  subtitle_field_id?: string | null;
  badge_field_id?: string | null;
  shown_field_ids: string[];
}

export interface ModelSchema {
  sections: ModelSection[];
  section_selector_field_id?: string | null;
  // When set, import skips any row whose value for this field matches an
  // existing record's value for the same field (case-insensitive, trimmed).
  // Lookup fields compare by resolved id; everything else compares by string.
  duplicate_check_field_id?: string | null;
}

export interface AppModel {
  id: string;
  name: string; // snake_case slug
  label_ar: string;
  label_en: string;
  icon: string; // Lucide icon name
  color: string; // hex
  schema: ModelSchema;
  card_config: CardConfig;
  group_id?: string | null;
  /**
   * Sidebar display order within the model's group (or within the
   * ungrouped section if `group_id` is null). Lower = higher in the list.
   * Optional for backward compatibility; init assigns a value to any model
   * that lacks one.
   */
  order?: number;
  is_system: boolean;
  created_at: string;
  updated_at: string;
}

export interface ModelGroup {
  id: string;
  label_ar: string;
  label_en: string;
  order: number;
}

export interface AppRecord {
  id: string;
  model_id: string;
  data: Record<string, unknown>;
  created_at: string;
  updated_at: string;
}

// Field template — a reusable snapshot of a ModelField (options, type, width, etc.).
// Created by the user from any saved field; inserted into any section via the
// Builder catalog. Insertion creates a fresh ModelField with new IDs, so dropped
// copies are independent of the template and of each other.
export interface FieldTemplate {
  id: string;
  label_ar: string; // user-facing name in the template catalog
  label_en: string;
  field: Omit<ModelField, 'id' | 'section_id' | 'order'>;
  created_at: string;
  updated_at: string;
}

// Workflow types

export type WorkflowEvent = 'create' | 'update' | 'delete';

export type ConditionOperator =
  | 'equals'
  | 'not_equals'
  | 'contains'
  | 'intersects'
  | 'greater_than'
  | 'less_than'
  | 'is_empty'
  | 'is_not_empty';

export interface WorkflowCondition {
  id: string;
  field_id: string; // field slug (name)
  operator: ConditionOperator;
  value: unknown;
  // When true, the condition passes only on the transition into the "true" state:
  // - 'update' event: passes iff it passes on the new record AND did not pass on the previous record
  // - 'create' event: any first-time match counts as a transition (always passes if value matches)
  // - 'delete' event: ignored (behaves like a normal condition)
  only_on_change?: boolean;
}

export type FieldMappingSource = 'static' | 'trigger_field' | 'current_date' | 'current_user' | 'record_id' | 'role_variable' | 'date_expression' | 'formula';

// date_expression: base is either the current date/time or a date field read from the trigger record.
// Expression is a sequence of signed offsets like "+5d -2w +3mo +1y +2h -30min" (units: d, w, mo, y, h, min).
export type DateExpressionBase = 'current_date' | 'trigger_field';

export interface FieldMapping {
  id: string;
  target_field_id: string; // field slug (name)
  source_type: FieldMappingSource;
  static_value?: unknown;
  trigger_field_id?: string; // field slug (name)
  // role_variable: dynamic user selection by role field conditions (for assignee fields)
  role_id?: string;
  role_conditions?: RoleFieldCondition[];
  selection_strategy?: SelectionStrategy;
  // date_expression
  date_base?: DateExpressionBase;
  date_base_field_id?: string; // trigger field slug when date_base === 'trigger_field'
  date_expression?: string; // e.g. "+5d", "-2w", "+3mo +2h"
  // formula: computed value from trigger record fields. Same grammar as the
  // formula field type (math, comparisons, IF / CONCAT / DAYS / ADD_DAYS / …).
  // `{field_slug}` tokens reference fields on the trigger record. Error sentinels
  // (#ERR / #DIV0 / #REF / #CYCLE) resolve to null so records stay clean.
  formula_expression?: string;
}

export type WorkflowActionType = 'create_record' | 'update_record' | 'send_notification' | 'assign_user';

export interface WorkflowActionCreateRecord {
  id: string;
  type: 'create_record';
  target_model_id: string;
  field_mappings: FieldMapping[];
  // Dedup: skip creation when a record in target_model_id already has
  // dedup_target_field_id equal to the value this action would write there.
  skip_if_exists?: boolean;
  dedup_target_field_id?: string; // target field slug; must be one of field_mappings
}

export interface WorkflowActionUpdateRecord {
  id: string;
  type: 'update_record';
  target_model_id: string;
  filter_field_id: string;
  // Absent = 'static' for back-compat with old saved workflows.
  filter_value_source?: 'static' | 'trigger_field';
  filter_value: unknown; // used when filter_value_source is 'static' (or unset)
  filter_trigger_field_id?: string; // slug of a field on the trigger record
  field_mappings: FieldMapping[];
}

export interface WorkflowActionSendNotification {
  id: string;
  type: 'send_notification';
  message_ar: string;
  message_en: string;
}

export type AssignmentMode = 'specific_user' | 'role_based';
export type SelectionStrategy = 'first_match' | 'least_workload';

export interface RoleFieldCondition {
  id: string;
  field_name: string;
  operator: ConditionOperator;
  // Where the comparison value comes from. Absent = 'static' for back-compat with old saved workflows.
  value_source?: 'static' | 'trigger_field';
  value: unknown; // used when value_source is 'static' (or unset)
  trigger_field_id?: string; // used when value_source is 'trigger_field' — slug of a field on the trigger record
}

export interface WorkflowActionAssignUser {
  id: string;
  type: 'assign_user';
  assignment_field_id: string;
  mode: AssignmentMode;
  specific_user_id?: string;
  role_id?: string;
  role_conditions: RoleFieldCondition[];
  selection_strategy: SelectionStrategy;
}

export type WorkflowAction =
  | WorkflowActionCreateRecord
  | WorkflowActionUpdateRecord
  | WorkflowActionSendNotification
  | WorkflowActionAssignUser;

// A workflow branch — an if / else-if / else arm. Evaluated top-to-bottom; the
// first non-else branch whose conditions all pass is the winner and its actions
// run. If none match, an optional `is_else` branch at the end runs as the
// catch-all. Branches let one workflow express "if X do A, else if Y do B,
// else do C" without needing several workflows that all listen on the same
// trigger.
export interface WorkflowBranch {
  id: string;
  // Optional human label so the tree stays readable ("Hot lead", "Cold lead").
  label_ar?: string;
  label_en?: string;
  // AND-joined conditions. Empty = always true (useful for the winning arm of
  // an if/else when the author wants a catch-all without using `is_else`).
  conditions: WorkflowCondition[];
  // Actions run sequentially if this branch wins.
  actions: WorkflowAction[];
  // Marks this branch as the fallback / else arm. Evaluated only if no earlier
  // non-else branch matched. The editor enforces at most one `is_else` branch
  // and pins it to the end of the list.
  is_else?: boolean;
}

export interface Workflow {
  id: string;
  label_ar: string;
  label_en: string;
  trigger_model_id: string;
  trigger_event: WorkflowEvent;
  // Branched workflow (if / else if / else). Introduced after the flat
  // conditions+actions shape. Always present on workflows saved by the current
  // editor. Older saves may be missing this field; the engine falls back to
  // the legacy flat shape via `conditions` + `actions` below.
  branches?: WorkflowBranch[];
  // LEGACY flat shape. Kept required for back-compat with pre-branch saves and
  // downstream code that reads these fields (e.g. the list page's action
  // counter, field-rename propagation). The editor mirrors the first branch's
  // conditions/actions into these fields so older readers still see something
  // sensible; the engine prefers `branches` when present.
  conditions: WorkflowCondition[];
  actions: WorkflowAction[];
  is_active: boolean;
  created_at: string;
  updated_at: string;
}

// --- Workflow execution logs (fine-grained audit trail) ---

export type WorkflowRunStatus =
  | 'success'           // All actions executed without error
  | 'partial_success'   // Some actions executed, some skipped/failed
  | 'skipped'           // Conditions not met — nothing ran
  | 'failed'            // An uncaught error aborted the run
  | 'depth_exceeded';   // Recursive trigger capped by MAX_DEPTH

export type WorkflowActionTraceStatus = 'executed' | 'skipped' | 'failed';

export interface WorkflowConditionTrace {
  id: string;
  field_id: string;
  operator: ConditionOperator | 'is_empty' | 'is_not_empty';
  expected_value: unknown;     // from the workflow definition (condition.value)
  actual_value: unknown;       // from the trigger record at run time
  only_on_change: boolean;
  passes_now: boolean;         // condition is true against the current record state
  passed_before?: boolean;     // condition was true against the previous record state (update events only)
  result: boolean;             // final result after only_on_change adjustment
}

export interface FieldMappingTrace {
  target_field_id: string;
  source_type: FieldMapping['source_type'];
  // What the source expression looked like in the definition (for display)
  source_description: string;
  resolved_value: unknown;     // what was actually written
  // Optional detail per source_type
  formula_expression?: string;
  formula_result?: unknown;
  trigger_field_id?: string;
  role_id?: string;
  role_candidates_count?: number;
}

export interface WorkflowActionTraceBase {
  id: string;
  order: number;
  status: WorkflowActionTraceStatus;
  skip_reason?: string;        // Human-readable, localizable key or literal
  error?: string;
  duration_ms: number;
}

export interface WorkflowActionTraceCreate extends WorkflowActionTraceBase {
  type: 'create_record';
  target_model_id: string;
  resolved_data: Record<string, unknown>;
  field_mappings: FieldMappingTrace[];
  created_record_id?: string;
  dedup_checked?: boolean;
  dedup_field_id?: string;
  dedup_match_record_id?: string; // set when skip_if_exists fired
}

export interface WorkflowActionTraceUpdate extends WorkflowActionTraceBase {
  type: 'update_record';
  target_model_id: string;
  filter_field_id: string;
  filter_value_source: 'static' | 'trigger_field';
  filter_trigger_field_id?: string;
  resolved_filter_value: unknown;
  matched_record_id?: string;
  // True when the match happened via the target record's internal id — i.e. the
  // filter source was a single lookup field pointing to the target model, so the
  // stored value is the target record's UUID and not a business-key comparison.
  matched_by_record_id?: boolean;
  previous_data?: Record<string, unknown>;
  new_data?: Record<string, unknown>;
  diff?: Record<string, { before: unknown; after: unknown }>;
  field_mappings: FieldMappingTrace[];
}

export interface WorkflowActionTraceNotify extends WorkflowActionTraceBase {
  type: 'send_notification';
  message_ar: string;
  message_en: string;
  shown_message: string;
  shown_language: 'ar' | 'en';
}

export interface WorkflowActionTraceAssign extends WorkflowActionTraceBase {
  type: 'assign_user';
  assignment_field_id: string;
  mode: AssignmentMode;
  role_id?: string;
  role_conditions_count: number;
  candidates_count?: number;
  selection_strategy?: SelectionStrategy;
  assigned_user_id?: string;
  previous_assignee_id?: unknown;
}

export type WorkflowActionTrace =
  | WorkflowActionTraceCreate
  | WorkflowActionTraceUpdate
  | WorkflowActionTraceNotify
  | WorkflowActionTraceAssign;

// One branch's evaluation trace. Populated for every branch evaluated during a
// run (including ones that were short-circuited past because an earlier branch
// already won — those get `evaluated: false`).
export interface WorkflowBranchTrace {
  branch_id: string;
  branch_label_ar?: string;
  branch_label_en?: string;
  is_else: boolean;
  // Per-condition results. Empty for else branches (no conditions to evaluate).
  conditions_trace: WorkflowConditionTrace[];
  // True iff every condition passed (or the branch has no conditions).
  conditions_passed: boolean;
  // Did the engine actually evaluate this branch's conditions? False when an
  // earlier branch already won.
  evaluated: boolean;
  // Is this the winning branch whose actions ran?
  was_selected: boolean;
}

export interface WorkflowRun {
  id: string;
  workflow_id: string;
  // Snapshot of workflow name/event/model at the time of the run so logs stay
  // readable even if the workflow is later edited or deleted.
  workflow_label_ar: string;
  workflow_label_en: string;
  trigger_event: WorkflowEvent;
  trigger_model_id: string;
  trigger_model_label_ar?: string;
  trigger_model_label_en?: string;
  trigger_record_id: string;
  trigger_record_snapshot?: Record<string, unknown>; // the record's data at run time
  previous_record_snapshot?: Record<string, unknown>; // prior state for update events
  triggered_by_user_id?: string | null;
  depth: number;                // workflow cascade depth
  started_at: string;           // ISO
  finished_at: string;          // ISO
  duration_ms: number;
  status: WorkflowRunStatus;
  conditions_trace: WorkflowConditionTrace[];
  conditions_passed: boolean;
  actions_trace: WorkflowActionTrace[];
  // Branch trace — present on runs produced by the branched engine. The
  // legacy `conditions_trace` / `actions_trace` reflect the winning branch (or
  // the first-evaluated branch if none won) so old log UI keeps working.
  branches_trace?: WorkflowBranchTrace[];
  selected_branch_id?: string; // id of the winning branch, if any
  error?: string;
}

// Dashboard types

export type WidgetType = 'stat' | 'bar_chart' | 'pie_chart' | 'line_chart' | 'table';

export type WidgetFilterOperator =
  | 'equals'
  | 'not_equals'
  | 'contains'
  | 'greater_than'
  | 'less_than'
  | 'is_empty'
  | 'is_not_empty';

export interface WidgetFilterCondition {
  id: string;
  field_id: string; // field ID
  // Addresses a nested key on a structured field value. Currently only used for
  // range fields (value shape `{ min?: number; max?: number }`), where the user
  // picks `'min'` or `'max'`. Empty/undefined = compare against the top-level value.
  field_path?: string;
  operator: WidgetFilterOperator;
  value: unknown;
}

export interface WidgetConfigStat {
  conditions?: WidgetFilterCondition[];
  color: string;
}

export interface WidgetConfigChart {
  group_by_field_id: string;
  conditions?: WidgetFilterCondition[];
}

export interface WidgetConfigLine {
  date_field_id: string;
  period: 'day' | 'week' | 'month';
  conditions?: WidgetFilterCondition[];
}

export interface WidgetConfigTable {
  field_ids: string[];
  sort_field_id?: string | null;
  sort_direction: 'asc' | 'desc';
  max_rows: number;
  conditions?: WidgetFilterCondition[];
}

export type WidgetConfig =
  | WidgetConfigStat
  | WidgetConfigChart
  | WidgetConfigLine
  | WidgetConfigTable;

export interface DashboardWidget {
  id: string;
  type: WidgetType;
  title_ar: string;
  title_en: string;
  source_model_id: string;
  config: WidgetConfig;
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface Dashboard {
  id: string;
  label_ar: string;
  label_en: string;
  description?: string;
  widgets: DashboardWidget[];
  is_public: boolean;
  public_token?: string | null;
  created_at: string;
  updated_at: string;
}

// Saved-view types (per-model, per-user, optionally shared)

export interface ModelView {
  id: string;
  model_id: string;
  user_id: string; // author
  is_shared: boolean;
  is_default: boolean; // per (model, user) — only one at a time
  label_ar: string;
  label_en: string;
  field_ids: string[]; // ordered column list (by ModelField.id)
  sort_field_id: string | null;
  sort_direction: 'asc' | 'desc' | null;
  conditions: WidgetFilterCondition[]; // reuse dashboard filter shape
  // Research-comparison-only. When the view targets a section_mirror container
  // with a multi-select sibling (e.g. projects_research.project_comparison),
  // these let the view scope the rows (linked target records) in addition to
  // the columns scoped by field_ids. null/undefined for non-research views.
  project_ids?: string[] | null; // subset of linked target ids to render as rows
  research_container_field_id?: string | null; // pin a view to one section_mirror container
  created_at: string;
  updated_at: string;
}

// Access control types

export type ModelPermission = 'view' | 'create' | 'edit' | 'delete' | 'import' | 'export';

export interface ProfileModelPermissions {
  model_id: string;
  permissions: ModelPermission[];
}

export interface Profile {
  id: string;
  label_ar: string;
  label_en: string;
  model_permissions: ProfileModelPermissions[];
  // Structural: can't be deleted from UI. Seed Administrator = true.
  is_system: boolean;
  // Semantic: gates admin-only routes (Builder, Workflows, Dashboards, Settings/*).
  is_admin: boolean;
  created_at: string;
  updated_at: string;
}

// Role types (operational/assignment)
//
// Roles share the same `schema` shape as models — same sections, same full
// palette of field types, same per-field options. This lets the Model
// Builder's SectionManager + FieldEditor be reused as-is for role schemas.
// Legacy `field_definitions: RoleFieldDefinition[]` is migrated to
// `schema.sections[0].fields` on first boot (see appStore.initialize).

export interface Role {
  id: string;
  label_ar: string;
  label_en: string;
  schema: ModelSchema;
  // Structural: can't be deleted from UI. Seed Sales Rep / Sales Manager = true.
  is_system: boolean;
  created_at: string;
  updated_at: string;
}

// Result type for destructive / invariant-bearing store mutations.
// Stable machine-readable `reason` codes; pages map them to localized toasts.
export type StoreMutationReason =
  | 'is_system'
  | 'has_users'
  | 'self_delete'
  | 'last_admin'
  | 'missing_profile';

export type StoreMutationResult =
  | { ok: true }
  | { ok: false; reason: StoreMutationReason };

// User types

export interface UserRoleAssignment {
  role_id: string;
  field_values: Record<string, unknown>;
}

export interface User {
  id: string;
  name_ar: string;
  name_en: string;
  email: string;
  profile_id: string;
  role_assignments: UserRoleAssignment[];
  is_active: boolean;
  created_at: string;
  updated_at: string;
}

// UI types

export type Language = 'ar' | 'en';

export type ToastType = 'success' | 'error' | 'info';

export interface Toast {
  id: string;
  message: string;
  type: ToastType;
}

// Store types

export interface AppState {
  // Data
  models: AppModel[];
  groups: ModelGroup[];
  records: Record<string, AppRecord[]>;
  workflows: Workflow[];
  workflowRuns: WorkflowRun[];
  dashboards: Dashboard[];
  views: ModelView[];
  users: User[];
  profiles: Profile[];
  roles: Role[];
  fieldTemplates: FieldTemplate[];
  currentUserId: string | null;

  // Auth (Supabase Auth session state)
  /** Email of the currently signed-in auth user, or null if signed out. */
  authEmail: string | null;
  /** True once the initial session-check completes. Used to avoid flashing
   *  the login page before we've checked localStorage for a cached session. */
  authReady: boolean;

  // UI
  language: Language;
  toasts: Toast[];
  /**
   * Queue of `targeted_projects` record ids awaiting a research-linking
   * prompt. When a new targeted project is saved (single form, bulk edit,
   * bulk import, workflow fan-out) its id is appended here. A global modal
   * shows every queued project at once and lets the user decide per-project:
   * create a new research study, append to an existing study, or skip.
   * Empty array when nothing is pending.
   */
  pendingResearchPromptTargetedIds: string[];

  // Init
  initialized: boolean;
  initialize: () => Promise<void>;

  // Auth actions
  /**
   * Called once at app startup. Reads the cached Supabase session, subscribes
   * to future auth changes, and sets `authEmail` / `authReady`. Safe to call
   * multiple times — subsequent calls are no-ops.
   */
  bindAuth: () => Promise<void>;
  /**
   * Sign out of Supabase Auth and clear the in-memory current user. Does NOT
   * wipe localStorage data (the user will see their cached view again on next
   * sign-in, which is the desired behavior).
   */
  signOutAndClear: () => Promise<void>;

  // Language
  setLanguage: (lang: Language) => void;

  // Toasts
  addToast: (message: string, type: ToastType) => void;
  removeToast: (id: string) => void;

  // Research prompt (fired after Targeted Projects record creation — queued)
  queueResearchPromptTargetedId: (id: string) => void;
  dismissResearchPrompts: (ids?: string[]) => void;

  // Models
  saveModel: (model: AppModel) => void;
  deleteModel: (modelId: string) => void;
  /**
   * Rename a field's slug AND apply the rest of the field's edits in one
   * atomic transaction. Propagates the slug change to record data keys, same-model
   * formula expressions, cross-model lookups / mirrors / section-mirrors, workflow
   * conditions + mappings, and virtual field IDs in views. `updatedField` carries
   * the full new field body (label, type, options, section_id, etc.) — same
   * contract as `SectionManager.saveField`'s `onSave`.
   */
  renameField: (modelId: string, fieldId: string, updatedField: ModelField) => void;

  // Groups
  saveGroup: (group: ModelGroup) => void;
  deleteGroup: (groupId: string) => void;

  /**
   * Reorder the sidebar menu in one atomic commit. The `models` and `groups`
   * arrays must be the full desired next state — the position of each item
   * in its array becomes its new `order`. Use this from the Menu Arrangement
   * settings page; individual save actions are better for single edits.
   */
  reorderMenu: (models: AppModel[], groups: ModelGroup[]) => void;

  // Records
  getRecords: (modelId: string) => AppRecord[];
  saveRecord: (record: AppRecord) => void;
  deleteRecord: (modelId: string, recordId: string) => void;
  // Re-saves every record on the model where `targetFieldId`'s value is empty,
  // causing the save-time fallback resolver to fill it. Used by the Builder's
  // "Apply to existing records" button. Returns the count of records touched.
  applyFallbackToExistingRecords: (modelId: string, targetFieldId: string) => { count: number };

  // Workflows
  saveWorkflow: (workflow: Workflow) => void;
  deleteWorkflow: (workflowId: string) => void;

  // Workflow execution logs (audit trail)
  appendWorkflowRun: (run: WorkflowRun) => void;
  deleteWorkflowRun: (runId: string) => void;
  clearWorkflowRuns: (workflowId?: string) => void;

  // Dashboards
  saveDashboard: (dashboard: Dashboard) => void;
  deleteDashboard: (dashboardId: string) => void;

  // Views (per-model saved table configurations)
  saveView: (view: ModelView) => void;
  deleteView: (viewId: string) => void;
  setDefaultView: (modelId: string, userId: string, viewId: string | null) => void;

  // Users
  saveUser: (user: User) => StoreMutationResult;
  deleteUser: (userId: string) => StoreMutationResult;
  setCurrentUser: (userId: string | null) => void;

  // Profiles
  saveProfile: (profile: Profile) => void;
  deleteProfile: (profileId: string) => StoreMutationResult;

  // Roles
  saveRole: (role: Role) => void;
  deleteRole: (roleId: string) => StoreMutationResult;

  // Field templates
  saveFieldTemplate: (template: FieldTemplate) => void;
  deleteFieldTemplate: (templateId: string) => void;
}
