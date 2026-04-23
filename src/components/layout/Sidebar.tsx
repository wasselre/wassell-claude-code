import { NavLink, useNavigate, useLocation } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import {
  Home,
  Zap,
  Plus,
  X,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Users,
  PhoneCall,
  Building2,
  Target,
  Star,
  FileSearch,
  FileText,
  Database,
  Globe,
  Folder,
  Briefcase,
  Calendar,
  Mail,
  Truck,
  MapPin,
  Clipboard,
  Tag,
  Layers,
  Grid3X3,
  Box,
  Package,
  Activity,
  Bell,
  Flag,
  Heart,
  Award,
  Shield,
  Presentation,
  Settings,
  MessageCircle,
} from 'lucide-react';
import { useEffect, useState } from 'react';
import { useAppStore } from '@/stores/appStore';
import { hasPermission } from '@/lib/permissions';
import type { ComponentType } from 'react';
import type { LucideProps } from 'lucide-react';

const ICON_MAP: Record<string, ComponentType<LucideProps>> = {
  users: Users,
  'phone-call': PhoneCall,
  'building-2': Building2,
  target: Target,
  star: Star,
  'file-search': FileSearch,
  'file-text': FileText,
  presentation: Presentation,
  database: Database,
  globe: Globe,
  folder: Folder,
  briefcase: Briefcase,
  calendar: Calendar,
  mail: Mail,
  truck: Truck,
  home: Home,
  'map-pin': MapPin,
  clipboard: Clipboard,
  tag: Tag,
  layers: Layers,
  grid: Grid3X3,
  box: Box,
  package: Package,
  activity: Activity,
  zap: Zap,
  bell: Bell,
  flag: Flag,
  heart: Heart,
  award: Award,
  shield: Shield,
  'message-circle': MessageCircle,
};

export function getIconComponent(name: string): ComponentType<LucideProps> {
  return ICON_MAP[name] ?? Database;
}

interface SidebarProps {
  mobileOpen?: boolean;
  onMobileClose?: () => void;
}

export default function Sidebar({ mobileOpen = false, onMobileClose }: SidebarProps) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const location = useLocation();
  const { models, groups, language, currentUserId, users, profiles } = useAppStore();
  const currentUser = users.find((u) => u.id === currentUserId);
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});
  const [railCollapsed, setRailCollapsed] = useState<boolean>(() => {
    if (typeof window === 'undefined') return false;
    return localStorage.getItem('sidebar_collapsed') === 'true';
  });
  const isAr = language === 'ar';

  // Sync the rail-collapsed state to <html> so CSS can resize the sidebar
  // and main-content margin together, and persist across reloads.
  useEffect(() => {
    document.documentElement.classList.toggle('sidebar-collapsed', railCollapsed);
    localStorage.setItem('sidebar_collapsed', String(railCollapsed));
  }, [railCollapsed]);

  const toggleRail = () => setRailCollapsed((v) => !v);
  // When expanded, the arrow points toward the edge the sidebar is attached to
  // (collapse direction). When collapsed, it points outward (expand direction).
  const RailArrow = (() => {
    const towardEdge = isAr ? ChevronRight : ChevronLeft;
    const awayFromEdge = isAr ? ChevronLeft : ChevronRight;
    return railCollapsed ? awayFromEdge : towardEdge;
  })();

  // Filter nav by `view` permission. hasPermission returns true when
  // currentUserId is null (pre-init fallback) so nothing flickers.
  const canView = (modelId: string) => hasPermission(currentUserId, users, profiles, modelId, 'view');

  // Helpers to sort by the optional `order` field, with a stable fallback
  // to the array position for records that haven't been assigned an order yet.
  const byModelOrder = (a: typeof models[number], b: typeof models[number]) => {
    const ao = typeof a.order === 'number' ? a.order : models.indexOf(a);
    const bo = typeof b.order === 'number' ? b.order : models.indexOf(b);
    return ao - bo;
  };
  const byGroupOrder = (a: typeof groups[number], b: typeof groups[number]) => {
    const ao = typeof a.order === 'number' ? a.order : groups.indexOf(a);
    const bo = typeof b.order === 'number' ? b.order : groups.indexOf(b);
    return ao - bo;
  };

  const ungroupedModels = models
    .filter((m) => !m.group_id && canView(m.id))
    .slice()
    .sort(byModelOrder);
  const groupedModels = groups
    .slice()
    .sort(byGroupOrder)
    .map((g) => ({
      group: g,
      models: models
        .filter((m) => m.group_id === g.id && canView(m.id))
        .slice()
        .sort(byModelOrder),
    }))
    .filter((g) => g.models.length > 0);

  const toggleGroup = (groupId: string) => {
    setCollapsed((prev) => ({ ...prev, [groupId]: !prev[groupId] }));
  };

  return (
    <aside className={`sidebar ${mobileOpen ? 'is-open' : ''}`}>
      <div className="flex flex-col h-full">
        {/* Logo + rail toggle */}
        <div
          className={`pt-6 pb-4 flex items-center gap-3 ${
            railCollapsed ? 'px-3 flex-col' : 'px-6 justify-between'
          }`}
        >
          <div className={`flex items-center gap-3 ${railCollapsed ? 'justify-center' : ''}`}>
            <img
              src="/assets/logo-castle.png"
              alt="Wassel"
              className={`${railCollapsed ? 'w-10 h-10' : 'w-12 h-12'} object-contain`}
            />
            {!railCollapsed && (
              <div>
                <div className="text-base font-bold text-chocolate">
                  {isAr ? 'وصل العقارية' : 'Wassel Real Estate'}
                </div>
              </div>
            )}
          </div>
          <div className="flex items-center gap-1">
            {onMobileClose && !railCollapsed && (
              <button
                onClick={onMobileClose}
                className="md:hidden p-1.5 rounded-lg hover:bg-cream text-charcoal/40 hover:text-charcoal transition-colors"
                aria-label={isAr ? 'إغلاق القائمة' : 'Close menu'}
              >
                <X size={18} />
              </button>
            )}
            <button
              onClick={toggleRail}
              className="hidden md:flex p-1.5 rounded-lg hover:bg-cream text-charcoal/40 hover:text-charcoal transition-colors"
              aria-label={
                isAr
                  ? railCollapsed
                    ? 'توسيع القائمة'
                    : 'طي القائمة'
                  : railCollapsed
                  ? 'Expand menu'
                  : 'Collapse menu'
              }
              title={
                isAr
                  ? railCollapsed
                    ? 'توسيع القائمة'
                    : 'طي القائمة'
                  : railCollapsed
                  ? 'Expand menu'
                  : 'Collapse menu'
              }
            >
              <RailArrow size={18} />
            </button>
          </div>
        </div>

        {/* Navigation */}
        <nav className="flex-1 px-3 space-y-0.5 overflow-y-auto">
          {/* Home */}
          <NavLink
            to="/"
            end
            className={({ isActive }) => `nav-item ${isActive ? 'active' : ''}`}
            title={railCollapsed ? t('nav.home') : undefined}
          >
            <Home size={20} />
            {!railCollapsed && <span>{t('nav.home')}</span>}
          </NavLink>

          {/* Presentations (catalog of decks fired from the app) */}
          <NavLink
            to="/presentations"
            className={({ isActive }) => `nav-item ${isActive ? 'active' : ''}`}
            title={railCollapsed ? t('nav.presentations') : undefined}
          >
            <Presentation size={20} />
            {!railCollapsed && <span>{t('nav.presentations')}</span>}
          </NavLink>

          {/* Divider label */}
          {!railCollapsed && (
            <div className="pt-5 pb-2 px-3">
              <span className="text-[0.6875rem] font-bold text-charcoal/30 uppercase tracking-widest">
                {isAr ? 'لوحة المعلومات' : 'Dashboard'}
              </span>
            </div>
          )}

          {/* Ungrouped models */}
          {ungroupedModels.map((model) => {
            const Icon = getIconComponent(model.icon);
            const label = isAr ? model.label_ar : model.label_en;
            return (
              <NavLink
                key={model.id}
                to={`/model/${model.name}`}
                className={({ isActive }) => `nav-item ${isActive ? 'active' : ''}`}
                title={railCollapsed ? label : undefined}
              >
                <div
                  className="w-8 h-8 rounded-lg flex items-center justify-center shrink-0"
                  style={{ backgroundColor: `${model.color}12` }}
                >
                  <Icon size={16} style={{ color: model.color }} />
                </div>
                {!railCollapsed && <span>{label}</span>}
              </NavLink>
            );
          })}

          {/* Grouped models — flat list of icons when rail is collapsed */}
          {railCollapsed
            ? groupedModels.flatMap(({ models: gModels }) =>
                gModels.map((model) => {
                  const Icon = getIconComponent(model.icon);
                  const label = isAr ? model.label_ar : model.label_en;
                  return (
                    <NavLink
                      key={model.id}
                      to={`/model/${model.name}`}
                      className={({ isActive }) => `nav-item ${isActive ? 'active' : ''}`}
                      title={label}
                    >
                      <div
                        className="w-8 h-8 rounded-lg flex items-center justify-center shrink-0"
                        style={{ backgroundColor: `${model.color}12` }}
                      >
                        <Icon size={16} style={{ color: model.color }} />
                      </div>
                    </NavLink>
                  );
                })
              )
            : groupedModels.map(({ group, models: gModels }) => (
                <div key={group.id}>
                  <button
                    onClick={() => toggleGroup(group.id)}
                    className="nav-item w-full justify-between mt-1"
                  >
                    <div className="flex items-center gap-3">
                      <div className="w-8 h-8 rounded-lg flex items-center justify-center shrink-0 bg-sand/20">
                        <Folder size={16} className="text-charcoal/40" />
                      </div>
                      <span>{isAr ? group.label_ar : group.label_en}</span>
                    </div>
                    <ChevronDown
                      size={14}
                      className={`transition-transform text-charcoal/30 ${collapsed[group.id] ? '-rotate-90 rtl:rotate-90' : ''}`}
                    />
                  </button>
                  {!collapsed[group.id] && (
                    <div className="ms-5 ps-3 border-s border-sand/20 space-y-0.5 mt-0.5">
                      {gModels.map((model) => {
                        const Icon = getIconComponent(model.icon);
                        return (
                          <NavLink
                            key={model.id}
                            to={`/model/${model.name}`}
                            className={({ isActive }) => `nav-item text-sm ${isActive ? 'active' : ''}`}
                          >
                            <div
                              className="w-7 h-7 rounded-md flex items-center justify-center shrink-0"
                              style={{ backgroundColor: `${model.color}12` }}
                            >
                              <Icon size={14} style={{ color: model.color }} />
                            </div>
                            <span>{isAr ? model.label_ar : model.label_en}</span>
                          </NavLink>
                        );
                      })}
                    </div>
                  )}
                </div>
              ))}

          {/* Settings */}
          {!railCollapsed && (
            <div className="pt-5 pb-2 px-3">
              <span className="text-[0.6875rem] font-bold text-charcoal/30 uppercase tracking-widest">
                {isAr ? 'النظام' : 'System'}
              </span>
            </div>
          )}

          {(() => {
            const p = location.pathname;
            const isSettingsActive = p.startsWith('/settings') || p.startsWith('/builder') || p.startsWith('/workflow') || p.startsWith('/dashboards');
            const settingsLabel = isAr ? 'الإعدادات' : 'Settings';
            return (
              <NavLink
                to="/settings"
                className={`nav-item ${isSettingsActive ? 'active' : ''}`}
                title={railCollapsed ? settingsLabel : undefined}
              >
                <div className="w-8 h-8 rounded-lg flex items-center justify-center shrink-0 bg-charcoal/5">
                  <Settings size={16} className="text-charcoal/60" />
                </div>
                {!railCollapsed && <span>{settingsLabel}</span>}
              </NavLink>
            );
          })()}
        </nav>

        {/* Bottom user area */}
        <div className={`border-t border-sand/20 ${railCollapsed ? 'p-2' : 'p-4'}`}>
          <button
            onClick={() => navigate('/builder')}
            className={`w-full flex items-center justify-center gap-2 rounded-xl bg-copper text-white hover:bg-terracotta transition-colors text-sm font-bold ${
              railCollapsed ? 'px-2 py-2' : 'px-4 py-2.5'
            }`}
            title={railCollapsed ? t('nav.new_model') : undefined}
            aria-label={railCollapsed ? t('nav.new_model') : undefined}
          >
            <Plus size={16} />
            {!railCollapsed && t('nav.new_model')}
          </button>
          <div className={`flex items-center gap-3 mt-3 ${railCollapsed ? 'justify-center' : 'px-2'}`}>
            <div
              className="w-8 h-8 rounded-full bg-copper/10 flex items-center justify-center text-xs font-bold text-copper shrink-0"
              title={railCollapsed ? currentUser?.email ?? 'admin@wassel.sa' : undefined}
            >
              {currentUser ? (isAr ? currentUser.name_ar : currentUser.name_en).charAt(0) : 'A'}
            </div>
            {!railCollapsed && (
              <div className="text-xs text-charcoal/40 truncate">{currentUser?.email ?? 'admin@wassel.sa'}</div>
            )}
          </div>
        </div>
      </div>
    </aside>
  );
}
