import { NavLink, useNavigate, useLocation } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import {
  Home,
  Zap,
  Plus,
  ChevronDown,
  Users,
  PhoneCall,
  Building2,
  Target,
  Star,
  FileSearch,
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
  Settings,
} from 'lucide-react';
import { useState } from 'react';
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
};

export function getIconComponent(name: string): ComponentType<LucideProps> {
  return ICON_MAP[name] ?? Database;
}

export default function Sidebar() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const location = useLocation();
  const { models, groups, language, currentUserId, users, profiles } = useAppStore();
  const currentUser = users.find((u) => u.id === currentUserId);
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});
  const isAr = language === 'ar';

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
    <aside className="sidebar">
      <div className="flex flex-col h-full">
        {/* Logo */}
        <div className="p-6 pb-4">
          <div className="flex items-center gap-3">
            <img
              src="/assets/logo-icon.png"
              alt="Wassel"
              className="w-12 h-12 object-contain"
            />
            <div>
              <div className="text-base font-bold text-chocolate">
                {isAr ? 'وصل العقارية' : 'Wassel Real Estate'}
              </div>
            </div>
          </div>
        </div>

        {/* Navigation */}
        <nav className="flex-1 px-3 space-y-0.5 overflow-y-auto">
          {/* Home */}
          <NavLink
            to="/"
            end
            className={({ isActive }) => `nav-item ${isActive ? 'active' : ''}`}
          >
            <Home size={20} />
            <span>{t('nav.home')}</span>
          </NavLink>

          {/* Divider label */}
          <div className="pt-5 pb-2 px-3">
            <span className="text-[0.6875rem] font-bold text-charcoal/30 uppercase tracking-widest">
              {isAr ? 'لوحة المعلومات' : 'Dashboard'}
            </span>
          </div>

          {/* Ungrouped models */}
          {ungroupedModels.map((model) => {
            const Icon = getIconComponent(model.icon);
            return (
              <NavLink
                key={model.id}
                to={`/model/${model.name}`}
                className={({ isActive }) => `nav-item ${isActive ? 'active' : ''}`}
              >
                <div
                  className="w-8 h-8 rounded-lg flex items-center justify-center shrink-0"
                  style={{ backgroundColor: `${model.color}12` }}
                >
                  <Icon size={16} style={{ color: model.color }} />
                </div>
                <span>{isAr ? model.label_ar : model.label_en}</span>
              </NavLink>
            );
          })}

          {/* Grouped models */}
          {groupedModels.map(({ group, models: gModels }) => (
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
          <div className="pt-5 pb-2 px-3">
            <span className="text-[0.6875rem] font-bold text-charcoal/30 uppercase tracking-widest">
              {isAr ? 'النظام' : 'System'}
            </span>
          </div>

          {(() => {
            const p = location.pathname;
            const isSettingsActive = p.startsWith('/settings') || p.startsWith('/builder') || p.startsWith('/workflow') || p.startsWith('/dashboards');
            return (
              <NavLink
                to="/settings"
                className={`nav-item ${isSettingsActive ? 'active' : ''}`}
              >
                <div className="w-8 h-8 rounded-lg flex items-center justify-center shrink-0 bg-charcoal/5">
                  <Settings size={16} className="text-charcoal/60" />
                </div>
                <span>{isAr ? 'الإعدادات' : 'Settings'}</span>
              </NavLink>
            );
          })()}
        </nav>

        {/* Bottom user area */}
        <div className="p-4 border-t border-sand/20">
          <button
            onClick={() => navigate('/builder')}
            className="w-full flex items-center justify-center gap-2 px-4 py-2.5 rounded-xl bg-copper text-white hover:bg-terracotta transition-colors text-sm font-bold"
          >
            <Plus size={16} />
            {t('nav.new_model')}
          </button>
          <div className="flex items-center gap-3 mt-3 px-2">
            <div className="w-8 h-8 rounded-full bg-copper/10 flex items-center justify-center text-xs font-bold text-copper">
              {currentUser ? (isAr ? currentUser.name_ar : currentUser.name_en).charAt(0) : 'A'}
            </div>
            <div className="text-xs text-charcoal/40 truncate">{currentUser?.email ?? 'admin@wassel.sa'}</div>
          </div>
        </div>
      </div>
    </aside>
  );
}
