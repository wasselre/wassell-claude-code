// The guided-mission stage model for the Follow-up Workspace.
//
// A follow-up is worked as a short journey — Context → (Call | WhatsApp) → Qualify →
// Outcome — rather than one long form. Which stages a mission shows depends on the
// follow-up type: only the "qualifying" missions (first booking call, WhatsApp
// checkpoint, after-visit) gather preferences and match inventory; confirmation /
// offer / financing calls go straight Context → Call → Outcome.
//
// NOTE: the "Present" (Suggested Projects) stage is intentionally NOT here yet — it
// comes back after the rest of the flow is in place.

export type MissionStage = 'context' | 'call' | 'whatsapp' | 'qualify' | 'confirm';

/** Missions where the rep captures preferences + checks own-inventory before the outcome. */
const QUALIFYING_TYPES = new Set<string>([
  'appointment_booking_call',
  'whatsapp_follow_up',
  'follow_up_call_after_visit',
]);

/** The ordered stages for a mission, derived from its type + primary channel.
 *  Any non-WhatsApp channel (call / manual / undefined) uses the "call" contact step. */
export function missionStages(typeKey: string | null, channel: string | undefined): MissionStage[] {
  const contact: MissionStage = channel === 'whatsapp' ? 'whatsapp' : 'call';
  const stages: MissionStage[] = ['context', contact];
  if (typeKey && QUALIFYING_TYPES.has(typeKey)) stages.push('qualify');
  stages.push('confirm');
  return stages;
}

export const STAGE_LABELS: Record<MissionStage, { ar: string; en: string }> = {
  context: { ar: 'السياق', en: 'Context' },
  // The contact step is named for the ACT (reach the client), not the channel —
  // whether the rep calls or messages, the step is "التواصل". The channel-specific
  // buttons live inside the step (PrimaryAction).
  call: { ar: 'التواصل', en: 'Outreach' },
  whatsapp: { ar: 'التواصل', en: 'Outreach' },
  qualify: { ar: 'التأهيل', en: 'Qualify' },
  confirm: { ar: 'النتيجة', en: 'Outcome' },
};
