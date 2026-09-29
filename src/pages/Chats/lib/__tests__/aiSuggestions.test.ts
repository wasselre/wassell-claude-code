import { describe, it, expect } from 'vitest';
import { defaultAiTab, liveOutcomeSuggestion } from '../aiSuggestions';
import type { ChatOutcomeSuggestion } from '@/lib/chatSuggestions/client';

const suggestion = (over: Partial<ChatOutcomeSuggestion> = {}): ChatOutcomeSuggestion => ({
  id: 's1', client_id: 'c1', chat_wid: 'w1', followup_id: 't1', followup_type: 'whatsapp_follow_up',
  status: 'ready', suggested_outcome: 'interested', confidence: 85, reasoning: 'r', summary: null,
  suggested_fields: {}, quoted_phrase: null, created_at: '2026-09-29T10:00:00Z',
  ...over,
});

describe('defaultAiTab', () => {
  it('opens on preferences when both tabs have something (tab order)', () => {
    expect(defaultAiTab(3, 1)).toBe('prefs');
  });
  it('opens on the outcome when only it has something', () => {
    expect(defaultAiTab(0, 1)).toBe('outcome');
  });
  it('opens on preferences when only they have something', () => {
    expect(defaultAiTab(2, 0)).toBe('prefs');
  });
  it('falls back to preferences when both are empty', () => {
    expect(defaultAiTab(0, 0)).toBe('prefs');
  });
});

describe('liveOutcomeSuggestion', () => {
  it('keeps a suggestion that targets this task', () => {
    const s = suggestion();
    expect(liveOutcomeSuggestion(s, 't1')).toBe(s);
  });
  it('drops a suggestion for another (completed / replaced) task', () => {
    expect(liveOutcomeSuggestion(suggestion(), 't2')).toBeNull();
  });
  it('drops a suggestion without an outcome', () => {
    expect(liveOutcomeSuggestion(suggestion({ suggested_outcome: null }), 't1')).toBeNull();
  });
  it('is null without a task or a suggestion', () => {
    expect(liveOutcomeSuggestion(suggestion(), null)).toBeNull();
    expect(liveOutcomeSuggestion(null, 't1')).toBeNull();
  });
});
