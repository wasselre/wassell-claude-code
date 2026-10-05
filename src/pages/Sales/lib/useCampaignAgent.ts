import { useEffect, useState } from 'react';
import { supabase } from '@/lib/supabase';

/**
 * The old-lead campaign's sales agent (public.users id), or null while the
 * campaign is off.
 *
 * `sales_call_campaign_settings` is a bespoke singleton table (not an app
 * model), read directly the same way useAiNotifications reads its table. The
 * agent approves the campaign's morning messages, so the Work Queue's AI tab
 * opens for them as it does for admins (RLS on ai_actions agrees).
 */
export function useCampaignAgent(): string | null {
  const [agent, setAgent] = useState<string | null>(null);

  useEffect(() => {
    if (!supabase) return;
    let cancelled = false;
    void supabase
      .from('sales_call_campaign_settings')
      .select('enabled, agent_user_id')
      .eq('id', 1)
      .maybeSingle()
      .then(({ data, error }) => {
        if (cancelled) return;
        if (error) {
          // Loud: without this the agent silently loses the approvals tab.
          console.error('[useCampaignAgent] could not read the campaign settings:', error.message);
          return;
        }
        const row = data as { enabled?: boolean; agent_user_id?: string | null } | null;
        setAgent(row?.enabled ? row.agent_user_id ?? null : null);
      });
    return () => { cancelled = true; };
  }, []);

  return agent;
}
