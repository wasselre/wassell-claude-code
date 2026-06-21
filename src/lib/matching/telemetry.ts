/**
 * Lightweight Sales-Assistant telemetry + feedback. Everything is stored INLINE
 * on each assistant message inside the `matching_chats` record (no schema change,
 * no extra write path): per-turn telemetry (which capabilities fired, response
 * time, whether it errored) and an optional 👍/👎 with the rep's intended task.
 * The admin insights view aggregates these over the conversations it can see.
 */

export interface MessageTelemetry {
  /** Tool/capability names that fired this turn (match_projects, compare_projects, …). */
  tools_used: string[];
  /** Wall-clock ms from send to the turn completing. */
  response_ms: number;
  /** True if the turn surfaced an error / hit the tool-iteration limit. */
  errored: boolean;
}

export type FeedbackRating = 'up' | 'down';

export interface MessageFeedbackData {
  rating: FeedbackRating;
  /** On 👎 — what the rep was trying to do (so we learn which capability failed). */
  intent?: string;
  comment?: string;
  at: string;
}

/** The intents shown on a 👎 — "what were you trying to do?" */
export const FEEDBACK_INTENTS: ReadonlyArray<{ value: string; ar: string; en: string }> = [
  { value: 'find_project', ar: 'ترشيح مشروع', en: 'Find a project' },
  { value: 'compare', ar: 'مقارنة مشاريع', en: 'Compare projects' },
  { value: 'understand_customer', ar: 'فهم العميل', en: 'Understand a customer' },
  { value: 'write_message', ar: 'كتابة رسالة', en: 'Write a message' },
  { value: 'create_task', ar: 'إنشاء مهمة', en: 'Create a task' },
  { value: 'other', ar: 'شيء آخر', en: 'Something else' },
];

export function intentLabel(value: string, isAr: boolean): string {
  const e = FEEDBACK_INTENTS.find((i) => i.value === value);
  return e ? (isAr ? e.ar : e.en) : value;
}

// ─── Aggregation (pure — unit-tested) ────────────────────────────────────────

interface AggMessage {
  role?: string;
  cards?: Array<{ kind?: string }>;
  telemetry?: MessageTelemetry;
  feedback?: MessageFeedbackData;
}
interface AggRecord {
  data?: { messages?: unknown };
}

export interface AssistantInsights {
  conversations: number;
  user_messages: number;
  assistant_turns: number;
  tool_usage: Array<{ name: string; count: number }>;
  card_usage: Array<{ kind: string; count: number }>;
  thumbs_up: number;
  thumbs_down: number;
  /** up / (up + down); null when there's no feedback yet. */
  thumbs_up_rate: number | null;
  failed_intents: Array<{ intent: string; count: number }>;
  complaints: Array<{ comment: string; intent?: string; at: string }>;
  errored_turns: number;
  avg_response_ms: number | null;
}

/** Aggregate insights over a set of matching_chats records. Pure + defensive
 *  (any record/message shape is tolerated). */
export function aggregateInsights(records: AggRecord[]): AssistantInsights {
  let conversations = 0;
  let userMessages = 0;
  let assistantTurns = 0;
  let erroredTurns = 0;
  let up = 0;
  let down = 0;
  let responseSum = 0;
  let responseCount = 0;
  const toolUsage = new Map<string, number>();
  const cardUsage = new Map<string, number>();
  const failedIntents = new Map<string, number>();
  const complaints: AssistantInsights['complaints'] = [];

  for (const rec of records) {
    const msgs = Array.isArray(rec?.data?.messages) ? (rec.data!.messages as AggMessage[]) : [];
    if (msgs.length === 0) continue;
    conversations += 1;
    for (const m of msgs) {
      if (m?.role === 'user') userMessages += 1;
      if (m?.role === 'assistant') {
        assistantTurns += 1;
        const t = m.telemetry;
        if (t) {
          if (t.errored) erroredTurns += 1;
          if (typeof t.response_ms === 'number' && t.response_ms > 0) {
            responseSum += t.response_ms;
            responseCount += 1;
          }
          for (const name of Array.isArray(t.tools_used) ? t.tools_used : []) {
            toolUsage.set(name, (toolUsage.get(name) ?? 0) + 1);
          }
        }
        for (const c of Array.isArray(m.cards) ? m.cards : []) {
          const kind = c?.kind;
          if (kind) cardUsage.set(kind, (cardUsage.get(kind) ?? 0) + 1);
        }
      }
      const fb = m?.feedback;
      if (fb?.rating === 'up') up += 1;
      else if (fb?.rating === 'down') {
        down += 1;
        if (fb.intent) failedIntents.set(fb.intent, (failedIntents.get(fb.intent) ?? 0) + 1);
        if (fb.comment && fb.comment.trim()) complaints.push({ comment: fb.comment.trim(), intent: fb.intent, at: fb.at });
      }
    }
  }

  const sortDesc = (map: Map<string, number>) =>
    [...map.entries()].sort((a, b) => b[1] - a[1]);

  return {
    conversations,
    user_messages: userMessages,
    assistant_turns: assistantTurns,
    tool_usage: sortDesc(toolUsage).map(([name, count]) => ({ name, count })),
    card_usage: sortDesc(cardUsage).map(([kind, count]) => ({ kind, count })),
    thumbs_up: up,
    thumbs_down: down,
    thumbs_up_rate: up + down > 0 ? up / (up + down) : null,
    failed_intents: sortDesc(failedIntents).map(([intent, count]) => ({ intent, count })),
    complaints: complaints.slice(0, 50),
    errored_turns: erroredTurns,
    avg_response_ms: responseCount > 0 ? Math.round(responseSum / responseCount) : null,
  };
}
