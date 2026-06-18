import type { ComponentType } from 'react';
import type { LucideProps } from 'lucide-react';
import { ClipboardList, Activity, BarChart3 } from 'lucide-react';

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
export type CustomPageId = 'sales_tasks' | 'sales_process' | 'sales_manager';

export interface CustomPageDef {
  id: CustomPageId;
  /** Router path the sidebar link points at and the route guard protects. */
  route: string;
  label_ar: string;
  label_en: string;
  icon: ComponentType<LucideProps>;
  default_access: 'all' | 'admin';
}

export const CUSTOM_PAGES: CustomPageDef[] = [
  {
    id: 'sales_tasks',
    route: '/sales/tasks',
    label_ar: 'مهام المبيعات',
    label_en: 'Sales Tasks',
    icon: ClipboardList,
    default_access: 'all',
  },
  {
    id: 'sales_process',
    route: '/sales/process',
    label_ar: 'استوديو المبيعات',
    label_en: 'Sales Process',
    icon: Activity,
    default_access: 'admin',
  },
  {
    id: 'sales_manager',
    route: '/sales/manager',
    label_ar: 'مدير المبيعات',
    label_en: 'Sales Manager',
    icon: BarChart3,
    default_access: 'admin',
  },
];

export function getCustomPage(pageId: string): CustomPageDef | undefined {
  return CUSTOM_PAGES.find((p) => p.id === pageId);
}
