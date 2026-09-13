/**
 * Hatif call transcript → speaker-labelled turns.
 *
 * `phone_calls.transcription_text` is Hatif's FLATTENED transcript: one line,
 * no speaker labels. The rich `call_logs.transcription.words[]` (same call id)
 * is DIARIZED for essentially every transcribed call — each word carries a
 * `speaker` — under two schemes seen on prod (2026-09-13, 603 Hatif calls):
 *   - `ch_0` / `ch_1`      — the two audio channels (our leg vs the customer's)
 *   - `speaker_0` / `_1`   — acoustic diarization (ids NOT stable across calls)
 * Hatif's resolved `role` (Agent / Customer) is present on only ~3.6% of calls.
 *
 * WHO IS THE AGENT — decided in this order, and recorded on the result so the
 * extractor + grader know how much to trust the labels:
 *   1. `role` labels when Hatif sent them                      → 'hatif_role'
 *   2. exactly ONE speaker introduces the company («معك فهد من وصل العقارية»)
 *      — the strict pattern below, not a loose «شركة» match       → 'self_intro'
 *   3. channel scheme + direction (outbound: our leg is ch_0)   → 'channel'
 *   4. otherwise the turns are kept (turn boundaries are still valuable) but
 *      every speaker is 'unknown'                               → 'none'
 * The "first speaker is the customer" guess used elsewhere is NOT used here —
 * measured on prod it is close to a coin flip for outbound calls.
 *
 * This is the geo-preference twin of `buildDialogue` in
 * worker/src/runCallAnalysisJob.ts (which renders a string for the call-result
 * model). Keep the agent-detection ideas aligned, but this one returns typed
 * turns with per-turn timestamps for provenance. Pure: no I/O, never throws.
 */
import type { ConversationTurn } from './extractor.js';
import type { Speaker } from './ontology.js';

export interface HatifWord {
  text?: unknown;
  start?: unknown;
  end?: unknown;
  type?: unknown;
  speaker?: unknown;
  role?: unknown;
}

export type SpeakerLabelSource = 'hatif_role' | 'self_intro' | 'channel' | 'none';

export interface HatifDialogue {
  turns: ConversationTurn[];
  /** How the agent/client labels were decided ('none' ⇒ every speaker is 'unknown'). */
  labelSource: SpeakerLabelSource;
  /** The diarization id decided to be the agent, when labelSource ≠ 'hatif_role'/'none'. */
  agentSpeaker: string | null;
  /** Distinct diarization ids seen, in first-appearance order. */
  speakers: string[];
}

/** The company self-introduction the sales agent opens with — TIERED, because
 *  the customer often ECHOES the company name («من شركة؟ وصل العقارية. أهلًا»),
 *  which made a single pattern match both sides on the 2026-06-17 call:
 *   1. STRONG — the agent naming themself: «معك صالح من (شركة) وصل العقارية»,
 *      «أنا فهد من وصل». Only the agent says this.
 *   2. WEAK — the bare company name. Used only when the strong tier is silent
 *      and exactly one speaker says it.
 *  A loose «شركة|العقاري» is never used: it matched BOTH speakers on 114 of 570
 *  outbound calls. */
export const AGENT_SELF_INTRO_STRONG = /معك\s+\S+\s+من\s|أنا\s+\S+\s+من\s+(شركة\s+)?(وصل|واصل|تواصل)/;
export const AGENT_SELF_INTRO_WEAK = /(وصل|واصل|تواصل)\s+العقاري/;
/** @deprecated kept for callers/tests — the union of both tiers. */
export const AGENT_SELF_INTRO = new RegExp(`${AGENT_SELF_INTRO_STRONG.source}|${AGENT_SELF_INTRO_WEAK.source}`);

/**
 * Hatif stamps `phone_calls.call_time` as UTC WITHOUT a timezone suffix
 * («2026-06-25T12:54:03.885911»; measured 22/22 equal to call_logs.creation_time
 * in UTC). `Date.parse` treats a suffix-less ISO string as LOCAL time, so on a
 * Riyadh machine every call timestamp landed 3 h early. Normalise: no suffix ⇒ UTC.
 */
export function isoUtc(value: string | null | undefined): string | null {
  const v = (value ?? '').trim();
  if (!v) return null;
  const withZone = /(Z|[+-]\d\d:?\d\d)$/i.test(v) ? v : `${v}Z`;
  const t = Date.parse(withZone);
  return Number.isFinite(t) ? new Date(t).toISOString() : null;
}

/** Channel-scheme rule: which channel is OUR side, per call direction.
 *  Measured on prod 2026-09-13 (see the SQL in the PRD): outbound → ch_0 on
 *  every call whose self-introduction was unique. Inbound had too few
 *  channel-labelled calls to trust, so it stays unset (falls through to 'none'). */
export const CHANNEL_AGENT_BY_DIRECTION: Record<string, string | undefined> = {
  outbound: 'ch_0',
};

interface CleanWord { text: string; start: number | null; speaker: string; role: 'Agent' | 'Customer' | null; punct: boolean }

function cleanWords(raw: unknown): CleanWord[] {
  if (!Array.isArray(raw)) return [];
  const out: CleanWord[] = [];
  for (const w of raw as HatifWord[]) {
    if (w == null || typeof w !== 'object') continue;
    const text = typeof w.text === 'string' ? w.text.trim() : '';
    if (!text) continue;
    const start = typeof w.start === 'number' && Number.isFinite(w.start) ? w.start
      : typeof w.start === 'string' && w.start.trim() && Number.isFinite(Number(w.start)) ? Number(w.start) : null;
    const speaker = w.speaker == null ? '' : String(w.speaker);
    const role = w.role === 'Agent' || w.role === 'Customer' ? w.role : null;
    const punct = w.type === 'punctuation' || /^[.،؟!,?;:]+$/.test(text);
    out.push({ text, start, speaker, role, punct });
  }
  // Stable sort by start time; words without a time keep their array position at the end.
  return out
    .map((w, i) => ({ w, i }))
    .sort((a, b) => {
      if (a.w.start == null && b.w.start == null) return a.i - b.i;
      if (a.w.start == null) return 1;
      if (b.w.start == null) return -1;
      return a.w.start - b.w.start || a.i - b.i;
    })
    .map((x) => x.w);
}

function joinWords(words: CleanWord[]): string {
  let s = '';
  for (const w of words) {
    if (!s) { s = w.text; continue; }
    s += w.punct ? w.text : ` ${w.text}`;
  }
  return s.trim();
}

/**
 * Build speaker-labelled turns from `call_logs.transcription`. Returns null when
 * the transcript is not diarized (no `words`, or a single speaker) — the caller
 * then falls back to the flattened text.
 */
export function hatifWordsToTurns(
  transcription: unknown,
  opts: { direction?: string | null; ref: string; callTimeIso?: string | null },
): HatifDialogue | null {
  const t = transcription as { words?: unknown } | null | undefined;
  const words = cleanWords(t?.words);
  if (words.length === 0) return null;

  const speakers: string[] = [];
  for (const w of words) if (w.speaker && !speakers.includes(w.speaker)) speakers.push(w.speaker);
  if (speakers.length < 2) return null; // not diarized — nothing better than the flat text

  // 1. Hatif's own roles.
  const hasRoles = words.some((w) => w.role !== null);
  let labelSource: SpeakerLabelSource = 'none';
  let agentSpeaker: string | null = null;

  if (hasRoles) {
    labelSource = 'hatif_role';
  } else {
    // 2. Exactly one speaker introduces the company — strong tier first, then weak.
    const bySpeaker = new Map<string, string>();
    for (const w of words) if (!w.punct) bySpeaker.set(w.speaker, `${bySpeaker.get(w.speaker) ?? ''} ${w.text}`);
    const strong = speakers.filter((sp) => AGENT_SELF_INTRO_STRONG.test(bySpeaker.get(sp) ?? ''));
    const weak = speakers.filter((sp) => AGENT_SELF_INTRO_WEAK.test(bySpeaker.get(sp) ?? ''));
    const intro = strong.length === 1 ? strong : strong.length === 0 && weak.length === 1 ? weak : [];
    if (intro.length === 1) {
      agentSpeaker = intro[0]!;
      labelSource = 'self_intro';
    } else {
      // 3. Channel scheme + direction.
      const channelScheme = speakers.every((sp) => /^ch_\d+$/.test(sp));
      const ours = opts.direction ? CHANNEL_AGENT_BY_DIRECTION[String(opts.direction).toLowerCase()] : undefined;
      if (channelScheme && ours && speakers.includes(ours)) {
        agentSpeaker = ours;
        labelSource = 'channel';
      }
    }
  }

  const speakerOf = (w: CleanWord): Speaker => {
    if (labelSource === 'hatif_role') return w.role === 'Agent' ? 'agent' : w.role === 'Customer' ? 'client' : 'unknown';
    if (labelSource === 'none') return 'unknown';
    return w.speaker === agentSpeaker ? 'agent' : 'client';
  };

  const baseIso = isoUtc(opts.callTimeIso);
  const base = baseIso ? Date.parse(baseIso) : NaN;
  const stampFor = (start: number | null): string | undefined => {
    if (!Number.isFinite(base)) return undefined;
    return new Date(base + Math.max(0, start ?? 0) * 1000).toISOString();
  };

  // Group consecutive words of the same diarization id into one turn.
  const turns: ConversationTurn[] = [];
  let cur: CleanWord[] = [];
  const flush = () => {
    if (!cur.length) return;
    const text = joinWords(cur);
    const firstWord = cur.find((w) => !w.punct) ?? cur[0]!;
    if (text && /[\p{L}\p{N}]/u.test(text)) {
      turns.push({ speaker: speakerOf(firstWord), text, ref: opts.ref, timestamp: stampFor(firstWord.start) });
    }
    cur = [];
  };
  for (const w of words) {
    if (cur.length && w.speaker !== cur[0]!.speaker) flush();
    cur.push(w);
  }
  flush();

  if (turns.length === 0) return null;
  return { turns, labelSource, agentSpeaker, speakers };
}
