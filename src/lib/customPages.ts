import type { ComponentType } from 'react';
import type { LucideProps } from 'lucide-react';
import { ClipboardList, Activity, BarChart3, Layers, LineChart, UserCheck, ListChecks, Compass, Megaphone, Radar, Calculator, DatabaseZap, ClipboardList as ClipboardListIcon, MessageSquareText, Boxes, LayoutDashboard, Star, Building2, Users, RefreshCw, Wrench } from 'lucide-react';
import { MARKET_LISTINGS_ARCHIVED } from '@/lib/featureFlags';

/**
 * Registry of custom (non-model) app pages whose sidebar visibility + route
 * access is controlled per-profile.
 *
 * These are the Sales Operations surfaces — real React pages, not models —
 * so they can't ride the per-model `model_permissions` matrix the way
 * Clients / Projects / etc. do. Instead a profile carries a `page_access`
 * map of explicit per-page on/off overrides; when a page id is ABSENT from
 * that map, the page's `default_access` applies.
 *
 * `default_access`:
 *   - 'all'   → visible to every non-admin profile unless explicitly revoked.
 *   - 'admin' → hidden from non-admin profiles unless explicitly granted.
 *
 * Admin profiles always see every page regardless of `page_access`, mirroring
 * the `is_admin` bypass in `hasPermission`.
 *
 * The defaults below preserve the pre-2026-06-18 behavior EXACTLY: Sales
 * Tasks was open to everyone; Sales Process + Sales Manager were admin-only.
 * Adding a page here is the only place that needs to change to make a new
 * custom surface per-profile gateable (Sidebar + PermissionMatrix + the
 * route guard all read this list).
 */
export type CustomPageId =
  | 'project_finder'
  | 'my_clients'
  | 'my_tasks'
  | 'sales_tasks'
  | 'sales_process'
  | 'sales_manager'
  | 'sales_studio'
  | 'market_intelligence'
  | 'posts_content'
  | 'marketing_intelligence'
  | 'marketing_management'
  | 'financing_calculator'
  | 'market_automation'
  | 'competitor_watch'
  | 'follow_up_queue'
  // Projects & Inventory workspace (one visible sidebar row) + its sections.
  // The section ids are access-only (hidden_from_sidebar) — they gate the
  // section TABS inside the workspace and appear in Settings → Profiles so
  // access is managed by the existing per-profile system, not hardcoded by
  // role. Underlying model RLS + field permissions still apply beneath them.
  | 'projects_inventory'
  | 'pi_command_center'
  | 'pi_portfolio'
  | 'pi_market_registry'
  | 'pi_customer_demand'
  | 'pi_update_operations'
  | 'pi_raw_admin';

export interface CustomPageDef {
  id: CustomPageId;
  /** Router path the sidebar link points at and the route guard protects. */
  route: string;
  label_ar: string;
  label_en: string;
  icon: ComponentType<LucideProps>;
  default_access: 'all' | 'admin';
  /**
   * Hide the sidebar entry while keeping the page alive (2026-07-27, user
   * request: "for now just hide these from the side bar"). NON-DESTRUCTIVE —
   * the route, its guard, and the Settings → Profiles access toggle all stay
   * exactly as they were, so a direct URL still works for anyone who has
   * access. Restore = delete the flag from the entry.
   */
  hidden_from_sidebar?: boolean;
  /**
   * The page belongs to an ARCHIVED module (2026-09-14, market listings).
   * Stronger than `hidden_from_sidebar`: the nav row goes, the Settings →
   * Profiles access toggle goes, and the route renders the archived-module
   * notice instead of the page. Data + code stay; restore by clearing the
   * flag (driven by `MARKET_LISTINGS_ARCHIVED` in featureFlags.ts).
   */
  archived?: boolean;
}

export const CUSTOM_PAGES: CustomPageDef[] = [
  {
    id: 'project_finder',
    route: '/project-finder',
    label_ar: 'الباحث عن المشاريع',
    label_en: 'Project Finder',
    icon: Compass,
    // A standalone discovery tool — useful for the whole sales team. Visible to
    // every non-admin profile unless explicitly revoked in Settings → Profiles.
    default_access: 'all',
  },
  {
    id: 'my_clients',
    route: '/sales/my-clients',
    label_ar: 'عملائي',
    label_en: 'My Clients',
    icon: UserCheck,
    // Opt-in: hidden until an admin assigns it to a sales profile.
    default_access: 'admin',
  },
  {
    id: 'my_tasks',
    route: '/sales/my-tasks',
    label_ar: 'مهامي',
    label_en: 'My Tasks',
    icon: ListChecks,
    default_access: 'admin',
  },
  {
    id: 'follow_up_queue',
    route: '/sales/follow-up-queue',
    label_ar: 'متابعات مقترحة',
    label_en: 'Follow-up Queue',
    icon: MessageSquareText,
    // Claude-suggested WhatsApp follow-ups awaiting a human's read + confirm.
    // Opt-in: an admin grants it to the profiles that work the queue.
    default_access: 'admin',
  },
  {
    id: 'sales_tasks',
    route: '/sales/tasks',
    label_ar: 'مهام المبيعات',
    label_en: 'Sales Tasks',
    icon: ClipboardList,
    default_access: 'all',
    hidden_from_sidebar: true,
  },
  {
    id: 'sales_studio',
    route: '/sales/studio',
    label_ar: 'استوديو المبيعات 2.0',
    label_en: 'Sales Studio',
    icon: Layers,
    default_access: 'admin',
    hidden_from_sidebar: true,
  },
  {
    id: 'sales_process',
    route: '/sales/process',
    label_ar: 'خريطة سير العمل',
    label_en: 'Workflow Map',
    icon: Activity,
    default_access: 'admin',
    hidden_from_sidebar: true,
  },
  {
    id: 'sales_manager',
    route: '/sales/manager',
    label_ar: 'مدير المبيعات',
    label_en: 'Sales Manager',
    icon: BarChart3,
    default_access: 'admin',
    hidden_from_sidebar: true,
  },
  {
    id: 'market_intelligence',
    route: '/market-intelligence',
    label_ar: 'ذكاء السوق',
    label_en: 'Market Intelligence',
    icon: LineChart,
    default_access: 'admin',
    // Archived with the market-listings module (2026-09-14): every tab of this
    // page uses the scraped listings as its denominator, so it has nothing to
    // show without them.
    archived: MARKET_LISTINGS_ARCHIVED,
  },
  {
    id: 'posts_content',
    route: '/marketing/posts',
    label_ar: 'كاتب المحتوى',
    label_en: 'Content Writer',
    icon: Megaphone,
    // Opt-in: writes marketing copy against live project data and spends model
    // tokens, so an admin grants it per profile in Settings → Profiles.
    default_access: 'admin',
  },
  {
    // Competitor MARKETING intelligence — distinct from 'market_intelligence'
    // (listing/price data) and from 'posts_content' (writes OUR copy). This one
    // only OBSERVES competitors, hence Radar rather than another Megaphone.
    // Arabic keeps the first pair apart: ذكاء التسويق here vs ذكاء السوق there.
    id: 'marketing_management',
    // Points at the Marketing WORKSPACE, which lives outside the Sales shell.
    // Following this link leaves the Sales workspace entirely — that is the
    // intent, and the switcher in either header brings you back.
    route: '/m',
    // إدارة التسويق = OUR execution pipeline. Distinct from ذكاء التسويق below,
    // which watches competitors. Different verb, different data, different job.
    label_ar: 'مساحة التسويق',
    label_en: 'Marketing Workspace',
    icon: ClipboardListIcon,
    default_access: 'admin',
    // Reached via the workspace switcher at the top of the sidebar, not a nav
    // row — keeping the route + access rules but out of the sidebar list.
    hidden_from_sidebar: true,
  },
  {
    id: 'marketing_intelligence',
    route: '/marketing-intelligence',
    label_ar: 'ذكاء التسويق',
    label_en: 'Marketing Intelligence',
    icon: Radar,
    default_access: 'admin',
  },
  {
    // Competitor Watch — a NEW, from-scratch workspace (deliberately not built on
    // the old 'marketing_intelligence' page). v1 ships the Content Library; the
    // monitoring surfaces follow. Admin-only, same posture as the page it succeeds.
    id: 'competitor_watch',
    route: '/competitor-watch',
    label_ar: 'مرصد المنافسين',
    label_en: 'Competitor Watch',
    icon: Radar,
    default_access: 'admin',
  },
  {
    // Bayut-style flat-rate calculator (2026-08-20 rebuild) — holds no customer
    // data, just published bank rates. Kept opt-in per profile so enabling it
    // for a rep remains a deliberate decision.
    id: 'financing_calculator',
    route: '/financing',
    label_ar: 'حاسبة التمويل',
    label_en: 'Financing Calculator',
    icon: Calculator,
    default_access: 'admin',
    // Architecture cleanup Phase 1 (D22): hidden from the main nav — the
    // calculator is a contextual tool deep-linked from a client, not a
    // standalone destination. Route + per-profile access unchanged, so a
    // direct URL still works. Restore = delete this flag.
    hidden_from_sidebar: true,
  },
  {
    // The market-ingest cockpit: raw evidence, field decisions, data health, and the
    // publish gate for market_listings. An operational governance tool — visible to
    // authenticated users by default (the owner + operators aren't is_admin, so an
    // 'admin' default would hide it from them). Revoke per-profile in Settings →
    // Profiles for reps who shouldn't see it.
    id: 'market_automation',
    route: '/market-automation',
    label_ar: 'أتمتة إعلانات السوق',
    label_en: 'Market Automation',
    icon: DatabaseZap,
    default_access: 'all',
    // Archived with the market-listings module (2026-09-14) — the cockpit
    // governs an ingest pipeline that no longer runs.
    archived: MARKET_LISTINGS_ARCHIVED,
  },
  // ── Projects & Inventory workspace ───────────────────────────────────────
  // ONE visible sidebar row. Opens a workspace whose sections (Command Center,
  // Portfolio, Market Registry, Update Operations) are gated by the access-only
  // page ids below. All manageable per-profile in Settings → Profiles.
  {
    id: 'projects_inventory',
    route: '/projects-inventory',
    label_ar: 'المشاريع والمخزون',
    label_en: 'Projects & Inventory',
    icon: Boxes,
    // Broadly useful sales/ops workspace; revoke per profile if needed.
    default_access: 'all',
  },
  // Section access ids — access-only, no sidebar row. Each gates a workspace
  // section tab (RequirePageAccess also protects the section sub-route).
  {
    id: 'pi_command_center',
    route: '/projects-inventory/command-center',
    label_ar: 'مركز القيادة — المشاريع والمخزون',
    label_en: 'Command Center (Projects & Inventory)',
    icon: LayoutDashboard,
    default_access: 'all',
    hidden_from_sidebar: true,
  },
  {
    id: 'pi_portfolio',
    route: '/projects-inventory/portfolio',
    label_ar: 'المحفظة — المشاريع والمخزون',
    label_en: 'Portfolio (Projects & Inventory)',
    icon: Star,
    default_access: 'all',
    hidden_from_sidebar: true,
  },
  {
    id: 'pi_market_registry',
    route: '/projects-inventory/registry',
    label_ar: 'سجل السوق — المشاريع والمخزون',
    label_en: 'Market Registry (Projects & Inventory)',
    icon: Building2,
    default_access: 'all',
    hidden_from_sidebar: true,
  },
  {
    id: 'pi_customer_demand',
    route: '/projects-inventory/demand',
    label_ar: 'طلب العملاء — المشاريع والمخزون',
    label_en: 'Customer Demand (Projects & Inventory)',
    icon: Users,
    // Demand analytics land in a later phase; admin-gated until then.
    default_access: 'admin',
    hidden_from_sidebar: true,
  },
  {
    id: 'pi_update_operations',
    route: '/projects-inventory/updates',
    label_ar: 'عمليات التحديث — المشاريع والمخزون',
    label_en: 'Update Operations (Projects & Inventory)',
    icon: RefreshCw,
    // Provisional read-only shell; admin-gated.
    default_access: 'admin',
    hidden_from_sidebar: true,
  },
  {
    id: 'pi_raw_admin',
    route: '/projects-inventory/admin',
    label_ar: 'الإدارة المتقدمة — المشاريع والمخزون',
    label_en: 'Raw Administration (Projects & Inventory)',
    icon: Wrench,
    // Reach to the raw supporting model tables (developers/marketers/units…).
    default_access: 'admin',
    hidden_from_sidebar: true,
  },
];

export function getCustomPage(pageId: string): CustomPageDef | undefined {
  return CUSTOM_PAGES.find((p) => p.id === pageId);
}
