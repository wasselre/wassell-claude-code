import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { Megaphone, Sparkles, Users, ArrowRightLeft, Radio, Building2, ExternalLink } from 'lucide-react';
import { useAppStore } from '@/stores/appStore';
import { fetchClientAcquisition, type AcquisitionTouch } from '@/lib/acquisition/client';

interface Props {
  modelId: string;
  recordId: string;
  /**
   * 'form' (default) — standalone card in the generic record-form panel stack.
   * 'cockpit' — matches the 360 client cockpit's `.card` grid tiles (no top
   * margin; the grid gap handles spacing).
   */
  variant?: 'form' | 'cockpit';
}

/**
 * "كيف وصلنا هذا العميل" — the Sales-side acquisition/source panel on a client
 * record form. Self-hides on every other model and when the client has no
 * recorded acquisition touches.
 *
 * It shows only the useful sales context — where the client came from, which
 * project they responded to, which ad/content they saw, the platform, and when —
 * all resolved LIVE through the Ad (nothing marketing is copied onto the client;
 * see `mos_client_acquisition`). Each touch links out to the original ad in the
 * Marketing workspace for reps who want the full picture.
 */
export default function ClientAcquisitionPanel({ modelId, recordId, variant = 'form' }: Props) {
  const isAr = useAppStore((s) => s.language === 'ar');
  const models = useAppStore((s) => s.models);
  const tr = (ar: string, en: string) => (isAr ? ar : en);

  const model = models.find((m) => m.id === modelId);
  const isClients = model?.name === 'clients';

  const [touches, setTouches] = useState<AcquisitionTouch[] | null>(null);

  useEffect(() => {
    if (!isClients || !recordId) return;
    let cancelled = false;
    setTouches(null);
    fetchClientAcquisition(recordId).then((rows) => {
      if (!cancelled) setTouches(rows);
    });
    return () => {
      cancelled = true;
    };
  }, [isClients, recordId]);

  // Never render on other models; while loading render nothing (no flash); and
  // when the client has no acquisition history, stay hidden entirely.
  if (!isClients) return null;
  if (touches === null) return null;
  if (touches.length === 0) return null;

  const fmtDate = (iso: string) => {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return iso;
    return d.toLocaleDateString(isAr ? 'ar-SA' : 'en-US', { year: 'numeric', month: 'short', day: 'numeric' });
  };

  const wrapperCls =
    variant === 'cockpit'
      ? 'card p-5'
      : 'mt-6 bg-white rounded-2xl border border-sand/30 p-5';

  return (
    <div className={wrapperCls} dir={isAr ? 'rtl' : 'ltr'}>
      <div className="flex items-center gap-2 mb-4">
        <Megaphone size={16} className="text-copper" />
        <h3 className="font-bold text-charcoal text-sm">{tr('كيف وصلنا هذا العميل', 'How this client reached us')}</h3>
      </div>

      <ol className="space-y-3">
        {touches.map((t) => (
          <AcquisitionRow key={t.id} touch={t} isAr={isAr} tr={tr} fmtDate={fmtDate} />
        ))}
      </ol>
    </div>
  );
}

function channelMeta(channel: string, isAr: boolean): { label: string; Icon: typeof Megaphone; color: string } {
  switch (channel) {
    case 'paid_ad':
      return { label: isAr ? 'إعلان مدفوع' : 'Paid ad', Icon: Megaphone, color: 'text-copper bg-copper/10' };
    case 'organic':
      return { label: isAr ? 'منشور عضوي' : 'Organic', Icon: Sparkles, color: 'text-emerald-700 bg-emerald-50' };
    case 'referral':
      return { label: isAr ? 'إحالة' : 'Referral', Icon: Users, color: 'text-indigo-700 bg-indigo-50' };
    case 'direct':
      return { label: isAr ? 'مباشر' : 'Direct', Icon: ArrowRightLeft, color: 'text-slate-700 bg-slate-100' };
    default:
      return { label: isAr ? 'أخرى' : 'Other', Icon: Radio, color: 'text-slate-700 bg-slate-100' };
  }
}

function platformLabel(platform: string | null): string | null {
  if (!platform) return null;
  const map: Record<string, string> = {
    meta: 'Meta',
    facebook: 'Facebook',
    instagram: 'Instagram',
    tiktok: 'TikTok',
    snapchat: 'Snapchat',
    google: 'Google',
    x: 'X',
  };
  return map[platform.toLowerCase()] ?? platform.charAt(0).toUpperCase() + platform.slice(1);
}

function AcquisitionRow({
  touch,
  isAr,
  tr,
  fmtDate,
}: {
  touch: AcquisitionTouch;
  isAr: boolean;
  tr: (ar: string, en: string) => string;
  fmtDate: (iso: string) => string;
}) {
  const { label: chLabel, Icon, color } = channelMeta(touch.channel, isAr);
  const platform = platformLabel(touch.platform);
  const offer = touch.offer?.trim() || null;

  // Deep link into Marketing: prefer the execution (where the ad lives), else
  // the campaign. Reps without Marketing access see the workspace's own gate.
  const marketingHref =
    touch.campaign_id && touch.execution_id
      ? `/m/campaigns/${touch.campaign_id}/exec/${touch.execution_id}`
      : touch.campaign_id
        ? `/m/campaigns/${touch.campaign_id}`
        : null;

  return (
    <li className="rounded-xl border border-sand/40 bg-cream/30 p-3.5">
      <div className="flex flex-wrap items-center gap-2">
        <span className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-bold ${color}`}>
          <Icon size={12} />
          {chLabel}
        </span>
        {platform && (
          <span className="inline-flex items-center rounded-full bg-charcoal/5 px-2 py-0.5 text-[11px] font-semibold text-charcoal/70">
            {platform}
          </span>
        )}
        <span
          className={`inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-bold ${
            touch.touch_type === 'first' ? 'bg-gold/15 text-[#8a6a2f]' : 'bg-charcoal/5 text-charcoal/60'
          }`}
        >
          {touch.touch_type === 'first' ? tr('أول تواصل', 'First touch') : tr('آخر تواصل', 'Latest touch')}
        </span>
        <span className="ms-auto text-[11px] text-charcoal/50">{fmtDate(touch.occurred_at)}</span>
      </div>

      <div className="mt-2 space-y-1 text-xs text-charcoal/80">
        {touch.project_name && (
          <div className="flex items-center gap-1.5">
            <Building2 size={13} className="shrink-0 text-copper/70" />
            <span className="font-semibold text-charcoal">{touch.project_name}</span>
            <span className="text-charcoal/40">{tr('المشروع', 'Project')}</span>
          </div>
        )}
        {(touch.campaign_name || touch.ad_name) && (
          <div className="text-charcoal/70">
            {touch.campaign_name && <span>{touch.campaign_name}</span>}
            {touch.ad_name && (
              <>
                {touch.campaign_name ? <span className="text-charcoal/30"> · </span> : null}
                <span className="font-medium">{touch.ad_name}</span>
              </>
            )}
            {touch.ad_set_name && <span className="text-charcoal/40"> · {touch.ad_set_name}</span>}
          </div>
        )}
        {touch.content_title && (
          <div className="text-charcoal/60">
            {tr('المحتوى', 'Content')}: <span className="text-charcoal/80">{touch.content_title}</span>
          </div>
        )}
        {offer && (
          <div className="text-charcoal/60">
            {tr('العرض', 'Offer')}: <span className="text-charcoal/80">{offer}</span>
          </div>
        )}
      </div>

      {marketingHref && (
        <Link
          to={marketingHref}
          className="mt-2.5 inline-flex items-center gap-1 text-[11px] font-semibold text-copper hover:underline"
        >
          <ExternalLink size={12} />
          {tr('فتح الإعلان في التسويق', 'Open the ad in Marketing')}
        </Link>
      )}
    </li>
  );
}
