/**
 * «الفريق والصلاحيات» — Team & Access (architecture cleanup D28/D29, 2026-09-29).
 *
 * ONE page for everything about who is on the team and what they can do, built
 * around the person. Each tab is the existing screen, unchanged underneath, so
 * every engine keeps its own table and rules:
 *   people    — accounts, access level, Sales jobs, Marketing roles, WhatsApp
 *               visibility per person (UsersPage)
 *   access    — access levels = `profiles` (pages + records the Sales app shows),
 *               with WhatsApp chat visibility as a section (it only ever edited
 *               the chats entry of a profile)
 *   jobs      — Sales jobs = `roles` domain='sales' (who work can be assigned to)
 *   marketing — the Marketing surfaces/capabilities matrix (`surface_access` +
 *               `role_capabilities`), the same editor the Marketing workspace uses
 * The engines are NOT fused — see CLAUDE.md "Marketing OS capabilities are DATA".
 */
import { Users, Shield, Briefcase, Megaphone, UsersRound } from 'lucide-react';
import SettingsTabsShell from './components/SettingsTabsShell';
import UsersPage from './UsersPage';
import ProfilesPage from './ProfilesPage';
import RolesPage from './RolesPage';
import WhatsAppPermissionsPage from './WhatsAppPermissionsPage';
import SettingsAccess from '@/pages/Marketing/components/SettingsAccess';
import { useAppStore } from '@/stores/appStore';
// The Marketing editor is styled by the Marketing design system, which is
// scoped under `.mos-root` — importing it here cannot restyle the Sales app.
import '@/pages/Marketing/mos.css';
import '@/pages/Marketing/styles/settings-engine.css';
import './components/mosEmbedLight.css';

function MarketingRolesTab() {
  const isAr = useAppStore((s) => s.language === 'ar');
  return (
    // `.mos-root` is a full-height flex shell in the workspace; here it is just
    // a styling scope inside the page.
    <div className="mos-root mos-embed-light rounded-2xl overflow-hidden" style={{ minHeight: 0, display: 'block' }}>
      {/* The page is admin-only (RequireAdmin) and the server re-checks
          `manage_roles` on every change, so the editor is always editable here. */}
      <SettingsAccess canManage isAr={isAr} embedded />
    </div>
  );
}

export default function TeamAccessPage() {
  return (
    <SettingsTabsShell
      titleAr="الفريق والصلاحيات"
      titleEn="Team & Access"
      descAr="كل ما يخص أعضاء الفريق: حساباتهم، وما يرونه في المبيعات، ووظائفهم، وأدوارهم في التسويق."
      descEn="Everything about the team: accounts, what they see in Sales, their jobs, and their Marketing roles."
      icon={UsersRound}
      color="#4F46E5"
      tabs={[
        { id: 'people', ar: 'الأشخاص', en: 'People', icon: Users, render: () => <UsersPage /> },
        {
          id: 'access', ar: 'مستويات الوصول', en: 'Access levels', icon: Shield,
          render: () => (
            <>
              <ProfilesPage />
              <WhatsAppPermissionsPage />
            </>
          ),
        },
        { id: 'jobs', ar: 'وظائف المبيعات', en: 'Sales jobs', icon: Briefcase, render: () => <RolesPage /> },
        { id: 'marketing', ar: 'أدوار التسويق', en: 'Marketing roles', icon: Megaphone, render: () => <MarketingRolesTab /> },
      ]}
    />
  );
}
