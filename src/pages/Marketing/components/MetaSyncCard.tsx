/**
 * Settings → Platforms — the LIVE Meta Marketing API card.
 *
 * Unlike the static per-platform cards in SettingsPlatforms (which describe the
 * manual publishing posture), this one talks to OUR ad account: it shows the
 * last sync outcome and lets a manage_paid_ads role run a sync on demand or flip
 * the kill switch. Campaigns/ad sets/ads + spend/lead metrics flow into the MOS
 * spine; Click-to-WhatsApp lead attribution self-heals on every sync.
 *
 * Reads are open (any role sees status); the Sync + kill-switch controls only
 * render for manage_paid_ads (the server re-checks — this is display gating).
 */
import { useEffect, useState } from 'react';
import { useAppStore } from '@/stores/appStore';
import {
  mosMetaAccount, mosMetaSync, mosMetaToggle,
  type MetaAccountInfo,
} from '@/lib/marketingOS/client';
import { useWorkspace } from '../MarketingWorkspace';
import { Pill } from './kit';
import { shortDate } from '../lib/format';

export function MetaSyncCard() {
  const { isAr, can } = useWorkspace();
  const addToast = useAppStore((s) => s.addToast);
  const [info, setInfo] = useState<MetaAccountInfo | null>(null);
  const [busy, setBusy] = useState<'sync' | 'toggle' | null>(null);
  const mayManage = can('manage_paid_ads');

  useEffect(() => {
    let alive = true;
    mosMetaAccount().then((r) => { if (alive) setInfo(r); }).catch(() => { if (alive) setInfo({ configured: false }); });
    return () => { alive = false; };
  }, []);

  async function runSync() {
    setBusy('sync');
    try {
      const r = await mosMetaSync();
      if (r.skipped === 'disabled') {
        addToast(isAr ? 'المزامنة موقوفة حاليًا.' : 'Sync is currently turned off.', 'error');
      } else if (r.skipped === 'not_configured' || !r.ok) {
        addToast(isAr ? 'تعذّرت المزامنة.' : 'Sync failed.', 'error');
      } else {
        const a = r.applied ?? {};
        addToast(
          isAr
            ? `تمت المزامنة: ${a.campaigns ?? 0} حملة، ${a.ads ?? 0} إعلان، ${a.healed ?? 0} عميل رُبط.`
            : `Synced: ${a.campaigns ?? 0} campaigns, ${a.ads ?? 0} ads, ${a.healed ?? 0} leads linked.`,
          'success',
        );
      }
      setInfo(await mosMetaAccount());
    } catch {
      addToast(isAr ? 'تعذّرت المزامنة.' : 'Sync failed.', 'error');
    } finally {
      setBusy(null);
    }
  }

  async function toggle(enabled: boolean) {
    setBusy('toggle');
    try {
      await mosMetaToggle(enabled);
      setInfo(await mosMetaAccount());
    } catch {
      addToast(isAr ? 'تعذّر التغيير.' : 'Could not change the setting.', 'error');
    } finally {
      setBusy(null);
    }
  }

  if (!info) return null; // brief load; the rest of Settings is already visible
  const st = info.state;
  const enabled = st?.is_enabled !== false;
  const res = (st?.last_result ?? {}) as Record<string, number>;

  return (
    <div className="card" style={{ padding: 16, marginBottom: 16 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 8 }}>
        <div style={{
          width: 40, height: 40, borderRadius: 8, display: 'grid', placeItems: 'center',
          background: '#1877F2', color: '#fff', fontWeight: 700,
        }}>Ac</div>
        <div style={{ flex: 1 }}>
          <div style={{ fontWeight: 700 }}>{isAr ? 'ميتا — حسابنا الإعلاني' : 'Meta — our ad account'}</div>
          <div style={{ fontSize: 13, opacity: 0.7 }}>
            {info.configured
              ? (isAr ? 'مزامنة تلقائية للحملات والإنفاق ونسب العملاء' : 'Auto-syncs campaigns, spend & lead attribution')
              : (isAr ? 'غير مُهيّأ — أضف مفاتيح ميتا' : 'Not configured — add the Meta credentials')}
          </div>
        </div>
        {info.configured
          ? <Pill tone={enabled ? 'go' : 'wait'}>{enabled ? (isAr ? 'مفعّل' : 'On') : (isAr ? 'موقوف' : 'Off')}</Pill>
          : <Pill tone="idle">{isAr ? 'غير مُهيّأ' : 'Not set'}</Pill>}
      </div>

      {info.configured && (
        <>
          <div style={{ display: 'flex', gap: 20, flexWrap: 'wrap', fontSize: 13, margin: '10px 0' }}>
            <span>{isAr ? 'آخر مزامنة: ' : 'Last sync: '}
              <b>{st?.last_synced_at ? shortDate(st.last_synced_at, isAr) : (isAr ? 'لم تتم بعد' : 'never')}</b></span>
            {st?.currency && <span>{isAr ? 'العملة: ' : 'Currency: '}<b>{st.currency}</b></span>}
            {st?.last_result && (
              <span>{isAr ? 'الأخيرة: ' : 'Last run: '}
                <b>{res.campaigns ?? 0}</b> {isAr ? 'حملة' : 'campaigns'} · <b>{res.ads ?? 0}</b> {isAr ? 'إعلان' : 'ads'} · <b>{res.healed ?? 0}</b> {isAr ? 'ربط' : 'healed'}</span>
            )}
          </div>
          {st?.last_error && (
            <div style={{ fontSize: 12, color: 'var(--danger, #b91c1c)', marginBottom: 8 }}>
              {isAr ? 'خطأ آخر مزامنة: ' : 'Last error: '}{st.last_error}
            </div>
          )}
          {mayManage && (
            <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
              <button type="button" className="btn btn-p btn-sm" disabled={busy !== null} onClick={runSync}>
                {busy === 'sync' ? (isAr ? 'جارٍ المزامنة…' : 'Syncing…') : (isAr ? 'مزامنة الآن' : 'Sync now')}
              </button>
              <button type="button" className="btn btn-sm" disabled={busy !== null} onClick={() => toggle(!enabled)}>
                {enabled ? (isAr ? 'إيقاف المزامنة' : 'Turn off') : (isAr ? 'تفعيل المزامنة' : 'Turn on')}
              </button>
            </div>
          )}
        </>
      )}
    </div>
  );
}
