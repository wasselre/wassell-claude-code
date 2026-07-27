import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { useAppStore } from '@/stores/appStore';
import { useIsAdmin } from '@/hooks/usePermission';
import {
  Hammer, Zap, LayoutDashboard, Languages,
  Shield, Briefcase, Users, ChevronRight,
  Settings, ScrollText, ListOrdered, MessageCircle, Webhook,
  Globe, LayoutTemplate, FileText, MapPin, Activity, Megaphone, Film, Bot,
} from 'lucide-react';

interface SettingsCard {
  titleAr: string;
  titleEn: string;
  descAr: string;
  descEn: string;
  icon: typeof Hammer;
  color: string;
  bg: string;
  route: string;
  adminOnly: boolean;
}

const CARDS: SettingsCard[] = [
  {
    titleAr: 'بناء النماذج',
    titleEn: 'Model Builder',
    descAr: 'إنشاء وتعديل النماذج والحقول والأقسام',
    descEn: 'Create and edit models, fields, and sections',
    icon: Hammer,
    color: '#B8734F',
    bg: '#B8734F14',
    route: '/builder',
    adminOnly: true,
  },
  {
    titleAr: 'ترتيب القائمة',
    titleEn: 'Menu Arrangement',
    descAr: 'ترتيب المجموعات والنماذج في القائمة الجانبية',
    descEn: 'Reorder groups and models in the sidebar',
    icon: ListOrdered,
    color: '#C09B5F',
    bg: '#C09B5F14',
    route: '/settings/menu',
    adminOnly: true,
  },
  {
    titleAr: 'سير العمل',
    titleEn: 'Workflows',
    descAr: 'أتمتة الإجراءات عند إنشاء أو تعديل السجلات',
    descEn: 'Automate actions on record create or update',
    icon: Zap,
    color: '#059669',
    bg: '#05966914',
    route: '/workflow',
    adminOnly: true,
  },
  {
    titleAr: 'سجل تنفيذ سير العمل',
    titleEn: 'Workflow Execution Logs',
    descAr: 'كل تفعيل لسير العمل مع شروط وإجراءات بتفاصيل كاملة',
    descEn: 'Every workflow firing with full condition + action trace',
    icon: ScrollText,
    color: '#0369A1',
    bg: '#0369A114',
    route: '/workflow/logs',
    adminOnly: true,
  },
  {
    titleAr: 'لوحات المعلومات',
    titleEn: 'Dashboards',
    descAr: 'إنشاء لوحات تحليلية ومشاركتها',
    descEn: 'Build analytics dashboards and share them',
    icon: LayoutDashboard,
    color: '#2563EB',
    bg: '#2563EB14',
    route: '/dashboards',
    adminOnly: true,
  },
  {
    titleAr: 'الترجمات',
    titleEn: 'Translations',
    descAr: 'إدارة الترجمات العربية والإنجليزية',
    descEn: 'Manage Arabic and English translations',
    icon: Languages,
    color: '#7C3AED',
    bg: '#7C3AED14',
    route: '/settings/translations',
    adminOnly: true,
  },
  {
    titleAr: 'الصلاحيات',
    titleEn: 'Profiles',
    descAr: 'تحديد صلاحيات الوصول لكل نموذج',
    descEn: 'Define access permissions per model',
    icon: Shield,
    color: '#D97706',
    bg: '#D9770614',
    route: '/settings/profiles',
    adminOnly: true,
  },
  {
    titleAr: 'الأدوار',
    titleEn: 'Roles',
    descAr: 'إدارة الأدوار وحقولها وأعضائها',
    descEn: 'Manage roles, their fields, and members',
    icon: Briefcase,
    color: '#0D9488',
    bg: '#0D948814',
    route: '/settings/roles',
    adminOnly: true,
  },
  {
    titleAr: 'المستخدمون',
    titleEn: 'Users',
    descAr: 'إضافة المستخدمين وتعيين صلاحياتهم وأدوارهم',
    descEn: 'Add users and assign profiles and roles',
    icon: Users,
    color: '#4F46E5',
    bg: '#4F46E514',
    route: '/settings/users',
    adminOnly: true,
  },
  {
    titleAr: 'نقاط الخطافات',
    titleEn: 'Webhooks',
    descAr: 'نقاط استقبال HTTP واردة للربط مع الأنظمة الخارجية وتشغيل سير العمل تلقائياً',
    descEn: 'Inbound HTTP endpoints for external systems to POST to — fire workflows on receipt',
    icon: Webhook,
    color: '#DB2777',
    bg: '#DB277714',
    route: '/settings/webhooks',
    adminOnly: true,
  },
  {
    titleAr: 'أرقام واتساب',
    titleEn: 'WhatsApp Numbers',
    descAr: 'الأرقام المتصلة عبر Haberchat والرقم الافتراضي للمحادثات',
    descEn: 'Connected Haberchat numbers and default for new chats',
    icon: MessageCircle,
    color: '#25D366',
    bg: '#25D36614',
    route: '/settings/whatsapp-numbers',
    adminOnly: true,
  },
  {
    titleAr: 'المساعد الذكي للواتساب',
    titleEn: 'WhatsApp AI Agent',
    descAr: 'متى يرد المساعد على العملاء وحدود الأمان',
    descEn: 'When the agent answers customers, and its safety limits',
    icon: Bot,
    color: '#B8734F',
    bg: '#B8734F14',
    route: '/settings/whatsapp-ai',
    adminOnly: true,
  },
  {
    titleAr: 'سجل المراجعة',
    titleEn: 'Audit Log',
    descAr: 'سجل تغييرات المستخدمين والملفات والأدوار',
    descEn: 'History of changes to users, profiles, and roles',
    icon: ScrollText,
    color: '#7C3AED',
    bg: '#7C3AED14',
    route: '/settings/audit-log',
    adminOnly: true,
  },
  {
    titleAr: 'إعدادات الموقع',
    titleEn: 'Website Settings',
    descAr: 'محتوى الموقع العام، معلومات التواصل، وتخصيص بطاقة الخريطة',
    descEn: 'Public site copy, contact info, and map card customization',
    icon: Globe,
    color: '#B8734F',
    bg: '#B8734F14',
    route: '/settings/website',
    adminOnly: true,
  },
  {
    titleAr: 'قوالب المستندات',
    titleEn: 'Document Templates',
    descAr: 'قوالب وصل الرسمية لإنشاء مستندات العملاء (الحجوزات، العروض…) كـ PDF مُوحّد',
    descEn: 'Official templates for generating branded customer PDFs (reservations, offers…)',
    icon: FileText,
    color: '#8E4E3A',
    bg: '#8E4E3A14',
    route: '/settings/document-templates',
    adminOnly: true,
  },
  {
    titleAr: 'تفاصيل المشاريع',
    titleEn: 'Project Details Pages',
    descAr: 'تخصيص صفحة التفاصيل لكل مشروع — صور، مميزات، معالم قريبة، مستشار، ولون مميّز',
    descEn: 'Per-project detail pages — images, features, nearby landmarks, agent, and accent color',
    icon: LayoutTemplate,
    color: '#C4754A',
    bg: '#C4754A14',
    route: '/settings/project-details',
    adminOnly: true,
  },
  {
    titleAr: 'عناصر الجغرافيا',
    titleEn: 'Geo Elements',
    descAr: 'إدارة معالم الرياض (طرق، مترو، مولات…) المستخدمة في تفضيلات الموقع وإيجاد المشاريع',
    descEn: 'Manage Riyadh anchors (roads, metro, malls…) used by location preferences + Project Finder',
    icon: MapPin,
    color: '#B8734F',
    bg: '#B8734F14',
    route: '/settings/geo-elements',
    adminOnly: true,
  },
  {
    titleAr: 'مراقبة التسويق',
    titleEn: 'Marketing Operations',
    descAr: 'صحة التجميع، المزوّدون، قائمة المهام، التكلفة، والتنبيهات التشغيلية لنظام ذكاء التسويق',
    descEn: 'Collection health, providers, queue, cost, and operational alerts for Marketing Intelligence',
    icon: Activity,
    color: '#8E4E3A',
    bg: '#8E4E3A14',
    route: '/settings/marketing-ops',
    adminOnly: true,
  },
  {
    titleAr: 'ذكاء المحتوى',
    titleEn: 'Content Intelligence',
    descAr: 'الوسائط الدائمة، التفريغ الصوتي، النص المرئي، الإثراء، وإسناد المشاريع لكل منشور تم جمعه',
    descEn: 'Permanent media, transcripts, visual text, enrichment, and project attribution per collected post',
    icon: Film,
    color: '#4A2C2A',
    bg: '#4A2C2A14',
    route: '/settings/content-intelligence',
    adminOnly: true,
  },
  {
    titleAr: 'المعلنون المدفوعون',
    titleEn: 'Paid Advertisers',
    descAr: 'اكتشاف وتأكيد معلني Meta للمنافسين — مقارنة المرشّحين، الأدلّة، والحماية من الأسواق العقارية',
    descEn: 'Discover & confirm competitor Meta advertisers — candidate comparison, evidence, and marketplace safety',
    icon: Megaphone,
    color: '#B8734F',
    bg: '#B8734F14',
    route: '/settings/marketing-advertisers',
    adminOnly: true,
  },
];

export default function SettingsPage() {
  const navigate = useNavigate();
  const { t } = useTranslation();
  const { language } = useAppStore();
  const isAdmin = useIsAdmin();
  const isAr = language === 'ar';

  const visibleCards = isAdmin ? CARDS : CARDS.filter((c) => !c.adminOnly);

  return (
    <div className="max-w-4xl">
      {/* Header */}
      <div className="flex items-center gap-3 mb-8">
        <div className="w-12 h-12 rounded-2xl bg-charcoal/5 flex items-center justify-center">
          <Settings size={24} className="text-charcoal/60" />
        </div>
        <div>
          <h1 className="text-2xl font-bold text-chocolate">
            {isAr ? 'الإعدادات' : 'Settings'}
          </h1>
          <p className="text-sm text-charcoal/40">
            {isAr ? 'إدارة النظام والنماذج والصلاحيات' : 'Manage system, models, and access control'}
          </p>
        </div>
      </div>

      {visibleCards.length === 0 && (
        <div className="card p-8 text-center text-charcoal/40">
          <Settings size={32} className="mx-auto mb-3 opacity-30" />
          <p className="text-sm">{t('access.settings_empty_for_role')}</p>
        </div>
      )}

      {/* Cards grid */}
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
        {visibleCards.map((card) => {
          const Icon = card.icon;
          return (
            <button
              key={card.route}
              onClick={() => navigate(card.route)}
              className="card p-5 flex items-start gap-4 text-start w-full hover:border-copper/30 transition-all group"
            >
              <div
                className="w-11 h-11 rounded-xl flex items-center justify-center shrink-0"
                style={{ backgroundColor: card.bg }}
              >
                <Icon size={20} style={{ color: card.color }} />
              </div>
              <div className="flex-1 min-w-0">
                <h3 className="font-bold text-charcoal group-hover:text-copper transition-colors">
                  {isAr ? card.titleAr : card.titleEn}
                </h3>
                <p className="text-xs text-charcoal/40 mt-0.5 leading-relaxed">
                  {isAr ? card.descAr : card.descEn}
                </p>
              </div>
              <ChevronRight
                size={16}
                className="text-charcoal/15 group-hover:text-copper/50 transition-colors mt-1 shrink-0 rtl:rotate-180"
              />
            </button>
          );
        })}
      </div>
    </div>
  );
}
