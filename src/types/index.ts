import type { AnalyticsQuery, AnalyticsResult } from '../lib/analytics/types';

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
  | 'multi_link'
  | 'checkbox'
  | 'dropdown'
  | 'multiselect'
  | 'lookup'
  | 'location'
  | 'unit_picker'
  | 'mirror'
  | 'section_mirror'
  | 'section_selector'
  | 'assignee'
  | 'notes'
  | 'range'
  | 'auto_id'
  | 'formula'
  | 'table'
  | 'image'
  | 'multi_image'
  | 'video'
  | 'multi_video'
  | 'file'
  | 'multi_file'
  | 'attachment'
  | 'template_variables'
  | 'templates_picker'
  | 'generations_gallery'
  | 'whatsapp_history'
  | 'call_history';

/**
 * Reference to either a file row or folder row in the Files System (the
 * /files page, backed by the `wassel-files` Storage bucket + `files` /
 * `folders` tables). The `attachment` field type stores AttachmentRef[].
 * `file` / `multi_file` / `image` / `multi_image` store the raw file id
 * (or array of ids) instead — folders aren't valid targets for those.
 */
export type AttachmentRef =
  | { type: 'file'; id: string }
  | { type: 'folder'; id: string };

// Column in a `table` field. The table's stored value on a record is an
// array of row objects keyed by `name` (slug). Phase-1 storage mode is
// always 'inline' (JSONB on the parent record). A future `child_model`
// mode can add relational storage without a breaking change.
export type TableColumnType = 'text' | 'textarea' | 'number' | 'currency' | 'date' | 'url' | 'dropdown' | 'formula' | 'image_icon';

export interface TableColumn {
  id: string;
  name: string; // slug, snake_case
  label_ar: string;
  label_en: string;
  type: TableColumnType;
  required?: boolean;
  options?: FieldOption[]; // dropdown columns only
  // Formula config (formula columns only). The expression is evaluated per row
  // against the row's data — `{column_slug}` references resolve to that row's
  // cells. Re-uses the standard formulaEngine. The cell renders read-only.
  formula_expression?: string;
  formula_output_type?: 'number' | 'currency' | 'percentage' | 'text';
  formula_decimals?: number; // 0..6, default 2
  formula_currency?: string; // e.g. 'SAR'. Only when output_type is 'currency'.
  formula_thousands_separator?: boolean; // default true
}

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
  // The stable API name. Stored on records (`record.data[slug]`) and compared
  // as a literal string by workflows, filters, and code. Seeded from the
  // initial label when the option is first created, then NEVER rewritten by
  // label edits — users can change display labels without breaking anything
  // downstream. The Builder exposes this as an editable `api_name` input; we
  // recommend not changing it once records reference the option.
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

/**
 * Field-level conditional visibility. When a field carries a `visible_when`
 * rule, it renders in the record form ONLY if the controlling field's current
 * value matches one of `values` (membership test — the controller value may be
 * a scalar OR an array, as with dropdown / multiselect / section_selector).
 * `field_id` references the controlling field by id (stable across renames).
 * Display-only: it does not change storage, table columns, exports, or the
 * field's own behavior. See `isFieldVisible` in src/lib/fieldVisibility.ts.
 */
export interface FieldVisibilityRule {
  field_id: string; // controlling field's id (any sibling on the same model)
  values: string[]; // show this field when the controller's value is one of these
}

/**
 * One level of a `location` cascade field (region → city → district). Levels are
 * ordered top → bottom. Each level points at a geography model and stores the
 * picked record id under `key` in the field's compound value. A child level's
 * candidate list is filtered to records whose `parent_link_field` holds the
 * parent level's selected id(s). When `parent_link_field` is omitted it's
 * auto-detected: the child model's first `lookup` field whose `lookup_model_id`
 * equals the parent level's `model_id` (e.g. cities.region_lookup → regions,
 * districts.city_lookup → cities).
 */
export interface LocationLevel {
  key: string; // role key in the stored value: 'region' | 'city' | 'district'
  model_id: string; // geography model this level picks from
  display_field: string; // slug shown to the user (name_ar / display_name)
  parent_link_field?: string | null; // slug on this level's records holding the parent record id; null/absent for the top level
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
  // Location cascade (type: 'location'). A guided region → city → district picker
  // where each level is gated by its parent and the child list is filtered to the
  // parent's children. Stored value is a compound object keyed by each level's
  // `key`: single mode → { region?: id, city?: id, district?: id }; multi mode →
  // { region: id[], city: id[], district: id[] }. See LocationLevel.
  location_multi?: boolean; // false = one pick per level (projects/listings/offices); true = multi only on the deepest level (client preferences)
  location_levels?: LocationLevel[]; // ordered top → bottom; defaults to the regions/cities/districts geography models
  // Default ids per level key, used to pre-seed an EMPTY location field so the user
  // only has to pick the deepest level (e.g. region+city default to الرياض → the user
  // just picks a district; they can still change region/city). Display/seed only —
  // nothing is written until the user actually picks.
  location_default?: Record<string, string>;

  // Unit picker (type: 'unit_picker'). A cascading project→unit selector: the
  // user first picks a project (filter only, NOT stored) from the project model
  // that owns units, then picks one or more units rendered as cards (the unit
  // model's card_config). Stored value is the unit id(s) — a string when single,
  // string[] when is_multi. The project model is derived from the link field's
  // lookup_model_id, so only these two need configuring:
  unit_picker_unit_model_id?: string | null; // model holding the units (default: the `units` model)
  unit_picker_project_link_field?: string; // slug on the unit model whose lookup points at the project (default 'project_id')
  assignee_role_ids?: string[];
  assignee_profile_ids?: string[];
  // 'all'        — any active user is eligible (role/profile lists ignored)
  // 'restricted' — eligible users = active users whose profile is in
  //                assignee_profile_ids OR who hold any role in
  //                assignee_role_ids (union, not intersection)
  // Missing/undefined is inferred for backward compat: empty role_ids
  // (and no profile_ids) means 'all'; otherwise 'restricted'.
  assignee_user_filter_mode?: 'all' | 'restricted';
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
  // When `options` (above) is set, the record form renders min & max as two
  // <select> pickers instead of free number inputs. Option `value`s MUST be
  // numeric strings so the stored {min,max} stays numeric (v_* views, analytics,
  // PDF/Excel, sort/search all depend on it). Leave options empty for free entry.
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
  // Conditional visibility. When set, this field only renders in the record
  // form if the controlling field's value matches the rule (see
  // FieldVisibilityRule). Null/absent = always visible. A field that already
  // holds a value is shown regardless, so toggling the controller never hides
  // data the user already entered.
  visible_when?: FieldVisibilityRule | null;
  // Fallback source field. When set and this field's value is empty at save
  // time, `saveRecord` copies the referenced field's current value into this
  // field. User-editable afterward (not a derived/computed snapshot). Disallowed
  // as *target* for types where "empty" isn't meaningful or the value is already
  // computed: formula, mirror, section_mirror, section_selector, auto_id, notes,
  // checkbox, assignee. Cannot self-reference; source may not be formula / mirror
  // / section_mirror (those resolve in a different phase). Lookup sources resolve
  // to the linked record's `lookup_display_field` — never a raw UUID.
  fallback_source_field_id?: string | null;
  // Table field (type: 'table'). Stored value shape is Array<Record<columnSlug, unknown>>.
  // Columns are defined inline on the field so each table can have its own
  // schema. Phase 1: inline JSONB storage only (never a separate table/model).
  table_columns?: TableColumn[];
  table_min_rows?: number; // validation hint; 0 = any
  table_max_rows?: number; // 0/undefined = unlimited
  // Image / file / attachment fields (types: 'image', 'multi_image', 'file',
  // 'multi_file', 'attachment'). Uploads land in the Files System
  // (`wassel-files` Storage bucket + `files` table), NOT the legacy
  // marketing-assets bucket. Stored value shapes:
  //   image        → string (a `files.id` UUID, or a legacy/external http(s) URL)
  //   multi_image  → string[] (array of `files.id` / URLs)
  //   video        → string (a `files.id` UUID, or an external video URL —
  //                  direct media file OR a YouTube/Vimeo link, embedded inline)
  //   multi_video  → string[] (array of `files.id` / video URLs)
  //   file         → string (a `files.id` UUID)
  //   multi_file   → string[]
  //   attachment   → AttachmentRef[] (file OR folder references; preserves order)
  // The form input is a drop-zone + chip / thumbnail row that, on upload,
  // opens a folder picker so the user chooses where in the Drive the
  // bytes land. Click on a chip opens the existing FilePreviewModal.
  image_max_size_mb?: number; // default 25 (image) / 200 (video); soft cap enforced client-side. Applies to image/video/file/multi_*/attachment.
  image_accept?: string; // MIME pattern; default for `image` is 'image/*'; `video` is 'video/*'; for `file` is everything in the FILES bucket allowlist.
  // Preferred destination folder in the user's Drive when uploading through
  // this field. `null` (or absent) = upload to Drive root. User can override
  // at upload time via the folder picker. NOT a hard constraint — the user
  // can also pre-existing files from anywhere in their Drive.
  attachment_default_folder_id?: string | null;
  // Soft cap on how many items a multi_image / multi_file / attachment field
  // accepts. Absent / 0 = unlimited.
  attachment_max_items?: number;
  // Legacy props from the pre-files-system image field. Kept on the type so
  // existing seed-model rows that wrote them still parse; never read by the
  // current Files-system-backed inputs. Safe to omit on new fields.
  /** @deprecated — the marketing-assets bucket is no longer used by record fields. */
  image_folder?: 'raw' | 'cleaned' | 'final' | 'reference' | 'presets' | 'snippets' | 'image-chats/uploads';
  // Reverse-link primitive. When THIS field's value changes, the form
  // debounce-searches the sibling lookup's target model for a record where
  // `auto_link_target_field_name` matches this field's value, and on a
  // unique match sets the lookup field to that record's id. Used by the
  // visits model: typing a client phone in the `phone` field auto-selects
  // the matching `client_id` lookup.
  //
  // `auto_link_normalize` controls how the typed value is compared. 'phone'
  // routes through normalizePhone() to handle 0xx / 5xx / 966 / +966 all
  // collapsing to the same E.164 form. Future-proofed as a discriminated
  // string so we can add 'email_lower' / 'whitespace_collapsed' etc.
  // without breaking existing rows.
  auto_link_lookup_field_id?: string | null;
  auto_link_target_field_name?: string | null;
  auto_link_normalize?: 'phone';
  // Auto-create primitive (extends auto-link). When the debounced search
  // returns zero matches AND this is true, the form creates a new minimal
  // record in the lookup target model with `{ [auto_link_target_field_name]:
  // <normalized value> }`, then links to it. Used by the appointments
  // model: typing a phone that doesn't belong to any existing client
  // creates a new client on the fly so the user can keep filling out the
  // appointment without context-switching to /model/clients/new.
  //
  // `auto_link_create_min_length` guards against mid-typing creates: the
  // normalized source value must be at least this many characters before
  // the create fires. Sensible default for E.164 Saudi mobiles is 12
  // (e.g. "+9665012345" is 11 — too short; "+966501234567" is 13 — ok).
  // Absent / 0 = no guard (any non-empty value triggers create — risky).
  auto_link_create_if_missing?: boolean;
  auto_link_create_min_length?: number;
  // Controls WHEN the auto-create fires. 'while_typing' (default, the
  // appointments behavior) creates the missing record during the debounced
  // search in useAutoLink. 'on_save' defers creation to the form Save commit
  // (see createMissingLinkedRecords) so a record is only created when the user
  // actually commits — used by the visits model so a half-typed phone never
  // spawns a stray client.
  auto_link_create_timing?: 'while_typing' | 'on_save';
  // Extra fields to copy from the CURRENT record into the newly-created target
  // record (beyond auto_link_target_field_name, which always receives the
  // matched value). Each entry maps a source field slug on THIS model → a
  // target field slug on the lookup model. Visits uses
  // [{ from: 'name', to: 'client_name' }] so an auto-created client captures
  // the typed visitor name, not just the phone number.
  auto_link_create_copy_fields?: { from: string; to: string }[];
  // Forward auto-fill primitive. When the referenced lookup field's value
  // changes, the form copies the linked record's `auto_fill_source_field_name`
  // value into THIS field. Editable afterwards — user overrides survive
  // until the lookup id changes again. Used by the visits model: picking
  // a client_id auto-fills the visit's `name` from the client's
  // `client_name`. Different from `mirror`: mirror is read-only and resolves
  // at render time; auto-fill writes once on change and the user can edit.
  auto_fill_from_lookup_field_id?: string | null;
  auto_fill_source_field_name?: string | null;
  // Dynamic default for NEW records, applied by useFieldDefaults on the create
  // form when this field is still empty. 'current_user' stamps the signed-in
  // user's id (assignee fields); 'now' stamps the current ISO datetime
  // (datetime); 'today' stamps the current ISO date (date). The user can edit
  // the value afterwards — this only seeds the initial blank, it does not lock
  // the field. Visits uses 'current_user' on sales_representative and 'now' on
  // scheduled_datetime. 'token' stamps a random opaque key (crypto.randomUUID)
  // — used for the hidden, write-once visits.rating_token the public rating link
  // references; a DB BEFORE-INSERT trigger backstops server-created records.
  default_dynamic?: 'current_user' | 'now' | 'today' | 'token';
  // Cross-record rollup. When `is_rollup` is true the field is never
  // user-edited; it's a STORED aggregate maintained by a DB trigger
  // (units → project rollups on all_projects — see
  // src/lib/ourProjectsRollup.ts and 2026-06-15_persist_project_rollups.sql).
  // `rollup_kind` selects which recipe the trigger runs into this field's
  // slug. The field's underlying `type` still controls rendering (a count
  // uses `number`, a min/max uses `range`, a per-meter average uses
  // `currency`) so the form + table cells render it with no special casing —
  // they only treat the input as read-only, which the permissions resolver
  // does for any `is_rollup` / `read_only` field.
  is_rollup?: boolean;
  rollup_kind?: OurProjectsComputedKind;
  read_only?: boolean;
  // Conditional units-derived field (distinct from the unconditional
  // `is_rollup` aggregates above). When `auto_from_units` is true the field is
  // derived from this project's linked units ONLY while at least one unit is
  // linked — the DB trigger (`recalc_project_rollups_data`) fills the distinct
  // set of the units' values and the form renders the field read-only. With NO
  // linked units the trigger leaves the value untouched and the form keeps it
  // manually editable, so the user-entered value stands in until units exist.
  // Used by all_projects.unit_types (derived from units.unit_type). Unlike
  // `is_rollup` this does NOT force read-only everywhere — read-only is decided
  // per-record in SectionBlock based on whether the project has linked units.
  auto_from_units?: boolean;
}

// ── Computed-field rollup kinds ────────────────────────────────────────
//
// Hardcoded recipes for the units → project rollups (used by both
// our_projects and all_projects). Each kind has a matching implementation
// in src/lib/ourProjectsRollup.ts. When you add
// a new kind here you MUST also add a case to `computeOurProjectsRollups`
// or the field's value silently stays `null` for every record. Kinds
// follow snake_case so the value lines up with the slug we suggest in
// the seed model (e.g. units_available_count → field slug
// `units_available`). Slugs are NOT required to match kinds 1:1 — the
// rollup engine writes to `field.name`, not to the kind's string.
export type OurProjectsComputedKind =
  | 'units_count'              // COUNT of units linked to this project
  | 'units_available_count'    // COUNT where unit_status is the "available" option
  | 'units_sold_count'         // COUNT where unit_status is the "sold" option
  | 'units_reserved_count'     // COUNT where unit_status is the "reserved" option
  | 'price_range'              // { min, max } of unit.price (range shape) — ALL units, incl. sold/reserved
  | 'area_range'               // { min, max } of unit.area_sqm (range shape) — ALL units, incl. sold/reserved
  | 'available_price_range'    // { min, max } of unit.price over AVAILABLE units only (customer-facing)
  | 'available_area_range'     // { min, max } of unit.area_sqm over AVAILABLE units only (customer-facing)
  | 'bedroom_range'            // { min, max } of unit.bedrooms (range shape)
  | 'bathroom_range'           // { min, max } of unit.bathrooms (range shape)
  | 'min_price_per_meter'      // MIN of (price / area_sqm), skipping units with area_sqm ≤ 0
  | 'max_price_per_meter'      // MAX of (price / area_sqm), skipping units with area_sqm ≤ 0
  | 'avg_price_per_meter';     // AVG of (price / area_sqm), skipping units with area_sqm ≤ 0

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

/**
 * Per-model Maps view config (JSONB on `models.maps_config`). Mirrors the
 * `card_config` pattern. See src/pages/Records/components/MapsView.tsx.
 */
export interface MapsConfig {
  location_url_field_id: string | null;
  manual_lat_field_id: string | null;
  manual_lng_field_id: string | null;
  pin_color_field_id: string | null;
  pin_label_field_id: string | null;
  click_action: 'popup' | 'navigate';
  popup_title_field_id: string | null;
  popup_subtitle_field_id: string | null;
  popup_badge_field_id: string | null;
  popup_shown_field_ids: string[];
  map_style_json: string | null;
  default_center_lat: number | null;
  default_center_lng: number | null;
  default_zoom: number | null;
}

export const MAPS_CONFIG_DEFAULT: MapsConfig = {
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

export interface ModelSchema {
  sections: ModelSection[];
  section_selector_field_id?: string | null;
  // When set, import skips any row whose value for this field matches an
  // existing record's value for the same field (case-insensitive, trimmed).
  // Lookup fields compare by resolved id; everything else compares by string.
  duplicate_check_field_id?: string | null;
  // User-defined custom buttons that render in the record form / list view
  // and trigger workflows on click. Optional for back-compat — older models
  // simply have none.
  custom_buttons?: CustomButton[];
}

// ── Custom buttons ────────────────────────────────────────────────────
// User-configurable buttons attached to a model. Each renders in the
// record form, the list-view toolbar, or both, and fires a workflow when
// clicked. The workflow is run server-side with the current record as the
// trigger context, so any `trigger_field` references in the workflow's
// actions resolve against fields on the clicked record.
export type CustomButtonLocation = 'record_form' | 'record_list';

// For now buttons can trigger a workflow OR fire the marketing-operations
// design generator (Higgsfield two-phase orchestration). Future actions
// extend this discriminated union.
export type CustomButtonActionType =
  | 'trigger_workflow'
  | 'generate_design'
  | 'analyze_reel'
  | 'create_record'
  | 'find_or_create_record';

export interface CustomButtonActionTriggerWorkflow {
  type: 'trigger_workflow';
  workflow_id: string;
}

/**
 * Fires `/api/marketing/generate` for the current record. Server reads the
 * record + linked template + linked project, runs Higgsfield phase 1
 * (cleanup) and phase 2 (design), and writes results back to the record.
 * No payload — the action discriminator is enough.
 */
export interface CustomButtonActionGenerateDesign {
  type: 'generate_design';
}

/**
 * Fires `/api/analyze-reel` for the current record: cleans the raw `content`
 * transcript (transcription correction) and extracts the marketing-analysis
 * fields (hook, angle, psychological trigger, structure, tone, CTA) back onto
 * the record. Used by the Competitor Library's "Clean & Analyze" button.
 * No payload — the action discriminator is enough.
 */
export interface CustomButtonActionAnalyzeReel {
  type: 'analyze_reel';
}

/**
 * Maps one field on the trigger record to one field on the new/found target
 * record. Used by `create_record` (prefill) and `find_or_create_record`
 * (search criteria + prefill on no-match). Both names are the field's
 * snake_case slug — never UUIDs — because the consumer reads/writes the
 * record's JSONB `data` map by slug.
 */
export interface CustomButtonFieldMap {
  target_field_name: string;
  source_field_name: string;
}

/**
 * Opens a record-form modal for `target_model_id` with a blank new record.
 * `prefill` copies values from the trigger record into the new record's
 * data before the user sees the form. Used by the Follow-Ups buttons
 * "Book a visit" (target = visits) and "Schedule a follow-up" (target =
 * followups), both prefilling the client.
 */
export interface CustomButtonActionCreateRecord {
  type: 'create_record';
  target_model_id: string;
  prefill?: CustomButtonFieldMap[];
}

/**
 * Opens a record-form modal for `target_model_id` with either:
 * - an existing record (the latest match by `search_by` + `order_by`), or
 * - a blank new record prefilled per `prefill` if no match exists.
 *
 * `search_by` is treated as an AND of equality predicates against
 * `unified_records.data->>field`. Used by the Follow-Ups "Register a visit"
 * button to find the most recent visit for the trigger record's client_id
 * and surface it for editing.
 */
export interface CustomButtonActionFindOrCreateRecord {
  type: 'find_or_create_record';
  target_model_id: string;
  search_by: CustomButtonFieldMap[];
  order_by: 'created_at_desc' | 'updated_at_desc';
  prefill?: CustomButtonFieldMap[];
}

export type CustomButtonAction =
  | CustomButtonActionTriggerWorkflow
  | CustomButtonActionGenerateDesign
  | CustomButtonActionAnalyzeReel
  | CustomButtonActionCreateRecord
  | CustomButtonActionFindOrCreateRecord;

export interface CustomButton {
  id: string;
  label_ar: string;
  label_en: string;
  // Lucide icon name (e.g. 'sparkles', 'play', 'wand-2'). Defaults to
  // 'sparkles' on the consumer side when undefined.
  icon?: string;
  // Hex; falls back to `model.color` at render time when undefined.
  color?: string;
  // Where the button appears in the UI. At least one location must be
  // selected — we hide buttons with an empty `locations` array.
  locations: CustomButtonLocation[];
  action: CustomButtonAction;
  // Allows the button to be disabled without deleting it (so its
  // workflow / mappings are preserved).
  enabled?: boolean;
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
  maps_config: MapsConfig;
  group_id?: string | null;
  /**
   * Sidebar display order within the model's group (or within the
   * ungrouped section if `group_id` is null). Lower = higher in the list.
   * Optional for backward compatibility; init assigns a value to any model
   * that lacks one.
   */
  order?: number;
  is_system: boolean;
  /**
   * Frozen ("hardcoded") flag. When true, this model has been promoted
   * from a JSONB row in the unified `records` table to its own physical
   * Postgres table named `table_name`. Reads/writes go through the
   * record_save / unified_records SQL paths instead of `records` directly.
   * Schema edits via the Builder UI are disabled for frozen models —
   * future changes happen via Claude writing a migration. Custom-UI
   * models (`chats`, `ai_chats`) cannot be frozen.
   * See `freeze_model()` in supabase/schema.sql.
   */
  is_hardcoded?: boolean;
  /**
   * Physical table name when `is_hardcoded` is true. Equals `name` for
   * every model frozen through the standard pipeline; kept as a separate
   * field so a future rename-physical-table operation doesn't have to
   * walk every consumer. Null/undefined for unfrozen models.
   */
  table_name?: string | null;
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
  /**
   * The in-app `users.id` of whoever first saved this record. Set on first
   * `saveRecord` when a user is signed in; preserved across edits. Older
   * records imported before this column existed will have `null` and are
   * treated as "no known creator" by scope filters.
   *
   * Filter-based view/edit scopes can reference this via the `created_by`
   * target — the canonical "records I created" rule. See ScopeFilterCondition.
   */
  created_by_user_id?: string | null;
  created_at: string;
  updated_at: string;
  /**
   * Optimistic-concurrency version (Phase F.2). Bumped by a BEFORE UPDATE
   * trigger on `records`. The store passes the loaded `version` into
   * `record_save` as `p_expected_version` on every save; if another tab
   * has bumped it server-side since we loaded, the RPC raises
   * `version_mismatch` and we surface a "reload to see latest" toast
   * rather than silently overwriting their edit. May be missing on
   * records imported before the column existed — null is treated as
   * "skip the check" by the RPC.
   */
  version?: number;
}

// Freeze types — see `freeze_model()` in supabase/schema.sql.

/**
 * One row that would fail JSONB → typed-column coercion if the model were
 * frozen now. Returned by `checkFreezeCoercion` so the Freeze modal can
 * point the user at exactly which records to fix before promoting the
 * model.
 */
export interface FreezeCoercionFailure {
  record_id: string;
  field_name: string;
  field_type: string;
  raw_value: string | null;
  reason: string;
}

/**
 * Result of a successful `freezeModel` call. Errors throw — the caller is
 * expected to surface them via toast.
 */
export interface FreezeResult {
  ok: boolean;
  modelId: string;
  modelName: string;
  tableName: string;
  rowsCopied: number;
  frozenAt: string; // ISO timestamp
  error?: string; // populated when ok=false
}

/**
 * Optional context callers can pass to `saveRecord` to opt into stronger
 * concurrency guarantees and richer telemetry.
 *
 * `expectedVersion` — the value of `record.version` at the moment the
 * caller LOADED the record (e.g. when a form first mounts). The store
 * passes this to the `record_save` RPC as `p_expected_version`. The RPC
 * raises `version_mismatch` (SQLSTATE 40001) if the row has been bumped
 * by another writer in the meantime, and `saveRecord` resolves with
 * `{ status: 'conflict' }` instead of silently overwriting. Pass
 * `undefined` (or omit) to fall back to the store's live version
 * (the pre-Phase F.2-fix behavior — fine for fire-and-forget callers
 * but unsafe for forms that may stay open while realtime mutates the
 * underlying row).
 */
/**
 * Audit M5: actor provenance for activity log entries. Default kind='user'.
 * Workflow engine / webhooks / AI agent pass their own kind so the unified
 * /logs timeline can split bot-driven edits from manual ones.
 */
export type SaveRecordActor =
  | { kind: 'user' }
  | { kind: 'workflow'; workflow_id: string; run_id?: string }
  | { kind: 'webhook'; slug: string }
  | { kind: 'agent'; conversation_id?: string };

export interface SaveRecordOpts {
  expectedVersion?: number | null;
  actor?: SaveRecordActor;
}

/**
 * Discriminated outcome of a single record save.
 *
 * - `saved`    — the row landed in Supabase (or there was no Supabase
 *                client to write to and the in-memory + localStorage
 *                update is the entire story for an offline-only deploy).
 * - `queued`   — the Supabase write failed for a non-conflict reason
 *                (network, RLS, FK, RPC error). The write was added to
 *                the `wassell_pending_sync` retry queue and will replay
 *                on the next `initialize()`. Local state IS updated.
 * - `conflict` — the RPC returned `version_mismatch`: another writer
 *                bumped the row's version since we loaded it. The write
 *                was NOT enqueued (replay would just hit the same
 *                conflict). Local state IS updated, but the caller
 *                should warn the user to reload before saving again.
 */
export type SaveResult =
  | { status: 'saved' }
  | { status: 'queued'; reason: string }
  // `kind` (T1) lets callers distinguish a recoverable concurrent edit
  // (`version_mismatch` — one reload/retry is allowed) from a terminal stop
  // (`storm_blocked` from the server, `wedged` after a failed reload, or a
  // `hard_stop` tab-wide write lock) where NO automatic retry must happen.
  | {
      status: 'conflict';
      message: string;
      kind?: 'version_mismatch' | 'storm_blocked' | 'wedged' | 'hard_stop';
    };

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

export type WorkflowEvent = 'create' | 'update' | 'delete' | 'webhook' | 'button_click' | 'on_due';

// A declared inbound-webhook endpoint. External systems POST JSON to
// /functions/v1/inbox/<slug> and the workflow engine fires any workflow
// whose `trigger_webhook_slug_id` points at this slug's id.
export interface WebhookSlug {
  id: string;
  slug: string;
  name: string;
  description?: string | null;
  secret?: string | null;
  payload_schema?: Record<string, unknown>;
  is_active: boolean;
  created_at: string;
  updated_at: string;
  created_by?: string | null;
}

// One received payload row. Kept as an audit trail; `consumed_at` is claimed
// atomically by the first client that runs its workflows so multiple open
// browsers don't double-fire.
export interface WebhookPayload {
  id: string;
  slug: string;
  slug_id?: string | null;
  payload: Record<string, unknown>;
  signature_valid?: boolean | null;
  source_ip?: string | null;
  received_at: string;
  consumed_at?: string | null;
  consumed_by?: string | null;
  error?: string | null;
}

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

export type WorkflowActionType = 'create_record' | 'update_record' | 'send_notification' | 'assign_user' | 'http_request' | 'outbound_ivr' | 'send_whatsapp_message' | 'paseet_query';

// HTTP method for the outbound `http_request` workflow action.
export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

// A single header pair on the http_request action. The value supports the
// same `{field_slug}` templating as `url` and `body_template`.
export interface HttpHeaderPair {
  id: string;
  name: string;   // e.g. "Authorization", "Content-Type"
  value: string;  // may include "{trigger_field_slug}" tokens
}

export type HttpBodyMode = 'none' | 'json_template' | 'form_mappings';

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

// Outbound HTTP request. Intended for calling external webhooks (e.g. a
// Supabase edge function that runs an AI agent) from a workflow. Fire-and-
// forget by default — the action records the response status in the run log
// but doesn't block other actions and doesn't write the response back to any
// record (the callee should write its own result via a record update or via
// an inbound webhook that triggers another workflow).
export interface WorkflowActionHttpRequest {
  id: string;
  type: 'http_request';
  method: HttpMethod;
  url: string;                   // may include "{trigger_field_slug}" tokens
  headers?: HttpHeaderPair[];    // optional extra headers
  body_mode: HttpBodyMode;       // 'none' | 'json_template' | 'form_mappings'
  // For 'json_template': raw JSON string with {field_slug} tokens. Invalid
  // JSON after substitution is sent as-is; the response is logged for debug.
  body_template?: string;
  // For 'form_mappings': each mapping becomes one top-level key in a JSON body.
  body_mappings?: FieldMapping[];
  // Max wall time before we abort the request and log a 'failed' trace.
  // Default 30000 (30s). Cap at 120000 (2min) so a stuck request can't wedge
  // the workflow run.
  timeout_ms?: number;
}

// outbound_ivr — fires an automated phone call via Hatif. Customer (from a
// phone field on the trigger record) hears a TTS message or a pre-uploaded
// audio file, then picks one of the configured digit options. The DTMF
// choice flows back through the post-call webhook into `call_logs.dtmf_*`.
// Tokens like `{field_slug}` in `tts_text` resolve against the trigger record.
export interface WorkflowIvrOption {
  id: string;
  digit: string;      // '0'-'9', '*', '#'
  label_ar: string;
  label_en: string;
}

/**
 * Where the outbound-IVR action pulls its destination phone number from.
 * Four sources:
 *   - trigger_field       — phone field on the record that triggered the workflow
 *   - lookup              — 1-hop traversal: lookup field on trigger → phone field on target
 *   - static              — hardcoded E.164 number (e.g. always call the office)
 *   - prev_action_output  — phone field on a record created by a prior create_record action in the same branch
 */
export type OutboundIvrDestination =
  | { kind: 'trigger_field'; field_name: string }
  | { kind: 'lookup'; lookup_field_name: string; target_phone_field_name: string }
  | { kind: 'static'; phone: string }
  | { kind: 'prev_action_output'; action_id: string; phone_field_name: string };

export interface WorkflowActionOutboundIvr {
  id: string;
  type: 'outbound_ivr';
  // Destination resolver. Replaces the old `to_field_id` shape. For backward
  // compatibility, actions saved before this field existed have `to_field_id`
  // populated and `to` missing — use `getIvrDestination(action)` helper.
  to?: OutboundIvrDestination;
  /** @deprecated — kept for backward compat; migrated to `to` at read time. */
  to_field_id?: string;
  // Hatif channel id. Optional — server falls back to HATIF_DEFAULT_CHANNEL_ID
  // when empty. Exposed as a field so multi-channel tenants can route per workflow.
  channel_id?: string;
  // Audio source: 'tts' speaks the text; 'audio' plays a pre-uploaded Hatif file.
  audio_mode: 'tts' | 'audio';
  // For audio_mode='tts': the message text. Supports `{field_slug}` tokens.
  tts_text?: string;
  tts_voice?: 'Male' | 'Female';
  // For audio_mode='audio': the URL returned by POST /v1/support/upload-audio.
  audio_file_url?: string;
  // Display name the editor shows next to the stored URL (not sent to Hatif).
  audio_file_label?: string;
  // IVR menu options. Hatif requires at least one.
  options: WorkflowIvrOption[];
  // Language hint for Hatif's voice engine. 'ar' or 'en'.
  language?: 'ar' | 'en';
}

// send_whatsapp_message — sends an automated WhatsApp message through the
// Chats module's proxy. Recipient phone comes from a field on the trigger
// record; body supports `{field_slug}` token substitution like http_request
// and outbound_ivr. Mirror-pattern of outbound_ivr (both are "resolve a
// phone + template text + dispatch via a Haberchat/Hatif proxy" flows).
export interface WorkflowActionSendWhatsAppMessage {
  id: string;
  type: 'send_whatsapp_message';
  // Destination resolver — same shape as outbound_ivr so admins get the
  // same 4-source picker (trigger field / lookup / static / previous
  // action output). The union lives on outbound_ivr for historical
  // reasons, but the semantics are "resolve a phone number", not
  // IVR-specific.
  to?: OutboundIvrDestination;
  // Legacy storage from the initial v1 ship — a bare trigger-field slug.
  // Kept for round-tripping saved workflows; the editor upgrades to `to`
  // the first time the action is edited + saved.
  to_field_id?: string;
  // Haberchat device id. Optional — server falls back to
  // HABERCHAT_DEFAULT_DEVICE_ID when empty, then to whichever default the
  // admin marked in /settings/whatsapp-numbers.
  device_id?: string;
  // Message body. Supports `{field_slug}` tokens resolved against the
  // trigger record via substituteFieldTokens().
  body_template: string;
}

// Paseet AI query — sends a free-form Arabic prompt to paseet.ai over a
// Browserbase session bound to a persistent context (so the cookies for
// auth are reused — no login during the workflow), waits for the chat
// response to render, and applies one or more `response_mappings` that
// write parsed pieces of the answer back onto the trigger record.
//
// The prompt template supports `{field_slug}` tokens against the trigger
// record (same shape as http_request body templates). The response_shape
// tells the parser what to extract; the mappings tell it where to put it.
export type PaseetResponseShape =
  // The full settled assistant text after the response stops streaming.
  | 'text'
  // A single scalar value parsed from the answer (e.g. an average price).
  // Use a regex/keyword inside the mapping if you need to pluck one value
  // out of a longer answer.
  | 'single_value'
  // A markdown / HTML table rendered by Paseet, broken into rows of cells.
  // Most common case for the 2 km market study.
  | 'table_rows';

export type PaseetResponseMappingKind =
  // Set one field on the trigger record to the parsed response.
  | 'set_field'
  // Append rows into a `table` type field on the trigger record. Each
  // table_column_mapping resolves a Paseet header keyword to a CRM
  // table column id.
  | 'append_table_rows'
  // Replace the rows of a `table` field instead of appending.
  | 'replace_table_rows';

// Maps a single column inside a Paseet response table → a column inside
// a CRM `table` field. Matched case-insensitively after underscore→space
// normalization, so "متوسط_السعر" matches "متوسط السعر".
export interface PaseetTableColumnMapping {
  id: string;
  // Column id on the target CRM table field (e.g. 'col_1').
  target_column_id: string;
  // Header keyword(s) the Paseet column must contain. Multiple values are
  // OR'd, so "أقل" / "أدنى" both map to the same min column.
  source_header_keywords: string[];
  // For numeric columns: how to coerce the cell text.
  parse_as?: 'text' | 'number' | 'currency';
}

export interface PaseetResponseMapping {
  id: string;
  kind: PaseetResponseMappingKind;
  // Target field slug on the trigger record's model.
  target_field_id: string;
  // For 'set_field' on a single value: how to coerce the parsed value.
  parse_as?: 'text' | 'number' | 'currency';
  // For 'append_table_rows' / 'replace_table_rows': how the Paseet
  // table's columns map onto the CRM table field's columns.
  table_column_mappings?: PaseetTableColumnMapping[];
  // Optional regex applied to the response *before* mapping. Used to
  // pluck a single value out of a longer text answer when
  // response_shape === 'single_value'.
  extract_regex?: string;
}

export interface WorkflowActionPaseetQuery {
  id: string;
  type: 'paseet_query';
  // Arabic (or any language) prompt sent to Paseet's chat. Supports
  // `{field_slug}` tokens that resolve against the trigger record.
  prompt_template: string;
  response_shape: PaseetResponseShape;
  response_mappings: PaseetResponseMapping[];
  // Hard cap on the BB session + Paseet response wait. Default 90000
  // (90s). Cap at 180000 (3 min) — Paseet's complex queries occasionally
  // run that long.
  timeout_ms?: number;
}

export type WorkflowAction =
  | WorkflowActionCreateRecord
  | WorkflowActionUpdateRecord
  | WorkflowActionSendNotification
  | WorkflowActionAssignUser
  | WorkflowActionHttpRequest
  | WorkflowActionOutboundIvr
  | WorkflowActionSendWhatsAppMessage
  | WorkflowActionPaseetQuery;

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
  // Conditions for this branch. Joined by `condition_mode` (default 'all' =
  // AND). Empty = always true (useful for the winning arm of an if/else when
  // the author wants a catch-all without using `is_else`).
  conditions: WorkflowCondition[];
  // How to join the conditions: 'all' = every condition must pass (AND, the
  // default and pre-existing behavior), 'any' = at least one must pass (OR).
  // Optional for back-compat with saves predating this field.
  condition_mode?: 'all' | 'any';
  // Actions run sequentially if this branch wins.
  actions: WorkflowAction[];
  // Marks this branch as the fallback / else arm. Evaluated only if no earlier
  // non-else branch matched. The editor enforces at most one `is_else` branch
  // and pins it to the end of the list.
  is_else?: boolean;
}

// Folder for organizing workflows in the editor list. Mirrors `ModelGroup`.
export interface WorkflowGroup {
  id: string;
  label_ar: string;
  label_en: string;
  order: number;
}

export interface Workflow {
  id: string;
  label_ar: string;
  label_en: string;
  // Folder this workflow lives in. Null / undefined = ungrouped (rendered
  // at the top of the list).
  group_id?: string | null;
  // For record-event triggers (create/update/delete): the model whose event
  // fires the workflow. Empty string when `trigger_event === 'webhook'`.
  trigger_model_id: string;
  trigger_event: WorkflowEvent;
  // Webhook trigger: the id of a `WebhookSlug`. Only meaningful when
  // `trigger_event === 'webhook'`. When a payload arrives on this slug the
  // client claims it and runs this workflow with the payload as the trigger
  // record (conditions + field mappings reference payload fields via the
  // existing `trigger_field` source).
  trigger_webhook_slug_id?: string | null;
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
  // Free-form metadata (JSONB column). Used by the Sales Process Studio to mark
  // workflows it manages/links and to drive drift detection. Round-trips
  // automatically: `workflowToSupabaseRow` spreads the whole object and
  // `supabaseLoad` selects '*', so no mapping code is needed — only the column.
  metadata?: WorkflowMetadata | null;
  created_at: string;
  updated_at: string;
}

// Sales Process Studio binding metadata stamped on a Workflow's `metadata`
// column. `last_generated_hash` is a hash of the simple-generated shape used to
// detect manual ("advanced") edits in the Workflow Builder (drift detection).
export interface WorkflowMetadata {
  sales_process_id?: string;
  managed_by?: 'sales_process_studio' | string;
  sales_stage?: string;
  activity_type?: string;
  outcome?: string;
  compatibility?: 'simple' | 'advanced';
  last_generated_hash?: string;
  [key: string]: unknown;
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

export interface WorkflowActionTraceHttpRequest extends WorkflowActionTraceBase {
  type: 'http_request';
  method: HttpMethod;
  resolved_url: string;              // url after {field} substitution
  resolved_headers?: Record<string, string>;
  body_mode: HttpBodyMode;
  resolved_body?: string;            // serialized body that was sent (may be truncated)
  response_status?: number;
  response_snippet?: string;         // first ~500 chars of the response body
  timeout_ms?: number;
}

export interface WorkflowActionTraceOutboundIvr extends WorkflowActionTraceBase {
  type: 'outbound_ivr';
  resolved_to_number?: string;       // dialed E.164 number (after resolution)
  /** Which source was used to derive the phone: trigger_field / lookup / static / prev_action_output. */
  destination_kind?: OutboundIvrDestination['kind'];
  /** Descriptor captured at resolve time — e.g. "trigger.phone_number" or "static +96655…". */
  destination_description?: string;
  /** @deprecated kept for backward compat with historic run logs. */
  to_field_id?: string;
  channel_id?: string;               // Hatif channel used (resolved)
  audio_mode: 'tts' | 'audio';
  resolved_tts_text?: string;        // text after token substitution (may be truncated)
  audio_file_url?: string;           // for audio_mode='audio'
  tts_voice?: 'Male' | 'Female';
  options_count: number;
  // Hatif returns an IVR call id we can use to correlate webhook → call_logs.
  ivr_call_id?: string;
  response_status?: number;
  response_snippet?: string;
}

export interface WorkflowActionTraceSendWhatsAppMessage extends WorkflowActionTraceBase {
  type: 'send_whatsapp_message';
  resolved_to_number?: string;       // E.164 number after destination resolution
  // Which destination source the admin picked — lets the run log show
  // "trigger field X" / "lookup Y.phone" / "static +966..." without us
  // re-computing it from the action config.
  destination_kind?: 'trigger_field' | 'lookup' | 'static' | 'prev_action_output';
  destination_description?: string;  // e.g. "trigger.phone_number" / "lookup(client).phone_number"
  device_id?: string;                // Haberchat device used (resolved)
  resolved_body?: string;            // body after token substitution (may be truncated)
  // Haberchat returns the new message's wid. Stored so the Realtime row
  // that later arrives via the webhook can be correlated with this action.
  message_wid?: string;
  response_status?: number;
  response_snippet?: string;
}

export type WorkflowActionTrace =
  | WorkflowActionTraceCreate
  | WorkflowActionTraceUpdate
  | WorkflowActionTraceNotify
  | WorkflowActionTraceAssign
  | WorkflowActionTraceHttpRequest
  | WorkflowActionTraceOutboundIvr
  | WorkflowActionTraceSendWhatsAppMessage;

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

// --- Unified activity log (auth, records, workflows, AI agent, API, webhooks) ---

export type ActivityLogCategory =
  | 'auth'      // sign-in, sign-out
  | 'record'    // create, update, delete, open
  | 'workflow'  // workflow run summary (full detail in workflow_runs)
  | 'ai_agent'  // every Claude turn + every tool call
  | 'api'       // every server-side API hit
  | 'webhook'   // incoming webhook receipt
  | 'system'    // initialize, migrations, fatal errors
  | 'file';     // file uploads, views, downloads, share-link events

export type {
  FilePreviewKind,
  FilePermissionRole,
  FolderRow,
  FileRow,
  FilePermission,
  FolderPermission,
  OfficePreviewResponse,
  PdfCompressResponse,
  SharedLink,
  SharedFileResponse,
  WasselDocumentRow,
  DocApprovalStatus,
} from './files';

export type ActivityLogStatus = 'success' | 'error' | 'warning' | 'info';

export interface ActivityLogEntry {
  id: string;
  created_at: string; // ISO
  category: ActivityLogCategory;
  /** Sub-type within the category — free-form, e.g. 'sign_in', 'create',
   *  'turn', 'tool_call', 'request', 'receipt'. */
  event_type: string;
  /** Who caused the event. Null for webhook / system events. */
  actor_user_id: string | null;
  /** Denormalized email so the row stays readable after a user is deleted. */
  actor_email: string | null;
  /** Target model — null when the event isn't about a specific record. */
  target_model_id: string | null;
  target_record_id: string | null;
  /** Human-readable label of the target (record title, model label, etc). */
  target_label: string | null;
  summary_ar: string;
  summary_en: string;
  /** Full detail payload — shape varies by category/event_type. UI pretty-prints. */
  details: Record<string, unknown>;
  duration_ms: number | null;
  status: ActivityLogStatus | null;
  error: string | null;
  /** Deep-link target for category='workflow' rows. */
  workflow_run_id: string | null;
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

export type WidgetType = 'stat' | 'bar_chart' | 'pie_chart' | 'line_chart' | 'table' | 'funnel' | 'leaderboard' | 'gauge' | 'progress' | 'pivot' | 'heatmap' | 'map';

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

// ── Universal analytics widget layer (Phase A) ─────────────────────────
// A widget is a visualization of an `AnalyticsQuery`. `viz` is visualization-
// only config, grouped BY FAMILY so switching variants within a family keeps
// the viz object. The 5 Phase-A families: stat, bars, pies, lines, table.

export interface WidgetNumberFormat {
  decimals?: number;
  thousands_separator?: boolean;
  currency?: string | null; // e.g. 'SAR'
  percent?: boolean;
  compact?: boolean; // 1.2K / 3.4M
}

export type WidgetColorMode =
  | { kind: 'by_group_option' } // use the group-by field's option colors
  | { kind: 'single'; color: string }
  | { kind: 'palette'; colors: string[] };

export interface VizStat {
  family: 'stat';
  color: string;
  number_format?: WidgetNumberFormat;
  icon?: string;
  // Comparison metrics (current vs previous/target/secondary) for the stat card.
  comparison?: {
    mode: 'previous_period' | 'target' | 'secondary_query';
    target_value?: number;
    secondary_query?: AnalyticsQuery;
    good_direction?: 'up' | 'down'; // colors the delta arrow
  };
}
export interface VizBars {
  family: 'bars';
  orientation?: 'vertical' | 'horizontal';
  color_mode?: WidgetColorMode;
  stacked?: boolean; // when a 2nd group-by level supplies the series
  show_legend?: boolean;
  number_format?: WidgetNumberFormat;
}
export interface VizPies {
  family: 'pies';
  donut?: boolean;
  color_mode?: WidgetColorMode;
  show_legend?: boolean;
  number_format?: WidgetNumberFormat;
}
export interface VizLines {
  family: 'lines';
  area?: boolean;
  smooth?: boolean;
  stacked?: boolean;
  color_mode?: WidgetColorMode;
  number_format?: WidgetNumberFormat;
}
export interface VizTable {
  family: 'table';
  // record_list mode: raw records (legacy table). column_field_ids = columns shown.
  column_field_ids?: string[];
  page_size?: number;
}
// Funnel: an ordered single-level grouped result rendered as descending stages
// (preserves the group order — e.g. pipeline stages — and scales each bar to the
// largest stage). Leaderboard: the same data ranked desc with inline bars + rank.
export interface VizFunnel {
  family: 'funnel';
  color_mode?: WidgetColorMode;
  number_format?: WidgetNumberFormat;
  show_pct?: boolean; // show each stage as % of the largest stage
}
export interface VizLeaderboard {
  family: 'leaderboard';
  color_mode?: WidgetColorMode;
  number_format?: WidgetNumberFormat;
  max_rows?: number;
}
// Gauge: a scalar (result.total) drawn as a radial arc filling to value/max.
// Progress: the same scalar as a linear bar filling to value/target. Both ignore
// grouping (they use the grand total) and drill to the records behind the number.
export interface VizGauge {
  family: 'gauge';
  max?: number; // scale top; defaults to 100 for percent metrics, else the value
  target?: number; // optional goal marker
  color?: string;
  number_format?: WidgetNumberFormat;
  good_direction?: 'up' | 'down';
}
export interface VizProgress {
  family: 'progress';
  target?: number; // the 100% point; defaults to 100 for percent metrics
  color?: string;
  number_format?: WidgetNumberFormat;
}
// Pivot: a two-level grouped result as a matrix — first level = rows, second
// level = columns, cells = the aggregated value. Collapses to a one-column
// table when only one group level is set.
export interface VizPivot {
  family: 'pivot';
  number_format?: WidgetNumberFormat;
}
// Heatmap: a two-level grouped result as a colored matrix — first level = rows,
// second level = columns, each cell shaded by value intensity (relative to the
// max cell). Reuses the pivot's 2-level shape; reads as a density grid.
export interface VizHeatmap {
  family: 'heatmap';
  color?: string; // base hue; cells scale its opacity by value
  number_format?: WidgetNumberFormat;
}
// Map: a single-level grouped result (a city/region field) as a bubble map over
// a built-in simplified Saudi outline — bubble area ∝ value. Self-contained (no
// map tiles / API keys); unmatched cities surface as a footnote count.
export interface VizMap {
  family: 'map';
  color?: string;
  number_format?: WidgetNumberFormat;
}
export type WidgetViz = VizStat | VizBars | VizPies | VizLines | VizTable | VizFunnel | VizLeaderboard | VizGauge | VizProgress | VizPivot | VizHeatmap | VizMap;

// Dashboard-level global filters + per-widget opt-in.
export type DashboardFilterControl = 'date_range' | 'select' | 'search';
export interface DashboardFilter {
  id: string;
  label_ar: string;
  label_en: string;
  control: DashboardFilterControl;
  ref_model_id?: string | null; // model whose field defines the option set (select)
  ref_field_id?: string | null;
  is_multi?: boolean;
  default_value?: unknown;
}
export interface WidgetFilterMapping {
  dashboard_filter_id: string;
  target_field_id: string | null; // field on the widget's source model; null = ignore this filter
  target_field_path?: 'min' | 'max';
}
export type WidgetFilterBehavior =
  | { mode: 'inherit_dashboard_filters' }
  | { mode: 'ignore_dashboard_filters' }
  | { mode: 'custom_mapping'; mappings: WidgetFilterMapping[] };

// ── Scheduled Reports (analytics consumer #2) ──────────────────────────────
export type ReportFrequency = 'daily' | 'weekly' | 'monthly';
export type ReportSourceType = 'dashboard' | 'widget' | 'metric' | 'custom';
export type ReportStatus = 'active' | 'paused' | 'running' | 'error';

export interface ScheduledReport {
  id: string;
  title: string;
  owner_user_id?: string | null;
  owner_auth_uid?: string | null; // auth.users id — lets the runner mint an owner-scoped token
  frequency: ReportFrequency;
  hour_of_day: number;        // 0..23, Asia/Riyadh
  day_of_week?: number | null;  // 0=Sun, weekly
  day_of_month?: number | null; // 1..28, monthly
  timezone: string;
  recipients: string[];
  delivery_channel: 'email';
  source_type: ReportSourceType;
  dashboard_id?: string | null;
  widget_id?: string | null;
  metric_id?: string | null;
  query?: AnalyticsQuery | null;
  status: ReportStatus;
  last_run_at?: string | null;
  next_run_at?: string | null;
  last_status?: string | null;
  last_result_snapshot?: unknown;
  error_message?: string | null;
  created_by_user_id?: string | null;
  created_at: string;
  updated_at: string;
}

export interface ScheduledReportRun {
  id: string;
  report_id: string;
  started_at: string;
  finished_at?: string | null;
  status: 'running' | 'sent' | 'draft' | 'failed' | 'partial';
  triggered_by: 'schedule' | 'manual';
  data_as_of?: string | null;
  result_snapshot?: unknown;
  warnings?: unknown;
  recipients?: string[];
  delivery?: string | null;
  error_message?: string | null;
}

/**
 * Manager-editable override of a follow-up type's instruction text.
 * `id` IS the follow-up type key (e.g. 'appointment_booking_call'). Merged over
 * DEFAULT_SALES_PROCESS by applyOverridesToConfig so the Follow-up Workspace
 * mission (objective) and Call Guidance panel (script) show the edited text.
 * `script_ar` / `script_en` are newline-separated — one call-guidance bullet per
 * line. Admin-write, all-authenticated-read (reps see it).
 */
export interface SalesProcessOverride {
  id: string;
  objective_ar: string | null;
  objective_en: string | null;
  script_ar?: string | null;
  script_en?: string | null;
  updated_at?: string;
}

// ════════════════════════════════════════════════════════════════════════════
// Sales Studio 2.0 — the Sales Strategy operating layer.
//
// Sales Studio CONFIGURES strategy; the Workflow engine EXECUTES it. A process
// version's `config_json` is an OVERLAY the engine reads at run time (timing /
// message / assignment / branch-enabled) keyed by the LIVE workflow's branch.id
// / action.id — never a second transition path. A client with no active
// assignment runs the legacy hardcoded workflow behavior unchanged.
// ════════════════════════════════════════════════════════════════════════════

export type SalesProcessStatus = 'draft' | 'active' | 'archived';

export interface SalesProcess {
  id: string;
  name_ar: string;
  name_en: string;
  description_ar?: string | null;
  description_en?: string | null;
  status: SalesProcessStatus;
  is_default: boolean;
  /** Denormalized pointer to the live version (nullable until first publish). */
  active_version_id?: string | null;
  created_by?: string | null;
  created_at: string;
  updated_at: string;
}

export type SalesProcessVersionStatus = 'draft' | 'active' | 'archived';

/** The safe assignment strategy a step's next-action uses. */
export type SalesAssignmentStrategy =
  | 'same_sales_rep'
  | 'current_user'
  | 'fixed_user'
  | 'role_least_workload';

/**
 * Per-branch override inside a workflow overlay. Keyed by the LIVE workflow's
 * branch.id, so keys always match what the simple editor read off the workflow.
 */
export interface SalesBranchOverride {
  /** Disabled branches are removed from the executable copy the engine runs. */
  enabled?: boolean;
  label_ar?: string | null;
  label_en?: string | null;
  /** Primary success outcome flag (display + analytics; no execution effect). */
  primary_success?: boolean;
}

/**
 * Overrides for ONE workflow, applied by applyProcessOverlayToWorkflow. Timing /
 * message / assignment are keyed by the create_record / send_whatsapp_message /
 * assignee action.id inside the workflow.
 */
export interface SalesWorkflowOverlay {
  /** Manager objective text (display: Workspace mission + Journey card). */
  objective_ar?: string | null;
  objective_en?: string | null;
  /** Branch enable/disable + labels, keyed by branch.id. */
  branches?: Record<string, SalesBranchOverride>;
  /** Date-expression override (e.g. "+2d @10:00") keyed by create_record action.id. */
  timings?: Record<string, string>;
  /** Max attempts cap, keyed by create_record action.id (best-effort overlay). */
  max_attempts?: Record<string, number>;
  /** WhatsApp message template override keyed by send_whatsapp_message action.id. */
  messages?: Record<string, { ar?: string | null; en?: string | null }>;
  /** Assignment strategy override keyed by the action.id that sets the rep field. */
  assignments?: Record<string, { strategy: SalesAssignmentStrategy; fixed_user_id?: string | null }>;
}

/** A journey step: an activity bound to a workflow at a stage, plus simple config. */
export interface SalesProcessStep {
  stage_key: string;            // Arabic stage value (ClientStageValue)
  activity_type: string;        // FollowUpTypeKey
  workflow_id?: string | null;  // the bound workflow id
  display_order: number;
  simple_config: SalesWorkflowOverlay;
}

/** The full overlay stored in sales_process_versions.config_json. */
export interface SalesProcessVersionConfig {
  /** Normalized journey steps (also drives the Journey Map ordering). */
  steps: SalesProcessStep[];
  /** Workflow overlays keyed by workflow id (the execution-time lookup). */
  workflows: Record<string, SalesWorkflowOverlay>;
  /** Schema/version stamp so we can evolve the shape safely. */
  schema_version?: number;
}

export interface SalesProcessVersion {
  id: string;
  sales_process_id: string;
  version_number: number;
  status: SalesProcessVersionStatus;
  config_json: SalesProcessVersionConfig;
  published_at?: string | null;
  published_by?: string | null;
  created_at: string;
  updated_at: string;
}

export type SalesExperimentStatus = 'draft' | 'active' | 'paused' | 'completed' | 'archived';
export type SalesExperimentAssignmentMode = 'manual' | 'rules' | 'random_split';
export type SalesExperimentGroup = 'control' | 'variant';

/** Primary metric a funnel experiment optimizes for. */
export type SalesPrimaryMetric =
  | 'appointment_booking_rate'
  | 'appointment_attendance_rate'
  | 'visit_rate'
  | 'offer_request_rate'
  | 'reservation_rate'
  | 'closed_won_rate'
  | 'time_to_appointment'
  | 'time_to_offer'
  | 'time_to_close'
  | 'whatsapp_response_rate';

export type SalesGuardrailMetric =
  | 'lost_rate'
  | 'unqualified_rate'
  | 'no_answer_rate'
  | 'no_next_action_count'
  | 'rep_workload'
  | 'touches_per_client';

/** Targeting rules for rules / random_split assignment of eligible clients. */
export interface SalesExperimentTargetRules {
  source?: string[];
  project?: string[];
  city?: string[];
  district?: string[];
  budget_min?: number | null;
  budget_max?: number | null;
  client_stage?: string[];
  client_status?: string[];
  sales_rep?: string[];
  lead_created_from?: string | null;  // ISO
  lead_created_to?: string | null;    // ISO
}

export interface SalesExperiment {
  id: string;
  name_ar: string;
  name_en: string;
  hypothesis_ar?: string | null;
  hypothesis_en?: string | null;
  status: SalesExperimentStatus;
  start_date?: string | null;
  end_date?: string | null;
  target_rules_json: SalesExperimentTargetRules;
  control_process_version_id?: string | null;
  variant_process_version_id?: string | null;
  primary_metric?: SalesPrimaryMetric | null;
  guardrail_metrics_json: SalesGuardrailMetric[];
  assignment_mode: SalesExperimentAssignmentMode;
  split_percentage: number;
  owner_id?: string | null;
  result_summary_json?: unknown;
  created_at: string;
  updated_at: string;
}

export interface ClientSalesProcessAssignment {
  id: string;
  client_id: string;
  sales_process_id?: string | null;
  sales_process_version_id?: string | null;
  sales_experiment_id?: string | null;
  experiment_group?: SalesExperimentGroup | null;
  assigned_at: string;
  assigned_by?: string | null;
  assignment_reason?: string | null;
  is_active: boolean;
  created_at: string;
}

/**
 * Target for the app-level WhatsApp composer (GlobalChatComposer). Any phone
 * WhatsApp action sets this via openChatComposer; the host pre-connects to the
 * matching client (by explicit id, else by phone match) and shows the chat
 * popup + the conversation thread popup WITHOUT navigating — the caller stays
 * exactly where they were.
 */
export interface ChatComposerTarget {
  phone?: string;
  clientRecordId?: string;
}

export interface DashboardWidget {
  id: string;
  type: WidgetType;
  title_ar: string;
  title_en: string;
  source_model_id: string;
  // NEW (Phase A) — the universal query + visualization. Optional for back-compat:
  // legacy widgets render through `migrateLegacyWidget(widget, model)` which derives
  // these from `config` on the fly. The builder persists them; `config` is retained.
  query?: AnalyticsQuery;
  viz?: WidgetViz;
  filter_behavior?: WidgetFilterBehavior;
  // Pre-computed result for PUBLIC sharing. Filled on publish/refresh by running
  // the engine with the owner's scope; the public page renders this so anon
  // never reads raw records. Recomputed on demand; stale until refreshed.
  snapshot?: { result: AnalyticsResult; computed_at: string };
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
  // NEW (Phase A) — dashboard-level global filters + the owner whose RLS scope
  // public snapshots are computed with. Optional for back-compat (default []).
  filters?: DashboardFilter[];
  owner_user_id?: string | null;
  is_public: boolean;
  public_token?: string | null;
  created_at: string;
  updated_at: string;
}

/**
 * Semantic Metric — a named, reusable business measure (Revenue, Response Rate,
 * Average Deal Size, …). VALUE-ONLY by design: it answers "what is the value?"
 * and carries NO target. A future `KPIDefinition { metric_id, target_value,
 * warning_threshold, critical_threshold }` (answering "are we hitting target?")
 * layers on top WITHOUT changing this type or the engine. Persisted in the
 * `metric_definitions` table; resolved by the analytics engine via
 * `AggregationConfig.metric_id`.
 */
export interface MetricDefinition {
  id: string;
  label_ar: string;
  label_en: string;
  description?: string;
  // The query that produces the metric's value (a scalar, or per-group when a
  // consumer supplies a group_by). May itself use a percentage/ratio aggregation.
  query: AnalyticsQuery;
  // Optional composite: combine other metrics' scalar values via a safe formula
  // (evaluated by formulaEngine). Each `inputs[].name` is referenced in `formula`
  // as a `{name}` token, e.g. formula '{answered} / {total} * 100'.
  formula?: string;
  inputs?: { name: string; metric_id: string }[];
  format?: {
    decimals?: number;
    currency?: string | null;
    percent?: boolean;
    thousands_separator?: boolean;
  };
  is_system: boolean;
  owner_user_id?: string | null;
  created_at: string;
  updated_at: string;
}

// Whiteboard — flat folders holding tldraw-backed boards, shared across the
// workspace. The snapshot is whatever `editor.getSnapshot()` returns, stored
// as JSONB; we treat it as opaque here to avoid pulling in tldraw types.
export interface WhiteboardFolder {
  id: string;
  name: string;
  order: number;
  created_at: string;
  updated_at: string;
}

export interface Whiteboard {
  id: string;
  folder_id: string | null;
  name: string;
  snapshot: unknown | null;
  order: number;
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

/**
 * Per-field rule on the form/table. Default (when unset for a field) is
 * `editable`. Computed fields (formula, auto_id, mirror, section_mirror) are
 * always `readonly` regardless of what the matrix says — the renderer enforces
 * this so admins can't accidentally make a derived field writable.
 */
export type FieldPermission = 'hidden' | 'readonly' | 'editable';

/**
 * What a scope condition compares against on the target record.
 *  - `field`  → a regular field on the record's model schema (by field id).
 *               `field_slug` is stored alongside the id so SQL-side RLS
 *               evaluation can read the JSONB key directly without joining
 *               `models` to resolve the slug. Older profiles persisted
 *               before the RLS upgrade may have it missing; the JS evaluator
 *               falls back to the model-schema lookup, and `saveProfile`
 *               heals the slug on the next save.
 *  - `created_by` → the synthetic `record.created_by_user_id` column (set on
 *                   first save). Lets admins write "records I created" rules
 *                   without forcing every model to define a creator field.
 */
export type ScopeFieldRef =
  | { kind: 'field'; field_id: string; field_slug?: string; field_path?: string }
  | { kind: 'created_by' };

/**
 * Where a scope condition's right-hand value comes from. Plain literals look
 * just like dashboard filter conditions. The two user-context kinds resolve
 * at evaluation time against the signed-in user — that's what makes a single
 * profile rule like "Region = my Region" work for every Sales rep.
 *  - `literal`      → hardcoded value (string, number, boolean, …)
 *  - `current_user` → resolves to the signed-in user's id (used with `created_by`)
 *  - `role_field`   → resolves to the value of `field_slug` on the user's
 *                     assignment for `role_id`. If the user doesn't hold the
 *                     role (or the field is empty), the comparison fails.
 */
export type ScopeValueSource =
  | { kind: 'literal'; value: unknown }
  | { kind: 'current_user' }
  | { kind: 'role_field'; role_id: string; field_slug: string };

export type ScopeOperator =
  | 'equals'
  | 'not_equals'
  | 'contains'
  | 'greater_than'
  | 'less_than'
  | 'is_empty'
  | 'is_not_empty';

export interface ScopeFilterCondition {
  id: string;
  field: ScopeFieldRef;
  operator: ScopeOperator;
  source: ScopeValueSource;
}

/**
 * One scope (view or edit). `mode: 'all'` is the default and means "no row
 * filter" — every record the user can otherwise reach is included. Switching
 * to `mode: 'filtered'` activates the conditions (AND-only across rows).
 */
export type ScopeRule =
  | { mode: 'all' }
  | { mode: 'filtered'; conditions: ScopeFilterCondition[] };

export interface ProfileModelPermissions {
  model_id: string;
  permissions: ModelPermission[];
  /**
   * Which records of this model the profile can SEE (in lists, lookups,
   * search, the form). Optional for backward compatibility — a profile
   * without `view_scope` defaults to `{ mode: 'all' }`.
   */
  view_scope?: ScopeRule;
  /**
   * Which records of this model the profile can EDIT or DELETE. A record
   * that fails `view_scope` automatically fails `edit_scope` too — edits
   * can never reach what the user can't see. Default `{ mode: 'all' }`.
   */
  edit_scope?: ScopeRule;
  /**
   * Per-field overrides keyed by field id. Unset entries default to
   * `editable`. `hidden` fields don't render at all (form, table column,
   * card label). `readonly` fields render but disabled — the renderer
   * shows the value but rejects writes. Computed field types are forced
   * to `readonly` regardless of the configured value.
   */
  field_permissions?: Record<string, FieldPermission>;
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
  /**
   * IDs of `ModelView` rows hidden from this profile. Deny-list shape (not
   * an allow-list) so adding a new shared view is visible by default and
   * doesn't require touching every profile. A user's OWN views never appear
   * here at evaluation time — the author always sees their own views.
   */
  hidden_view_ids?: string[];
  /**
   * IDs of `CustomButton` entries hidden from this profile. Same deny-list
   * shape as `hidden_view_ids`. Buttons live on `model.schema.custom_buttons`;
   * the id matches the `CustomButton.id` field.
   */
  hidden_button_ids?: string[];
  /**
   * Per-profile access to custom (non-model) app pages — the Sales Operations
   * surfaces registered in `src/lib/customPages.ts` (Sales Tasks / Sales
   * Process / Sales Manager). Keyed by `CustomPageId`; an explicit `true` /
   * `false` overrides the page's `default_access`. A page id absent from the
   * map falls back to its `default_access`, so existing profiles keep the
   * pre-2026-06-18 behavior without anyone touching this field. Admin profiles
   * see every page regardless. See `canAccessPage` in `src/lib/permissions.ts`.
   */
  page_access?: Record<string, boolean>;
  /**
   * Read-only access to the workflow subsystem data (the `workflows`,
   * `workflow_groups`, `workflow_runs` tables). Default/absent = no access —
   * non-admins can't load any workflow rows (the hardened default). When
   * true, the profile can SEE workflows: the Sales Process Studio shows each
   * phase's linked workflow as "Linked", the workflow run-history pages become
   * viewable, AND the Workflow Builder opens READ-ONLY (canvas + drawer render
   * disabled) so the actual trigger / conditions / actions can be inspected.
   * EDITING workflows stays admin-only regardless of this flag. Admin profiles
   * can always see + manage workflows. Enforced in the app via
   * `canViewWorkflows` AND at the DB via the `wassell_can_view_workflows`
   * RLS helper. See docs/prd/access-control.md.
   */
  can_view_workflows?: boolean;
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
  /**
   * Foreign key into Supabase Auth's `auth.users.id`. Set on first sign-in
   * via the email-binding shim in `appStore.initialize()`. Older rows + the
   * seed admin start with null and get bound on first sign-in. RLS policies
   * key off this column so unbound users see an empty workspace until bound.
   */
  auth_uid?: string | null;
  profile_id: string;
  role_assignments: UserRoleAssignment[];
  is_active: boolean;
  /**
   * Grants the "preview app as another profile" switcher (Header pill +
   * banner). OFF by default — an admin enables it per-user from
   * Settings → Users. The permission layer ignores any preview override
   * for users without this flag, so it can never widen access by itself.
   */
  can_preview_profiles?: boolean;
  created_at: string;
  updated_at: string;
}

// (Presentations feature was removed.)
export type __PresentationsRemoved = never;

// UI types

export type Language = 'ar' | 'en';

export type ToastType = 'success' | 'error' | 'info';

export interface Toast {
  id: string;
  message: string;
  type: ToastType;
}

// ─── Chats module (WhatsApp via Haberchat) ─────────────────────────────
// Conversations surface as regular records in the `chats` system model
// (id = uuidv5(chat_wid)). Messages live in the Supabase `chat_messages`
// table and stream via Realtime. See docs/prd/chats.md.

/**
 * Local overlay for one Haberchat device (connected WhatsApp number).
 * Mirrors the `whatsapp_numbers` table. Merged with the live Haberchat
 * device list at render time so the admin sees both sides in one view.
 */
export interface WhatsAppNumber {
  device_id: string;
  phone: string;
  friendly_name_ar: string | null;
  friendly_name_en: string | null;
  is_default: boolean;
  is_active: boolean;
  created_at: string;
  updated_at: string;
  /** Gateway backing this number. Rows created before the WAHA migration may omit both. */
  provider?: 'haberchat' | 'waha' | null;
  /** WAHA session name (e.g. 'wassel_main') when provider === 'waha'. */
  session_name?: string | null;
}

/**
 * The Haberchat device shape the browser sees (post-proxy normalization).
 * Source of truth for phone/status is Haberchat; `WhatsAppNumber` is our
 * local overlay for friendly names + default flag. Note the property
 * names match api/_lib/haberchat.ts — keep in sync.
 */
export interface HaberchatDevice {
  id: string;
  phone: string;
  name: string | null;
  status?: 'online' | 'offline' | 'disconnected' | 'pending' | string;
  plan?: string;
  createdAt?: string;
  updatedAt?: string;
}

/**
 * Live Haberchat conversation (post-proxy normalization). Mirrors the
 * HaberchatChat type in api/_lib/haberchat.ts — keep in sync.
 */
export interface HaberchatChat {
  wid: string;
  kind: 'user' | 'group' | 'channel' | string;
  name: string | null;
  phone: string | null;
  status?: 'active' | 'resolved' | 'archived' | 'muted' | string;
  ownerAgentId?: string | null;
  labels?: string[];
  unreadCount?: number;
  lastMessageAt?: string | null;
  lastMessagePreview?: string | null;
  meta?: Record<string, unknown>;
}

/**
 * A single message in a chat. Post-proxy normalization — mirrors the
 * HaberchatMessage type in api/_lib/haberchat.ts.
 * `pending` + `client_id` are optimistic-only: set when the user presses
 * Send and cleared when the webhook echoes the server-assigned wid.
 */
export interface ChatMessage {
  id: string;                 // = Haberchat message wid
  chat_wid: string;
  flow: 'in' | 'out';
  kind: 'text' | 'image' | 'video' | 'audio' | 'document' | 'sticker' | 'location' | 'template' | 'contact' | 'poll' | 'interactive' | string;
  /** Haberchat message subtype — discriminates system events (e.g.
   *  `biz_privacy_mode_init_fb` on a `notification_template`). Drives the
   *  localized system-notice rendering for body-less system messages. */
  subtype?: string | null;
  body: string | null;
  from_phone: string | null;
  to_phone: string | null;
  ack: 'failed' | 'pending' | 'sent' | 'delivered' | 'read' | 'played' | null;
  date: string;
  media_file_id: string | null;
  media_mime: string | null;
  media_size: number | null;
  media_caption: string | null;
  reference: string | null;
  quoted: { wid: string; body: string | null; kind: string } | null;
  /** Optimistic placeholder — true between send click and webhook ack. */
  pending?: boolean;
  /** Local correlation key used to match the optimistic placeholder to
   *  the real message when it arrives via webhook or ack. */
  client_id?: string;
}

/**
 * A scheduled (queued, not-yet-sent) outbound message living in Haberchat's
 * delivery queue — created by sending with `deliverAt`. Mirrors
 * HaberchatQueuedMessage in api/_lib/haberchat.ts — keep in sync.
 */
export interface ScheduledChatMessage {
  id: string;                 // Haberchat message resource id (used to cancel)
  phone: string | null;       // recipient in E.164
  body: string | null;
  deliverAt: string | null;   // ISO scheduled delivery time
  createdAt: string | null;
  hasMedia: boolean;
}

// ─── Calls (Hatif) ────────────────────────────────────────────────
// Call events Hatif POSTs to our webhook. Mirrors `call_logs` in schema.sql —
// keep in sync. Every call Hatif's platform sees lands here: inbound,
// outbound-IVR, and calls agents place from Hatif's own app on our channel.

export type CallDirection = 'inbound' | 'outbound';

// Normalized from Hatif's integer status field. Raw mapping lives in the
// webhook handler; consumers only see the string.
export type CallStatus =
  | 'active'
  | 'completed'
  | 'missed'
  | 'rejected_by_caller'
  | 'rejected_by_callee'
  | 'no_answer'
  | 'cancelled'
  | 'failed'
  | 'ringing';

export type CallSentiment = 'positive' | 'neutral' | 'negative' | 'mixed' | 'unknown';

/** A single transcription word with Hatif's diarization info. */
export interface CallTranscriptionWord {
  text: string;
  start: number;          // seconds
  end: number;            // seconds
  type?: string;           // 'word' | 'punctuation' | ...
  speaker?: string | number | null;
}

export interface CallTranscription {
  text: string;
  words: CallTranscriptionWord[];
}

export interface CallEvaluationResult {
  id: string;
  dataType: string;
  description: string;
  value: unknown;
  rationale: string | null;
}

/** A call row as the SPA consumes it (snake_case from Postgres). */
export interface CallLog {
  id: string;                                       // Hatif callId
  workspace_id: string | null;
  channel_id: string;
  direction: CallDirection;
  status: CallStatus;
  caller_number: string | null;
  callee_number: string | null;
  contact_phone: string | null;                     // normalized E.164 — used to match to clients
  contact_id: string | null;                        // Hatif contactId (NOT records.id)
  agent_user_id: string | null;
  agent_name: string | null;
  ai_agent_id: string | null;
  pickup_time: string | null;                       // ISO
  hangup_time: string | null;                       // ISO
  duration_seconds: number | null;
  recording_url: string | null;
  summary: string | null;
  sentiment: CallSentiment | null;
  transcription: CallTranscription | null;
  evaluation_criteria_result: CallEvaluationResult[] | null;
  // DTMF outcome from an outbound-IVR call triggered by a workflow. Null for
  // inbound / agent-placed calls.
  dtmf_digit: string | null;
  dtmf_label: string | null;
  creation_time: string;                            // ISO — Hatif event creationTime
  created_at: string;                               // ISO — row inserted
  updated_at: string;                               // ISO
}

// Store types

// Phase E.2: paginated records cache. Imported here to avoid a
// circular import — recordsCache.ts depends on AppRecord which is
// declared in this file.
import type { PaginatedRecordsByModel } from '../lib/recordsCache';

export interface LoadRecordsPageOpts {
  filters?: Record<string, unknown>;
  searchText?: string;
  /** Force a page-1 reload even if the existing cache matches the filter context. */
  reset?: boolean;
  /** Per-call override; default 50, max 500 (clamped server-side). */
  limit?: number;
}

/** Background slim-full-load state for a SUMMARY model. */
export interface SummaryLoadState {
  /** True while the keyset-paged background load is in flight. */
  loading: boolean;
  /** True once at least one successful background load has completed for
   *  this session (rows are now in `records[modelId]`). */
  loaded: boolean;
  /** Last background-load error message, or null on success. */
  error: string | null;
}

export interface AppState {
  // Data
  models: AppModel[];
  groups: ModelGroup[];
  records: Record<string, AppRecord[]>;
  /** Phase E.2: per-model paginated cache, populated by
   *  `loadRecordsPage`. Coexists with the legacy `records` slice;
   *  RecordListPage opts in via the VITE_PAGINATED_RECORDS feature
   *  flag. */
  recordsByModel: PaginatedRecordsByModel;
  /** Per-model load state for SUMMARY models (e.g. market_listings):
   *  their slim full set is loaded into `records[modelId]` in the
   *  background after boot. Keyed by model id. Lets the list page show a
   *  brief "loading listings…" state on first visit before the
   *  background load lands. Models not background-loaded are absent. */
  summaryLoadState: Record<string, SummaryLoadState>;
  workflows: Workflow[];
  workflowGroups: WorkflowGroup[];
  workflowRuns: WorkflowRun[];
  /** Model ids enrolled in server-authoritative workflow execution
   *  (`workflow_capture_models`). When a saved record's model is in this set,
   *  the CLIENT engine SKIPS execution (the Fly worker is the sole executor) to
   *  prevent client+server double-fire. Loaded at init + kept fresh via a
   *  realtime channel; empty on load failure (fail-safe: existing behavior). */
  serverEnrolledModelIds: Set<string>;
  /** Unified activity log — capped at 200 most recent entries in memory + localStorage.
   *  Older entries live in Supabase only and are paged in by the LogsPage. */
  activityLog: ActivityLogEntry[];
  dashboards: Dashboard[];
  metricDefinitions: MetricDefinition[];
  scheduledReports: ScheduledReport[];
  salesProcessOverrides: SalesProcessOverride[];
  // Sales Studio 2.0 strategy layer (top-level tables, not JSONB records).
  salesProcesses: SalesProcess[];
  salesProcessVersions: SalesProcessVersion[];
  salesExperiments: SalesExperiment[];
  clientSalesProcessAssignments: ClientSalesProcessAssignment[];
  /** Non-null while the app-level WhatsApp composer popup is open. */
  chatComposerTarget: ChatComposerTarget | null;
  views: ModelView[];
  users: User[];
  profiles: Profile[];
  roles: Role[];
  fieldTemplates: FieldTemplate[];
  currentUserId: string | null;
  /**
   * Profile-preview override ("view app as"). When set AND the current
   * user carries `can_preview_profiles`, the client permission layer
   * evaluates this profile instead of the user's own. Pure UI perspective:
   * RLS still runs against the real signed-in user, so data can only
   * narrow, never widen.
   */
  previewProfileId: string | null;

  // Auth (Supabase Auth session state)
  /** Email of the currently signed-in auth user, or null if signed out. */
  authEmail: string | null;
  /**
   * Supabase Auth user id (`auth.users.id`) of the currently signed-in user,
   * or null if signed out. Threaded through `bindAuth` from the active
   * session and used by `initialize()` to populate `users.auth_uid` on the
   * matched in-app user the first time. RLS policies key off this column.
   */
  authUid: string | null;
  /** True once the initial session-check completes. Used to avoid flashing
   *  the login page before we've checked localStorage for a cached session. */
  authReady: boolean;

  // UI
  language: Language;
  toasts: Toast[];

  // Phase E.2: server-side cursor pagination via record_search RPC.
  /** Fetches the next page of records for `modelId` with the given
   *  filter context. Idempotent: repeated calls advance via the
   *  cached cursor. Pass `reset: true` to start from page 1 (used
   *  when filters change). Result lands in `state.recordsByModel`. */
  loadRecordsPage: (modelId: string, opts?: LoadRecordsPageOpts) => Promise<void>;

  /** Background slim-full-load for a SUMMARY model: keyset-pages the
   *  model's `<name>_summary` view into `records[modelId]` and tracks
   *  progress in `summaryLoadState[modelId]`. Idempotent — a no-op if a
   *  load for this model is already in flight or has already completed
   *  this session (pass `force: true` to reload). Fired automatically
   *  after boot; the list page can also trigger it on first visit. */
  loadSummaryRecords: (modelId: string, opts?: { force?: boolean }) => Promise<void>;

  // Init
  initialized: boolean;
  /** Phase D.2: True once the chrome-critical loads are done (groups,
   *  models, profiles, roles, users, views, dashboards, current-user
   *  resolution). The slow tail (records, workflows, workflow_runs,
   *  whiteboards, activity_log) may still be in flight. Components that
   *  only need chrome data — Sidebar, Header, navigation — render as
   *  soon as this flips. Page bodies that need records can show a
   *  skeleton until `initialized` flips. */
  criticalDataReady: boolean;
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
  /**
   * Save a record. The function resolves AFTER the Supabase write has
   * settled (or been queued for retry), so callers that need to react
   * to a `version_mismatch` conflict can `await` the result. Fire-and-
   * forget callers (`void saveRecord(rec)`) keep working unchanged.
   *
   * Pass `opts.expectedVersion` to override which version is sent as the
   * RPC's `p_expected_version`. Forms should snapshot the version at
   * mount time and pass it here, otherwise concurrent realtime echoes
   * will silently update the live row's version and defeat the check.
   */
  saveRecord: (record: AppRecord, opts?: SaveRecordOpts) => Promise<SaveResult>;
  deleteRecord: (modelId: string, recordId: string) => void;
  /** Read-only single-record refresh from `unified_records`, merged through the
   * same path as Realtime. The Realtime-independent fallback for surfacing a
   * worker's writes when the WebSocket isn't reaching this browser. Issues no
   * write, so it never interacts with the conflict-storm machinery. */
  refreshRecordById: (recordId: string) => Promise<void>;
  // Re-saves every record on the model where `targetFieldId`'s value is empty,
  // causing the save-time fallback resolver to fill it. Used by the Builder's
  // "Apply to existing records" button. Returns the count of records touched.
  applyFallbackToExistingRecords: (modelId: string, targetFieldId: string) => { count: number };

  // ── Freeze (model promotion to dedicated Postgres table) ──────────────
  /**
   * Preview-mode coercion check for a model. Returns the rows that would
   * fail to coerce if `freezeModel` were called now — empty array means
   * the model is ready to freeze. Called by the Freeze modal in the
   * Builder before the user confirms; freeze itself runs the same check
   * inside the SQL transaction so a successful preview doesn't bypass
   * the safety net. Returns null when Supabase is unavailable.
   */
  checkFreezeCoercion: (modelId: string) => Promise<FreezeCoercionFailure[] | null>;
  /**
   * Promote a JSONB-backed model into a dedicated Postgres table with
   * proper typed columns + junction tables for multi-value fields. Calls
   * the `freeze_model` SQL RPC, which runs everything in a single
   * transaction (validate → coercion check → CREATE → copy → mark frozen
   * → delete from records → rebuild unified view). On success, refreshes
   * the model's `is_hardcoded` flag in local state. One-way; there is
   * no Unfreeze. See supabase/schema.sql.
   */
  freezeModel: (modelId: string) => Promise<FreezeResult>;

  // Prev/next navigation context published by RecordListPage so RecordFormPage
  // can step through the list in the order the user was viewing (filtered +
  // sorted). In-memory only; clears on page refresh.
  recordNavContext: { modelId: string; orderedIds: string[] } | null;
  setRecordNavContext: (modelId: string, orderedIds: string[]) => void;

  // Per-model map view state (pan/zoom + selected pin) preserved in-memory so
  // navigating to a record detail and clicking "back" returns the user to the
  // exact map view they left. Cleared on page refresh.
  mapsViewState: Record<string, { center: { lat: number; lng: number }; zoom: number; selectedId: string | null }>;
  setMapsViewState: (modelId: string, state: { center: { lat: number; lng: number }; zoom: number; selectedId: string | null }) => void;

  // Workflows
  saveWorkflow: (workflow: Workflow) => void;
  deleteWorkflow: (workflowId: string) => void;
  saveWorkflowGroup: (group: WorkflowGroup) => void;
  deleteWorkflowGroup: (groupId: string) => void;

  // Workflow execution logs (audit trail)
  appendWorkflowRun: (run: WorkflowRun) => void;
  deleteWorkflowRun: (runId: string) => void;
  clearWorkflowRuns: (workflowId?: string) => void;
  // Fetch a single run by id from Supabase — for the detail page to open a run
  // older than the recent-runs boot window (only the newest ~500 are in memory).
  fetchWorkflowRun: (runId: string) => Promise<WorkflowRun | null>;

  // Unified activity log
  /** Append one entry to the in-memory + localStorage cap (200 most recent)
   *  and async-write to Supabase. Caller passes a partial — id and created_at
   *  default to a fresh uuid + now(). */
  appendActivityLog: (entry: Omit<ActivityLogEntry, 'id' | 'created_at'> & Partial<Pick<ActivityLogEntry, 'id' | 'created_at'>>) => void;
  /** Page in the most recent N entries from Supabase (typically 500). Used by
   *  the LogsPage on mount so admins can see beyond the in-memory cap of 200. */
  loadActivityLog: (limit?: number) => Promise<void>;
  /** Delete a single log entry. */
  deleteActivityLog: (id: string) => void;
  /** Clear the entire log (admin-only — UI gates this). */
  clearActivityLog: () => void;

  // Dashboards
  saveDashboard: (dashboard: Dashboard) => void;
  deleteDashboard: (dashboardId: string) => void;
  // Semantic metrics
  saveMetricDefinition: (metric: MetricDefinition) => void;
  deleteMetricDefinition: (metricId: string) => void;
  // Scheduled reports
  saveScheduledReport: (report: ScheduledReport) => void;
  deleteScheduledReport: (reportId: string) => void;
  // Sales-process instruction overrides (manager-editable follow-up objectives)
  saveSalesProcessOverride: (override: SalesProcessOverride) => void;
  // Sales Studio 2.0 — process/version/experiment/assignment management
  saveSalesProcess: (process: SalesProcess) => void;
  deleteSalesProcess: (processId: string) => void;
  setDefaultSalesProcess: (processId: string) => Promise<void>;
  saveSalesProcessVersion: (version: SalesProcessVersion) => void;
  /** Create-or-reuse the draft version for a process (never mutates active). */
  ensureDraftVersion: (processId: string) => SalesProcessVersion;
  publishSalesProcessVersion: (versionId: string) => Promise<void>;
  discardDraftVersion: (versionId: string) => void;
  saveSalesExperiment: (experiment: SalesExperiment) => void;
  deleteSalesExperiment: (experimentId: string) => void;
  /** Assign a client to a process/version (+ optional experiment group). Deactivates prior. */
  assignClientToProcess: (input: {
    clientId: string;
    processId: string | null;
    versionId: string | null;
    experimentId?: string | null;
    group?: SalesExperimentGroup | null;
    reason?: string | null;
  }) => void;
  removeClientFromExperiment: (clientId: string) => void;
  /** Apply an experiment's rules/random-split assignment to all eligible clients. */
  applyExperimentAssignments: (experimentId: string) => number;
  /** Seed the Default Sales Process + its v1 active version from live workflows (admin, idempotent). */
  seedDefaultSalesProcess: () => void;
  // App-level WhatsApp composer (phone icons + Workspace button → one popup)
  openChatComposer: (target: ChatComposerTarget) => void;
  closeChatComposer: () => void;

  // Views (per-model saved table configurations)
  saveView: (view: ModelView) => void;
  deleteView: (viewId: string) => void;
  setDefaultView: (modelId: string, userId: string, viewId: string | null) => void;

  // Users
  saveUser: (user: User) => StoreMutationResult;
  deleteUser: (userId: string) => StoreMutationResult;
  setCurrentUser: (userId: string | null) => void;
  setPreviewProfile: (profileId: string | null) => void;

  // Profiles
  saveProfile: (profile: Profile) => void;
  deleteProfile: (profileId: string) => StoreMutationResult;

  // Roles
  saveRole: (role: Role) => void;
  deleteRole: (roleId: string) => StoreMutationResult;

  // Field templates
  saveFieldTemplate: (template: FieldTemplate) => void;
  deleteFieldTemplate: (templateId: string) => void;

  // ── Chats module (WhatsApp via Haberchat) ───────────────────────────
  /** Connected WhatsApp numbers; empty until loadWhatsAppNumbers() runs. */
  waDevices: WhatsAppNumber[];
  /** Live Haberchat-side device state, fetched via /api/haberchat/devices.
   *  Not persisted — refreshed on demand by the Settings page. */
  waDevicesLive: HaberchatDevice[];
  /**
   * Fetch the live Haberchat device list via the proxy AND the local
   * `whatsapp_numbers` overlay from Supabase; update both state slices.
   * Admins call this on mount of /settings/whatsapp-numbers and after edits.
   */
  loadWhatsAppNumbers: () => Promise<void>;
  /** Upsert one local overlay row. Used to rename, set default, activate/hide. */
  saveWhatsAppNumber: (entry: WhatsAppNumber) => Promise<void>;
  /**
   * Fetch every active device's conversation list from Haberchat (via the
   * proxy) and upsert each chat as a record on the `chats` system model.
   * Idempotent — safe to call on every Chats list page mount.
   */
  loadChatsFromHaberchat: () => Promise<void>;
  /**
   * Per-chat message store. Keyed by chat WID, ascending by date. Fills on
   * ChatDetailPage mount and (Step 8) on webhook → Realtime push.
   */
  chatMessages: Record<string, ChatMessage[]>;
  /**
   * Load the latest page of messages for one conversation from Haberchat
   * (via the proxy). Writes to `chatMessages[chatWid]`. When `before` is
   * passed, prepends older messages (for infinite scroll up). Returns
   * `{ hasMore }` so the page knows whether to keep offering a "load older"
   * action.
   */
  loadMessagesForChat: (chatWid: string, opts?: { before?: string; size?: number }) => Promise<{ hasMore: boolean }>;
  /**
   * Send an outbound text message on a conversation. Optimistic UI: inserts
   * a `pending: true` placeholder immediately; when the proxy returns the
   * server wid, swaps the placeholder for a real ChatMessage keyed by wid.
   * On failure marks the placeholder `ack: 'failed'`.
   *
   * v1 handles user (direct-chat) kind. Group/channel sends are rejected
   * at the action boundary so the UI doesn't silently no-op.
   */
  sendChatMessage: (
    chatWid: string,
    input: {
      body?: string;
      quotedWid?: string;
      /** Haberchat file id from POST /api/haberchat/files. Required
       *  when `body` is empty. */
      mediaFileId?: string;
      /** Optional caption to display with the media attachment. */
      mediaCaption?: string;
      /** Haberchat kind for the outbound bubble (image | document | audio |
       *  video | text). Defaults to `text` when body is set. */
      kind?: ChatMessage['kind'];
      /** Mime / size for the optimistic placeholder (so the bubble
       *  renders something reasonable before the proxy upload echoes). */
      mediaMime?: string | null;
      mediaSize?: number | null;
      /** Future ISO datetime — schedule instead of sending now. The message
       *  waits in Haberchat's delivery queue; no optimistic bubble (the
       *  webhook echoes it into the thread when it actually sends). */
      deliverAt?: string;
    },
  ) => Promise<void>;
  /**
   * Start a brand-new WhatsApp conversation to a phone number we've never
   * messaged before. Creates a local chats record (optimistic — so the
   * user can navigate to it immediately), then POSTs the first message
   * through the proxy. The webhook later fires `message:out:new` and the
   * Realtime subscription reconciles the real wid/ack. Returns the local
   * record id so the caller can navigate to the detail page.
   */
  startNewChat: (input: {
    phone: string;
    body: string;
    deviceId?: string;
    /**
     * Explicitly-chosen client (from the Start New Chat picker). When set and
     * still a live client, the new conversation's `client_link` is set to this
     * id directly — explicit selection wins over the phone-match heuristic.
     */
    clientRecordId?: string;
    /** Future ISO datetime — schedule the first message instead of sending
     *  now. The conversation record is still created immediately; the
     *  message waits in Haberchat's delivery queue. */
    deliverAt?: string;
  }) => Promise<{ recordId: string; chatWid: string }>;
  /**
   * Subscribe to Supabase Realtime INSERT/UPDATE events on `chat_messages`
   * for one conversation. Idempotent — calling twice for the same chatWid
   * is a no-op. The webhook writes rows via service-role; Realtime pushes
   * them to every open browser, and the store merges the incoming row
   * into `chatMessages[chatWid]` (replacing pending placeholders when
   * `reference` matches).
   */
  subscribeToChat: (chatWid: string) => void;
  /** Unsubscribe from Realtime for a conversation. Safe to call even if
   *  no subscription exists. Called by ChatDetailPage on unmount. */
  unsubscribeFromChat: (chatWid: string) => void;
  /**
   * Global Realtime subscription on the whole `chat_messages` table —
   * no chat_wid filter. Used by ChatsSplitPage to keep the conversation
   * list up to date with unread counts / last-message previews for every
   * chat, even ones the user isn't currently viewing. Idempotent.
   */
  subscribeToAllChats: () => void;
  unsubscribeFromAllChats: () => void;
  /**
   * Zero out unread_count on the local chat record. Called when the user
   * opens a chat. Local-only write; Haberchat tracks unread separately.
   */
  markChatAsRead: (chatWid: string) => void;
  /**
   * Patch a chat's status and / or labels. Optimistic: updates the local
   * record immediately, then calls the proxy. On failure, reverts the
   * patched fields and shows a toast. Haberchat's chat:update webhook
   * later confirms the new state via Realtime — idempotent.
   */
  patchChat: (
    chatWid: string,
    patch: { status?: 'active' | 'resolved' | 'archived'; labels?: string[] },
  ) => Promise<void>;

  // ── Webhook ingress ────────────────────────────────────────────────
  // External services post to /functions/v1/inbox/<slug>. The inbox
  // function writes a webhook_payloads row; the app atomically claims
  // each payload and fires any workflow with a matching webhook
  // trigger.
  webhookSlugs: WebhookSlug[];
  webhookPayloads: WebhookPayload[];

  /** CRUD for user-declared webhook endpoints. */
  saveWebhookSlug: (slug: WebhookSlug) => Promise<void>;
  deleteWebhookSlug: (slugId: string) => Promise<void>;

  /**
   * Atomically claim an unconsumed webhook_payloads row and — if claimed —
   * fire every workflow whose `trigger_webhook_slug_id` matches the payload's
   * slug_id. Returns true iff this client claimed the row (so multiple open
   * browsers don't double-fire workflows).
   */
  claimAndRunWebhookPayload: (payloadId: string) => Promise<boolean>;

  /**
   * Subscribe to webhook_payloads INSERTs so incoming agent events fan
   * out to the workflow engine without a page reload. Idempotent — a
   * second call is a no-op. Returns an unsubscribe function; callers
   * don't need to use it (the channel lives for the app's lifetime).
   */
  subscribeMarketingRealtime: () => () => void;

  // --- Whiteboards ---
  // Flat folder list + boards shared across the workspace. See whiteboard.md.
  whiteboardFolders: WhiteboardFolder[];
  whiteboards: Whiteboard[];

  createWhiteboardFolder: (name: string) => WhiteboardFolder;
  renameWhiteboardFolder: (folderId: string, name: string) => void;
  deleteWhiteboardFolder: (folderId: string) => void;

  createWhiteboard: (name: string, folderId: string | null) => Whiteboard;
  renameWhiteboard: (boardId: string, name: string) => void;
  deleteWhiteboard: (boardId: string) => void;
  moveWhiteboard: (boardId: string, folderId: string | null) => void;
  saveWhiteboardSnapshot: (boardId: string, snapshot: unknown) => void;
}
