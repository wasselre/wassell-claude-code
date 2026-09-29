import type { ChatOutcomeSuggestion } from '@/lib/chatSuggestions/client';

/**
 * «اقتراحات الذكاء الاصطناعي» — the chat's AI card, with one tab per kind of
 * suggestion: the client's preferences (places / specs read from the chat and
 * the calls) and the suggested outcome of the current follow-up. PURE.
 */

export type AiTab = 'prefs' | 'outcome';

export const AI_TABS: readonly AiTab[] = ['prefs', 'outcome'];

/**
 * The tab the card opens on: the first tab that has something to act on, in
 * tab order; the preferences tab when neither has anything.
 */
export function defaultAiTab(prefCount: number, outcomeCount: number): AiTab {
  if (prefCount > 0) return 'prefs';
  if (outcomeCount > 0) return 'outcome';
  return 'prefs';
}

/**
 * The suggestion to show, or null. A proposal is only live while it targets
 * THIS task: if the task was completed or replaced since the AI read the chat,
 * the proposal is stale. A proposal without an outcome is not shown either.
 */
export function liveOutcomeSuggestion(
  suggestion: ChatOutcomeSuggestion | null,
  taskId: string | null | undefined,
): ChatOutcomeSuggestion | null {
  if (!suggestion || !taskId) return null;
  return suggestion.followup_id === taskId && suggestion.suggested_outcome ? suggestion : null;
}
