import { useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { useAppStore } from '@/stores/appStore';
import { getIconComponent } from '@/components/layout/Sidebar';
import { Users, PhoneCall, Building2, Zap, Plus, Hammer, Calendar, TrendingUp } from 'lucide-react';
import Button from '@/components/ui/Button';
import Badge from '@/components/ui/Badge';

export default function HomePage() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const { models, records, workflows, language } = useAppStore();
  const isAr = language === 'ar';

  const clientsModel = models.find((m) => m.name === 'clients');
  const clientCount = clientsModel ? (records[clientsModel.id]?.length ?? 0) : 0;

  const followupsModel = models.find((m) => m.name === 'followups');
  const allFollowups = followupsModel ? (records[followupsModel.id] ?? []) : [];

  const today = new Date().toISOString().slice(0, 10);
  const todaysFollowups = allFollowups.filter((r) => {
    const d = r.data.followup_date;
    return typeof d === 'string' && d.startsWith(today);
  });

  const upcomingFollowups = useMemo(() => {
    const now = new Date();
    const weekLater = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000);
    return allFollowups
      .filter((r) => {
        const d = r.data.next_followup_date;
        if (typeof d !== 'string') return false;
        const date = new Date(d);
        return date >= now && date <= weekLater;
      })
      .sort((a, b) => String(a.data.next_followup_date ?? '').localeCompare(String(b.data.next_followup_date ?? '')))
      .slice(0, 5);
  }, [allFollowups]);

  const projectModels = models.filter((m) =>
    ['all_projects', 'targeted_projects', 'our_projects'].includes(m.name),
  );
  const projectCount = projectModels.reduce(
    (sum, m) => sum + (records[m.id]?.length ?? 0),
    0,
  );

  const recentRecords = useMemo(() => {
    return Object.values(records)
      .flat()
      .sort((a, b) => b.updated_at.localeCompare(a.updated_at))
      .slice(0, 5);
  }, [records]);

  const stats = [
    { label: t('home.total_clients'), value: clientCount, icon: Users, color: '#B8734F', bg: '#B8734F' },
    { label: t('home.todays_followups'), value: todaysFollowups.length, icon: PhoneCall, color: '#C09B5F', bg: '#C09B5F' },
    { label: t('home.active_projects'), value: projectCount, icon: Building2, color: '#8E4E3A', bg: '#8E4E3A' },
    { label: t('home.total_workflows'), value: workflows.length, icon: Zap, color: '#4A4E54', bg: '#4A4E54' },
  ];

  return (
    <div className="max-w-6xl">
      {/* Welcome header */}
      <div className="mb-10">
        <div className="flex items-center gap-3 mb-2">
          <div className="w-10 h-10 rounded-xl bg-copper/10 flex items-center justify-center">
            <TrendingUp size={20} className="text-copper" />
          </div>
          <div>
            <h1 className="text-2xl font-bold text-chocolate">{t('home.welcome')}</h1>
            <p className="text-sm text-charcoal/40">
              {isAr ? 'نظرة شاملة على أداء المنصة وحركة البيانات.' : 'Overview of platform performance and data activity.'}
            </p>
          </div>
        </div>
      </div>

      {/* Stats */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-5 mb-10">
        {stats.map((stat) => {
          const Icon = stat.icon;
          return (
            <div key={stat.label} className="stat-card">
              <div
                className="w-14 h-14 rounded-2xl flex items-center justify-center shrink-0"
                style={{ backgroundColor: `${stat.bg}10` }}
              >
                <Icon size={26} style={{ color: stat.color }} strokeWidth={1.5} />
              </div>
              <div>
                <div className="text-3xl font-bold text-chocolate">{stat.value}</div>
                <div className="text-sm text-charcoal/40 mt-0.5">{stat.label}</div>
              </div>
            </div>
          );
        })}
      </div>

      {/* Quick Actions */}
      <div className="flex gap-3 mb-10">
        <Button onClick={() => navigate('/model/clients/new')}>
          <Plus size={16} />
          {t('home.new_client')}
        </Button>
        <Button variant="secondary" onClick={() => navigate('/model/followups/new')}>
          <Plus size={16} />
          {t('home.new_followup')}
        </Button>
        <Button variant="ghost" onClick={() => navigate('/builder')}>
          <Hammer size={16} />
          {t('home.open_builder')}
        </Button>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* Recent Records */}
        <div className="card p-6">
          <h2 className="font-bold text-chocolate text-lg mb-5">{t('home.recent_records')}</h2>
          {recentRecords.length === 0 ? (
            <div className="text-center py-8">
              <p className="text-sm text-charcoal/30">{t('records.no_records')}</p>
            </div>
          ) : (
            <div className="space-y-1">
              {recentRecords.map((rec) => {
                const model = models.find((m) => m.id === rec.model_id);
                if (!model) return null;
                const Icon = getIconComponent(model.icon);
                const titleField = model.schema.sections
                  .flatMap((s) => s.fields)
                  .find((f) => f.id === model.card_config.title_field_id);
                const title = titleField ? String(rec.data[titleField.name] ?? '') : `#${rec.id.slice(0, 8)}`;

                return (
                  <button
                    key={rec.id}
                    onClick={() => navigate(`/model/${model.name}/${rec.id}`)}
                    className="w-full flex items-center gap-4 px-4 py-3 rounded-xl hover:bg-cream/60 transition-colors text-start group"
                  >
                    <div
                      className="w-10 h-10 rounded-xl flex items-center justify-center shrink-0"
                      style={{ backgroundColor: `${model.color}10` }}
                    >
                      <Icon size={18} style={{ color: model.color }} />
                    </div>
                    <div className="flex-1 min-w-0">
                      <div className="text-sm font-bold text-charcoal truncate group-hover:text-copper transition-colors">{title || '—'}</div>
                      <div className="text-xs text-charcoal/30">
                        {isAr ? model.label_ar : model.label_en}
                      </div>
                    </div>
                    <span className="text-xs text-charcoal/20">
                      {new Date(rec.updated_at).toLocaleDateString(isAr ? 'ar-SA' : 'en-GB')}
                    </span>
                  </button>
                );
              })}
            </div>
          )}
        </div>

        {/* Upcoming Follow-ups */}
        <div className="card p-6">
          <h2 className="font-bold text-chocolate text-lg mb-5 flex items-center gap-3">
            <div className="w-8 h-8 rounded-lg bg-gold/10 flex items-center justify-center">
              <Calendar size={16} className="text-gold" />
            </div>
            {t('home.upcoming_followups')}
          </h2>
          {upcomingFollowups.length === 0 ? (
            <div className="text-center py-8">
              <p className="text-sm text-charcoal/30">{isAr ? 'لا توجد متابعات قادمة' : 'No upcoming follow-ups'}</p>
            </div>
          ) : (
            <div className="space-y-1">
              {upcomingFollowups.map((rec) => {
                const resultField = followupsModel?.schema.sections
                  .flatMap((s) => s.fields)
                  .find((f) => f.name === 'result');
                const resultValue = rec.data.result as string | undefined;
                const resultOpt = resultField?.options?.find((o) => o.value === resultValue);

                return (
                  <button
                    key={rec.id}
                    onClick={() => navigate(`/model/followups/${rec.id}`)}
                    className="w-full flex items-center justify-between px-4 py-3 rounded-xl hover:bg-cream/60 transition-colors text-start"
                  >
                    <div>
                      <div className="text-sm font-bold text-charcoal">
                        {String(rec.data.client_id ?? '').slice(0, 8)}...
                      </div>
                      <div className="text-xs text-charcoal/30">
                        {String(rec.data.next_followup_date ?? '')}
                      </div>
                    </div>
                    {resultOpt && (
                      <Badge label={isAr ? resultOpt.label_ar : resultOpt.label_en} color={resultOpt.color} />
                    )}
                  </button>
                );
              })}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
