// Compact client timeline primitives for the Follow-up Workspace.
//
// Pure utilities — the Workspace (Phase 3) collects related records (follow-ups,
// appointments, visits, calls, chats, offers) from the store, maps each to a
// TimelineEntry, and renders them via sortTimeline. Keeping the shape + sort here
// means the Workspace just supplies data.

export type TimelineKind =
  | 'client_created'
  | 'followup'
  | 'appointment'
  | 'visit'
  | 'call'
  | 'chat'
  | 'offer'
  | 'reservation'
  | 'financing'
  | 'generic';

export interface TimelineEntry {
  id: string;
  kind: TimelineKind;
  /** ISO timestamp used for ordering. */
  at: string;
  title_ar: string;
  title_en: string;
  subtitle_ar?: string;
  subtitle_en?: string;
  model_name?: string;
  record_id?: string;
  tone?: 'positive' | 'neutral' | 'negative';
  /** Optional key/value rows shown when the entry is expanded inline (a read-only
   *  summary — outcome, notes, rep… — instead of opening the full record form). */
  summary?: TimelineSummaryRow[];
}

/** One labelled line in an entry's inline summary. */
export interface TimelineSummaryRow {
  label_ar: string;
  label_en: string;
  value: string;
}

/** Common date slugs, most-relevant first, for picking an entry timestamp. */
const DATE_SLUGS = [
  'actual_datetime',
  'scheduled_datetime',
  'appointment_date',
  'call_time',
  'last_message_at',
  'visit_date',
  'created_at',
  'updated_at',
];

/** Pick the most relevant ISO timestamp from a record's data + metadata. */
export function pickEntryDate(
  data: Record<string, unknown>,
  fallbackCreatedAt?: string | null,
): string | null {
  for (const slug of DATE_SLUGS) {
    const v = data[slug];
    if (typeof v === 'string' && v.trim()) return v;
  }
  return fallbackCreatedAt ?? null;
}

/** Sort entries chronologically (newest first by default). Drops dateless ones. */
export function sortTimeline(entries: TimelineEntry[], dir: 'asc' | 'desc' = 'desc'): TimelineEntry[] {
  return entries
    .filter((e) => Boolean(e.at))
    .slice()
    .sort((a, b) => {
      if (a.at === b.at) return 0;
      const cmp = a.at < b.at ? -1 : 1;
      return dir === 'desc' ? -cmp : cmp;
    });
}
