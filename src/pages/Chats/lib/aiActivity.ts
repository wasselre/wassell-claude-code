import { useCallback, useEffect, useState } from 'react';
import { callJson } from './cardHttp';

/**
 * Shapes returned by GET /api/chat-ai-activity (api/chat-ai-activity.ts) and
 * the hook the chat's AI cards and the client's AI timeline share.
 */

export interface AgentRunSearch {
  criteria: Record<string, unknown>;
  total: number;
  relaxed: string | null;
  area_understood: Array<{ place: string; wanted: boolean }> | null;
  overrides: string[];
  /** The saved profile the search was for (a client with several). */
  profile_id?: string | null;
  profile_name?: string | null;
  top: AgentFoundProject[];
  /** Nothing fit: the closest options, each missing one condition. */
  alternatives?: Array<{ without: 'near' | 'readiness' | 'near_and_readiness' | 'area'; top: AgentFoundProject[] }>;
}

export interface AgentFoundProject { id: string; name: string; district: string | null; price_from: number | null }

export interface AgentRunReading {
  unit_types?: string[] | null;
  budget_max?: number | null;
  bedrooms_min?: number | null;
  area_min?: number | null;
  purpose?: string[] | null;
  readiness?: 'ready' | 'off_plan' | null;
  amenities?: string[] | null;
}

export interface AgentRunActions {
  sent_project?: { id: string; name: string };
  sent_units?: { project_id: string; name: string; count: number };
  booked?: { projectId: string; day: string };
  handoff?: { reason: string; note: string | null };
  asked?: boolean;
  ended?: boolean;
}

export interface AgentRun {
  id: string;
  chat_wid: string;
  kind: 'brain' | 'rules' | 'holding';
  model: string | null;
  ms: number | null;
  customer_text: string | null;
  reading: AgentRunReading | null;
  searches: AgentRunSearch[];
  actions: AgentRunActions;
  reply: string | null;
  reply_sent: boolean | null;
  reply_failed: boolean;
  guard_problems: string[];
  tool_trace: string[];
  created_at: string;
}

export interface AiChangeRow {
  id: string;
  kind: 'pref' | 'place' | 'outcome' | 'profile';
  profile_id?: string | null;
  profile_name?: string | null;
  field: string | null;
  before_value: unknown;
  after_value: unknown;
  added: unknown;
  applied: boolean;
  note: string | null;
  source: 'chat' | 'call' | 'agent';
  quote: string | null;
  label: string | null;
  created_at: string;
  undone_at: string | null;
}

export interface OutcomeRow {
  id: string;
  chat_wid: string | null;
  status: string;
  suggested_outcome: string | null;
  confidence: number | null;
  summary: string | null;
  quoted_phrase: string | null;
  auto_applied: boolean | null;
  confirmed_outcome: string | null;
  confirmed_at: string | null;
  finished_at: string | null;
  created_at: string;
}

export interface PortalJobRow {
  id: string;
  portal_record_id: string | null;
  project_record_id: string | null;
  status: string;
  origin: string | null;
  kind: string | null;
  error_message: string | null;
  created_at: string;
  finished_at: string | null;
}

export interface AiActionRow {
  id: string;
  kind: string;
  status: string;
  project_id: string | null;
  body: string | null;
  error: string | null;
  created_at: string;
  sent_at: string | null;
}

export interface AgentQuestionRow {
  id: string;
  question: string;
  status: string;
  answer: string | null;
  created_at: string;
  answered_at: string | null;
}

export interface HandoffRow { id: string; chat_wid: string; title: string | null; body: string | null; severity: string | null; created_at: string }

export interface BookingRow { id: string; kind: 'appointment' | 'visit'; created_at: string; when: string | null; status: string | null; project_id: string | null }

export interface InterestRow { project_id: string; score: number; visits: number | null; appointments: number | null; message_level: string | null }

export interface TimelineMessage { chat_wid: string; date: string; by: 'customer' | 'ai' | 'rep'; text: string }

export interface AiActivity {
  scope: 'chat' | 'client';
  chat_wids: string[];
  runs: AgentRun[];
  stats: { customer: number; ai: number; rep: number; last_ai_at: string | null; last_customer_at: string | null; sampled: number };
  messages: TimelineMessage[];
  changes: AiChangeRow[];
  outcomes: OutcomeRow[];
  portal: { jobs: PortalJobRow[]; registrations: Array<{ portal_record_id: string; our_status: string | null; portal_status: string | null; registered_at: string | null }> };
  actions: AiActionRow[];
  questions: AgentQuestionRow[];
  handoffs: HandoffRow[];
  bookings: BookingRow[];
  interest: InterestRow[];
  names: Record<string, string>;
}

/** Loads the activity; `refreshKey` changes re-load it (e.g. a new message arrived). */
export function useAiActivity(clientId: string, chatWid: string | null, refreshKey: string | number) {
  const [data, setData] = useState<AiActivity | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const qs = new URLSearchParams({ clientId });
      if (chatWid) qs.set('chatWid', chatWid);
      setData(await callJson<AiActivity>(`/api/chat-ai-activity?${qs.toString()}`, { method: 'GET' }));
      setError(null);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error('[useAiActivity] load failed:', err);
      setError(msg);
    } finally {
      setLoading(false);
    }
  }, [clientId, chatWid]);

  useEffect(() => { void load(); }, [load, refreshKey]);

  return { data, error, loading, reload: load };
}
