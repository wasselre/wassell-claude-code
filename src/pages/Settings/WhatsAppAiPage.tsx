import { useEffect, useState, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { useAppStore } from '@/stores/appStore';
import { supabase } from '@/lib/supabase';
import { Bot, Loader2, Save, Clock, ShieldAlert, CheckCircle2, PauseCircle } from 'lucide-react';
import Button from '@/components/ui/Button';
import BackToSettings from './components/BackToSettings';

/**
 * Settings → WhatsApp AI agent.
 *
 * Controls WHEN the agent may answer customers on its own. The agent itself is
 * a real Claude Code session (see wa-agent/), so this page is purely policy:
 * the kill switch, the hours humans cover, and the two safety limits.
 */

interface AiSettings {
  is_enabled: boolean;
  work_start_hour: number;
  work_end_hour: number;
  work_days: number[];
  timezone: string;
  max_replies_per_chat: number;
  human_quiet_hours: number;
}

// ISO weekday numbering (Mon=1 … Sun=7) — matches EXTRACT(ISODOW) in the gate.
const DAYS: { iso: number; ar: string; en: string }[] = [
  { iso: 7, ar: 'الأحد', en: 'Sun' },
  { iso: 1, ar: 'الإثنين', en: 'Mon' },
  { iso: 2, ar: 'الثلاثاء', en: 'Tue' },
  { iso: 3, ar: 'الأربعاء', en: 'Wed' },
  { iso: 4, ar: 'الخميس', en: 'Thu' },
  { iso: 5, ar: 'الجمعة', en: 'Fri' },
  { iso: 6, ar: 'السبت', en: 'Sat' },
];

export default function WhatsAppAiPage() {
  useTranslation();
  const { language, addToast } = useAppStore();
  const isAr = language === 'ar';

  const [settings, setSettings] = useState<AiSettings | null>(null);
  const [now, setNow] = useState<{ would_reply: boolean; reason: string | null } | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  const authHeader = useCallback(async (): Promise<Record<string, string>> => {
    const session = supabase ? (await supabase.auth.getSession()).data.session : null;
    return session?.access_token ? { Authorization: `Bearer ${session.access_token}` } : {};
  }, []);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch('/api/whatsapp/ai-settings', { headers: await authHeader() });
      const body = await res.json();
      if (!res.ok) throw new Error(body?.error ?? `(${res.status})`);
      setSettings(body.settings);
      setNow(body.now);
    } catch (err) {
      addToast(
        isAr ? `تعذر تحميل الإعدادات: ${String(err)}` : `Failed to load settings: ${String(err)}`,
        'error',
      );
    } finally {
      setLoading(false);
    }
  }, [authHeader, addToast, isAr]);

  useEffect(() => { void load(); }, [load]);

  const save = async (patch: Partial<AiSettings>) => {
    setSaving(true);
    try {
      const res = await fetch('/api/whatsapp/ai-settings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...(await authHeader()) },
        body: JSON.stringify(patch),
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body?.error ?? `(${res.status})`);
      setSettings(body.settings);
      await load();               // refresh the "answering now?" probe
      addToast(isAr ? 'تم الحفظ' : 'Saved', 'success');
    } catch (err) {
      addToast(isAr ? `تعذر الحفظ: ${String(err)}` : `Save failed: ${String(err)}`, 'error');
    } finally {
      setSaving(false);
    }
  };

  if (loading) {
    return (
      <div className="p-6">
        <BackToSettings />
        <div className="flex items-center gap-2 text-charcoal/60 mt-6">
          <Loader2 className="w-4 h-4 animate-spin" />
          {isAr ? 'جاري التحميل…' : 'Loading…'}
        </div>
      </div>
    );
  }
  if (!settings) return <div className="p-6"><BackToSettings /></div>;

  const toggleDay = (iso: number) => {
    const has = settings.work_days.includes(iso);
    const next = has ? settings.work_days.filter((d) => d !== iso) : [...settings.work_days, iso];
    void save({ work_days: next.sort() });
  };

  const REASON_AR: Record<string, string> = {
    disabled: 'المساعد متوقف',
    working_hours: 'ضمن ساعات عمل الفريق — الردود للمندوبين',
    human_active: 'مندوب رد على المحادثة مؤخراً',
    reply_cap_reached: 'وصل الحد الأقصى للردود',
    ok: 'المساعد يرد الآن على المحادثات الجديدة',
  };

  return (
    <div className="p-6 max-w-3xl">
      <BackToSettings />

      <div className="flex items-center gap-3 mt-4 mb-1">
        <div className="w-10 h-10 rounded-xl bg-copper/10 flex items-center justify-center">
          <Bot className="w-5 h-5 text-copper" />
        </div>
        <div>
          <h1 className="text-xl font-bold text-charcoal">
            {isAr ? 'المساعد الذكي للواتساب' : 'WhatsApp AI agent'}
          </h1>
          <p className="text-sm text-charcoal/60">
            {isAr
              ? 'يرد على العملاء خارج ساعات عمل الفريق فقط.'
              : 'Answers customers outside the team’s working hours only.'}
          </p>
        </div>
      </div>

      {/* Live state — what the policy means RIGHT NOW. */}
      <div className={`card p-4 mb-5 flex items-start gap-3 ${now?.would_reply ? 'bg-green-50' : 'bg-sand/10'}`}>
        {now?.would_reply
          ? <CheckCircle2 className="w-5 h-5 text-green-600 shrink-0 mt-0.5" />
          : <PauseCircle className="w-5 h-5 text-charcoal/40 shrink-0 mt-0.5" />}
        <div className="text-sm">
          <div className="font-semibold text-charcoal">
            {now?.would_reply
              ? (isAr ? 'المساعد يعمل الآن' : 'Agent is answering now')
              : (isAr ? 'المساعد لا يرد الآن' : 'Agent is not answering now')}
          </div>
          <div className="text-charcoal/60">
            {isAr
              ? (REASON_AR[now?.reason ?? ''] ?? now?.reason ?? '')
              : (now?.reason ?? '')}
          </div>
        </div>
      </div>

      {/* Kill switch */}
      <div className="card p-5 mb-4">
        <label className="flex items-start gap-3 cursor-pointer">
          <input
            type="checkbox"
            className="mt-1 w-5 h-5 accent-copper"
            checked={settings.is_enabled}
            disabled={saving}
            onChange={(e) => void save({ is_enabled: e.target.checked })}
          />
          <div>
            <div className="font-semibold text-charcoal">
              {isAr ? 'تفعيل المساعد الذكي' : 'Enable the AI agent'}
            </div>
            <div className="text-sm text-charcoal/60">
              {isAr
                ? 'عند الإيقاف لن يرد المساعد على أي عميل، حتى لو تم تحويل محادثة إليه يدوياً.'
                : 'When off, the agent replies to nobody — even a manual handover does nothing.'}
            </div>
          </div>
        </label>
      </div>

      {/* Working hours = when HUMANS cover */}
      <div className="card p-5 mb-4">
        <div className="flex items-center gap-2 mb-1">
          <Clock className="w-4 h-4 text-copper" />
          <h2 className="font-semibold text-charcoal">
            {isAr ? 'ساعات عمل الفريق' : 'Team working hours'}
          </h2>
        </div>
        <p className="text-sm text-charcoal/60 mb-4">
          {isAr
            ? 'خلال هذه الأوقات يرد المندوبون. المساعد يرد خارجها فقط.'
            : 'Reps answer during these hours. The agent covers everything outside them.'}
        </p>

        <div className="flex flex-wrap gap-2 mb-4">
          {DAYS.map((d) => {
            const on = settings.work_days.includes(d.iso);
            return (
              <button
                key={d.iso}
                type="button"
                disabled={saving}
                onClick={() => toggleDay(d.iso)}
                className={`px-3 py-1.5 rounded-lg text-sm border transition ${
                  on ? 'bg-copper text-white border-copper' : 'bg-white text-charcoal/70 border-sand'
                }`}
              >
                {isAr ? d.ar : d.en}
              </button>
            );
          })}
        </div>

        <div className="flex items-end gap-3 flex-wrap">
          <label className="text-sm">
            <span className="block text-charcoal/70 mb-1">{isAr ? 'من الساعة' : 'From'}</span>
            <input
              type="number" min={0} max={23} className="form-input w-24"
              defaultValue={settings.work_start_hour}
              onBlur={(e) => {
                const v = Number(e.target.value);
                if (v !== settings.work_start_hour) void save({ work_start_hour: v });
              }}
            />
          </label>
          <label className="text-sm">
            <span className="block text-charcoal/70 mb-1">{isAr ? 'إلى الساعة' : 'To'}</span>
            <input
              type="number" min={1} max={24} className="form-input w-24"
              defaultValue={settings.work_end_hour}
              onBlur={(e) => {
                const v = Number(e.target.value);
                if (v !== settings.work_end_hour) void save({ work_end_hour: v });
              }}
            />
          </label>
          <div className="text-sm text-charcoal/50 pb-2">{settings.timezone}</div>
        </div>
      </div>

      {/* Safety limits */}
      <div className="card p-5">
        <div className="flex items-center gap-2 mb-1">
          <ShieldAlert className="w-4 h-4 text-copper" />
          <h2 className="font-semibold text-charcoal">{isAr ? 'حدود الأمان' : 'Safety limits'}</h2>
        </div>
        <p className="text-sm text-charcoal/60 mb-4">
          {isAr
            ? 'تمنع المساعد من الاستمرار بلا نهاية أو الرد فوق مندوب يتابع العميل.'
            : 'Stop the agent running on forever, or talking over a rep who is on the case.'}
        </p>
        <div className="flex flex-wrap gap-5">
          <label className="text-sm">
            <span className="block text-charcoal/70 mb-1">
              {isAr ? 'أقصى عدد ردود لكل محادثة' : 'Max replies per conversation'}
            </span>
            <input
              type="number" min={1} max={100} className="form-input w-28"
              defaultValue={settings.max_replies_per_chat}
              onBlur={(e) => {
                const v = Number(e.target.value);
                if (v !== settings.max_replies_per_chat) void save({ max_replies_per_chat: v });
              }}
            />
          </label>
          <label className="text-sm">
            <span className="block text-charcoal/70 mb-1">
              {isAr ? 'صمت بعد رد المندوب (ساعات)' : 'Stay silent after a rep replies (hours)'}
            </span>
            <input
              type="number" min={0} max={168} className="form-input w-28"
              defaultValue={settings.human_quiet_hours}
              onBlur={(e) => {
                const v = Number(e.target.value);
                if (v !== settings.human_quiet_hours) void save({ human_quiet_hours: v });
              }}
            />
          </label>
        </div>
      </div>

      {saving && (
        <div className="flex items-center gap-2 text-sm text-charcoal/60 mt-4">
          <Save className="w-4 h-4 animate-pulse" /> {isAr ? 'جاري الحفظ…' : 'Saving…'}
        </div>
      )}
      <div className="mt-6">
        <Button variant="secondary" onClick={() => void load()} disabled={loading || saving}>
          {isAr ? 'تحديث' : 'Refresh'}
        </Button>
      </div>
    </div>
  );
}
