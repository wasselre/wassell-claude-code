/**
 * Raw Administration — gated reach to the raw supporting model tables whose
 * sidebar rows were hidden by the workspace (developers, marketers, project
 * officers, units, unit updates). These open the generic record table/form,
 * so power users keep an escape hatch (spec: supporting models stay accessible
 * "contextually or through an advanced administration area"). Access is gated
 * by the `pi_raw_admin` custom-page id (managed in Settings → Profiles);
 * per-model RLS still applies on the target table.
 */
import { useNavigate } from 'react-router-dom';
import { ChevronRight, Building2, Megaphone, UserCog, Home, RefreshCw } from 'lucide-react';

const TABLES: { model: string; icon: typeof Building2; ar: string; en: string }[] = [
  { model: 'developers', icon: Building2, ar: 'المطورون', en: 'Developers' },
  { model: 'marketers', icon: Megaphone, ar: 'المسوّقون', en: 'Marketers' },
  { model: 'project_officers', icon: UserCog, ar: 'مسؤولو المشاريع', en: 'Project Officers' },
  { model: 'units', icon: Home, ar: 'الوحدات (جدول)', en: 'Units (table)' },
  { model: 'unit_updates', icon: RefreshCw, ar: 'تحديثات الوحدات', en: 'Unit Updates' },
];

export default function RawAdminSection({ isAr }: { isAr: boolean }) {
  const navigate = useNavigate();
  return (
    <div className="space-y-3">
      <p className="text-xs text-charcoal/50 max-w-2xl">
        {isAr
          ? 'الوصول المتقدم لجداول النماذج الداعمة الخام. تفتح الجدول العام مع تطبيق صلاحيات كل نموذج. للاستخدام الإداري فقط.'
          : 'Advanced access to the raw supporting model tables. Opens the generic table with each model’s own permissions applied. Administrative use only.'}
      </p>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        {TABLES.map((t) => {
          const Icon = t.icon;
          return (
            <button
              key={t.model}
              onClick={() => navigate(`/model/${t.model}`)}
              className="card p-4 flex items-center gap-3 text-start w-full hover:border-copper/30 transition-all group"
            >
              <div className="w-10 h-10 rounded-xl flex items-center justify-center shrink-0 bg-charcoal/5">
                <Icon size={18} className="text-charcoal/60" />
              </div>
              <span className="flex-1 font-medium text-charcoal group-hover:text-copper transition-colors">{isAr ? t.ar : t.en}</span>
              <ChevronRight size={16} className="text-charcoal/15 group-hover:text-copper/50 rtl:rotate-180" />
            </button>
          );
        })}
      </div>
    </div>
  );
}
