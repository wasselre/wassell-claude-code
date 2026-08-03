import type { ComponentType } from 'react';
import type { LucideProps } from 'lucide-react';
import { ClipboardList, Activity, BarChart3, Layers, LineChart, UserCheck, ListChecks, Compass, Megaphone, Radar, Calculator, ClipboardList as ClipboardListIcon } from 'lucide-react';

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
  | 'financing_calculator';

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
    // The financing calculator reads customer salary, debt and card limits —
    // the most sensitive data the app holds. Opt-in per profile rather than
    // open by default, so a rep sees it only once someone decides they should.
    // (The `fin_*` RLS policies are the real gate; this controls the surface.)
    id: 'financing_calculator',
    route: '/financing',
    label_ar: 'حاسبة التمويل',
    label_en: 'Financing Calculator',
    icon: Calculator,
    default_access: 'admin',
  },
];

export function getCustomPage(pageId: string): CustomPageDef | undefined {
  return CUSTOM_PAGES.find((p) => p.id === pageId);
}
