import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useAppStore } from '@/stores/appStore';
import type { AppRecord } from '@/types';
import { getFollowUpTypeConfig, getOutcome } from '@/lib/salesProcess';
import { readFollowupType } from '@/pages/Followups/lib/followupContext';
import {
  fetchReadyChatSuggestion,
  resolveChatSuggestion,
  subscribeChatSuggestions,
  type ChatOutcomeSuggestion,
} from '@/lib/chatSuggestions/client';
import { liveOutcomeSuggestion } from './aiSuggestions';

/**
 * The AI's suggested outcome for the client's current follow-up — ONE data
 * source for the chat, shared by the AI card's «النتائج» tab and the task bar's
 * chip. Called once in ChatDetail so the chat subscribes to
 * `chat_outcome_suggestions` once.
 *
 * Loads (and subscribes) only while the client has an open task: a suggestion
 * is only ever shown against THIS task (liveOutcomeSuggestion).
 */

export interface ChatOutcomeSuggestionState {
  /** The suggestion for THIS task, or null (none, stale, or no task). */
  live: ChatOutcomeSuggestion | null;
  /** The first load finished (successfully or not) — or there is nothing to load. */
  loaded: boolean;
  dismissing: boolean;
  /** «تجاهل» — record the rep's rejection (status 'dismissed'). */
  dismiss: () => Promise<void>;
}

export function useChatOutcomeSuggestion(clientId: string | null, task: AppRecord | null): ChatOutcomeSuggestionState {
  const addToast = useAppStore((s) => s.addToast);
  const { t } = useTranslation();
  const [suggestion, setSuggestion] = useState<ChatOutcomeSuggestion | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [dismissing, setDismissing] = useState(false);
  const enabled = !!clientId && !!task;
  // Bumped per client / task appearance, so a late answer for a previous
  // client can never land on this one.
  const seq = useRef(0);

  const reload = useCallback(() => {
    if (!clientId) return;
    const mine = seq.current;
    fetchReadyChatSuggestion(clientId)
      .then((s) => { if (mine === seq.current) setSuggestion(s); })
      .catch((e: Error) => {
        if (mine === seq.current) addToast(t('chats.ai.outcome_load_failed', { msg: e.message }), 'error');
      })
      .finally(() => { if (mine === seq.current) setLoaded(true); });
  }, [clientId, addToast, t]);

  useEffect(() => {
    seq.current += 1;
    setSuggestion(null);
    setLoaded(!enabled);
    if (!enabled || !clientId) return;
    reload();
    return subscribeChatSuggestions(clientId, reload);
  }, [clientId, enabled, reload]);

  const live = liveOutcomeSuggestion(suggestion, task?.id);

  const dismiss = useCallback(async () => {
    if (!live) return;
    setDismissing(true);
    try {
      await resolveChatSuggestion(live.id, 'dismissed');
      setSuggestion(null);
    } catch (e) {
      addToast(t('chats.ai.outcome_dismiss_failed', { msg: (e as Error).message }), 'error');
    } finally {
      setDismissing(false);
    }
  }, [live, addToast, t]);

  return { live, loaded, dismissing, dismiss };
}

/** The follow-up's type, in the UI language (falls back to the raw key). */
export function taskTypeLabel(task: AppRecord, isAr: boolean): string {
  const typeKey = readFollowupType(task.data as Record<string, unknown>);
  const cfg = getFollowUpTypeConfig(typeKey);
  return cfg ? (isAr ? cfg.label_ar : cfg.label_en) : (typeKey ?? '');
}

/** The suggested outcome's label, in the UI language (falls back to the raw value). */
export function outcomeLabel(s: ChatOutcomeSuggestion, isAr: boolean): string {
  const o = s.suggested_outcome ? getOutcome(s.suggested_outcome) : undefined;
  return o ? (isAr ? o.label_ar : o.label_en) : s.suggested_outcome ?? '';
}
