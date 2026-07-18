import type { AppModel, AppRecord, ModelField, User } from '@/types';

/**
 * Pure, reusable "Client 360" view resolver.
 *
 * Resolves a clients record into a flat, display-ready `ClientView` plus a
 * cross-model activity timeline and related-record counts. Everything here is
 * pure (no store access, no React) so it can be unit-tested and reused by both
 * the custom Clients list page and the Client detail cockpit.
 *
 * Hard rules baked in:
 *  - Missing facts resolve to `null` (or `[]` for collections) — never guessed.
 *  - `preferred_projects` (→ all_projects) and `preferred_market_listings`
 *    (→ market_listings) are read from their OWN slugs, each verified against
 *    its own lookup target model. They can never cross-pollute at read time.
 *  - Derived/lifecycle fields are READ here but are display-only everywhere —
 *    see DERIVED_READONLY_SLUGS, which the Preferences editor uses to exclude
 *    them from any editable surface.
 */

// ---------------------------------------------------------------------------
// Slugs
// ---------------------------------------------------------------------------

/**
 * Fields maintained by Postgres triggers / RPCs — NEVER user-editable in this
 * UI. The Preferences tab excludes these so a derived value can't be edited and
 * silently overwritten by the next trigger recompute. Kept as a frozen set so
 * `isDerivedReadOnly` is a single source of truth.
 */
export const DERIVED_READONLY_SLUGS = [
  'next_followup_id',
  'next_action_type',
  'next_action_due_at',
  'last_activity_at',
  'lifecycle_health',
  'lost_reason',
  'lost_at',
  'latest_visit_rating',
  'latest_visit_rated_at',
] as const;

export type DerivedReadOnlySlug = (typeof DERIVED_READONLY_SLUGS)[number];

const DERIVED_SET = new Set<string>(DERIVED_READONLY_SLUGS);

/** True when `slug` is a derived/trigger-maintained field (display-only). */
export function isDerivedReadOnly(slug: string): boolean {
  return DERIVED_SET.has(slug);
}

/**
 * Editable client-preference slugs, in display order. Only those present on the
 * live model are rendered — the editor filters to the actual schema, so a
 * Builder rename or removal degrades gracefully. Derived slugs are deliberately
 * absent. `preferred_projects` and `preferred_market_listings` each carry their
 * own lookup target on the schema, so the picker cannot cross-pollute.
 */
export const PREFERENCE_EDIT_SLUGS = [
  'preferred_unit_type',
  'budget',
  'preferred_bedrooms',
  'preferred_area',
  'preferred_direction',
  'preferred_amenities',
  'location',
  'location_priority',
  'max_distance_km',
  'preferred_language',
  'preferred_projects',
  'preferred_market_listings',
  'client_favorite_units',
  'preferred_location_notes',
  'preference_notes',
] as const;

// ---------------------------------------------------------------------------
// Context + types
// ---------------------------------------------------------------------------

export interface ClientViewCtx {
  models: AppModel[];
  records: Record<string, AppRecord[]>;
  users: User[];
  language: 'ar' | 'en';
}

export type LifecycleHealth = 'on_track' | 'overdue' | 'no_next_action' | 'closed';

export interface LookupRef {
  id: string;
  /** Resolved display name, or null when the target record isn't loaded. */
  name: string | null;
}

export interface NumericRange {
  min: number | null;
  max: number | null;
}

export interface RelatedCounts {
  followups: number | null;
  visits: number | null;
  appointments: number | null;
  calls: number | null;
}

export interface ClientView {
  id: string;
  /** Human-facing auto-ID — `client_id` (live, e.g. "ع1039") else `client_code` (seed, "CLT-0001"). */
  clientId: string | null;
  name: string | null;
  phone: string | null;
  ownerId: string | null;
  ownerName: string | null;
  stage: string | null;
  status: string | null;
  lifecycleHealth: LifecycleHealth | null;
  nextActionType: string | null;
  nextActionDueAt: string | null;
  nextFollowupId: string | null;
  lastActivityAt: string | null;
  lostReason: string | null;
  lostAt: string | null;
  latestVisitRating: number | null;
  latestVisitRatedAt: string | null;
  // Preferences
  preferredUnitType: string[];
  budget: NumericRange | null;
  preferredCity: string | null;
  preferredDirection: string[];
  preferredDistrict: string | null;
  preferredProjects: LookupRef[];
  preferredMarketListings: LookupRef[];
  counts: RelatedCounts;
}

// ---------------------------------------------------------------------------
// Small pure value helpers
// ---------------------------------------------------------------------------

export function nonEmptyString(v: unknown): string | null {
  return typeof v === 'string' && v.trim() ? v.trim() : null;
}

function toFiniteNumber(v: unknown): number | null {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string' && v.trim()) {
    const n = Number(v);
    if (Number.isFinite(n)) return n;
  }
  return null;
}

/** Normalize a value to an array of non-empty strings (scalar → [scalar]). */
function asStringArray(v: unknown): string[] {
  if (Array.isArray(v)) return v.map((x) => nonEmptyString(x)).filter((x): x is string => !!x);
  const s = nonEmptyString(v);
  return s ? [s] : [];
}

/** Range fields store `{ min, max }`; tolerate a bare scalar too. */
function readRange(v: unknown): NumericRange | null {
  if (v && typeof v === 'object' && !Array.isArray(v)) {
    const o = v as Record<string, unknown>;
    const min = toFiniteNumber(o.min);
    const max = toFiniteNumber(o.max);
    if (min === null && max === null) return null;
    return { min, max };
  }
  const n = toFiniteNumber(v);
  return n === null ? null : { min: n, max: n };
}

// ---------------------------------------------------------------------------
// Schema + lookup helpers
// ---------------------------------------------------------------------------

export function getClientsModel(ctx: ClientViewCtx): AppModel | null {
  return ctx.models.find((m) => m.name === 'clients') ?? null;
}

export function allFields(model: AppModel): ModelField[] {
  return model.schema.sections.flatMap((s) => s.fields);
}

export function fieldBySlug(model: AppModel | null, slug: string): ModelField | null {
  if (!model) return null;
  return allFields(model).find((f) => f.name === slug) ?? null;
}

function modelById(ctx: ClientViewCtx, id: string | null | undefined): AppModel | null {
  if (!id) return null;
  return ctx.models.find((m) => m.id === id) ?? null;
}

/** A model's best human label for a record: explicit card-title field, else a
 *  common name slug, else the first text field's value. Null when not found. */
function recordDisplayName(model: AppModel, record: AppRecord): string | null {
  const data = record.data;
  // Prefer a card-title field when the model declares one.
  const titleFieldId = model.card_config?.title_field_id;
  if (titleFieldId) {
    const f = allFields(model).find((x) => x.id === titleFieldId);
    if (f) {
      const v = nonEmptyString(data[f.name]);
      if (v) return v;
    }
  }
  for (const slug of ['client_name', 'project_name', 'unit_name', 'title', 'name', 'label']) {
    const v = nonEmptyString(data[slug]);
    if (v) return v;
  }
  const firstText = allFields(model).find((f) => f.type === 'text' || f.type === 'textarea');
  if (firstText) {
    const v = nonEmptyString(data[firstText.name]);
    if (v) return v;
  }
  return null;
}

/**
 * Resolve a single lookup id to a display name via the target model's records.
 * Honors the field's `lookup_display_field` first, then falls back to the
 * target record's best display name. Returns `{ id, name: null }` when the
 * target record isn't loaded — never fabricates a name.
 */
function resolveLookupRef(
  ctx: ClientViewCtx,
  targetModelId: string | null | undefined,
  displayField: string | null | undefined,
  id: string,
): LookupRef {
  const target = modelById(ctx, targetModelId);
  if (!target) return { id, name: null };
  const rec = (ctx.records[target.id] ?? []).find((r) => r.id === id);
  if (!rec) return { id, name: null };
  if (displayField) {
    const v = nonEmptyString(rec.data[displayField]);
    if (v) return { id, name: v };
  }
  return { id, name: recordDisplayName(target, rec) };
}

/**
 * Resolve a multi-value lookup field on the client to display refs, scoped to
 * its OWN target model. Used independently for preferred_projects and
 * preferred_market_listings so the two can never blend.
 */
function resolveLookupField(ctx: ClientViewCtx, model: AppModel, slug: string, data: Record<string, unknown>): LookupRef[] {
  const field = fieldBySlug(model, slug);
  if (!field) return [];
  const ids = asStringArray(data[slug]);
  return ids.map((id) => resolveLookupRef(ctx, field.lookup_model_id, field.lookup_display_field, id));
}

/** Resolve a level (city/district) of the `location` cascade field to name(s). */
function resolveLocationLevel(
  ctx: ClientViewCtx,
  locationField: ModelField | null,
  data: Record<string, unknown>,
  levelKey: string,
): string[] {
  if (!locationField || locationField.type !== 'location') return [];
  const compound = data[locationField.name];
  if (!compound || typeof compound !== 'object' || Array.isArray(compound)) return [];
  const level = (locationField.location_levels ?? []).find((l) => l.key === levelKey);
  if (!level) return [];
  const ids = asStringArray((compound as Record<string, unknown>)[levelKey]);
  return ids
    .map((id) => resolveLookupRef(ctx, level.model_id, level.display_field, id).name)
    .filter((n): n is string => !!n);
}

// ---------------------------------------------------------------------------
// Owner / user resolution
// ---------------------------------------------------------------------------

export function userDisplayName(ctx: ClientViewCtx, id: string | null | undefined): string | null {
  const uid = nonEmptyString(id);
  if (!uid) return null;
  const u = ctx.users.find((x) => x.id === uid);
  if (!u) return null;
  return (ctx.language === 'ar' ? u.name_ar : u.name_en) || u.email || null;
}

/** assignee fields may store a scalar id, an array, or `{ user_id }`. */
function readOwnerId(v: unknown): string | null {
  if (Array.isArray(v)) {
    for (const x of v) {
      const id = readOwnerId(x);
      if (id) return id;
    }
    return null;
  }
  if (v && typeof v === 'object') {
    const o = v as Record<string, unknown>;
    return nonEmptyString(o.user_id) ?? nonEmptyString(o.id);
  }
  return nonEmptyString(v);
}

// ---------------------------------------------------------------------------
// Related-record discovery (drives counts + timeline)
// ---------------------------------------------------------------------------

/**
 * For each model, the slugs of every lookup field that targets the clients
 * model. Mirrors RelatedRecordsPanel's discovery so counts/timeline agree with
 * the Related tab. Keyed by model id.
 */
function clientLookupSlugsByModel(ctx: ClientViewCtx, clientsModelId: string): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const m of ctx.models) {
    const slugs = allFields(m)
      .filter((f) => f.type === 'lookup' && f.lookup_model_id === clientsModelId)
      .map((f) => f.name);
    if (slugs.length) out.set(m.id, slugs);
  }
  return out;
}

/** Records in `model` that reference `clientId` through any of `slugs`. */
function recordsLinkedToClient(records: AppRecord[], slugs: string[], clientId: string): AppRecord[] {
  return records.filter((r) =>
    slugs.some((slug) => {
      const v = r.data[slug];
      return Array.isArray(v) ? v.includes(clientId) : v === clientId;
    }),
  );
}

/**
 * Count related records of a specific model by name. Returns `null` when the
 * model or a client-targeting lookup isn't available (can't determine), or a
 * number (possibly 0) when it is.
 */
export function countRelatedByModelName(ctx: ClientViewCtx, clientId: string, modelName: string): number | null {
  const clients = getClientsModel(ctx);
  if (!clients) return null;
  const model = ctx.models.find((m) => m.name === modelName);
  if (!model) return null;
  const slugs = allFields(model)
    .filter((f) => f.type === 'lookup' && f.lookup_model_id === clients.id)
    .map((f) => f.name);
  if (!slugs.length) return null;
  return recordsLinkedToClient(ctx.records[model.id] ?? [], slugs, clientId).length;
}

// ---------------------------------------------------------------------------
// Timeline
// ---------------------------------------------------------------------------

export interface TimelineItem {
  id: string;
  modelId: string;
  modelName: string;
  /** Bilingual model label for the type chip. */
  typeLabel: string;
  /** ISO date string, or null when undated. */
  date: string | null;
  ownerName: string | null;
  status: string | null;
  summary: string | null;
  /** Click-through route to the source record. */
  href: string;
}

const DATE_SLUG_CANDIDATES = [
  'actual_datetime',
  'completed_at',
  'scheduled_datetime',
  'call_time',
  'appointment_datetime',
  'appointment_date',
  'visit_datetime',
  'visit_date',
  'datetime',
  'date',
  'rated_at',
];

const OWNER_SLUG_CANDIDATES = ['sales_rep', 'owner', 'client_owner', 'assignee', 'agent', 'rep', 'created_by'];

const STATUS_SLUG_CANDIDATES = ['call_result', 'followup_status', 'status', 'result', 'outcome', 'visit_rating', 'state'];

const SUMMARY_SLUG_CANDIDATES = ['notes', 'summary', 'note', 'description', 'message', 'details'];

/** Resolve a dropdown option's display label, else the raw value as a string. */
function resolveOptionLabel(field: ModelField | null, value: unknown, isAr: boolean): string | null {
  const raw = Array.isArray(value) ? value[0] : value;
  if (raw === undefined || raw === null || raw === '') return null;
  if (field?.options?.length) {
    const opt = field.options.find((o) => o.value === raw || o.id === raw);
    if (opt) return (isAr ? opt.label_ar : opt.label_en) || String(raw);
  }
  return typeof raw === 'string' || typeof raw === 'number' ? String(raw) : null;
}

function firstPresentField(model: AppModel, data: Record<string, unknown>, candidates: string[]): { field: ModelField | null; value: unknown } | null {
  const fields = allFields(model);
  for (const slug of candidates) {
    if (data[slug] !== undefined && data[slug] !== null && data[slug] !== '') {
      return { field: fields.find((f) => f.name === slug) ?? null, value: data[slug] };
    }
  }
  return null;
}

function readItemDate(model: AppModel, record: AppRecord): string | null {
  const hit = firstPresentField(model, record.data, DATE_SLUG_CANDIDATES);
  if (hit) {
    const s = nonEmptyString(hit.value);
    if (s) return s;
  }
  // Fall back to the first datetime/date field on the model, else created_at.
  const dateField = allFields(model).find((f) => f.type === 'datetime' || f.type === 'date');
  if (dateField) {
    const s = nonEmptyString(record.data[dateField.name]);
    if (s) return s;
  }
  return nonEmptyString(record.created_at);
}

/**
 * Build a chronological activity stream for a client across every model that
 * links to it via a lookup (follow-ups, appointments, visits, calls, offers,
 * reservations, financing, deed transfers…). WhatsApp lives on its own tab, so
 * the `chats` model is excluded here. Sorted newest-first; undated items last.
 */
export function buildClientTimeline(ctx: ClientViewCtx, clientId: string, opts?: { excludeModelNames?: string[] }): TimelineItem[] {
  const clients = getClientsModel(ctx);
  if (!clients) return [];
  const isAr = ctx.language === 'ar';
  const exclude = new Set(['clients', 'chats', ...(opts?.excludeModelNames ?? [])]);
  const slugsByModel = clientLookupSlugsByModel(ctx, clients.id);
  const items: TimelineItem[] = [];

  for (const [modelId, slugs] of slugsByModel) {
    const model = ctx.models.find((m) => m.id === modelId);
    if (!model || exclude.has(model.name)) continue;
    const matches = recordsLinkedToClient(ctx.records[modelId] ?? [], slugs, clientId);
    for (const rec of matches) {
      const ownerHit = firstPresentField(model, rec.data, OWNER_SLUG_CANDIDATES);
      const ownerName = ownerHit ? userDisplayName(ctx, readOwnerId(ownerHit.value)) ?? nonEmptyString(ownerHit.value) : userDisplayName(ctx, rec.created_by_user_id);
      const statusHit = firstPresentField(model, rec.data, STATUS_SLUG_CANDIDATES);
      const summaryHit = firstPresentField(model, rec.data, SUMMARY_SLUG_CANDIDATES);
      items.push({
        id: rec.id,
        modelId,
        modelName: model.name,
        typeLabel: (isAr ? model.label_ar : model.label_en) || model.name,
        date: readItemDate(model, rec),
        ownerName: ownerName ?? null,
        status: statusHit ? resolveOptionLabel(statusHit.field, statusHit.value, isAr) : null,
        summary: summaryHit ? nonEmptyString(summaryHit.value) : recordDisplayName(model, rec),
        href: `/model/${model.name}/${rec.id}`,
      });
    }
  }

  items.sort((a, b) => {
    const ta = a.date ? Date.parse(a.date) : NaN;
    const tb = b.date ? Date.parse(b.date) : NaN;
    const va = Number.isNaN(ta) ? -Infinity : ta;
    const vb = Number.isNaN(tb) ? -Infinity : tb;
    return vb - va;
  });
  return items;
}

// ---------------------------------------------------------------------------
// The resolver
// ---------------------------------------------------------------------------

const LIFECYCLE_VALUES = new Set<LifecycleHealth>(['on_track', 'overdue', 'no_next_action', 'closed']);

function asLifecycle(v: unknown): LifecycleHealth | null {
  const s = nonEmptyString(v);
  return s && LIFECYCLE_VALUES.has(s as LifecycleHealth) ? (s as LifecycleHealth) : null;
}

/**
 * Resolve a clients record into a flat, display-ready view. Safe on a sparse
 * record (`{}` data) — every field falls back to null / empty collection.
 */
export function resolveClientView(client: AppRecord, ctx: ClientViewCtx): ClientView {
  const model = getClientsModel(ctx);
  const data = (client.data ?? {}) as Record<string, unknown>;
  const locationField = fieldBySlug(model, 'location');

  const cityNames = resolveLocationLevel(ctx, locationField, data, 'city');
  const districtNames = resolveLocationLevel(ctx, locationField, data, 'district');

  return {
    id: client.id,
    clientId: nonEmptyString(data.client_id) ?? nonEmptyString(data.client_code),
    name: nonEmptyString(data.client_name),
    phone: nonEmptyString(data.phone_number),
    ownerId: readOwnerId(data.client_owner),
    ownerName: userDisplayName(ctx, readOwnerId(data.client_owner)),
    stage: nonEmptyString(data.client_stage),
    status: nonEmptyString(data.client_status),
    lifecycleHealth: asLifecycle(data.lifecycle_health),
    nextActionType: nonEmptyString(data.next_action_type),
    nextActionDueAt: nonEmptyString(data.next_action_due_at),
    nextFollowupId: nonEmptyString(data.next_followup_id),
    lastActivityAt: nonEmptyString(data.last_activity_at),
    lostReason: nonEmptyString(data.lost_reason),
    lostAt: nonEmptyString(data.lost_at),
    latestVisitRating: toFiniteNumber(data.latest_visit_rating),
    latestVisitRatedAt: nonEmptyString(data.latest_visit_rated_at),
    preferredUnitType: asStringArray(data.preferred_unit_type),
    budget: readRange(data.budget),
    preferredCity: cityNames[0] ?? null,
    preferredDirection: asStringArray(data.preferred_direction),
    preferredDistrict: districtNames.length ? districtNames.join('، ') : null,
    preferredProjects: model ? resolveLookupField(ctx, model, 'preferred_projects', data) : [],
    preferredMarketListings: model ? resolveLookupField(ctx, model, 'preferred_market_listings', data) : [],
    counts: {
      followups: countRelatedByModelName(ctx, client.id, 'followups'),
      visits: countRelatedByModelName(ctx, client.id, 'visits'),
      appointments: countRelatedByModelName(ctx, client.id, 'appointments'),
      calls: countRelatedByModelName(ctx, client.id, 'phone_calls'),
    },
  };
}

// ---------------------------------------------------------------------------
// Derived predicates (overdue / no-next-action) — pure & testable
// ---------------------------------------------------------------------------

/**
 * Overdue — driven by the trigger-maintained `lifecycle_health` when present
 * (so it matches dashboards exactly); only when health is unknown does it fall
 * back to a past `next_action_due_at`. `now` injectable for testing.
 */
export function isOverdue(view: Pick<ClientView, 'lifecycleHealth' | 'nextActionDueAt'>, now: number = Date.now()): boolean {
  if (view.lifecycleHealth) return view.lifecycleHealth === 'overdue';
  if (!view.nextActionDueAt) return false;
  const due = Date.parse(view.nextActionDueAt);
  return Number.isFinite(due) && due < now;
}

/**
 * No next action — false for terminal clients (closed-won / lost / unqualified):
 * a closed client isn't "missing" an action. Otherwise trust `lifecycle_health`
 * when present, else fall back to having neither a next follow-up nor a due date.
 */
export function hasNoNextAction(
  view: Pick<ClientView, 'stage' | 'lifecycleHealth' | 'nextFollowupId' | 'nextActionDueAt'>,
): boolean {
  if (isClosedWon(view) || isLostOrUnqualified(view)) return false;
  if (view.lifecycleHealth) return view.lifecycleHealth === 'no_next_action';
  return !view.nextFollowupId && !view.nextActionDueAt;
}

/** Closed-won iff the stage is the terminal "won" stage. */
export function isClosedWon(view: Pick<ClientView, 'stage'>): boolean {
  return view.stage === 'مغلق ناجح';
}

/** Lost / unqualified iff the stage is a terminal failure stage. */
export function isLostOrUnqualified(view: Pick<ClientView, 'stage'>): boolean {
  return view.stage === 'خاسر' || view.stage === 'غير مؤهل';
}

/** At-risk: a poor visit rating, or the "visited another project — review" status. */
export function isAtRisk(view: Pick<ClientView, 'latestVisitRating' | 'status'>): boolean {
  if (typeof view.latestVisitRating === 'number' && view.latestVisitRating > 0 && view.latestVisitRating <= 2) return true;
  return view.status === 'زار مشروعًا آخر — للمراجعة';
}

/** Open: not in any terminal (closed/lost/unqualified) state. */
export function isOpen(view: Pick<ClientView, 'stage' | 'lifecycleHealth'>): boolean {
  if (view.lifecycleHealth === 'closed') return false;
  return !isClosedWon(view) && !isLostOrUnqualified(view);
}

// ---------------------------------------------------------------------------
// Routing escape hatch
// ---------------------------------------------------------------------------

/**
 * `?generic=1` escape hatch — when present, the custom Clients pages defer to
 * the generic RecordListPage / RecordFormPage. Accepts a query string,
 * URLSearchParams, or null. Pure so the fallback is unit-testable.
 */
export function isGenericMode(search: string | URLSearchParams | null | undefined): boolean {
  if (!search) return false;
  const params = typeof search === 'string' ? new URLSearchParams(search) : search;
  return params.get('generic') === '1';
}
