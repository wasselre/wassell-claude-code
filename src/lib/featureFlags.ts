/**
 * Lightweight runtime feature flags, read from the `feature_flags` table.
 *
 * Fail-OPEN by design: a flag is "on" unless an operator has explicitly set its
 * row to `enabled = false`. So a missing table / read error / absent row leaves
 * the feature ON (current behavior) — the row is purely a KILL SWITCH. Rollback
 * for a whole feature = flip its row to false (no schema change, no redeploy).
 *
 * Cached for the tab's lifetime (one read), so gating many components is cheap.
 */

import { useEffect, useState } from 'react';
import { supabase } from '@/lib/supabase';

/**
 * PROJECT_FINDER_ONLY (2026-06-28): the assistant direction was narrowed to ONE
 * focused capability — the deterministic Project Finder (find + rank the right
 * projects for a client, geography boundary-verified). The broad AI assistants —
 * the AI sales agent (`ai_chats`), the reel copywriter (`copywriter_chats`), and
 * the conversational match co-pilot (`matching_chats`, with its next-best-action /
 * lead-temperature / WhatsApp-draft / task-creation tools) — are UNWIRED: their
 * code and live data are kept intact for reference/rollback, but no UI surfaces
 * them and no nav reaches them. This is a STATIC build flag (not the DB kill
 * switch above); flip to `false` to restore every old surface at once.
 */
export const PROJECT_FINDER_ONLY = true;

/** System models whose custom AI-chat UI is retired under PROJECT_FINDER_ONLY.
 *  (The models + their records remain in the DB — this only hides the surfaces.) */
export const RETIRED_ASSISTANT_MODELS = ['ai_chats', 'copywriter_chats', 'matching_chats'] as const;

/**
 * ARCHIVED MODULES (2026-07-22): dormant product areas removed from the UI on
 * the user's request — the deck builder, the in-app Data Migration wizard
 * (superseded by the Claude-driven /migrate-project flow), the Image Studio,
 * and the Designs/creative suite models. Like the retired assistants above,
 * this is NON-DESTRUCTIVE: every model + record stays in the DB; nav hides the
 * entries and deep links land on the archived-module notice. Restore = remove
 * the name from this list (the page code itself was deleted — restore it from
 * git history, see commit that introduced this list).
 */
export const ARCHIVED_MODULE_MODELS = [
  'data_migration',
  'decks',
  'image_chats',
  'design_templates',
  'marketing_operations',
  'image_presets',
  'competitors',
  'reel_scripts',
  'prompt_snippets',
  // Stale models archived 2026-07-22 (second pass, user request). Note:
  // `targeted_projects` still RECEIVES writes from the «المشاريع - المستهدفة»
  // workflow + api/research-project — archiving only hides the UI surface.
  // `tasks` also hides the "Other Tasks" tab in MyTasksPage (gated on this list).
  //
  // `contacts` was UN-ARCHIVED 2026-08-10 — it is now a first-class top-level
  // section (a plain address book for people who are neither clients nor
  // advertisers) and is created from the WhatsApp inbox's "Add new contact"
  // button. See supabase/migrations/2026-08-10_contacts_section.sql.
  'targeted_projects',
  'tasks',
  // Market listings archived 2026-09-14 (user request: "retire the market
  // listing part of the app entirely — just archived for now"). The scraped
  // Aqar/Bayut/Dubizzle/PropertyFinder dataset (~318k rows in the frozen
  // `market_listings` table) stays in the DB untouched; every scraper app on
  // Fly was already suspended and no listing had been written since
  // 2026-08-30. What this entry hides — via `MARKET_LISTINGS_ARCHIVED` below —
  // is every surface built ON that dataset: the model's nav row + list/record
  // pages, the Market Automation ingest cockpit (/market-automation), the
  // Market Intelligence analytics (/market-intelligence — every tab uses the
  // listings as its denominator, so it is meaningless without them), the
  // "market listings" source in the Project Finder + follow-up suggestions,
  // the market-listing tab / send / contact-advertiser actions on client
  // options, the "preferred listing" client filter, and the listing-message
  // job rehydration. Existing client options that point at a listing keep
  // rendering from their saved `facts` snapshot (history is not lost).
  // The Fly worker lanes (clean-text / video-convert / listing-mirror / REGA)
  // stay deployed and simply idle on empty queues. Restore = remove this line.
  'market_listings',
] as const;

/**
 * True while the market-listings feature is archived (see the entry above).
 * Gates the SHARED surfaces that `isRetiredModel` alone cannot reach (custom
 * pages, Finder sources, client-option actions). Flip by editing the list —
 * there is deliberately no second switch.
 */
export const MARKET_LISTINGS_ARCHIVED = (ARCHIVED_MODULE_MODELS as readonly string[]).includes('market_listings');

/** True when `name` is a retired broad-assistant model AND the narrowing flag is on. */
export function isRetiredAssistantModel(name: string | null | undefined): boolean {
  return PROJECT_FINDER_ONLY && !!name && (RETIRED_ASSISTANT_MODELS as readonly string[]).includes(name);
}

/** True when `name` is hidden from the UI — retired assistant OR archived module. */
export function isRetiredModel(name: string | null | undefined): boolean {
  if (isRetiredAssistantModel(name)) return true;
  return !!name && (ARCHIVED_MODULE_MODELS as readonly string[]).includes(name);
}

/**
 * WORKSPACE-HIDDEN MODELS (2026-09-16, architecture cleanup Phase 1 — decisions
 * D10/D11/D20/D21/D23/D24/D41/D46/D47 in docs/architecture-cleanup-build-plan.md).
 *
 * Raw model nav rows hidden from the sidebar because their data is (or will be)
 * surfaced inside a workspace, a Client 360 tab, or a contextual drill-in —
 * NOT because the model is retired or archived.
 *
 * Deliberately WEAKER than `ARCHIVED_MODULE_MODELS`: this ONLY drops the sidebar
 * button. The `/model/<name>` route stays fully live (no archived-module
 * notice), the data still loads, and every workflow trigger / rollup / lookup /
 * document-template binding keeps working. Reversible with zero data change —
 * delete the name to restore its nav row.
 */
export const WORKSPACE_HIDDEN_MODEL_NAMES = [
  // D10 — lookup dimensions, surfaced in Projects & Inventory / contextually.
  'developers', 'marketers', 'project_officers', 'unit_updates',
  // D11 — units live in a project's Units tab + Project Finder.
  'units',
  // D20 — sales-lifecycle milestones, surfaced on Client 360. Models + triggers
  // + doc-template bindings (offer_prices, reservations) all stay.
  'offer_prices', 'reservations', 'financing', 'ownership_transfer', 'visits',
  // D21 — calls shown contextually on Client 360 (Hatif webhook writer stays).
  'phone_calls',
  // D23 — lives in Client 360's Options tab.
  'client_property_options',
  // D24 — reachable inside Chats as a Templates tab (powers every send flow).
  'chat_templates',
  // D41 — geography lookups feeding Project Finder.
  'countries', 'regions', 'cities', 'districts',
  // D46 — hidden now; activated later with the unanswered-requests feature (D38).
  'real_estate_offices',
  // D47 — data retained, nav off now (shares the market-listings archived state).
  'advertisers',
] as const;

/** True when a model's sidebar row is hidden because it's surfaced in a workspace. */
export function isWorkspaceHiddenModel(name: string | null | undefined): boolean {
  return !!name && (WORKSPACE_HIDDEN_MODEL_NAMES as readonly string[]).includes(name);
}

let cache: Promise<Record<string, boolean>> | null = null;

export function loadFeatureFlags(): Promise<Record<string, boolean>> {
  if (cache) return cache;
  cache = (async () => {
    if (!supabase) return {};
    const { data, error } = await supabase.from('feature_flags').select('key, enabled');
    if (error || !data) {
      // Fail-open: never let a flags read error hide a feature.
      if (error) console.warn('[featureFlags] read failed (failing open):', error.message);
      return {};
    }
    const out: Record<string, boolean> = {};
    for (const row of data as Array<{ key: string; enabled: boolean }>) {
      out[row.key] = row.enabled !== false;
    }
    return out;
  })();
  return cache;
}

/**
 * React hook: returns whether a feature flag is enabled. Defaults to ON
 * (`defaultOn = true`) until the flag row is read; only an explicit
 * `enabled = false` row turns it off.
 */
export function useFeatureFlag(key: string, defaultOn = true): boolean {
  const [enabled, setEnabled] = useState(defaultOn);
  useEffect(() => {
    let alive = true;
    loadFeatureFlags().then((flags) => {
      if (alive && key in flags) setEnabled(flags[key]!);
    });
    return () => {
      alive = false;
    };
  }, [key]);
  return enabled;
}
