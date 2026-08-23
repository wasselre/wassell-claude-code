// Sales-process configuration TYPES.
//
// The config (config.ts) is the typed recipe that drives the Follow-up Workspace
// and Sales Process Studio: which outcomes a follow-up type allows, what fields
// each outcome requires, and what the workflow engine will then do (previewed to
// the human, executed by the engine — never a second write path). Stage/status
// values are the canonical live Arabic strings (arabicEnums.generated.ts);
// outcome values are the OUTCOME_CATALOG values (outcomes.ts).

import type { OutcomeValue } from './outcomes';
import type { ClientStageValue, ClientStatusValue } from './arabicEnums.generated';

/** The ten follow-up activity types the sales process supports. */
export type FollowUpTypeKey =
  | 'appointment_booking_call'
  | 'whatsapp_follow_up'
  | 'appointment_confirmation_call'
  | 'same_day_appointment_confirmation'
  | 'no_show_recovery_call'
  | 'follow_up_call_after_visit'
  | 'offer_follow_up'
  | 'reservation_payment_follow_up'
  | 'financing_follow_up'
  | 'ownership_transfer_follow_up';

export type PrimaryChannel = 'call' | 'whatsapp' | 'manual';

/** Context blocks the Workspace can render above the outcome panel, per type. */
export type ContextBlockId =
  | 'lead_source'
  | 'campaign'
  | 'preferred_project'
  | 'budget'
  | 'preferred_area'
  | 'preferred_unit_type'
  | 'previous_attempts'
  | 'latest_call_summary'
  | 'latest_whatsapp'
  | 'whatsapp_status'
  | 'appointment'
  | 'project_location'
  | 'appointment_status'
  | 'sales_rep'
  | 'previous_confirmations'
  | 'suggested_template'
  | 'preference_summary'
  | 'next_recommended'
  | 'visited_project'
  | 'visit_date'
  | 'visited_units'
  | 'customer_feedback'
  | 'objections'
  | 'offer_readiness'
  | 'missed_appointment_date'
  | 'reschedule_suggestion'
  | 'offer_details';

/**
 * Hard-required fields per outcome. `appointment_created` is special — it means
 * the outcome cannot be saved unless an Appointment record was created and linked
 * (correction #8: Appointment Booked is owned by Appointment creation).
 */
export interface OutcomeRequires {
  actual_datetime?: boolean;
  appointment_id?: boolean;
  appointment_created?: boolean;
  visit?: boolean;
  reschedule_contact_date?: boolean;
  new_appointment_datetime?: boolean;
  lost_reason?: boolean;
  outcome_notes?: boolean;
}

/**
 * What the client record will look like after the workflow runs. Shown to the
 * rep as a preview BEFORE save; the actual write happens in the bound workflow
 * (single source of truth for automation). Omitting both stage and status means
 * "no client move for this outcome" (e.g. appointment_booked is owned by W3).
 */
export interface ClientUpdatePreview {
  stage?: ClientStageValue;
  status?: ClientStatusValue;
  note_ar?: string;
  note_en?: string;
}

export type NextActionKind =
  | 'create_followup'
  | 'book_appointment'
  | 'schedule_recontact'
  | 'create_offer'
  | 'none';

/** Preview of the next task the workflow will create (human-facing). */
export interface NextActionPreview {
  kind: NextActionKind;
  create_followup_type?: FollowUpTypeKey;
  /** Default delay (days) from now/actual_datetime for the next task. */
  delay_days?: number;
  /** Follow-up field whose value becomes the next task's scheduled_datetime. */
  use_field?: 'reschedule_contact_date' | 'new_appointment_datetime';
  note_ar?: string;
  note_en?: string;
}

export interface FollowUpOutcomeConfig {
  /** The call_result value stored on the follow-up. Must be in OUTCOME_CATALOG. */
  value: OutcomeValue;
  /** Fields the rep MUST fill before this outcome can be saved (hard block). */
  requires?: OutcomeRequires;
  // NOTE: there is deliberately no `warn` list any more (2026-08-10). Missing
  // evidence — a call OR a WhatsApp conversation — no longer warns at
  // completion. Call evidence links itself and the rep cannot attach one, and
  // the user asked for the WhatsApp twin to go the same way. An outcome either
  // hard-requires a field or says nothing about it.
  /** Preview of the client stage/status the bound workflow will set. */
  client_update_preview?: ClientUpdatePreview;
  /** Preview of the next task the bound workflow will create. */
  next_action_preview?: NextActionPreview;
  /** Terminal = closes the follow-up with no further action (lost / done). */
  is_terminal?: boolean;
}

export interface ScriptConfig {
  ar?: string[];
  en?: string[];
}

export interface FollowUpTypeConfig {
  type: FollowUpTypeKey;
  label_ar: string;
  label_en: string;
  objective_ar: string;
  objective_en: string;
  primary_channel: PrimaryChannel;
  /** The lifecycle stage this activity belongs to (Arabic stage value). */
  stage?: ClientStageValue;
  context_blocks: ContextBlockId[];
  /** Client field slugs to surface in the compact Preferences summary. */
  preference_summary_fields: string[];
  /** Outcomes (with required-fields + previews) valid for THIS type only. */
  allowed_outcomes: FollowUpOutcomeConfig[];
  script?: ScriptConfig;
}

export interface SalesStageConfig {
  value: ClientStageValue;
  label_ar: string;
  label_en: string;
  order: number;
  color?: string;
  /** Activities (follow-up types) that belong to this stage. */
  followup_types: FollowUpTypeKey[];
}

export interface SalesProcessConfig {
  stages: SalesStageConfig[];
  followup_types: FollowUpTypeConfig[];
}

/**
 * Sales Process Studio ↔ Workflow binding metadata (stored on workflow.metadata).
 * Used to resolve which workflow implements a given stage/activity/outcome and
 * to detect drift (a Studio-managed workflow edited by hand in the Builder).
 */
export interface SalesWorkflowBinding {
  sales_stage?: string;
  activity_type?: FollowUpTypeKey | string;
  outcome?: OutcomeValue | string;
}
