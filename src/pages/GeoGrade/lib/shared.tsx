import { supabase } from '@/lib/supabase';

/**
 * Shared bits of the geo grader: the item shape the endpoint returns, the
 * plain-Arabic reading of the AI's guess, and the auth header helper. Used by
 * both the one-card-at-a-time page and the conversation (chat + map) view.
 */

export interface Item {
  id: string; client_id: string; client: string; mention: string;
  /** Which channel the mention came from — a phone call or a WhatsApp thread. */
  source_channel: 'chat' | 'call';
  /** The phone_calls record id (call) or chat_wid (chat) — the transcript key. */
  conversation_id: string;
  role: 'positive' | 'negative' | 'exploratory' | 'none';
  commitment: string; holder: string; applicability: string; anchor_type: string | null;
  my_verdict: 'right' | 'wrong' | 'unsure' | null;
}
export type Verdict = 'right' | 'wrong' | 'unsure';

/** What the AI placed on the map for ONE mention (from the proposal's compiled expression). */
export interface Placement {
  polarity: 'include' | 'exclude';
  operation: string;
  /** Real element ids when resolved; the bare names when the resolver could not pick. */
  element_ids: string[];
  resolved: boolean;
  label: string;
  /** district_side_clip: which side of the road (last element id) is kept. */
  side?: string | null;
  clip_parts?: Array<{ name: string; kept: boolean; crossed: boolean; kept_km2: number | null; total_km2: number | null }> | null;
}

export interface LocationItemDTO {
  id: string; kind: 'district' | 'element_rule' | 'drawn_area'; polarity: 'include' | 'exclude';
  district_id?: string; district_label?: string; element_label?: string; label?: string;
  conditions?: unknown[];
  /** drawn_area: CLOSED ring in GeoJSON order [lng, lat]. */
  coordinates?: [number, number][];
}

export interface ConversationView {
  conversation_id: string;
  client_id: string;
  client: string;
  channel: 'chat' | 'call';
  timestamp: string | null;
  evidence_ids: string[];
  checkpoint_id: string | null;
  proposal: null | {
    id: string;
    action: string;
    items: LocationItemDTO[];
    by_evidence: Record<string, Placement>;
  };
  map_verdict: Verdict | null;
}

export interface DistrictInfo { name_ar: string; name_en: string; city: string }

const STRENGTH_AR: Record<string, string> = {
  required: 'شرط أساسي', preferred: 'يفضّلها', acceptable: 'مقبولة', considered: 'يفكّر فيها',
};
const STRENGTH_EN: Record<string, string> = {
  required: 'a must', preferred: 'prefers it', acceptable: 'is fine with it', considered: 'just considering it',
};
const HOLDER_AR: Record<string, string> = {
  co_decision_maker: 'شريك في القرار', beneficiary_occupant: 'الشخص الساكن',
  influencer: 'شخص يؤثر عليه', unrelated_third_party: 'شخص آخر (ليس صاحب القرار)', other_person: 'شخص آخر',
};
const HOLDER_EN: Record<string, string> = {
  co_decision_maker: 'a co-decision-maker', beneficiary_occupant: 'the person who will live there',
  influencer: 'someone influencing them', unrelated_third_party: 'someone else (not the buyer)', other_person: 'someone else',
};

export function reading(it: Item, isAr: boolean): string {
  if (isAr) {
    let s: string;
    if (it.role === 'negative') s = it.commitment === 'required' ? 'العميل **لا يريدها إطلاقًا**' : 'العميل **لا يريدها**';
    else if (it.role === 'positive') s = `العميل **يميل إليها**${STRENGTH_AR[it.commitment] ? ` — ${STRENGTH_AR[it.commitment]}` : ''}`;
    else s = 'مجرد **ذكر عابر** — ليس تفضيلًا (سياق أو سؤال)';
    if (it.holder && it.holder !== 'buyer' && it.holder !== 'unknown') s += ` — التفضيل لـ ${HOLDER_AR[it.holder] ?? it.holder}`;
    return s;
  }
  let s: string;
  if (it.role === 'negative') s = it.commitment === 'required' ? 'the customer **does NOT want it, firmly**' : 'the customer **does not want it**';
  else if (it.role === 'positive') s = `the customer **wants it**${STRENGTH_EN[it.commitment] ? ` — ${STRENGTH_EN[it.commitment]}` : ''}`;
  else s = 'just a **passing mention** — not a preference (context or a question)';
  if (it.holder && it.holder !== 'buyer' && it.holder !== 'unknown') s += ` — for ${HOLDER_EN[it.holder] ?? it.holder}`;
  return s;
}

export function Bold({ text }: { text: string }) {
  return <>{text.split(/(\*\*[^*]+\*\*)/g).map((p, i) => {
    const m = /^\*\*([^*]+)\*\*$/.exec(p);
    return m ? <strong key={i} className="text-chocolate">{m[1]}</strong> : <span key={i}>{p}</span>;
  })}</>;
}

export async function authHeader(): Promise<Record<string, string>> {
  const session = supabase ? (await supabase.auth.getSession()).data.session : null;
  return session?.access_token ? { Authorization: `Bearer ${session.access_token}` } : {};
}

/** Render a transcript with every occurrence of `mention` highlighted. */
export function Transcript({ text, mention }: { text: string; mention: string }) {
  const m = (mention ?? '').trim();
  if (!m) return <>{text}</>;
  const parts = text.split(m);
  return <>{parts.map((p, i) => (
    <span key={i}>
      {p}
      {i < parts.length - 1 && <mark className="rounded bg-copper/25 px-0.5 font-bold text-chocolate">{m}</mark>}
    </span>
  ))}</>;
}
