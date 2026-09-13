import { describe, it, expect } from 'vitest';
import { hatifWordsToTurns, AGENT_SELF_INTRO } from '../hatifDialogue.js';

/**
 * Hatif diarized words → speaker-labelled turns. Pure, offline. Shapes mirror
 * what prod holds in call_logs.transcription.words (2026-09-13): `ch_0/ch_1`
 * channel ids or `speaker_N` diarization ids, word/punctuation entries with
 * start/end seconds, and (rarely) Hatif's resolved `role`.
 */

const W = (text: string, start: number, speaker: string, extra: Record<string, unknown> = {}) =>
  ({ text, start, end: start + 0.3, type: /^[.،؟!]$/.test(text) ? 'punctuation' : 'word', speaker, ...extra });

const CALL_TIME = '2026-06-21T13:31:18.000Z';

describe('hatifWordsToTurns', () => {
  it('self-introduction decides the agent; consecutive words group into turns with per-turn timestamps', () => {
    const words = [
      W('ألو', 0.5, 'speaker_1'),
      W('.', 0.8, 'speaker_1'),
      W('معك', 1.0, 'speaker_0'), W('فهد', 1.2, 'speaker_0'), W('من', 1.4, 'speaker_0'), W('وصل', 1.6, 'speaker_0'), W('العقارية', 1.8, 'speaker_0'),
      W('عندنا', 2.5, 'speaker_0'), W('مشروع', 2.7, 'speaker_0'), W('في', 2.9, 'speaker_0'), W('القروان', 3.1, 'speaker_0'), W('.', 3.3, 'speaker_0'),
      W('لا', 4.0, 'speaker_1'), W('أبي', 4.2, 'speaker_1'), W('المهدية', 4.4, 'speaker_1'),
    ];
    const d = hatifWordsToTurns({ text: 'x', words }, { direction: 'outbound', ref: 'call-1', callTimeIso: CALL_TIME })!;
    expect(d).not.toBeNull();
    expect(d.labelSource).toBe('self_intro');
    expect(d.agentSpeaker).toBe('speaker_0');
    expect(d.turns.map((t) => [t.speaker, t.text])).toEqual([
      ['client', 'ألو.'],
      ['agent', 'معك فهد من وصل العقارية عندنا مشروع في القروان.'],
      ['client', 'لا أبي المهدية'],
    ]);
    // Every turn carries the call id as ref + call_time offset by the first word's start.
    for (const t of d.turns) expect(t.ref).toBe('call-1');
    expect(d.turns[1]!.timestamp).toBe('2026-06-21T13:31:19.000Z'); // 1.0 s after call_time
    expect(d.turns[2]!.timestamp).toBe('2026-06-21T13:31:22.000Z'); // 4.0 s
  });

  it('Hatif role labels win over inference', () => {
    const words = [
      W('ألو', 0.5, 'ch_1', { role: 'Customer' }),
      W('معك', 1.0, 'ch_0', { role: 'Agent' }), W('سارة', 1.2, 'ch_0', { role: 'Agent' }),
    ];
    const d = hatifWordsToTurns({ words }, { direction: 'inbound', ref: 'c', callTimeIso: null })!;
    expect(d.labelSource).toBe('hatif_role');
    expect(d.turns.map((t) => t.speaker)).toEqual(['client', 'agent']);
  });

  it('channel scheme: on an OUTBOUND call ch_0 is our side when nobody introduces the company', () => {
    const words = [W('السلام', 1.0, 'ch_0'), W('عليكم', 1.3, 'ch_0'), W('وعليكم', 2.3, 'ch_1'), W('السلام', 2.6, 'ch_1'), W('أبي', 3.0, 'ch_1'), W('النرجس', 3.2, 'ch_1')];
    const d = hatifWordsToTurns({ words }, { direction: 'outbound', ref: 'c', callTimeIso: CALL_TIME })!;
    expect(d.labelSource).toBe('channel');
    expect(d.turns.map((t) => t.speaker)).toEqual(['agent', 'client']);
    // No inbound channel rule is asserted (not validated on prod) → unknown speakers, turns kept.
    const inbound = hatifWordsToTurns({ words }, { direction: 'inbound', ref: 'c', callTimeIso: CALL_TIME })!;
    expect(inbound.labelSource).toBe('none');
    expect(inbound.turns.map((t) => t.speaker)).toEqual(['unknown', 'unknown']);
    expect(inbound.turns.length).toBe(2); // turn boundaries survive even without labels
  });

  it('speaker_N ids with no self-introduction and no roles → turns kept, speakers unknown', () => {
    const words = [W('ألو', 0.5, 'speaker_0'), W('هلا', 1.0, 'speaker_1'), W('شركة', 1.3, 'speaker_1'), W('كبيرة', 1.5, 'speaker_1')];
    const d = hatifWordsToTurns({ words }, { direction: 'outbound', ref: 'c', callTimeIso: CALL_TIME })!;
    expect(d.labelSource).toBe('none');
    expect(d.agentSpeaker).toBeNull();
    expect(d.turns.every((t) => t.speaker === 'unknown')).toBe(true);
  });

  it('a loose «شركة» is NOT a self-introduction; both sides saying it stays ambiguous', () => {
    expect(AGENT_SELF_INTRO.test('أنت من أي شركة؟')).toBe(false);
    expect(AGENT_SELF_INTRO.test('معك فهد من وصل العقارية')).toBe(true);
    expect(AGENT_SELF_INTRO.test('معك صالح من شركة تواصل العقارية')).toBe(true);
  });

  it('words are sorted by start time before grouping (prod arrays are not guaranteed ordered)', () => {
    const words = [W('المهدية', 4.4, 'speaker_1'), W('معك', 1.0, 'speaker_0'), W('فهد', 1.2, 'speaker_0'), W('من', 1.4, 'speaker_0'), W('وصل', 1.6, 'speaker_0'), W('العقارية', 1.8, 'speaker_0'), W('أبي', 4.2, 'speaker_1')];
    const d = hatifWordsToTurns({ words }, { direction: 'outbound', ref: 'c', callTimeIso: CALL_TIME })!;
    expect(d.turns.map((t) => t.text)).toEqual(['معك فهد من وصل العقارية', 'أبي المهدية']);
  });

  it('returns null when not diarized: no words, or a single speaker', () => {
    expect(hatifWordsToTurns({ text: 'ألو ألو' }, { ref: 'c' })).toBeNull();
    expect(hatifWordsToTurns({ words: [W('ألو', 0, 'speaker_0'), W('هلا', 1, 'speaker_0')] }, { ref: 'c' })).toBeNull();
    expect(hatifWordsToTurns(null, { ref: 'c' })).toBeNull();
  });
});
