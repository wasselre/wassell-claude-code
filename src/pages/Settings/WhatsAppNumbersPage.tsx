import { useEffect, useMemo, useState } from 'react';
import { MessageCircle, RefreshCw, Star, Eye, EyeOff, Check, X } from 'lucide-react';
import { useAppStore } from '@/stores/appStore';
import Button from '@/components/ui/Button';
import BackToSettings from './components/BackToSettings';
import type { HaberchatDevice, WhatsAppNumber } from '@/types';

/**
 * Admin page: lists every Haberchat device (connected WhatsApp number) side
 * by side with the local overlay (friendly name, default flag, active flag).
 *
 * The Haberchat side is authoritative for phone + session status. The local
 * `whatsapp_numbers` table is authoritative for the fields the admin owns.
 * A device that appears in Haberchat but not yet in the overlay renders with
 * defaults — the first edit creates the overlay row.
 */
export default function WhatsAppNumbersPage() {
  const isAr = useAppStore((s) => s.language === 'ar');
  const waDevices = useAppStore((s) => s.waDevices);
  const waDevicesLive = useAppStore((s) => s.waDevicesLive);
  const loadWhatsAppNumbers = useAppStore((s) => s.loadWhatsAppNumbers);
  const saveWhatsAppNumber = useAppStore((s) => s.saveWhatsAppNumber);
  const addToast = useAppStore((s) => s.addToast);

  const [refreshing, setRefreshing] = useState(false);
  const [refreshError, setRefreshError] = useState<string | null>(null);

  useEffect(() => {
    void (async () => {
      setRefreshing(true);
      setRefreshError(null);
      try {
        await loadWhatsAppNumbers();
      } catch (err) {
        setRefreshError(err instanceof Error ? err.message : String(err));
      } finally {
        setRefreshing(false);
      }
    })();
  }, [loadWhatsAppNumbers]);

  const handleRefresh = async () => {
    setRefreshing(true);
    setRefreshError(null);
    try {
      await loadWhatsAppNumbers();
      addToast(isAr ? 'تم التحديث' : 'Refreshed', 'success');
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setRefreshError(msg);
      addToast(msg, 'error');
    } finally {
      setRefreshing(false);
    }
  };

  // Merge live + overlay. Keyed by device_id. Live wins for phone/status;
  // overlay wins for friendly_name / default / active.
  const merged = useMemo(() => mergeDevicesAndOverlay(waDevicesLive, waDevices), [waDevicesLive, waDevices]);

  return (
    <div className="p-6 md:p-8 max-w-5xl mx-auto">
      <BackToSettings />
      <div className="flex items-center gap-3 mb-6">
        <div className="w-12 h-12 rounded-2xl bg-charcoal/5 flex items-center justify-center">
          <MessageCircle size={24} className="text-charcoal/60" />
        </div>
        <div className="flex-1">
          <h1 className="text-2xl font-bold text-chocolate">
            {isAr ? 'أرقام واتساب' : 'WhatsApp Numbers'}
          </h1>
          <p className="text-sm text-charcoal/50 mt-0.5">
            {isAr
              ? 'الأرقام المتصلة عبر Haberchat. اختر الرقم الافتراضي للمحادثات الجديدة.'
              : 'Numbers connected via Haberchat. Pick the default for new conversations.'}
          </p>
        </div>
        <Button onClick={handleRefresh} disabled={refreshing}>
          <RefreshCw size={16} className={refreshing ? 'animate-spin' : ''} />
          {isAr ? 'تحديث' : 'Refresh'}
        </Button>
      </div>

      {refreshError && (
        <div className="card p-4 mb-4 border-red-300 bg-red-50">
          <p className="text-sm text-red-700 font-medium">
            {isAr ? 'تعذّر الاتصال بـ Haberchat' : 'Could not reach Haberchat'}
          </p>
          <p className="text-xs text-red-600/80 mt-1">{refreshError}</p>
          <p className="text-xs text-red-600/60 mt-2">
            {isAr
              ? 'تحقق من متغيّر HABERCHAT_TOKEN في Vercel وأعد نشر التطبيق.'
              : 'Check the HABERCHAT_TOKEN env var in Vercel and redeploy.'}
          </p>
        </div>
      )}

      {!refreshError && merged.length === 0 && !refreshing && (
        <div className="card p-10 text-center">
          <MessageCircle size={32} className="mx-auto mb-3 text-charcoal/20" />
          <p className="text-charcoal/60 font-medium">
            {isAr ? 'لا يوجد أرقام متصلة' : 'No numbers connected yet'}
          </p>
          <p className="text-xs text-charcoal/40 mt-1">
            {isAr
              ? 'افتح حساب Haberchat واربط رقم واتساب، ثم اضغط تحديث.'
              : 'Connect a WhatsApp number in the Haberchat dashboard, then click Refresh.'}
          </p>
        </div>
      )}

      {merged.length > 0 && (
        <div className="space-y-3">
          {merged.map((row) => (
            <NumberRow
              key={row.device_id}
              row={row}
              isAr={isAr}
              onSave={saveWhatsAppNumber}
            />
          ))}
        </div>
      )}
    </div>
  );
}

// ─── Row ────────────────────────────────────────────────────────────

interface MergedRow {
  device_id: string;
  phone: string;
  live_name: string | null;              // Haberchat's own name/alias for the device
  live_status: string | null;
  friendly_name_ar: string | null;
  friendly_name_en: string | null;
  is_default: boolean;
  is_active: boolean;
  // True when the overlay row exists in waDevices (vs synthesized from live only).
  has_overlay: boolean;
  overlay_created_at: string | null;
}

function NumberRow({
  row,
  isAr,
  onSave,
}: {
  row: MergedRow;
  isAr: boolean;
  onSave: (entry: WhatsAppNumber) => Promise<void>;
}) {
  const [editing, setEditing] = useState(false);
  const [nameAr, setNameAr] = useState(row.friendly_name_ar ?? '');
  const [nameEn, setNameEn] = useState(row.friendly_name_en ?? '');
  const [saving, setSaving] = useState(false);

  const label = isAr
    ? (row.friendly_name_ar || row.friendly_name_en || row.live_name || row.phone)
    : (row.friendly_name_en || row.friendly_name_ar || row.live_name || row.phone);

  const statusColor = statusBadge(row.live_status);

  const persist = async (patch: Partial<WhatsAppNumber>) => {
    setSaving(true);
    try {
      const now = new Date().toISOString();
      const entry: WhatsAppNumber = {
        device_id: row.device_id,
        phone: row.phone,
        friendly_name_ar: row.friendly_name_ar,
        friendly_name_en: row.friendly_name_en,
        is_default: row.is_default,
        is_active: row.is_active,
        created_at: row.overlay_created_at ?? now,
        updated_at: now,
        ...patch,
      };
      await onSave(entry);
    } finally {
      setSaving(false);
    }
  };

  const saveNames = async () => {
    await persist({
      friendly_name_ar: nameAr.trim() || null,
      friendly_name_en: nameEn.trim() || null,
    });
    setEditing(false);
  };

  const cancelNames = () => {
    setNameAr(row.friendly_name_ar ?? '');
    setNameEn(row.friendly_name_en ?? '');
    setEditing(false);
  };

  return (
    <div
      className={`card p-4 flex flex-col sm:flex-row gap-3 items-start sm:items-center ${
        row.is_default ? 'border-copper' : ''
      } ${!row.is_active ? 'opacity-60' : ''}`}
    >
      {/* Left: number + status */}
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2 flex-wrap">
          {!editing ? (
            <>
              <h3 className="font-bold text-charcoal truncate">{label}</h3>
              {row.is_default && (
                <span className="inline-flex items-center gap-1 text-xs font-medium px-2 py-0.5 rounded-full bg-copper/10 text-copper">
                  <Star size={12} fill="currentColor" />
                  {isAr ? 'افتراضي' : 'Default'}
                </span>
              )}
              {row.live_status && (
                <span
                  className="inline-flex items-center gap-1 text-xs font-medium px-2 py-0.5 rounded-full"
                  style={{ backgroundColor: `${statusColor}14`, color: statusColor }}
                >
                  {statusLabel(row.live_status, isAr)}
                </span>
              )}
            </>
          ) : (
            <div className="flex flex-col sm:flex-row gap-2 flex-1 w-full">
              <input
                type="text"
                dir="rtl"
                placeholder={isAr ? 'اسم عربي' : 'Arabic name'}
                value={nameAr}
                onChange={(e) => setNameAr(e.target.value)}
                className="input flex-1 text-sm"
                disabled={saving}
              />
              <input
                type="text"
                dir="ltr"
                placeholder={isAr ? 'اسم إنجليزي' : 'English name'}
                value={nameEn}
                onChange={(e) => setNameEn(e.target.value)}
                className="input flex-1 text-sm"
                disabled={saving}
              />
              <button
                onClick={saveNames}
                disabled={saving}
                className="btn-secondary !px-3"
                title={isAr ? 'حفظ' : 'Save'}
              >
                <Check size={16} />
              </button>
              <button
                onClick={cancelNames}
                disabled={saving}
                className="btn-secondary !px-3"
                title={isAr ? 'إلغاء' : 'Cancel'}
              >
                <X size={16} />
              </button>
            </div>
          )}
        </div>
        {!editing && (
          <p className="text-xs text-charcoal/50 mt-1 font-mono" dir="ltr">
            {row.phone}
          </p>
        )}
      </div>

      {/* Right: action buttons — only shown when not editing names */}
      {!editing && (
        <div className="flex flex-wrap gap-2 shrink-0">
          <button
            onClick={() => setEditing(true)}
            className="btn-secondary !px-3 !text-xs"
            disabled={saving}
          >
            {isAr ? 'تعديل الاسم' : 'Rename'}
          </button>
          {!row.is_default && (
            <button
              onClick={() => persist({ is_default: true })}
              className="btn-secondary !px-3 !text-xs"
              disabled={saving || !row.is_active}
              title={!row.is_active ? (isAr ? 'يجب التفعيل أولاً' : 'Activate first') : undefined}
            >
              <Star size={12} />
              {isAr ? 'اجعله افتراضي' : 'Set default'}
            </button>
          )}
          <button
            onClick={() => persist({ is_active: !row.is_active, is_default: row.is_active ? false : row.is_default })}
            className="btn-secondary !px-3 !text-xs"
            disabled={saving}
          >
            {row.is_active ? <EyeOff size={12} /> : <Eye size={12} />}
            {row.is_active
              ? (isAr ? 'إخفاء' : 'Hide')
              : (isAr ? 'تفعيل' : 'Activate')}
          </button>
        </div>
      )}
    </div>
  );
}

// ─── Helpers ────────────────────────────────────────────────────────

function mergeDevicesAndOverlay(live: HaberchatDevice[], overlay: WhatsAppNumber[]): MergedRow[] {
  const byDevice = new Map<string, WhatsAppNumber>();
  for (const row of overlay) byDevice.set(row.device_id, row);

  const seen = new Set<string>();
  const rows: MergedRow[] = live.map((d) => {
    seen.add(d.id);
    const o = byDevice.get(d.id);
    return {
      device_id: d.id,
      phone: d.phone || o?.phone || '',
      live_name: d.name ?? null,
      live_status: d.status ?? null,
      friendly_name_ar: o?.friendly_name_ar ?? null,
      friendly_name_en: o?.friendly_name_en ?? null,
      is_default: o?.is_default ?? false,
      is_active: o?.is_active ?? true,
      has_overlay: !!o,
      overlay_created_at: o?.created_at ?? null,
    };
  });

  // Orphan overlay rows — a device was removed from Haberchat but the local
  // row still exists. Surface them so the admin can deactivate or delete.
  for (const o of overlay) {
    if (seen.has(o.device_id)) continue;
    rows.push({
      device_id: o.device_id,
      phone: o.phone,
      live_name: null,
      live_status: 'disconnected',
      friendly_name_ar: o.friendly_name_ar,
      friendly_name_en: o.friendly_name_en,
      is_default: o.is_default,
      is_active: o.is_active,
      has_overlay: true,
      overlay_created_at: o.created_at,
    });
  }

  // Default rows first, then active, then inactive.
  return rows.sort((a, b) => {
    if (a.is_default !== b.is_default) return a.is_default ? -1 : 1;
    if (a.is_active !== b.is_active) return a.is_active ? -1 : 1;
    return a.phone.localeCompare(b.phone);
  });
}

function statusBadge(status: string | null): string {
  switch (status) {
    case 'online': return '#22c55e';
    case 'offline': return '#f59e0b';
    case 'disconnected': return '#ef4444';
    case 'pending': return '#6b7280';
    default: return '#6b7280';
  }
}

function statusLabel(status: string, isAr: boolean): string {
  const map: Record<string, { ar: string; en: string }> = {
    online: { ar: 'متصل', en: 'Online' },
    offline: { ar: 'غير متصل', en: 'Offline' },
    disconnected: { ar: 'منقطع', en: 'Disconnected' },
    pending: { ar: 'قيد التحقق', en: 'Pending' },
  };
  const entry = map[status];
  if (!entry) return status;
  return isAr ? entry.ar : entry.en;
}
